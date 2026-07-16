import { config, CHAINLINK_FEEDS } from './config.js';
import { openDb, makeStore } from './db.js';
import { FeedWatcher } from './feed.js';
import { runProbeCycle } from './probes.js';
import { createStatusServer } from './server.js';
import '../../docs/assets/status-core.js';

const { COMPONENTS, IncidentMachine, evaluators, clampSeverity, THRESHOLDS } =
  globalThis.StatusCore;

const startedAt = Date.now();
const db = openDb(config.dbPath);
const store = makeStore(db);

const cfg = { ...config, chainlinkFeeds: CHAINLINK_FEEDS };

// Resume published state from any incidents that were open when the worker
// last stopped, so a restart does not silently close them.
const machines = {};
const published = {};
const openByComponent = new Map(store.getOpenIncidents().map((i) => [i.component, i]));
for (const c of COMPONENTS) {
  const open = openByComponent.get(c.id);
  machines[c.id] = new IncidentMachine({ published: open ? open.severity : 'operational' });
  published[c.id] = open ? open.severity : 'unknown';
}

const feedWatcher = new FeedWatcher(config.feedUrl);
feedWatcher.start();

const state = {}; // cross-cycle probe memory (previous head, latency windows)
const latest = { reasons: {}, componentMetrics: {} };
let lastChainlinkAt = 0;
let cycleRunning = false;

async function cycle() {
  if (cycleRunning) return; // never overlap slow cycles
  cycleRunning = true;
  try {
    const includeChainlink = Date.now() - lastChainlinkAt >= config.chainlinkIntervalMs;
    const { observations, samples, now } = await runProbeCycle({
      config: cfg,
      feedWatcher,
      state,
      includeChainlink,
    });
    if (includeChainlink && observations.chainlink !== undefined) lastChainlinkAt = now;

    for (const s of samples) store.addSample(...s);

    for (const c of COMPONENTS) {
      if (c.optional && !(c.id === 'rpc_alchemy' && config.alchemyUrl)) continue;
      const obsKey = c.id === 'rpc_public' ? 'rpc_public' : c.id === 'rpc_alchemy' ? 'rpc_alchemy' : c.evaluator;
      let obs = observations[obsKey];
      if (c.evaluator === 'chainlink' && obs === undefined) {
        // Between 5-minute samples, re-evaluate the last stored observation
        // with a fresh clock so ages keep counting.
        const row = store.latestSample('chainlink');
        if (row) {
          const meta = row.meta ? JSON.parse(row.meta) : {};
          obs = row.ok
            ? {
                ok: true,
                maxAgeSec: (row.value ?? 0) + (now - row.t) / 1000,
                marketOpen: meta.marketOpen ?? false,
                staleFeeds: [],
                feeds: meta.feeds,
              }
            : { ok: false, maxAgeSec: null, marketOpen: meta.marketOpen ?? false };
        }
      }
      const evaluate = evaluators[c.evaluator];
      let { status, reason } = evaluate(obs);
      status = clampSeverity(status, THRESHOLDS[thresholdKey(c.evaluator)]?.maxSeverity);
      const { published: pub, event } = machines[c.id].step(status, reason, now);
      published[c.id] = pub;
      latest.reasons[c.id] = pub === 'operational' ? null : reason;
      latest.componentMetrics[c.id] = componentMetrics(c.id, obs, observations);

      if (event?.type === 'open') store.openIncident(c.id, event.severity, event.reason, event.t);
      else if (event?.type === 'close') store.closeIncident(c.id, event.t);
      else if (event?.type === 'severity')
        store.escalateIncident(c.id, event.severity, event.reason, event.t);
    }
    latest.componentMetrics.gas = observations.gas ?? latest.componentMetrics.gas ?? null;
  } catch (err) {
    console.error(`[cycle] ${err.stack || err.message}`);
  } finally {
    cycleRunning = false;
  }
}

function thresholdKey(evaluator) {
  return evaluator === 'blockscout' || evaluator === 'chainlink' ? evaluator : null;
}

function componentMetrics(id, obs, observations) {
  if (!obs) return null;
  switch (id) {
    case 'rpc_public':
    case 'rpc_alchemy':
      return { latencyMs: round(obs.latencyMs), block: obs.block ?? null };
    case 'blocks':
      return {
        height: obs.height ?? null,
        headAgeSec: round(obs.headAgeSec),
        blocksPerMin: round(obs.blocksPerMin),
      };
    case 'feed':
      return {
        connected: obs.connected,
        messagesPerMin: obs.messagesPerMin ?? null,
        lagBlocks: obs.lagBlocks ?? null,
      };
    case 'settlement':
      return obs.ok
        ? { lagL1Blocks: obs.lagL1Blocks, chainL1View: obs.chainL1View, l1Head: obs.l1Head }
        : null;
    case 'blockscout':
      return { latencyMs: round(obs.latencyMs) };
    case 'chainlink':
      return {
        marketOpen: obs.marketOpen ?? null,
        maxAgeSec: round(obs.maxAgeSec),
        feeds: (obs.feeds ?? [])
          .filter((f) => f.ok)
          .map((f) => ({ symbol: f.symbol, price: f.price, ageSec: Math.round(f.ageSec) })),
      };
    default:
      return null;
  }
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// --- boot ---
cycle();
const probeTimer = setInterval(cycle, config.probeIntervalMs);
const pruneTimer = setInterval(
  () => store.prune(config.retentionDays, config.incidentRetentionDays),
  3_600_000
);

const server = createStatusServer({ store, published, latest, startedAt, config: cfg });
server.listen(config.port, () => {
  console.log(
    `[hood-status] worker up on :${config.port} | rpc=${config.rpcUrl} | db=${config.dbPath} | interval=${config.probeIntervalMs}ms`
  );
});

function shutdown(signal) {
  console.log(`[hood-status] ${signal} received, shutting down`);
  clearInterval(probeTimer);
  clearInterval(pruneTimer);
  feedWatcher.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Do not hang forever if a request is stuck.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
