// api/_lib/x402/pipelines/service-uptime-monitor.js
//
// External x402 Service Uptime Monitor — autonomous pipeline (self/038).
//
// Every external x402 service we depend on lives in our discovery registry: the
// live, priced resources the Bazaar Discovery Warmup (self/008) snapshots into
// x402_bazaar_catalog, plus any directly-registered EXTERNAL_ENDPOINTS in
// autonomous-registry.js. Production pipelines pay those endpoints. If one goes
// dark, a paying pipeline wastes a tick (and risks a half-settled payment) on a
// dead URL. This monitor is the liveness gate in front of all of them.
//
// On each run it:
//   1. Collects every distinct EXTERNAL service URL from x402_bazaar_catalog
//      (latest snapshot per category) ∪ the registry's EXTERNAL_ENDPOINTS,
//      excluding our own three.ws origin.
//   2. Probes each with a cheap, unpaid HEAD request — falling back to OPTIONS
//      then GET when a server rejects HEAD (405/501). A live x402 endpoint
//      answers 402 (payment required); a reachable free/redirect endpoint answers
//      2xx/3xx. 5xx or a network timeout means the service is DOWN. Because the
//      probe never sends an X-PAYMENT header, reading a 402 challenge is free —
//      this pipeline moves no funds (amountAtomic is always 0).
//   3. Upserts each verdict into x402_service_uptime keyed by the service URL,
//      tracking consecutive_failures, total_probes/total_failures and
//      last_seen_live so a transient blip is distinguishable from a hard outage.
//   4. Records one x402_autonomous_log row per probe (value_extracted = the
//      verdict) and returns an aggregate summary the loop records too.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js
// (`external-service-uptime-monitor`). The per-tick loop
// (api/cron/x402-autonomous-loop.js) hands run() { origin, redis, sql, log,
// runId }; called standalone (manual test) it derives its own origin/sql.
//
// Value extracted & where it lands:
//   • x402_service_uptime — one row per external service. Columns:
//       alive                → up (402 / 2xx / 3xx) vs down (5xx / unreachable)
//       classification       → live_paywall | live_free | reachable_unexpected
//                              | server_error | unreachable
//       last_status          → HTTP status of the last probe (null on timeout)
//       last_probe_method    → HEAD | OPTIONS | GET (which method got the verdict)
//       latency_ms           → probe round-trip
//       consecutive_failures → consecutive down probes (0 once it answers again)
//       last_seen_live       → last time it was up — the recovery anchor
//   • Redis x402:service-uptime:dead   — JSON list of currently-down services for
//     a cheap, DB-free gate read.
//   • Redis x402:service-uptime:latest — the newest run summary.
//
// Downstream consumer: any pipeline that pays an EXTERNAL endpoint calls
// isServiceLive(sql, url) before settling so a confirmed-dead service is skipped
// instead of burning a tick (and the loop's daily cap) on a URL that will never
// answer 402. listServiceUptime() backs an ops reliability surface.

import { randomUUID } from 'node:crypto';

import { fetchWithTimeout } from '../pay.js';
import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';

const log = logger('x402-service-uptime-monitor');

// Informational route label (this pipeline owns no single URL — it fans across
// the external registry). Mirrors the registry entry's `path`/`endpoint`.
export const SERVICE_UPTIME_ENDPOINT = 'registered external services (HEAD/OPTIONS probe)';

// Probe methods, in fallback order. HEAD is cheapest; OPTIONS/GET cover servers
// that reject HEAD with 405/501. GET on a paid endpoint returns the 402
// challenge, which is free to read (we never attach an X-PAYMENT header).
const PROBE_METHODS = ['HEAD', 'OPTIONS', 'GET'];
// Short per-probe timeout — a healthy service answers a HEAD in well under this;
// anything slower is effectively down for production routing purposes.
const PROBE_TIMEOUT_MS = Number(env.X402_UPTIME_PROBE_TIMEOUT_MS || process.env.X402_UPTIME_PROBE_TIMEOUT_MS || 8_000);
// Cap probes per run so one tick stays bounded even with a large catalog; a
// Redis cursor rotates coverage across runs so every service is checked over time.
const MAX_PER_RUN = Number(env.X402_UPTIME_MAX_PER_RUN || process.env.X402_UPTIME_MAX_PER_RUN || 25);
// Concurrent probes per batch — keeps wall-clock low without hammering hosts.
const PROBE_CONCURRENCY = Number(env.X402_UPTIME_CONCURRENCY || process.env.X402_UPTIME_CONCURRENCY || 6);
// Down probes before a service is treated as hard-dead by isServiceLive(). One
// blip shouldn't pull a service from production; a sustained outage should.
const FAILURE_THRESHOLD = Number(env.X402_UPTIME_FAILURE_THRESHOLD || process.env.X402_UPTIME_FAILURE_THRESHOLD || 2);

const REDIS_DEAD_KEY = 'x402:service-uptime:dead';
const REDIS_LATEST_KEY = 'x402:service-uptime:latest';
const REDIS_CURSOR_KEY = 'x402:service-uptime:cursor';
// A run every ~15 min; keep the snapshot a little over two cycles so a missed
// run lapses to "unknown" rather than latching forever.
const REDIS_TTL_SECONDS = 40 * 60;

export const SERVICE_UPTIME = Object.freeze({
	endpoint: SERVICE_UPTIME_ENDPOINT,
	priceAtomic: 0, // free probe — never pays
	table: 'x402_service_uptime',
	maxPerRun: MAX_PER_RUN,
	failureThreshold: FAILURE_THRESHOLD,
	probeTimeoutMs: PROBE_TIMEOUT_MS,
	redisDeadKey: REDIS_DEAD_KEY,
	redisLatestKey: REDIS_LATEST_KEY,
});

// ── Classification ──────────────────────────────────────────────────────────
// Turn a probe's HTTP status (or network error) into a liveness verdict.
//   402            → live_paywall          (a healthy x402 endpoint)
//   2xx / 3xx      → live_free             (reachable; free, redirect, or open)
//   4xx (non-402)  → reachable_unexpected  (server is UP but answered oddly —
//                                          route/auth change, not an outage)
//   5xx            → server_error          (DOWN)
//   no response    → unreachable           (timeout / DNS / refused → DOWN)
// Only 5xx and unreachable count as failures, per the monitor's spec.
export function classifyProbe(status, errMsg) {
	if (status === 402) return { alive: true, classification: 'live_paywall', error_msg: null };
	if (status != null && status >= 200 && status < 400) return { alive: true, classification: 'live_free', error_msg: null };
	if (status != null && status >= 500) return { alive: false, classification: 'server_error', error_msg: `http_${status}` };
	if (status != null && status >= 400) return { alive: true, classification: 'reachable_unexpected', error_msg: `http_${status}` };
	return { alive: false, classification: 'unreachable', error_msg: errMsg || 'unreachable' };
}

// The error_msg an x402_autonomous_log row gets for a probe verdict. Only a
// FAILING verdict carries one: see recordCall for why an alive-but-4xx third
// party must not stamp a payment-shaped error code onto a success row.
export function logErrorMsgFor(verdict) {
	if (!verdict) return null;
	return verdict.alive ? null : (verdict.error_msg || null);
}

function hostOf(u) {
	try { return new URL(u).host.toLowerCase(); } catch { return null; }
}

// Add an external target to the dedup map, skipping non-absolute URLs and any
// host that is our own platform (this monitor is for EXTERNAL services only).
function addTarget(map, ownHost, t) {
	if (!t || typeof t.resource !== 'string' || !t.resource) return;
	const host = hostOf(t.resource);
	if (!host) return; // not an absolute URL
	if (ownHost && host === ownHost) return; // our own origin
	if (/(^|\.)three\.ws$/.test(host)) return; // never probe three.ws itself
	if (!map.has(t.resource)) {
		map.set(t.resource, {
			resource: t.resource,
			tool_name: t.tool_name || null,
			networks: Array.isArray(t.networks) ? t.networks : [],
		});
	}
}

// Pull the EXTERNAL_ENDPOINTS list from the registry without a static import,
// avoiding any module init-order coupling (the registry imports this pipeline).
async function externalRegistryEntries() {
	try {
		const mod = await import('../autonomous-registry.js');
		return typeof mod.getExternalRegistry === 'function' ? mod.getExternalRegistry() : [];
	} catch {
		return [];
	}
}

/**
 * Collect every distinct external x402 service URL we know about: the latest
 * live/priced resources snapshotted per category by the bazaar warmup, plus the
 * registry's directly-registered EXTERNAL_ENDPOINTS. Excludes our own origin.
 */
export async function collectExternalTargets({ sql = defaultSql, origin } = {}) {
	const ownHost = hostOf(origin || env.APP_ORIGIN || 'https://three.ws');
	const targets = new Map();

	// 1. Bazaar catalog — the discovery source of record for external services.
	try {
		const rows = await sql`
			SELECT DISTINCT ON (category) category, resources
			FROM x402_bazaar_catalog
			ORDER BY category, ts DESC
		`;
		for (const r of rows) {
			const list = Array.isArray(r.resources) ? r.resources : [];
			for (const s of list) addTarget(targets, ownHost, s);
		}
	} catch (err) {
		// Fresh install: the catalog table may not exist yet → no bazaar targets.
		if (!/does not exist/i.test(err?.message || '')) throw err;
	}

	// 2. Directly-registered external endpoints (manual onboarding).
	for (const e of await externalRegistryEntries()) {
		if (!e?.url) continue;
		addTarget(targets, ownHost, { resource: e.url, tool_name: e.name || e.id || null, networks: e.networks || ['solana'] });
	}

	return [...targets.values()];
}

/**
 * Probe a single service URL with HEAD, falling back to OPTIONS then GET when a
 * server rejects the method. Never throws — a network failure resolves to an
 * `unreachable` verdict. Reads a 402 challenge without paying (free).
 */
export async function probeService(url) {
	let last = null;
	for (const method of PROBE_METHODS) {
		const t0 = Date.now();
		try {
			const res = await fetchWithTimeout(url, {
				method,
				headers: { 'user-agent': 'threews-x402-uptime/1.0', accept: 'application/json' },
			}, PROBE_TIMEOUT_MS);
			const verdict = classifyProbe(res.status, null);
			verdict.status = res.status;
			verdict.method = method;
			verdict.latency_ms = Date.now() - t0;
			// Definitive outcomes: a paywall, any reachable success/redirect, or a
			// server error — stop here. Method-not-allowed (405/501) means the server
			// is up but dislikes this verb, so try the next method for a real verdict.
			if (res.status === 402 || (res.status >= 200 && res.status < 400) || res.status >= 500) return verdict;
			last = verdict;
			if ((res.status === 405 || res.status === 501) && method !== 'GET') continue;
			return verdict; // other 4xx — reachable, accept the verdict
		} catch (err) {
			const verdict = classifyProbe(null, err?.message || 'network_error');
			verdict.status = null;
			verdict.method = method;
			verdict.latency_ms = Date.now() - t0;
			last = verdict;
			if (method !== 'GET') continue; // a HEAD block may not apply to GET
			return verdict;
		}
	}
	return last;
}

// ── Schema ──────────────────────────────────────────────────────────────────
let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS x402_service_uptime (
			resource             text PRIMARY KEY,
			tool_name            text,
			networks             text[] NOT NULL DEFAULT '{}',
			alive                boolean NOT NULL,
			classification       text NOT NULL,
			last_status          int,
			last_probe_method    text,
			latency_ms           int,
			consecutive_failures int NOT NULL DEFAULT 0,
			total_probes         bigint NOT NULL DEFAULT 0,
			total_failures       bigint NOT NULL DEFAULT 0,
			first_seen           timestamptz NOT NULL DEFAULT now(),
			last_seen_live       timestamptz,
			last_checked         timestamptz NOT NULL DEFAULT now(),
			run_id               uuid,
			error_msg            text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_service_uptime_alive ON x402_service_uptime (alive, last_checked DESC)`;
	// The autonomous log predates this pipeline; ensure value_extracted before any
	// recordCall references it (idempotent).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// Upsert one verdict, maintaining the failure streak + totals, and return the
// post-upsert consecutive_failures so the run can flag a crossing into "dead".
async function upsertUptime(sql, runId, target, v) {
	const liveTs = v.alive ? new Date().toISOString() : null;
	const failInc = v.alive ? 0 : 1;
	const [row] = await sql`
		INSERT INTO x402_service_uptime
			(resource, tool_name, networks, alive, classification, last_status,
			 last_probe_method, latency_ms, consecutive_failures, total_probes,
			 total_failures, last_seen_live, last_checked, run_id, error_msg)
		VALUES
			(${target.resource}, ${target.tool_name}, ${target.networks}, ${v.alive},
			 ${v.classification}, ${v.status ?? null}, ${v.method}, ${v.latency_ms ?? null},
			 ${failInc}, ${1}, ${failInc}, ${liveTs}, now(), ${runId}, ${v.error_msg})
		ON CONFLICT (resource) DO UPDATE SET
			tool_name            = EXCLUDED.tool_name,
			networks             = EXCLUDED.networks,
			alive                = EXCLUDED.alive,
			classification       = EXCLUDED.classification,
			last_status          = EXCLUDED.last_status,
			last_probe_method    = EXCLUDED.last_probe_method,
			latency_ms           = EXCLUDED.latency_ms,
			consecutive_failures = CASE WHEN EXCLUDED.alive THEN 0
			                            ELSE x402_service_uptime.consecutive_failures + 1 END,
			total_probes         = x402_service_uptime.total_probes + 1,
			total_failures       = x402_service_uptime.total_failures + ${failInc},
			last_seen_live       = CASE WHEN EXCLUDED.alive THEN now()
			                            ELSE x402_service_uptime.last_seen_live END,
			last_checked         = now(),
			run_id               = EXCLUDED.run_id,
			error_msg            = EXCLUDED.error_msg
		RETURNING consecutive_failures
	`;
	return Number(row?.consecutive_failures ?? failInc);
}

// One x402_autonomous_log row per probe (endpoint_type 'self' — this pipeline is
// a self-pipeline; value_extracted carries the verdict). The loop also records a
// single aggregate summary row for the run() entry.
//
// error_msg is written ONLY when the probe verdict is a failure. A
// `reachable_unexpected` verdict (any non-5xx 4xx) means the service is UP and
// the row is recorded success=true, so stamping `http_400`/`http_405` there put
// thousands of third-party observations into the column the loop's own failure
// stats read: on 2026-08-06 every single http_400 and http_405 in the last 48h
// came from this monitor observing templated or verb-picky third-party routes
// (readx.sh /api/:name/followers, earth.x402.press /earth/ask), none of them a
// payment failure. The full detail (last_status, error_msg, classification)
// still lands in x402_service_uptime and in this row's value_extracted, which is
// where the reliability surface reads it.
async function recordCall(sql, runId, target, v) {
	const host = hostOf(target.resource) || target.resource;
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${`Uptime: ${host}`}, ${target.resource},
				 ${(target.networks && target.networks[0]) || 'solana:mainnet'}, ${0}, ${null}, ${null},
				 ${JSON.stringify({ status: v.status ?? null, method: v.method, classification: v.classification })},
				 ${JSON.stringify({
					alive: v.alive,
					classification: v.classification,
					status: v.status ?? null,
					method: v.method,
					latency_ms: v.latency_ms ?? null,
				})},
				 ${v.latency_ms ?? 0}, ${v.alive}, ${logErrorMsgFor(v)}, ${'reliability'})
		`;
	} catch (err) {
		log.warn('uptime_log_insert_failed', { resource: target.resource, message: err?.message });
	}
}

async function writeRedisState(redis, { down, summary }) {
	if (!redis) return;
	try {
		await redis.set(REDIS_LATEST_KEY, JSON.stringify(summary), { ex: REDIS_TTL_SECONDS });
		if (down.length) {
			await redis.set(REDIS_DEAD_KEY, JSON.stringify(down), { ex: REDIS_TTL_SECONDS });
		} else {
			await redis.del(REDIS_DEAD_KEY);
		}
	} catch (err) {
		log.warn('uptime_redis_write_failed', { message: err?.message });
	}
}

/**
 * Run the uptime monitor. Conforms to the run()-style registry contract:
 *   ctx = { origin, redis, sql, log, runId } (all optional for standalone runs).
 * Returns the aggregate outcome the loop records as one summary row.
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const sql = ctx.sql || defaultSql;
	const redis = ctx.redis || null;

	// Schema first — no sink, no value, so don't probe.
	try {
		await ensureSchema(sql);
	} catch (err) {
		log.warn('uptime_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, txSig: null, errorMsg: `schema_failed: ${err?.message}` };
	}

	let targets;
	try {
		targets = await collectExternalTargets({ sql, origin });
	} catch (err) {
		log.warn('uptime_targets_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, txSig: null, errorMsg: `targets_failed: ${err?.message}`, note: 'targets_failed' };
	}

	if (!targets.length) {
		log.info('uptime_no_targets', { run_id: runId });
		return {
			success: true, skipped: true, amountAtomic: 0, txSig: null,
			responseData: { total_targets: 0, probed: 0, alive: 0, down: 0 },
			note: 'no_external_services',
		};
	}

	// Rotate coverage across runs when the catalog exceeds the per-run cap.
	let start = 0;
	if (targets.length > MAX_PER_RUN && redis) {
		try {
			const n = await redis.incrby(REDIS_CURSOR_KEY, MAX_PER_RUN);
			start = ((Number(n) - MAX_PER_RUN) % targets.length + targets.length) % targets.length;
		} catch { /* fall back to start=0 */ }
	}
	const batch = [];
	for (let i = 0; i < Math.min(MAX_PER_RUN, targets.length); i++) {
		batch.push(targets[(start + i) % targets.length]);
	}

	let alive = 0;
	let down = 0;
	let flagged = 0; // reachable_unexpected (up, but answered oddly)
	const downServices = [];

	// Probe in bounded-concurrency batches.
	for (let i = 0; i < batch.length; i += PROBE_CONCURRENCY) {
		const slice = batch.slice(i, i + PROBE_CONCURRENCY);
		const probed = await Promise.all(slice.map(async (target) => {
			let v;
			try {
				v = await probeService(target.resource);
			} catch (err) {
				v = classifyProbe(null, err?.message || 'probe_error');
				v.status = null; v.method = 'HEAD'; v.latency_ms = null;
			}
			return { target, v };
		}));

		for (const { target, v } of probed) {
			let consec = v.alive ? 0 : 1;
			try {
				consec = await upsertUptime(sql, runId, target, v);
			} catch (err) {
				log.warn('uptime_upsert_failed', { resource: target.resource, message: err?.message });
			}
			await recordCall(sql, runId, target, v);

			if (v.alive) {
				alive += 1;
				if (v.classification === 'reachable_unexpected') flagged += 1;
			} else {
				down += 1;
				downServices.push({ resource: target.resource, classification: v.classification, consecutive_failures: consec, error: v.error_msg });
				// Warn once at the threshold crossing so a hard outage pages ops
				// without spamming on every subsequent probe.
				if (consec === FAILURE_THRESHOLD) {
					log.warn('external_service_down', { resource: target.resource, classification: v.classification, consecutive_failures: consec });
				}
			}
		}
	}

	const summary = {
		ts: new Date().toISOString(),
		total_targets: targets.length,
		probed: batch.length,
		alive,
		down,
		flagged,
		down_services: downServices.map((d) => d.resource),
	};
	await writeRedisState(redis, { down: downServices, summary });

	log.info('uptime_monitor_complete', {
		run_id: runId,
		total_targets: targets.length,
		probed: batch.length,
		alive, down, flagged,
	});

	return {
		// success when the sweep ran and at least one probed service was reachable;
		// a sweep where every probe failed still records (per-call rows above) but
		// flags not-ok so health can surface a wholesale external outage.
		success: batch.length > 0 && down < batch.length,
		amountAtomic: 0,
		txSig: null,
		responseData: summary,
		valueExtracted: { probed: batch.length, alive, down, flagged },
		errorMsg: down > 0 ? `services_down:${down}` : null,
		note: `uptime probed=${batch.length} alive=${alive} down=${down}${flagged ? ` flagged=${flagged}` : ''}`,
	};
}

// ── Downstream consumer API ───────────────────────────────────────────────────

/**
 * Liveness gate for paying pipelines. Returns false ONLY when a service is
 * known-dead beyond FAILURE_THRESHOLD consecutive probes; an unknown (never
 * probed) or recovering service returns true so we never block a fresh endpoint.
 */
export async function isServiceLive(sql = defaultSql, resource) {
	if (!resource) return true;
	try {
		const [row] = await sql`
			SELECT alive, consecutive_failures
			FROM x402_service_uptime
			WHERE resource = ${resource}
			LIMIT 1
		`;
		if (!row) return true; // unknown → allow
		if (row.alive) return true;
		return Number(row.consecutive_failures || 0) < FAILURE_THRESHOLD;
	} catch {
		return true; // never block production on a monitor read failure
	}
}

/**
 * Read the uptime table for an ops reliability surface.
 * @param {object} sql
 * @param {{ onlyDead?: boolean, limit?: number }} opts
 */
export async function listServiceUptime(sql = defaultSql, { onlyDead = false, limit = 200 } = {}) {
	try {
		const rows = onlyDead
			? await sql`
				SELECT * FROM x402_service_uptime
				WHERE alive = false
				ORDER BY consecutive_failures DESC, last_checked DESC
				LIMIT ${limit}`
			: await sql`
				SELECT * FROM x402_service_uptime
				ORDER BY alive ASC, last_checked DESC
				LIMIT ${limit}`;
		return rows;
	} catch (err) {
		if (!/does not exist/i.test(err?.message || '')) {
			log.warn('uptime_list_failed', { message: err?.message });
		}
		return [];
	}
}
