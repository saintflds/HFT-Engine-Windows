import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const errorText = error => error instanceof Error ? error.message : String(error);

export function killSwitchStore(folder) {
  const stateFile = path.join(folder, 'state.json');
  return {
    read: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    save(state) {
      mkdirSync(folder, { recursive: true });
      const temporary = path.join(folder, randomUUID() + '.tmp');
      try {
        writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx', flush: true });
        renameSync(temporary, stateFile);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    audit(entry) {
      mkdirSync(folder, { recursive: true });
      appendFileSync(path.join(folder, 'audit.jsonl'), JSON.stringify(entry) + '\n', { flush: true });
    },
  };
}

export function killSwitchRisk(env = process.env) {
  const dollars = env.HFTENGINE_KILL_MAX_LOSS_USD;
  const onDisconnect = env.HFTENGINE_KILL_ON_DISCONNECT;
  const maxLoss = dollars === undefined ? null : Number(dollars);
  const invalid = (maxLoss !== null && (!Number.isFinite(maxLoss) || maxLoss <= 0))
    || (onDisconnect !== undefined && !['0', '1'].includes(onDisconnect));
  return { maxLoss, onDisconnect: onDisconnect === '1', invalid };
}

export class KillSwitch {
  #state;
  #failures = new Map();
  #ioError = '';
  #bootId = randomUUID();
  #token;
  #risk;

  constructor(store, { resetToken, risk = killSwitchRisk({}), adapters = () => [], onActivated = () => {} } = {}) {
    this.store = store;
    this.adapters = adapters;
    this.onActivated = onActivated;
    this.#token = typeof resetToken === 'string' && resetToken.length >= 24 ? Buffer.from(resetToken) : null;
    this.#risk = risk;
    try {
      const state = store.read();
      if (state?.version !== 1 || typeof state.active !== 'boolean'
        || typeof state.id !== 'string' || !idPattern.test(state.id)
        || !['manual', 'risk', 'startup', 'reset'].includes(state.source)
        || state.active === (state.source === 'reset')
        || typeof state.reason !== 'string' || !state.reason
        || typeof state.at !== 'string' || !Number.isFinite(Date.parse(state.at))) {
        throw Error('Invalid kill-switch state.');
      }
      // Authorization applies to one server process. A crash or a failed
      // activation write can never reuse a previous process's permission.
      this.#state = state.active ? state : this.#newState(true, 'Server restarted. Authorize paper routing for this session.');
      this.#audit(state.active ? 'activation_restored' : 'startup_blocked', { persistedId: state.id });
    } catch (error) {
      this.#state = this.#newState(true, 'Kill-switch state unavailable. Authorization required.');
      this.#audit('startup_blocked', { error: errorText(error) });
    }
    if (risk.invalid) this.#audit('invalid_risk_configuration');
  }

  get blocked() { return this.#state.active || Boolean(this.#ioError) || this.#risk.invalid; }
  get stateId() { return this.#state.id; }

  status() {
    return {
      ...this.#state,
      active: this.blocked,
      reason: this.#risk.invalid ? 'Invalid kill-switch risk configuration.' : this.#state.reason,
      ioError: this.#ioError,
      cancellationFailures: [...this.#failures.values()].flatMap(orders => [...orders.values()]),
    };
  }

  #newState(active, reason, source = 'startup') {
    return { version: 1, active, source, reason, id: randomUUID(), at: new Date().toISOString() };
  }

  #audit(action, details = {}) {
    try {
      this.store.audit({ at: new Date().toISOString(), bootId: this.#bootId, action, id: this.#state.id, ...details });
      return true;
    } catch (error) {
      this.#ioError = 'Kill-switch audit write failed.';
      console.error(this.#ioError, { action, id: this.#state.id, ...details, error: errorText(error) });
      if (!this.#state.active) this.activate('risk', 'Required kill-switch audit unavailable.');
      return false;
    }
  }

  activate(source, reason, details = {}) {
    const first = !this.#state.active || this.#state.source === 'startup';
    if (first) this.#state = this.#newState(true, reason, source);
    this.#audit(first ? 'activated' : 'activation_requested_while_blocked', { source, reason, ...details });
    if (first) {
      try { this.store.save(this.#state); }
      catch (error) {
        this.#ioError = 'Kill-switch state write failed.';
        this.#audit('state_write_failed', { error: errorText(error) });
      }
    }
    if (first || (source === 'manual' && this.#failures.size)) {
      for (const [session, adapter] of this.adapters()) this.#cancel(session, adapter, 'emergency_stop');
    }
    if (first) this.onActivated();
    return this.status();
  }

  retirePaperSession(session, simulation, reason) {
    this.#cancel(session, simulation, reason);
    // This is the in-process simulator. Retiring it removes its exchange and
    // response queue, so nothing left there can fill or send an acknowledgment.
    simulation.retire();
    const failures = [...(this.#failures.get(session)?.values() ?? [])];
    this.#audit('paper_session_retired', { session, reason, reconciledFailures: failures });
    this.#failures.delete(session);
  }

  #cancel(session, adapter, trigger) {
    const failures = new Map();
    this.#failures.set(session, failures);
    try {
      for (const orderId of adapter.outstandingOrderIds()) {
        this.#audit('cancel_requested', { session, orderId, trigger });
        try {
          if (adapter.cancelOrder(orderId) !== true) throw Error('Adapter did not confirm cancellation.');
          this.#audit('cancel_confirmed', { session, orderId, trigger });
        } catch (error) {
          const failure = { session, orderId, error: errorText(error) };
          failures.set(orderId, failure);
          this.#audit('cancel_failed', { ...failure, trigger });
        }
      }
    } catch (error) {
      const failure = { session, orderId: null, error: errorText(error) };
      failures.set(null, failure);
      this.#audit('cancel_enumeration_failed', { ...failure, trigger });
    }
    if (!failures.size) this.#failures.delete(session);
  }

  checkRisk(session, position, equity, positionLimit) {
    if (this.blocked) return;
    if (!Number.isFinite(position) || !Number.isFinite(equity) || Math.abs(position) > positionLimit) {
      this.activate('risk', 'Critical paper exposure or accounting violation.', { session, position, equity, positionLimit });
    } else if (this.#risk.maxLoss !== null && equity <= -this.#risk.maxLoss) {
      this.activate('risk', 'Paper loss limit exceeded.', { session, equity, maxLoss: this.#risk.maxLoss });
    }
  }

  feedLost() {
    if (this.#risk.onDisconnect && !this.blocked) this.activate('risk', 'Sierra feed disconnected, stale, or invalid.');
  }

  denyReset(reason) {
    this.#audit('reset_denied', { reason });
    return 403;
  }

  reset(token, expectedId) {
    const supplied = typeof token === 'string' ? Buffer.from(token) : null;
    if (!this.#token || !supplied || supplied.length !== this.#token.length || !timingSafeEqual(supplied, this.#token)) {
      return this.denyReset('Invalid authorization.');
    }
    if (!this.blocked || expectedId !== this.#state.id || this.#risk.invalid || this.#failures.size) {
      this.#audit('reset_denied', { reason: 'State changed, invalid risk configuration, or outstanding cancellations.' });
      return 409;
    }
    const state = this.#newState(false, 'Paper routing authorized.', 'reset');
    if (!this.#audit('reset_authorized', { nextId: state.id, actor: 'local reset token' })) return 503;
    try { this.store.save(state); }
    catch (error) {
      this.#ioError = 'Kill-switch state write failed.';
      this.#audit('state_write_failed', { error: errorText(error) });
      return 503;
    }
    if (!this.#audit('reset_completed', { nextId: state.id })) return 503;
    this.#ioError = '';
    this.#state = state;
    return 200;
  }
}
