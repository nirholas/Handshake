// api/_lib/x402/pipelines/volume-shared.js
//
// Shared plumbing for the ring's paid-traffic drivers. Both the 5-minute volume
// bootstrap loop (volume-bootstrap-loop.js) and the per-minute ring tick
// (api/cron/x402-ring-tick.js) settle real USDC across the SAME internal
// catalog, record to the SAME per-call log, and roll up the SAME per-endpoint
// ledger. This module is that single source of truth so there is exactly one
// payment-recording path, not two that drift.
//
// Nothing here mints, prices, or moves money — it is the catalog + the two
// durable sinks (x402_autonomous_log rows and the x402_volume_metrics ledger).
// The payment itself is always payX402 (../pay.js); callers own budget/cadence.

import { USDC_MINT } from '../pay.js';
import { rotationPlan } from '../ring-catalog.js';
import { volumePerRunCapAtomic } from '../ring-constants.js';

export const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Self-imposed per-run USDC budget (atomics, 6dp) for the 5-minute volume loop.
// Bounds a single tick on top of the loop's daily cap so one run can't drain the
// day. The default ($1.10) accommodates the ring-settle price this catalog
// rotates ($1.00 default, X402_PRICE_RING_SETTLE) — at the old $0.05 the flagship
// ring-settle call was silently skipped every cycle (cap_would_exceed). The value
// and its env override live in ring-constants.js (the single source of truth that
// ring-config.js's price>cap check also reads); validateRingConfig() flags a
// price > cap contradiction, and payX402 warns loudly if one is ever hit.
export const VOLUME_PER_RUN_CAP_ATOMIC = volumePerRunCapAtomic();

// How many endpoints the 5-minute volume loop sweeps per run (cursor advances by
// this each tick). Sized so the default cadence (AUTONOMOUS_TICKS_PER_HOUR × this)
// covers the FULL autobuy rotation every hour — tests/x402-ring-catalog.test.js
// enforces it — because trailing-30-day settle activity is what keeps endpoints
// ranked on the x402 discovery surfaces. Spend per tick stays bounded by
// VOLUME_PER_RUN_CAP_ATOMIC and the daily cap regardless of batch size.
export const VOLUME_BATCH_PER_RUN = Math.max(
	1,
	Number(process.env.X402_VOLUME_BATCH_PER_RUN || 6),
);

// The catalog of paid self x402 endpoints the ring drivers round-robin is now the
// single source of truth in ../ring-catalog.js — every paid endpoint on the
// platform, each with a body()/query proven against the handler it points at.
// This module maps the catalog's autobuy, weighted rotation into the flat
// { key, name, path, method, body } shape both drivers already consume. INTERNAL
// paths only — the ring never pays anything outside three.ws; X402_EXTERNAL_ENABLED
// has no effect on it. To add an endpoint to ring volume, add it to ring-catalog.js
// with autobuy:true — the cursor, the metrics ledger, and the per-minute tick pick
// it up automatically (and tests/x402-ring-catalog.test.js fails until it is
// cataloged). The drivers themselves are never listed (no self-recursion).
//
// Turn a display name from a slug: 'club-cover-snapshot' → 'Club Cover Snapshot'.
function displayName(slug) {
	return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Fold a catalog entry into the driver's flat endpoint shape. GET query params
// are baked into the path (the settle path already appends nothing else), so the
// shared settleAndRecord needs no change; POST bodies are resolved once from
// body() (the payloads are static canaries).
function toVolumeEndpoint(e) {
	const qs = e.query ? `?${new URLSearchParams(e.query).toString()}` : '';
	return {
		key: e.slug,
		name: displayName(e.slug),
		path: `${e.path}${qs}`,
		method: e.method,
		body: e.method === 'POST' ? e.body() : null,
	};
}

// The weighted, interleaved autobuy rotation — a full pass touches every autobuy
// slug at least once (weight-N entries appear N times so they are hit more often).
export const VOLUME_ENDPOINTS = rotationPlan().map(toVolumeEndpoint);

// The ring-settle catalog entry (the periodic large volume carrier).
export const RING_SETTLE_ENDPOINT = VOLUME_ENDPOINTS.find((e) => e.key === 'ring-settle');
// Everything else — the cheap tips/services that dominate the per-minute count.
export const CHEAP_ENDPOINTS = VOLUME_ENDPOINTS.filter((e) => e.key !== 'ring-settle');

// Reserve the next window of `batch` endpoint indices, advancing a cursor
// atomically. Redis INCRBY gives a stable rotation across warm instances; the
// in-memory counter is the single-process fallback. `cursorKey` scopes the
// rotation so the volume loop and the ring tick keep independent cursors.
const _memCursors = new Map();
export async function reserveWindow(redis, batch, len, cursorKey = 'x402:auto:volume:cursor') {
	let end;
	if (redis) {
		try {
			end = Number(await redis.incrby(cursorKey, batch));
		} catch {
			end = (_memCursors.get(cursorKey) || 0) + batch;
			_memCursors.set(cursorKey, end);
		}
	} else {
		end = (_memCursors.get(cursorKey) || 0) + batch;
		_memCursors.set(cursorKey, end);
	}
	const start = end - batch;
	const out = [];
	for (let i = 0; i < batch; i++) out.push(((start + i) % len + len) % len);
	return out;
}

// One-time DDL guard per warm instance. Both drivers call this before recording.
let _schemaReady = false;
export async function ensureVolumeSchema(sql) {
	if (_schemaReady) return;
	// Per-endpoint cumulative volume ledger. PRIMARY KEY endpoint_key → one row
	// per paid endpoint, accumulated across every sweep (loop AND tick).
	await sql`
		CREATE TABLE IF NOT EXISTS x402_volume_metrics (
			endpoint_key        text PRIMARY KEY,
			service_name        text,
			endpoint_path       text,
			network             text NOT NULL DEFAULT 'solana:mainnet',
			asset               text,
			call_count          bigint NOT NULL DEFAULT 0,
			success_count       bigint NOT NULL DEFAULT 0,
			fail_count          bigint NOT NULL DEFAULT 0,
			total_spent_atomic  bigint NOT NULL DEFAULT 0,
			last_amount_atomic  bigint NOT NULL DEFAULT 0,
			last_success        boolean,
			last_status         int,
			last_tx_signature   text,
			last_error          text,
			last_run_id         uuid,
			first_called_at     timestamptz DEFAULT now(),
			last_called_at      timestamptz DEFAULT now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_volume_metrics_last_called ON x402_volume_metrics (last_called_at DESC)`;
	// The autonomous log predates value_extracted; ensure the column exists
	// (idempotent — shared with other pipelines).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// Compact, generic liveness summary of a paid response — keeps the log row small
// while still proving the endpoint returned something usable.
export function summarizeResponse(body) {
	if (body == null) return { ok: false, shape: 'empty' };
	if (typeof body === 'string') return { ok: body.length > 0, shape: 'text', length: body.length };
	if (Array.isArray(body)) return { ok: body.length > 0, shape: 'array', length: body.length };
	if (typeof body === 'object') {
		const keys = Object.keys(body);
		return { ok: keys.length > 0 && !body.error, shape: 'object', keys: keys.slice(0, 12) };
	}
	return { ok: true, shape: typeof body };
}

// Upsert the per-endpoint volume ledger and return the resulting cumulative row.
// Wrapped by the caller so a DB fault is logged, never fatal.
export async function upsertVolumeMetric(sql, ep, { amountAtomic, txSig, success, status, errorMsg, runId }) {
	const rows = await sql`
		INSERT INTO x402_volume_metrics
			(endpoint_key, service_name, endpoint_path, network, asset,
			 call_count, success_count, fail_count, total_spent_atomic,
			 last_amount_atomic, last_success, last_status, last_tx_signature,
			 last_error, last_run_id, first_called_at, last_called_at)
		VALUES
			(${ep.key}, ${ep.name}, ${ep.path}, ${'solana:mainnet'}, ${ASSET},
			 ${1}, ${success ? 1 : 0}, ${success ? 0 : 1}, ${amountAtomic || 0},
			 ${amountAtomic || 0}, ${success}, ${status ?? null}, ${txSig || null},
			 ${errorMsg || null}, ${runId}, now(), now())
		ON CONFLICT (endpoint_key) DO UPDATE SET
			service_name       = EXCLUDED.service_name,
			endpoint_path      = EXCLUDED.endpoint_path,
			asset              = EXCLUDED.asset,
			call_count         = x402_volume_metrics.call_count + 1,
			success_count      = x402_volume_metrics.success_count + ${success ? 1 : 0},
			fail_count         = x402_volume_metrics.fail_count + ${success ? 0 : 1},
			total_spent_atomic = x402_volume_metrics.total_spent_atomic + ${amountAtomic || 0},
			last_amount_atomic = EXCLUDED.last_amount_atomic,
			last_success       = EXCLUDED.last_success,
			last_status        = EXCLUDED.last_status,
			last_tx_signature  = EXCLUDED.last_tx_signature,
			last_error         = EXCLUDED.last_error,
			last_run_id        = EXCLUDED.last_run_id,
			last_called_at     = now()
		RETURNING call_count, success_count, fail_count, total_spent_atomic
	`;
	return rows[0] || null;
}

// Per-call row into x402_autonomous_log. `pipeline` tags the driver ('volume' or
// 'ring-tick') so each driver's spend can be summed independently — this is what
// keeps the ring tick's daily budget separate from the volume loop's.
export async function recordVolumeCall(sql, runId, ep, {
	endpointUrl, amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted,
	pipeline = 'volume', namePrefix = 'Volume',
}, log) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${`${namePrefix}: ${ep.name}`}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${pipeline})
		`;
	} catch (err) {
		log?.warn?.('volume_call_log_insert_failed', { endpoint: ep.key, pipeline, message: err?.message });
	}
}

// Settle one catalog endpoint through payX402, roll it into the ledger, and
// record the per-call log row. Returns the payX402 result plus the resolved
// endpoint URL. This is the ONE place a ring driver pays + records a single
// endpoint, so the loop and the tick never diverge. `payFn` is injectable for
// tests; production passes payX402.
export async function settleAndRecord({
	sql, runId, ep, origin, remaining, ctx, pipeline, namePrefix, payFn, log,
}) {
	const endpointUrl = `${origin}${ep.path}`;
	const t0 = Date.now();

	let result;
	try {
		result = await payFn({
			url: endpointUrl,
			method: ep.method || 'POST',
			body: ep.body,
			buyer: ctx.buyer,
			conn: ctx.conn,
			blockhash: ctx.blockhash,
			mintInfo: ctx.mintInfo,
			remainingCap: remaining,
		});
	} catch (err) {
		result = { success: false, paid: false, amountAtomic: 0, txSig: null, status: 0, responseBody: null, errorMsg: err?.message || 'fetch_failed' };
	}

	// Only PAID amounts count toward spend accounting; a skipped/failed call
	// settled nothing, so its recorded amount is 0 (keeps SUM(amount_atomic) an
	// honest spend total for the daily-cap query).
	const paidAmount = result.paid ? (result.amountAtomic || 0) : 0;

	let metric = null;
	try {
		metric = await upsertVolumeMetric(sql, ep, {
			amountAtomic: paidAmount,
			txSig: result.txSig,
			success: result.success,
			status: result.status,
			errorMsg: result.errorMsg,
			runId,
		});
	} catch (err) {
		log?.warn?.('volume_metric_upsert_failed', { endpoint: ep.key, message: err?.message });
	}

	const valueExtracted = {
		endpoint_key: ep.key,
		paid: result.paid === true,
		amount_atomic: paidAmount,
		liveness: summarizeResponse(result.responseBody),
		...(metric ? {
			cumulative_calls: Number(metric.call_count),
			cumulative_success: Number(metric.success_count),
			cumulative_spent_atomic: Number(metric.total_spent_atomic),
		} : {}),
	};

	await recordVolumeCall(sql, runId, ep, {
		endpointUrl,
		amountAtomic: paidAmount,
		txSig: result.txSig,
		responseData: { status: result.status, liveness: valueExtracted.liveness },
		durationMs: Date.now() - t0,
		success: result.success,
		errorMsg: result.errorMsg,
		valueExtracted,
		pipeline,
		namePrefix,
	}, log);

	return { result, endpointUrl, paidAmount };
}
