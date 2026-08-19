// Behavioral anomaly orchestration — the live wiring around the pure scoring
// engine (api/_lib/wallet-anomaly.js). This module does the I/O the engine
// deliberately avoids: it reads an agent's real custody history to build/cache a
// baseline, pulls live velocity counts, scores each outbound action, records the
// scored decision to the anomaly timeline, and — on a freeze verdict — flips the
// wallet's freeze switch and fires a real owner notification.
//
// `guardOutboundAnomaly()` is the single hot-path entrypoint. It is called from
// the shared spend guards (enforceSpendLimit / reserveSpendUsd) AFTER the static
// caps pass, so it covers every autonomous outbound path (trade/snipe/x402) plus
// withdraw. It is fail-safe: any internal error defaults to the safe side per the
// owner's sensitivity (Strict freezes; otherwise the spend is allowed but the
// error is recorded for the timeline). It never throws anything except a
// SpendLimitError describing the freeze — so a boundary surfaces it as a clean 4xx.

import { sql } from './db.js';
import { insertNotification } from './notify.js';
import {
	computeBaseline,
	scoreOutbound,
	summarize,
	getAnomalyConfig,
	normalizeAnomalyConfig,
	applyApproval,
	sensitivityPreset,
	MIN_HISTORY,
} from './wallet-anomaly.js';

// Cached baseline freshness. Recomputing the baseline from history on every spend
// would be wasteful; we cache it in agent_identities.meta.anomaly_baseline and
// refresh at most this often. The velocity counts are always read live (cheap).
const BASELINE_TTL_MS = 3 * 60 * 60 * 1000; // 3h
// How many recent spend rows feed a baseline recompute (capped so a busy wallet
// can't make the recompute query unbounded).
const BASELINE_SAMPLE = 2000;

// A freeze verdict is returned (not thrown) from guardOutboundAnomaly so the
// shared guards can raise their OWN SpendLimitError — the one the boundaries
// already match on with `instanceof`. This keeps the SpendLimitError class in one
// place and avoids a circular import between this module and agent-trade-guards.js.
const FREEZE_MESSAGE =
	'This action was held and the wallet frozen — it looked unusual for this agent. ' +
	'Review it under Self-defending wallet to approve or keep frozen.';

/** Live spend velocity for an agent: counts in the trailing 1- and 10-minute windows. */
async function recentVelocity(agentId, network) {
	const [row] = await sql`
		SELECT
			count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int  AS c1,
			count(*) FILTER (WHERE created_at > now() - interval '10 minutes')::int AS c10
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type = 'spend'
		  AND status IN ('ok', 'pending', 'confirmed')
	`;
	return { c1: Number(row?.c1) || 0, c10: Number(row?.c10) || 0 };
}

/** Recompute the baseline from the agent's recent priced custody spend history. */
async function recomputeBaseline(agentId, nowMs) {
	const rows = await sql`
		SELECT usd, destination, asset, category, created_at
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND event_type = 'spend'
		  AND status IN ('ok', 'confirmed')
		ORDER BY id DESC
		LIMIT ${BASELINE_SAMPLE}
	`;
	return computeBaseline(rows, nowMs);
}

/** Read the cached baseline from meta, recomputing + persisting it if stale/missing. */
async function resolveBaseline(agentId, meta, nowMs) {
	const cached = meta?.anomaly_baseline;
	const computedAt = cached?.computed_at ? Date.parse(cached.computed_at) : NaN;
	if (cached && Number.isFinite(computedAt) && nowMs - computedAt < BASELINE_TTL_MS) {
		return cached;
	}
	const baseline = await recomputeBaseline(agentId, nowMs);
	// Persist back for the next caller. Fire-and-forget: a failed cache write must
	// never block a spend, and the next call simply recomputes.
	sql`
		UPDATE agent_identities
		SET meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ anomaly_baseline: baseline })}::jsonb
		WHERE id = ${agentId}
	`.catch((e) => console.warn('[anomaly] baseline cache write failed', e?.message));
	return baseline;
}

/**
 * Record one scored decision to the anomaly timeline. Allowed decisions with no
 * contributing factors are NOT recorded (zero-signal spends would be pure noise);
 * everything notable (any factor) and every freeze is recorded.
 * @returns {Promise<string|null>} the new anomaly event id, or null if not recorded
 */
async function recordAnomalyEvent({ agentId, userId, network, action, verdict, custodyEventId = null }) {
	const flagged = verdict.decision === 'freeze';
	if (!flagged && (!verdict.factors || verdict.factors.length === 0)) return null;
	const summary = summarize(verdict);
	const hourUtc = Number.isFinite(action.atMs) ? new Date(action.atMs).getUTCHours() : null;
	const [row] = await sql`
		INSERT INTO agent_anomaly_events
			(agent_id, user_id, network, category, asset, usd, destination, score, decision,
			 critical, sensitivity, factors, summary, status, hour_utc, custody_event_id)
		VALUES (
			${agentId}, ${userId ?? null}, ${network}, ${action.category ?? null}, ${action.asset ?? null},
			${action.usdValue ?? null}, ${action.destination ?? null}, ${verdict.score}, ${verdict.decision},
			${verdict.critical}, ${verdict.sensitivity}, ${JSON.stringify(verdict.factors)}::jsonb, ${summary},
			${flagged ? 'flagged' : 'allowed'}, ${hourUtc}, ${custodyEventId != null ? String(custodyEventId) : null}
		)
		RETURNING id
	`;
	return row?.id ? String(row.id) : null;
}

/**
 * Idempotently freeze a wallet via the shared spend-limit switch. Only flips the
 * flag when it is currently off, so an anomaly can never thrash freeze→unfreeze→
 * refreeze, and writes a custody audit row for the auto-action.
 * @returns {Promise<boolean>} true if THIS call performed the freeze
 */
async function freezeWallet(agentId, userId, nowIso, reason) {
	const rows = await sql`
		UPDATE agent_identities
		SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
			'spend_limits',
			coalesce(meta->'spend_limits', '{}'::jsonb) || jsonb_build_object('frozen', true, 'updated_at', ${nowIso}::text)
		)
		WHERE id = ${agentId}
		  AND coalesce((meta->'spend_limits'->>'frozen')::boolean, false) = false
		RETURNING id
	`;
	const didFreeze = rows.length > 0;
	if (didFreeze) {
		await sql`
			INSERT INTO agent_custody_events (agent_id, user_id, event_type, reason, status, meta)
			VALUES (${agentId}, ${userId ?? null}, 'limit_change', ${reason}, 'ok',
				${JSON.stringify({ auto_freeze: true, source: 'anomaly_guard' })}::jsonb)
		`.catch((e) => console.warn('[anomaly] freeze audit failed', e?.message));
	}
	return didFreeze;
}

/**
 * Score one pending outbound action and enforce the graduated response.
 *
 * @param {object} o
 * @param {string} o.agentId
 * @param {string} [o.userId]
 * @param {object} o.meta              agent meta (carries anomaly config + cached baseline)
 * @param {'trade'|'snipe'|'x402'|'withdraw'} o.category
 * @param {number|null} o.usdValue
 * @param {string} [o.destination]
 * @param {string} [o.asset]
 * @param {string} [o.network]
 * @param {number|string|null} [o.custodyEventId]  link the timeline row to a spend row
 * @param {boolean} [o.selfCounted]    true when a pending row for THIS action already exists
 *                                      (reserveSpendUsd path) so velocity isn't double-counted
 * @returns {Promise<{ decision:'allow'|'freeze', verdict:object|null, anomalyId:string|null,
 *           froze:boolean, message?:string, detail?:object }>} on a 'freeze' decision the caller
 *           (the shared guard) raises a SpendLimitError using message/detail. Never throws on a
 *           normal verdict — only a programming error would propagate.
 */
export async function guardOutboundAnomaly({
	agentId,
	userId = null,
	meta = null,
	category,
	usdValue = null,
	destination = null,
	asset = null,
	network = 'mainnet',
	custodyEventId = null,
	selfCounted = false,
}) {
	const nowMs = Date.now();
	const action = {
		usdValue: typeof usdValue === 'number' && Number.isFinite(usdValue) ? usdValue : null,
		destination: destination || null,
		asset: asset || null,
		category,
		atMs: nowMs,
	};

	// `config` is resolved inside the try so a meta-load failure also lands on the
	// fail-safe path. Default to a balanced posture if we never get that far.
	let config = null;
	let verdict;
	try {
		// Many autonomous callers pass `limits` but not `meta`/`userId`. Resolving the
		// agent row here (one PK read) makes the guard cover EVERY outbound path and
		// lets the owner notification reach the real owner regardless of the caller.
		if (!meta || userId == null) {
			const [row] = await sql`SELECT user_id, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
			if (!meta) meta = row?.meta || {};
			if (userId == null) userId = row?.user_id || null;
		}
		config = getAnomalyConfig(meta);
		// Guard disabled by the owner → nothing to do.
		if (!config.enabled) return { decision: 'allow', verdict: null, anomalyId: null, froze: false };

		const [baseline, vel] = await Promise.all([
			resolveBaseline(agentId, meta, nowMs),
			recentVelocity(agentId, network),
		]);
		// Count THIS action exactly once. reserveSpendUsd inserts the pending row
		// before calling us (selfCounted), so the live counts already include it.
		const bump = selfCounted ? 0 : 1;
		const recent = { count_1min: vel.c1 + bump, count_10min: vel.c10 + bump };
		verdict = scoreOutbound({ baseline, config, action, recent });
	} catch (err) {
		// Fail-safe: never let a scoring/IO error silently fail open. Strict owners
		// get a freeze on uncertainty; others are allowed but the error is recorded.
		console.warn('[anomaly] scoring failed', err?.message);
		const strict = config && sensitivityPreset(config.sensitivity).key === 'strict';
		if (strict && category !== 'withdraw') {
			const froze = await freezeWallet(agentId, userId, new Date(nowMs).toISOString(), 'anomaly_scoring_error').catch(() => false);
			const [row] = await sql`
				INSERT INTO agent_anomaly_events
					(agent_id, user_id, network, category, usd, destination, score, decision, critical, sensitivity, factors, summary, status, hour_utc)
				VALUES (${agentId}, ${userId ?? null}, ${network}, ${category}, ${usdValue ?? null}, ${destination ?? null},
					1, 'freeze', true, ${config.sensitivity}, '[]'::jsonb,
					'Froze on the safe side — the anomaly guard could not finish scoring this action.', 'flagged',
					${new Date(nowMs).getUTCHours()})
				RETURNING id
			`.catch(() => [null]);
			const anomalyId = row?.id ? String(row.id) : null;
			notifyFrozen({ agentId, userId, category, usdValue, summary: 'The guard could not score an action and froze the wallet to be safe.', score: 1, factors: [], anomalyId });
			return {
				decision: 'freeze', verdict: null, anomalyId, froze,
				message: 'This wallet was frozen as a safety precaution — the guard could not finish scoring this action. Review it under Self-defending wallet, then approve or keep frozen.',
				detail: { category, reason: 'scoring_error', anomaly_id: anomalyId },
			};
		}
		return { decision: 'allow', verdict: null, anomalyId: null, froze: false };
	}

	// Withdraw is the owner's own escape hatch (it stays open even when frozen — a
	// freeze must never trap funds). So we SCORE + RECORD withdraws for visibility
	// and may freeze the autonomous paths, but never block the withdraw itself.
	const enforce = category !== 'withdraw';
	let froze = false;
	let anomalyId = null;

	if (verdict.decision === 'freeze' && enforce) {
		froze = await freezeWallet(agentId, userId, new Date(nowMs).toISOString(), 'anomaly_autofreeze');
		anomalyId = await recordAnomalyEvent({ agentId, userId, network, action, verdict, custodyEventId }).catch((e) => {
			console.warn('[anomaly] flag record failed', e?.message);
			return null;
		});
		notifyFrozen({
			agentId, userId, category, usdValue: action.usdValue,
			summary: summarize(verdict), score: verdict.score, factors: verdict.factors, anomalyId,
		});
		return {
			decision: 'freeze', verdict, anomalyId, froze,
			message: FREEZE_MESSAGE,
			detail: { category, score: verdict.score, anomaly_id: anomalyId, factors: verdict.factors.map((f) => f.label) },
		};
	}

	// Allowed (or a withdraw we only observe). Persist if notable. A withdraw is the
	// owner's escape hatch — even a freeze-scoring one is recorded as 'allowed' (never
	// a held flag), since we don't act on it; its factors still show in the timeline.
	const recordVerdict = enforce ? verdict : { ...verdict, decision: 'allow' };
	anomalyId = await recordAnomalyEvent({ agentId, userId, network, action, verdict: recordVerdict, custodyEventId }).catch((e) => {
		console.warn('[anomaly] record failed', e?.message);
		return null;
	});
	return { decision: 'allow', verdict, anomalyId, froze };
}

/** Real owner notification for an auto-freeze (in-app + push, gated by prefs). */
function notifyFrozen({ agentId, userId, category, usdValue, summary, score, factors, anomalyId = null }) {
	if (!userId) return;
	insertNotification(userId, 'wallet_anomaly_frozen', {
		agent_id: agentId,
		link: `/agents/${encodeURIComponent(agentId)}/wallet#guard`,
		category,
		usd: usdValue ?? null,
		score,
		summary,
		factors: Array.isArray(factors) ? factors.slice(0, 4).map((f) => f.label) : [],
		anomaly_id: anomalyId,
	});
}

// ── timeline + adjudication (read by the guard endpoint) ────────────────────────

/** Owner-facing anomaly timeline, newest first, keyset-paginated by id. */
export async function listAnomalyEvents(agentId, { limit = 50, beforeId = null } = {}) {
	const lim = Math.min(200, Math.max(1, Number(limit) || 50));
	const rows = await sql`
		SELECT id, network, category, asset, usd, destination, score, decision, critical,
		       sensitivity, factors, summary, status, hour_utc, swept, adjudicated_at, created_at
		FROM agent_anomaly_events
		WHERE agent_id = ${agentId}
		  AND (${beforeId}::bigint IS NULL OR id < ${beforeId})
		ORDER BY id DESC
		LIMIT ${lim}
	`;
	return rows;
}

/** The open flags (frozen, awaiting the owner's one-tap call) for an agent. */
export async function listOpenFlags(agentId) {
	return sql`
		SELECT id, category, asset, usd, destination, score, factors, summary, hour_utc, created_at
		FROM agent_anomaly_events
		WHERE agent_id = ${agentId} AND status = 'flagged'
		ORDER BY id DESC
		LIMIT 20
	`;
}

/** Fetch one flagged event by id (owner-scoped by the caller). */
export async function getAnomalyEvent(agentId, eventId) {
	const [row] = await sql`
		SELECT id, agent_id, user_id, category, asset, usd, destination, score, factors, summary,
		       status, hour_utc, created_at
		FROM agent_anomaly_events
		WHERE agent_id = ${agentId} AND id = ${eventId}
	`;
	return row || null;
}

/** Mark a flagged event's adjudication outcome. */
export async function setAnomalyStatus(eventId, { status, userId, swept = false }) {
	await sql`
		UPDATE agent_anomaly_events
		SET status = ${status},
		    adjudicated_by = ${userId ?? null},
		    adjudicated_at = now(),
		    swept = ${swept ? true : false} OR swept
		WHERE id = ${eventId}
	`;
}

// ── owner-facing helpers (used by the guard endpoint) ───────────────────────────

/**
 * Load the agent's behavioral baseline for display, recomputing + caching if stale.
 * Adds a `low_history` flag so the UI can be honest when tolerances are wide.
 */
export async function loadBaselineForDisplay(agentId, meta) {
	const baseline = await resolveBaseline(agentId, meta, Date.now());
	return { ...baseline, low_history: (baseline.n || 0) < MIN_HISTORY };
}

/**
 * Persist an owner config patch onto agent_identities.meta.anomaly. Returns the new
 * normalized config. The caller must have already verified ownership.
 */
export async function saveAnomalyConfig(agentId, prevMeta, patch) {
	const next = normalizeAnomalyConfig({ ...getAnomalyConfig(prevMeta), ...patch });
	next.updated_at = new Date().toISOString();
	await sql`
		UPDATE agent_identities
		SET meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ anomaly: next })}::jsonb
		WHERE id = ${agentId}
	`;
	return next;
}

/**
 * Teach the baseline from an owner-approved flagged action: fold the action's
 * destination / size / hour into the config so the same pattern won't re-trip.
 * Returns the new normalized config.
 */
export async function teachFromApproval(agentId, meta, evt) {
	const taught = applyApproval(getAnomalyConfig(meta), evt);
	return saveAnomalyConfig(agentId, meta, taught);
}
