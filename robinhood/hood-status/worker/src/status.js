import '../../docs/assets/status-core.js';

const { COMPONENTS, STATUS_LABELS, worstStatus } = globalThis.StatusCore;

/** Windows accepted by /api/history and their bucket sizes. */
export const HISTORY_WINDOWS = {
  '1h': { spanMs: 3_600_000, bucketMs: 60_000 },
  '6h': { spanMs: 21_600_000, bucketMs: 300_000 },
  '24h': { spanMs: 86_400_000, bucketMs: 900_000 },
  '7d': { spanMs: 604_800_000, bucketMs: 7_200_000 },
  '90d': { spanMs: 7_776_000_000, bucketMs: 86_400_000 },
};

export const HISTORY_METRICS = [
  'rpc_public',
  'rpc_alchemy',
  'block_height',
  'blocks_per_min',
  'feed',
  'settlement_lag',
  'blockscout',
  'gas_basefee',
  'chainlink',
];

/**
 * Assemble the full /api/status payload from the store, the incident
 * machines' published statuses, and the latest in-memory observations.
 */
export function buildStatus({ store, published, latest, startedAt, config, now = Date.now() }) {
  const since90d = now - 90 * 86_400_000;
  const activeComponents = COMPONENTS.filter(
    (c) => !c.optional || (c.id === 'rpc_alchemy' && config.alchemyUrl)
  );

  const components = activeComponents.map((c) => {
    const days = store.dailyUptime(c.metric, since90d);
    const byDay = new Map(days.map((d) => [d.day, d]));
    const uptime90d = [];
    let okSum = 0;
    let okDays = 0;
    for (let i = 89; i >= 0; i--) {
      const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      const row = byDay.get(day);
      uptime90d.push({
        date: day,
        uptime: row ? Math.round(row.ok_ratio * 10_000) / 100 : null,
        samples: row ? row.n : 0,
      });
      if (row) {
        okSum += row.ok_ratio;
        okDays += 1;
      }
    }
    return {
      id: c.id,
      name: c.name,
      status: published[c.id] ?? 'unknown',
      reason: latest.reasons?.[c.id] ?? null,
      metrics: latest.componentMetrics?.[c.id] ?? null,
      uptimePct90d: okDays ? Math.round((okSum / okDays) * 10_000) / 100 : null,
      uptime90d,
    };
  });

  const overall = worstStatus(components.map((c) => c.status));

  const shape = (i) => ({
    id: i.id,
    component: i.component,
    severity: i.severity,
    reason: i.reason,
    startedAt: i.started_at,
    endedAt: i.ended_at,
  });

  return {
    generatedAt: now,
    chain: { id: config.chainId, name: 'Robinhood Chain' },
    overall: { status: overall, label: STATUS_LABELS[overall] },
    components,
    gas: latest.componentMetrics?.gas ?? null,
    incidents: {
      open: store.getOpenIncidents().map(shape),
      recent: store.getRecentIncidents(50).map(shape),
    },
    meta: {
      probeIntervalMs: config.probeIntervalMs,
      workerStartedAt: startedAt,
      samplesCollected: store.sampleCount(),
      retentionDays: config.retentionDays,
      source: 'worker',
    },
  };
}

/** /api/history handler logic. */
export function buildHistory({ store, metric, window, now = Date.now() }) {
  if (!HISTORY_METRICS.includes(metric)) {
    return { error: `unknown metric "${metric}"`, metrics: HISTORY_METRICS };
  }
  const win = HISTORY_WINDOWS[window];
  if (!win) {
    return { error: `unknown window "${window}"`, windows: Object.keys(HISTORY_WINDOWS) };
  }
  const rows = store.history(metric, now - win.spanMs, win.bucketMs);
  return {
    metric,
    window,
    bucketMs: win.bucketMs,
    buckets: rows.map((r) => ({
      t: r.bt,
      samples: r.n,
      okRatio: r.ok_ratio === null ? null : Math.round(r.ok_ratio * 1000) / 1000,
      avg: r.avg_value === null ? null : Math.round(r.avg_value * 100) / 100,
      min: r.min_value === null ? null : Math.round(r.min_value * 100) / 100,
      max: r.max_value === null ? null : Math.round(r.max_value * 100) / 100,
    })),
  };
}
