import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite store: rolling probe samples + incident log.
 *
 * samples: one row per probe observation.
 *   metric  - series name (rpc_public, block_height, feed, ...)
 *   t       - epoch ms
 *   ok      - 1 healthy / 0 failed (drives uptime bars)
 *   value   - the metric's headline number (latency ms, height, lag, ...)
 *   meta    - JSON blob with the full observation
 */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      metric TEXT NOT NULL,
      t INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      value REAL,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_samples_metric_t ON samples(metric, t);
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT NOT NULL,
      severity TEXT NOT NULL,
      reason TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_component ON incidents(component, started_at);
  `);
  return db;
}

export function makeStore(db) {
  const insertSample = db.prepare(
    'INSERT INTO samples (metric, t, ok, value, meta) VALUES (?, ?, ?, ?, ?)'
  );
  const openIncident = db.prepare(
    'INSERT INTO incidents (component, severity, reason, started_at) VALUES (?, ?, ?, ?)'
  );
  const closeIncident = db.prepare(
    'UPDATE incidents SET ended_at = ? WHERE component = ? AND ended_at IS NULL'
  );
  const updateSeverity = db.prepare(
    "UPDATE incidents SET severity = ?, reason = COALESCE(reason, '') || ? WHERE component = ? AND ended_at IS NULL"
  );
  const openIncidents = db.prepare(
    'SELECT * FROM incidents WHERE ended_at IS NULL ORDER BY started_at DESC'
  );
  const recentIncidents = db.prepare(
    'SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?'
  );
  const latestSample = db.prepare(
    'SELECT * FROM samples WHERE metric = ? ORDER BY t DESC LIMIT 1'
  );
  const recentSamples = db.prepare(
    'SELECT * FROM samples WHERE metric = ? AND t >= ? ORDER BY t ASC'
  );
  const pruneSamples = db.prepare('DELETE FROM samples WHERE t < ?');
  const pruneIncidents = db.prepare(
    'DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?'
  );
  const countSamples = db.prepare('SELECT COUNT(*) AS n FROM samples');

  const dailyUptime = db.prepare(`
    SELECT date(t / 1000, 'unixepoch') AS day, AVG(ok) AS ok_ratio, COUNT(*) AS n
    FROM samples WHERE metric = ? AND t >= ?
    GROUP BY day ORDER BY day ASC
  `);

  const bucketed = db.prepare(`
    SELECT CAST(t / ? AS INTEGER) * ? AS bt,
           COUNT(*) AS n,
           AVG(ok) AS ok_ratio,
           AVG(CASE WHEN ok = 1 THEN value END) AS avg_value,
           MIN(CASE WHEN ok = 1 THEN value END) AS min_value,
           MAX(CASE WHEN ok = 1 THEN value END) AS max_value
    FROM samples WHERE metric = ? AND t >= ?
    GROUP BY bt ORDER BY bt ASC
  `);

  return {
    addSample(metric, t, ok, value, meta) {
      insertSample.run(metric, t, ok ? 1 : 0, value, meta ? JSON.stringify(meta) : null);
    },
    latestSample: (metric) => latestSample.get(metric) ?? null,
    recentSamples: (metric, sinceMs) => recentSamples.all(metric, sinceMs),
    openIncident: (component, severity, reason, t) =>
      openIncident.run(component, severity, reason ?? null, t),
    closeIncident: (component, t) => closeIncident.run(t, component),
    escalateIncident: (component, severity, reason, t) =>
      updateSeverity.run(
        severity,
        ` | ${new Date(t).toISOString()}: ${severity}: ${reason ?? ''}`,
        component
      ),
    getOpenIncidents: () => openIncidents.all(),
    getRecentIncidents: (limit = 50) => recentIncidents.all(limit),
    dailyUptime: (metric, sinceMs) => dailyUptime.all(metric, sinceMs),
    history: (metric, sinceMs, bucketMs) => bucketed.all(bucketMs, bucketMs, metric, sinceMs),
    prune(retentionDays, incidentRetentionDays, now = Date.now()) {
      pruneSamples.run(now - retentionDays * 86_400_000);
      pruneIncidents.run(now - incidentRetentionDays * 86_400_000);
    },
    sampleCount: () => countSamples.get().n,
  };
}
