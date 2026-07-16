import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, makeStore } from '../worker/src/db.js';
import { buildHistory, buildStatus, HISTORY_WINDOWS } from '../worker/src/status.js';

const NOW = 1_784_154_000_000;

function freshStore() {
  return makeStore(openDb(':memory:'));
}

describe('store', () => {
  let store;
  beforeEach(() => {
    store = freshStore();
  });

  it('round-trips samples and computes daily uptime', () => {
    for (let i = 0; i < 10; i++) {
      store.addSample('rpc_public', NOW - i * 30_000, i % 5 !== 0, 120 + i, { block: i });
    }
    const days = store.dailyUptime('rpc_public', NOW - 86_400_000);
    expect(days.length).toBe(1);
    expect(days[0].n).toBe(10);
    expect(days[0].ok_ratio).toBeCloseTo(0.8);
  });

  it('incident lifecycle: open, escalate, close', () => {
    store.openIncident('feed', 'degraded', 'lagging', NOW);
    expect(store.getOpenIncidents()).toHaveLength(1);
    store.escalateIncident('feed', 'down', 'disconnected', NOW + 60_000);
    const open = store.getOpenIncidents()[0];
    expect(open.severity).toBe('down');
    expect(open.reason).toContain('disconnected');
    store.closeIncident('feed', NOW + 120_000);
    expect(store.getOpenIncidents()).toHaveLength(0);
    const recent = store.getRecentIncidents();
    expect(recent[0].ended_at).toBe(NOW + 120_000);
  });

  it('prunes samples beyond retention', () => {
    store.addSample('rpc_public', NOW - 91 * 86_400_000, true, 100, null);
    store.addSample('rpc_public', NOW - 100_000, true, 100, null);
    store.prune(90, 180, NOW);
    expect(store.sampleCount()).toBe(1);
  });
});

describe('buildHistory', () => {
  it('buckets samples with ok ratio and min/avg/max', () => {
    const store = freshStore();
    const base = NOW - 10 * 60_000;
    for (let i = 0; i < 20; i++) {
      store.addSample('rpc_public', base + i * 30_000, i !== 3, 100 + i * 10, null);
    }
    const h = buildHistory({ store, metric: 'rpc_public', window: '1h', now: NOW });
    expect(h.buckets.length).toBeGreaterThan(5);
    const total = h.buckets.reduce((n, b) => n + b.samples, 0);
    expect(total).toBe(20);
    const failing = h.buckets.find((b) => b.okRatio < 1);
    expect(failing).toBeTruthy();
    expect(failing.avg).toBeGreaterThan(0);
    // failed samples' values are excluded from latency stats
    expect(failing.min).not.toBe(130);
  });

  it('rejects unknown metrics and windows with usable errors', () => {
    const store = freshStore();
    expect(buildHistory({ store, metric: 'nope', window: '1h' }).error).toMatch(/unknown metric/);
    const bad = buildHistory({ store, metric: 'rpc_public', window: '3y' });
    expect(bad.error).toMatch(/unknown window/);
    expect(bad.windows).toEqual(Object.keys(HISTORY_WINDOWS));
  });
});

describe('buildStatus', () => {
  it('assembles components, overall, incidents and 90-day bars', () => {
    const store = freshStore();
    for (let i = 0; i < 5; i++) {
      store.addSample('rpc_public', NOW - i * 30_000, true, 100, null);
      store.addSample('block_height', NOW - i * 30_000, true, 1000 + i, null);
    }
    store.openIncident('feed', 'down', 'disconnected', NOW - 60_000);
    const status = buildStatus({
      store,
      published: { rpc_public: 'operational', blocks: 'operational', feed: 'down' },
      latest: { reasons: { feed: 'disconnected' }, componentMetrics: {} },
      startedAt: NOW - 600_000,
      config: { chainId: 4663, probeIntervalMs: 30_000, retentionDays: 90, alchemyUrl: null },
      now: NOW,
    });
    expect(status.overall.status).toBe('down');
    // alchemy hidden without a key
    expect(status.components.find((c) => c.id === 'rpc_alchemy')).toBeUndefined();
    const rpc = status.components.find((c) => c.id === 'rpc_public');
    expect(rpc.uptime90d).toHaveLength(90);
    expect(rpc.uptime90d.at(-1).uptime).toBe(100);
    expect(rpc.uptime90d[0].uptime).toBeNull(); // honest: no data, not green
    expect(status.incidents.open).toHaveLength(1);
    expect(status.incidents.open[0].component).toBe('feed');
    // components with no samples yet publish unknown
    const settlement = status.components.find((c) => c.id === 'settlement');
    expect(settlement.status).toBe('unknown');
  });
});
