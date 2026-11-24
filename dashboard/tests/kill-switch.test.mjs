import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KillSwitch, killSwitchStore } from '../server/kill-switch.mjs';
import { paperExecutionPlugin } from '../server/paper-execution.mjs';
import { ReplaySimulation } from '../src/replay-simulation.ts';

const token = 'fixture-only-reset-token-123456';
const origin = 'http://127.0.0.1:5180';
const control = '/api/mnq/kill-switch';
const allow = (kill) => assert.equal(kill.reset(token, kill.status().id), 200);
const open = sim => sim.orders.filter(order => ['pending', 'working', 'canceling'].includes(order.state));

async function fixture(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'hft-kill-switch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const audit = async () => (await readFile(path.join(folder, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { folder, audit, store: killSwitchStore(folder) };
}

function print(sequence, timeMs, price = 100) {
  return { sequence, timeMs, price, side: 'sell', quantity: 10 };
}

function frame(trades, publishedMs, connected = true) {
  return {
    version: 1, connected, publishedMs, symbol: 'MNQZ26-CME', replay: false, tickSize: .25,
    last: trades.at(-1)?.price ?? 100, delaySeconds: 0,
    bids: [[100, 2, 1]], asks: [[100.25, 2, 1]], trades,
  };
}

async function paper(t, env = {}) {
  const files = await fixture(t);
  let time = 100000, nextPublication = 0;
  const plugin = paperExecutionPlugin({
    folder: files.folder, now: () => time,
    env: { HFTENGINE_KILL_RESET_TOKEN: token, ...env },
  });
  let handler;
  plugin.configureServer({ middlewares: { use: middleware => { handler = middleware; } } });
  const server = http.createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(route, { action, body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method: action || body ? 'POST' : 'GET',
      headers: { Origin: origin, ...headers, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  const status = async () => (await request(control)).data;
  const activate = () => request(control + '/activate', { action: true });
  const reset = async (override = {}) => request(control + '/reset', {
    action: true, headers: { Authorization: 'Bearer ' + token, 'X-Kill-Switch-Id': (await status()).id, ...override },
  });
  async function authorize() {
    assert.equal((await reset()).status, 200);
  }
  function publish(trades, connected = true) {
    const publication = ++nextPublication;
    const publishedMs = time;
    plugin.observe({ publication, ageMs: 0, bridgeReadMs: time, frame: frame(trades, publishedMs, connected) });
    return { publication, publishedMs };
  }
  function session(strategy = 'queue') {
    const id = randomUUID();
    return async (publication, options = {}) => {
      const result = await request('/api/mnq/paper', { body: {
        session: id, revision: 0, strategy, levels: 3, enabled: true, learning: true, ...publication, ...options,
      } });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data.simulation;
    };
  }
  const close = id => request('/api/mnq/paper/close?session=' + id, { action: true });
  async function beginPaper(body) {
    const observed = new Promise(resolve => server.once('request', resolve));
    const client = http.request(base + '/api/mnq/paper', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    });
    const response = new Promise((resolve, reject) => {
      client.once('error', reject);
      client.once('response', async res => {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    client.write(JSON.stringify(body).slice(0, -1));
    await observed;
    return () => { client.end('}'); return response; };
  }
  return { ...files, status, activate, reset, authorize, publish, session, request, close, beginPaper,
    observe: plugin.observe, setTime: next => { time = next; } };
}

test('manual activation blocks all subsequent submissions in multiple paper sessions', async t => {
  const h = await paper(t);
  await h.authorize();
  const one = h.session(), two = h.session();
  const first = print(1, 100000);
  const publication = h.publish([first]);
  assert.equal((await one(publication)).submits, 2);
  assert.equal((await two(publication)).submits, 2);
  assert.equal((await h.activate()).data.active, true);

  h.setTime(100150);
  const next = h.publish([first, print(2, 100150)]);
  for (const run of [one, two]) {
    const stopped = await run(next);
    assert.equal(stopped.submits, 2);
    assert.equal(stopped.cancels, 2);
    assert.equal(stopped.fillCount, 0);
    assert.equal(open(stopped).length, 0);
    assert.equal(stopped.status, 'blocked');
    const unchanged = await run(next, { revision: 1, enabled: false, strategy: 'liquidity' });
    assert.equal(unchanged.submits, 2);
    assert.equal(unchanged.generation, stopped.generation);
    assert.equal(unchanged.strategy, stopped.strategy);
  }
  assert.equal((await h.audit()).filter(entry => entry.action === 'cancel_confirmed').length, 4);
});

test('the final simulated exchange boundary rejects a strategy order after its evaluation', () => {
  let checks = 0;
  const sim = new ReplaySimulation({
    allowLive: true,
    orderSafety: { allowOrder: () => ++checks === 1, checkRisk() {} },
  });
  sim.accept(frame([print(1, 100000)], 100000), true);
  assert.ok(checks > 1);
  assert.equal(sim.snapshot().orders.length, 0);
  assert.equal(sim.snapshot().submits, 0);
});

test('an executed paper fill can still be acknowledged without a new exit after activation', async t => {
  const h = await paper(t);
  await h.authorize();
  const run = h.session();
  const first = print(1, 100000), fill = print(2, 100150);
  await run(h.publish([first]));
  h.setTime(100150);
  assert.equal((await run(h.publish([first, fill]))).fillCount, 0);
  await h.activate();
  h.setTime(100300);
  const model = await run(h.publish([first, fill, print(3, 100300, 97)]), { revision: 1, enabled: false });
  assert.equal(model.fillCount, 1);
  assert.equal(model.position, 1);
  assert.equal(model.submits, 2);
  assert.equal(open(model).length, 0);
  assert.equal(model.status, 'blocked');
  assert.equal(model.tradeCount, 1);
  assert.equal(model.markPrice, 100);
  assert.equal(model.equity, -.75);
});

test('configured critical loss trips automatically, before any new strategy order', async t => {
  const h = await paper(t, { HFTENGINE_KILL_MAX_LOSS_USD: '0.50' });
  await h.authorize();
  const run = h.session();
  const first = print(1, 100000), fill = print(2, 100150);
  await run(h.publish([first]));
  h.setTime(100150);
  await run(h.publish([first, fill]));
  h.setTime(100300);
  const model = await run(h.publish([first, fill, print(3, 100300, 99)]));
  assert.equal(model.position, 1);
  assert.equal(model.submits, 2);
  assert.equal(open(model).length, 0);
  assert.match((await h.status()).reason, /loss limit/i);
  const activation = (await h.audit()).find(entry => entry.action === 'activated');
  assert.equal(activation.source, 'risk');
  assert.equal(activation.maxLoss, 0.5);
});

test('activation sends requests to the mock execution adapter and audits both outcomes', async t => {
  const { store, audit } = await fixture(t);
  const calls = [];
  const kill = new KillSwitch(store, { resetToken: token, adapters: () => [['test-session', {
    outstandingOrderIds: () => ['open', 'pending'],
    cancelOrder(id) { calls.push(id); return true; },
  }]] });
  allow(kill);
  kill.activate('manual', 'Test stop');
  assert.deepEqual(calls, ['open', 'pending']);
  const canceled = (await audit()).filter(entry => entry.action.startsWith('cancel_'));
  assert.deepEqual(canceled.map(({ action, orderId }) => [action, orderId]), [
    ['cancel_requested', 'open'], ['cancel_confirmed', 'open'],
    ['cancel_requested', 'pending'], ['cancel_confirmed', 'pending'],
  ]);
});

test('adapter failures are reported, audited, and block reset until cancellation succeeds', async t => {
  const { store, audit } = await fixture(t);
  let works = false;
  const kill = new KillSwitch(store, { resetToken: token, adapters: () => [['test-session', {
    outstandingOrderIds: () => ['pending'],
    cancelOrder() { if (!works) throw Error('Simulated adapter timeout'); return true; },
  }]] });
  allow(kill);
  const failure = kill.activate('manual', 'Test stop').cancellationFailures;
  assert.deepEqual(failure, [{ session: 'test-session', orderId: 'pending', error: 'Simulated adapter timeout' }]);
  assert.equal(kill.reset(token, kill.status().id), 409);
  assert.equal((await audit()).find(entry => entry.action === 'cancel_failed').error, failure[0].error);
  works = true;
  assert.equal(kill.activate('risk', 'A second alarm').cancellationFailures.length, 1);
  assert.deepEqual(kill.activate('manual', 'Retry').cancellationFailures, []);
  allow(kill);
});

test('a server restart restores the active state and authorization from a prior boot cannot be reused', async t => {
  const { store, audit } = await fixture(t);
  const initial = new KillSwitch(store, { resetToken: token });
  allow(initial);
  const resumed = new KillSwitch(store, { resetToken: token });
  assert.equal(resumed.status().active, true);
  assert.notEqual(resumed.status().id, initial.status().id);

  const active = resumed.activate('manual', 'Restart persistence test');
  const restarted = new KillSwitch(store, { resetToken: token });
  assert.equal(restarted.status().active, true);
  assert.equal(restarted.status().id, active.id);
  assert.equal(restarted.status().reason, active.reason);
  assert.ok((await audit()).some(entry => entry.action === 'activation_restored' && entry.id === active.id));
});

test('missing tokens, invalid tokens, stale state IDs and foreign origins cannot reset', async t => {
  const h = await paper(t);
  assert.equal((await h.reset({ Authorization: '' })).status, 403);
  assert.equal((await h.reset({ Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await h.reset({ 'X-Kill-Switch-Id': randomUUID() })).status, 409);
  assert.equal((await h.reset({ Origin: 'http://foreign.invalid' })).status, 403);
  assert.equal((await h.status()).active, true);
  const audit = await h.audit();
  assert.equal(audit.filter(event => event.action === 'reset_denied').length, 4);
  assert.ok(audit.some(event => event.action === 'reset_denied' && event.reason === 'Foreign dashboard origin.'));
  assert.ok(!JSON.stringify(audit).includes(token));
});

test('simultaneous HTTP activations create one transition and one cancellation per outstanding order', async t => {
  const h = await paper(t);
  await h.authorize();
  const run = h.session();
  assert.equal((await run(h.publish([print(1, 100000)]))).submits, 2);
  const requests = await Promise.all(Array.from({ length: 12 }, () => h.activate()));
  assert.ok(requests.every(({ status, data }) => status === 200 && data.active && data.id === requests[0].data.id));
  const audit = await h.audit();
  assert.equal(audit.filter(event => event.action === 'activated').length, 1);
  assert.equal(audit.filter(event => event.action === 'activation_requested_while_blocked').length, 11);
  assert.deepEqual(audit.filter(event => event.action === 'cancel_requested').map(event => event.orderId), ['SIM-1', 'SIM-2']);
});

test('a disconnected Sierra feed cannot route even with a cached connected publication', async t => {
  const h = await paper(t, { HFTENGINE_KILL_ON_DISCONNECT: '1' });
  await h.authorize();
  const run = h.session();
  const first = print(1, 100000);
  const connected = h.publish([first]);
  assert.equal((await run(connected)).submits, 2);
  h.setTime(100150);
  const disconnected = h.publish([first, print(2, 100150)], false);
  assert.match((await h.status()).reason, /Sierra feed disconnected/);
  assert.equal((await run(disconnected)).cancels, 2);
  assert.equal((await run(connected, { revision: 1 })).submits, 2);
  assert.equal((await h.reset()).status, 200);
  const stillBlocked = await run(disconnected, { revision: 2 });
  assert.equal(stillBlocked.status, 'blocked');
  assert.equal(stillBlocked.submits, 2);
});

test('invalid or corrupted persisted state starts blocked and records the read failure', async t => {
  const { folder, store, audit } = await fixture(t);
  for (const invalid of ['{torn', '{"version":1,"active":false}', 'null']) {
    await writeFile(path.join(folder, 'state.json'), invalid);
    const kill = new KillSwitch(store, { resetToken: token });
    assert.equal(kill.status().active, true);
    assert.match(kill.status().reason, /unavailable/i);
  }
  assert.equal((await audit()).filter(event => event.action === 'startup_blocked' && event.error).length, 3);
});

test('a failed activation state write leaves current routing and the next boot blocked', async t => {
  const { store, audit } = await fixture(t);
  const flaky = { ...store, save(state) { if (state.active) throw Error('Simulated disk write failure'); store.save(state); } };
  const initial = new KillSwitch(flaky, { resetToken: token });
  allow(initial);
  assert.equal(initial.activate('manual', 'Test stop').active, true);
  assert.match(initial.status().ioError, /write failed/);
  assert.equal(new KillSwitch(store, { resetToken: token }).status().active, true);
  assert.ok((await audit()).some(entry => entry.action === 'state_write_failed'));
});

test('with authorization, paper submissions, acknowledgments and fills continue normally', async t => {
  const h = await paper(t);
  await h.authorize();
  const run = h.session();
  const first = print(1, 100000);
  assert.equal((await run(h.publish([first]))).submits, 2);
  h.setTime(100300);
  const model = await run(h.publish([first, print(2, 100100), print(3, 100250)]));
  assert.ok(model.events.some(event => event.kind === 2));
  assert.equal(model.fillCount, 1);
  assert.equal(model.position, 1);
  assert.equal((await h.status()).active, false);
});

test('an older request within the feed cache cannot rewind paper inventory or reset its risk data', async t => {
  const h = await paper(t);
  await h.authorize();
  const run = h.session();
  const first = print(1, 100000);
  const older = h.publish([first]);
  await run(older);
  h.setTime(100300);
  const current = h.publish([first, print(2, 100100), print(3, 100250)]);
  const filled = await run(current);
  assert.equal(filled.position, 1);
  assert.equal(filled.fillCount, 1);
  assert.deepEqual(await run(older), filled);
});


function paperBody(id, publication, options) {
  return { session: id, revision: 0, strategy: 'queue', levels: 3,
    enabled: true, learning: true, ...publication, ...options };
}

test('closing a paper session audits cancellation and rejects a request already in flight', async t => {
  const h = await paper(t);
  await h.authorize();
  const id = randomUUID();
  const first = print(1, 100000);
  const initial = await h.request('/api/mnq/paper', { body: paperBody(id, h.publish([first])) });
  assert.equal(open(initial.data.simulation).length, 2);
  h.setTime(100150);
  const finish = await h.beginPaper(paperBody(id, h.publish([first, print(2, 100150)])));
  assert.equal((await h.close(id)).status, 200);
  assert.equal((await finish()).status, 410);
  await h.activate();

  const audit = await h.audit();
  const canceled = audit.filter(e => e.action === 'cancel_confirmed' && e.session === id);
  assert.deepEqual(canceled.map(e => [e.orderId, e.trigger]), [
    ['SIM-1', 'session_close'], ['SIM-2', 'session_close'],
  ]);
  assert.ok(audit.some(e => e.action === 'paper_session_retired' && e.session === id));
});

test('closing a failed-cancellation session reconciles it only after its simulated exchange is retired', async t => {
  const h = await paper(t);
  await h.authorize();
  const id = randomUUID();
  const first = print(1, 100000);
  const publication = h.publish([first]);
  const originalCancel = ReplaySimulation.prototype.cancelOrder;
  let adapter;
  t.mock.method(ReplaySimulation.prototype, 'cancelOrder', function (orderId) {
    if (orderId === 'SIM-1') {
      adapter = this;
      throw Error('Fixture cancel failure');
    }
    return originalCancel.call(this, orderId);
  });

  const initial = await h.request('/api/mnq/paper', { body: paperBody(id, publication) });
  assert.equal(open(initial.data.simulation).length, 2);
  assert.deepEqual((await h.activate()).data.cancellationFailures.map(failure => failure.orderId), ['SIM-1']);
  assert.equal((await h.reset()).status, 409);
  h.setTime(100250);
  const blocked = await h.request('/api/mnq/paper', { body: paperBody(id, h.publish([first, print(2, 100250)])) });
  assert.equal(blocked.data.simulation.orders.find(order => order.id === 'SIM-1').state, 'pending');
  assert.equal(blocked.data.simulation.fillCount, 0);
  assert.equal((await h.close(id)).status, 200);
  assert.deepEqual(adapter.outstandingOrderIds(), []);
  assert.deepEqual((await h.status()).cancellationFailures, []);
  assert.equal((await h.reset()).status, 200);
  adapter.accept(frame([print(2, 100250)], 100250), true);
  assert.equal(adapter.snapshot().submits, 0);
  assert.equal(adapter.snapshot().fillCount, 0);
  const retirement = (await h.audit()).find(e => e.action === 'paper_session_retired' && e.session === id);
  assert.deepEqual(retirement.reconciledFailures.map(failure => failure.orderId), ['SIM-1']);
});

test('a paper request received before the stop settles only executed activity after the stop', async t => {
  const h = await paper(t);
  await h.authorize();
  const id = randomUUID();
  const first = print(1, 100000);
  const initial = await h.request('/api/mnq/paper', { body: paperBody(id, h.publish([first])) });
  assert.equal(initial.data.simulation.submits, 2);

  h.setTime(100200);
  const finish = await h.beginPaper(paperBody(id, h.publish([first, print(2, 100200, 99)])));
  await h.activate();
  const response = await finish();
  assert.equal(response.status, 200);
  const model = response.data.simulation;
  assert.equal(model.status, 'blocked');
  assert.equal(model.submits, 2);
  assert.equal(model.fillCount, 0);
  assert.equal(model.tradeCount, 0);
  assert.equal(open(model).length, 0);
});

test('invalid or unreadable Sierra data latches a configured stop immediately after a fresh feed', async t => {
  const h = await paper(t, { HFTENGINE_KILL_ON_DISCONNECT: '1' });
  await h.authorize();
  const run = h.session();
  const first = print(1, 100000);
  assert.equal((await run(h.publish([first]))).submits, 2);

  h.observe({ publication: 2, ageMs: 0, bridgeReadMs: 100100, frame: { version: 999 } });
  assert.match((await h.status()).reason, /invalid/);
  assert.equal((await run()).status, 'blocked');
  const failedFeed = (await h.audit()).find(e => e.action === 'activated');
  assert.equal(failedFeed.source, 'risk');

  await h.authorize();
  h.setTime(100200);
  await run(h.publish([print(2, 100200)]));
  h.observe(null);
  assert.equal((await h.status()).active, true);
});

test('the last dashboard listener closing does not trip the Sierra feed-loss latch', async t => {
  const h = await paper(t, { HFTENGINE_KILL_ON_DISCONNECT: '1' });
  await h.authorize();
  const run = h.session();
  const first = print(1, 100000);
  assert.equal((await run(h.publish([first]))).submits, 2);
  h.observe(null, 'idle');
  assert.equal((await h.status()).active, false);
  assert.equal(open(await run()).length, 0);
});

test('an interrupted state-write temporary file cannot authorize a restart', async t => {
  const { folder, store } = await fixture(t);
  const first = new KillSwitch(store, { resetToken: token });
  allow(first);
  const interrupted = first.status();
  const stop = first.activate('manual', 'Authoritative stop');
  await writeFile(path.join(folder, randomUUID() + '.tmp'), JSON.stringify(interrupted));
  const restarted = new KillSwitch(store, { resetToken: token });
  assert.equal(restarted.status().active, true);
  assert.equal(restarted.status().id, stop.id);
});


test('pre-reset requests and cached publications cannot place orders under a new authorization', async t => {
  const h = await paper(t);
  await h.authorize();
  const id = randomUUID();
  const first = print(1, 100000);
  const old = h.publish([first]);
  const finish = await h.beginPaper(paperBody(id, old));
  await h.activate();
  await h.authorize();
  assert.equal((await finish()).status, 409);
  const run = h.session();
  assert.equal((await run(old)).submits, 0);
  h.setTime(100250);
  assert.equal((await run(h.publish([first, print(2, 100250)]))).submits, 2);
});

test('invalid accounting and excess exposure trip the hard risk gate without a loss configuration', async t => {
  const { store, audit } = await fixture(t);
  const kill = new KillSwitch(store, { resetToken: token });
  allow(kill);
  kill.checkRisk('paper-demo', 0, NaN, 1);
  assert.match(kill.status().reason, /accounting violation/);
  allow(kill);
  kill.checkRisk('paper-demo', -2, 0, 1);
  assert.match(kill.status().reason, /exposure/);
  assert.equal((await audit()).filter(event => event.action === 'activated' && event.source === 'risk').length, 2);
});

