import path from 'node:path';
import { DeepModel } from '../src/deep-model.ts';
import { validateLiveFrame } from '../src/live-frame.ts';
import { ReplaySimulation } from '../src/replay-simulation.ts';
import { KillSwitch, killSwitchRisk, killSwitchStore } from './kill-switch.mjs';
import { engineRoot } from './project-paths.mjs';

const feedMaxAgeMs = 5000;
const sessionTimeoutMs = 120000;
const maxSessions = 32;
const maxPublications = 32;
const sessionIdPattern = /^[a-f0-9-]{36}$/i;

function fresh(publication, time) {
  return Boolean(publication?.frame.connected
    && time - publication.frame.publishedMs <= feedMaxAgeMs
    && time - publication.bridgeReadMs + publication.ageMs <= feedMaxAgeMs);
}

function profile(raw) {
  if (!raw || !Array.isArray(raw.outcomes)) return {};
  return {
    outcomes: raw.outcomes.filter(Number.isFinite).slice(-100),
    riskLevel: Number.isFinite(raw.riskLevel) ? raw.riskLevel : 0,
    reviewsSince: Number.isFinite(raw.reviewsSince) ? raw.reviewsSince : 0,
  };
}

export function paperExecutionPlugin({
  folder = path.join(engineRoot, 'data', 'kill-switch'),
  env = process.env, now = Date.now, deepState,
} = {}) {
  const sessions = new Map();
  const retiredSessions = new Map();
  const publications = new Map();
  const model = new DeepModel();
  let latest = null;
  let hadFreshFeed = false;
  let authorizedAfterPublication = 0;
  const kill = new KillSwitch(killSwitchStore(folder), {
    resetToken: env.HFTENGINE_KILL_RESET_TOKEN,
    risk: killSwitchRisk(env),
    adapters: () => Array.from(sessions, ([id, session]) => [id, session.sim]),
    onActivated: () => {
      for (const session of sessions.values()) {
        session.sim.block();
        session.suspended = true;
      }
    },
  });

  function suspend(session) {
    if (session.suspended) return;
    session.sim.suspend();
    session.suspended = true;
  }

  function checkFeed(time) {
    if (fresh(latest, time)) return true;
    if (hadFreshFeed) kill.feedLost();
    for (const session of sessions.values()) {
      if (!kill.blocked) suspend(session);
    }
    return false;
  }

  function observe(publication, event) {
    // Losing the last dashboard listener is not a Sierra disconnection.
    if (event === 'idle') hadFreshFeed = false;
    if (publication !== undefined) {
      try {
        latest = publication ? { ...publication, frame: validateLiveFrame(publication.frame) } : null;
      } catch {
        latest = null;
      }
      if (latest && fresh(latest, now())) {
        hadFreshFeed = true;
        publications.set(latest.publication, latest);
        if (publications.size > maxPublications) publications.delete(publications.keys().next().value);
      } else {
        publications.clear();
      }
    }
    checkFeed(now());
  }

  function pruneRetiredSessions(time) {
    for (const [id, expires] of retiredSessions) {
      if (expires <= time) retiredSessions.delete(id);
    }
  }

  function retireSession(id, time, reason) {
    pruneRetiredSessions(time);
    // Every publication a pre-close request can reference expires within this window.
    retiredSessions.set(id, time + feedMaxAgeMs);
    const session = sessions.get(id);
    if (!session) return;
    // Detach before auditing, since audit failure can activate the global switch.
    sessions.delete(id);
    kill.retirePaperSession(id, session.sim, reason);
  }

  function execute(body, requestStateId) {
    if (!body || typeof body.session !== 'string' || !sessionIdPattern.test(body.session)
      || !Number.isSafeInteger(body.revision) || body.revision < 0
      || !['queue', 'liquidity'].includes(body.strategy) || ![1, 3, 5].includes(body.levels)
      || typeof body.enabled !== 'boolean' || typeof body.learning !== 'boolean') {
      return { status: 400, value: { error: 'Invalid paper session request.' } };
    }
    const time = now();
    const feedReady = checkFeed(time);
    if (!kill.blocked && requestStateId !== kill.stateId) {
      return { status: 409, value: { error: 'Paper request predates routing authorization.' } };
    }
    const id = body.session;
    pruneRetiredSessions(time);
    if (retiredSessions.has(id)) return { status: 410, value: { error: 'Paper session closed.' } };
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= maxSessions) {
        const expired = [...sessions].find(([, candidate]) => time - candidate.seen > sessionTimeoutMs);
        if (!expired) return { status: 503, value: { error: 'Too many paper sessions.' } };
        retireSession(expired[0], time, 'idle_eviction');
      }
      const sim = new ReplaySimulation({
        allowLive: true, strategy: body.strategy, levels: body.levels, latency: 'variable', adaptive: true,
        orderSafety: {
          allowOrder: () => !kill.blocked && fresh(latest, now()),
          checkRisk: (position, equity, limit) => kill.checkRisk(id, position, equity, limit),
        },
      });
      if (deepState) sim.setPredictor((signal, timeMs) => model.predict(signal, timeMs));
      sim.restoreLearning(profile(body.profile));
      session = { sim, revision: body.revision, strategy: body.strategy, levels: body.levels,
        seen: time, suspended: true, lastPublication: 0 };
      sessions.set(id, session);
    }
    session.seen = time;
    if (Number.isSafeInteger(body.publication) && body.publication < session.lastPublication) {
      return { status: 200, value: { simulation: session.sim.snapshot() } };
    }
    const cached = publications.get(body.publication);
    const publication = feedReady && cached?.frame.publishedMs === body.publishedMs
      && fresh(cached, time) ? cached : undefined;
    if (kill.blocked) {
      session.sim.settleWhileBlocked(publication?.frame);
      if (publication) session.lastPublication = publication.publication;
      session.suspended = true;
      return { status: 200, value: { simulation: session.sim.snapshot() } };
    }
    if (body.revision < session.revision) return { status: 409, value: { error: 'Paper session request superseded.' } };
    if (body.revision > session.revision) {
      if (body.strategy !== session.strategy || body.levels !== session.levels) {
        session.sim.configure({ strategy: body.strategy, levels: body.levels });
      } else session.sim.reset();
      session.revision = body.revision;
      session.strategy = body.strategy;
      session.levels = body.levels;
    }
    session.sim.setLearning(body.learning);
    if (publication && publication.publication > authorizedAfterPublication) {
      if (deepState) model.state = deepState();
      session.sim.accept(publication.frame, body.enabled);
      session.lastPublication = publication.publication;
      session.suspended = kill.blocked;
    } else suspend(session);
    return { status: 200, value: { simulation: session.sim.snapshot() } };
  }

  return {
    name: 'paper-execution',
    observe,
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const control = '/api/mnq/kill-switch';
        const paper = '/api/mnq/paper';
        if (![control, control + '/activate', control + '/reset', paper, paper + '/close'].includes(pathname)) return next();
        const send = (status, value) => {
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(value));
        };
        if (pathname === control) {
          return req.method === 'GET' ? send(200, kill.status()) : send(405, { error: 'Use GET.' });
        }
        if (req.method !== 'POST') return send(405, { error: 'Use POST.' });
        if (req.headers.origin !== (env.HFTENGINE_DASHBOARD_ORIGIN || 'http://127.0.0.1:5180')) {
          if (pathname === control + '/reset') kill.denyReset('Foreign dashboard origin.');
          return send(403, { error: 'Use the local HFTENGINE dashboard.' });
        }
        if (pathname === control + '/activate') {
          return send(200, kill.activate('manual', 'Operator requested emergency stop.'));
        }
        if (pathname === control + '/reset') {
          const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
          const status = kill.reset(bearer, req.headers['x-kill-switch-id']);
          if (status === 200) authorizedAfterPublication = latest?.publication ?? 0;
          return send(status, kill.status());
        }
        if (pathname === paper + '/close') {
          const id = url.searchParams.get('session');
          if (!id || !sessionIdPattern.test(id)) return send(400, { error: 'Invalid paper session ID.' });
          retireSession(id, now(), 'session_close');
          return send(200, { closed: true });
        }
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return send(415, { error: 'Use JSON for paper session requests.' });
        }
        try {
          const requestStateId = kill.stateId;
          const chunks = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 16000) return send(413, { error: 'Paper session request too large.' });
            chunks.push(chunk);
          }
          const result = execute(JSON.parse(Buffer.concat(chunks).toString('utf8')), requestStateId);
          return send(result.status, result.value);
        } catch (error) {
          return send(error instanceof SyntaxError ? 400 : 503, { error: 'Paper execution unavailable.' });
        }
      });
    },
  };
}
