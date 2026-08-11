// Scoped session keys — capability-based least-privilege for autonomous agent
// spending. The companion to the wallet-wide policy in agent-trade-guards.js.
//
// THE MODEL
//   A capability is a signed, scoped, time-boxed, independently-revocable grant
//   that lets a SPECIFIC actor (a skill / strategy / integration) spend a NARROW
//   slice of the wallet's authority — e.g. "this sniper strategy may spend up to
//   2 SOL on these mints for the next 24h, and nothing else." Each capability is
//   audited and killable on its own; a rogue or buggy holder can never exceed the
//   leash the owner gave it.
//
// CAPABILITIES STRICTLY SUBTRACT AUTHORITY
//   On every autonomous spend BOTH the capability ceiling AND the wallet-wide
//   policy must pass. A capability can only ever narrow — never widen — what the
//   wallet policy already allows. A bug here must fail toward LESS access: an
//   unverifiable / expired / revoked / out-of-scope grant is rejected (deny), and
//   when the owner turns on "require a capability for every autonomous spend",
//   the absence of a covering grant is also a deny.
//
// UNFORGEABLE + TAMPER-EVIDENT
//   `grant_sig` is an HMAC-SHA256 over the immutable scope keyed by a server-held
//   secret (env.WALLET_CAPABILITY_SECRET). It is re-verified server-side on every
//   use. A DB-write attacker who forges a row or edits a scope field produces a
//   grant whose HMAC no longer verifies, so the spend path rejects it. Expiry and
//   revocation are likewise enforced server-side on every use, never client-trusted.
//
// AGGREGATE ACCOUNTING (concurrency-safe)
//   Per-capability lifetime spend is summed from agent_custody_events rows tagged
//   with capability_id — the SAME ledger that backs the wallet daily ceiling, so
//   one pending row counts toward both. reserveCapabilitySpend() does the check +
//   reserve as ONE statement under a per-capability advisory lock (and, when a
//   wallet daily cap is in play, the per-agent lock too), so K concurrent uses can
//   never all read the same stale total and overspend the ceiling.

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { sql } from './db.js';
import { env } from './env.js';
// Circular by design: the shared guards import the capability gate from here, and
// we import the custody-ledger writer + the SpendLimitError class from there. Both
// sides only touch these bindings inside function bodies (never at module eval), so
// the cycle resolves cleanly at call time. Capability denials ARE spend-policy
// breaches and reuse SpendLimitError so every existing `instanceof SpendLimitError`
// catch site (x402, trade, snipe, withdraw) handles them with no change.
import { getCounterpartySpendUsd, recordCustodyEvent, SpendLimitError } from './agent-trade-guards.js';

// Back-compat / intent-revealing alias: a capability breach is a SpendLimitError.
export { SpendLimitError as CapabilityError };

// The action types a capability can authorize. Mirrors the `category` vocabulary
// the shared guards already use for autonomous outbound paths. 'withdraw' is
// deliberately absent: an owner-initiated sweep is not a delegated capability.
export const CAPABILITY_ACTIONS = Object.freeze(['trade', 'snipe', 'x402']);
const ACTION_SET = new Set(CAPABILITY_ACTIONS);

export const CAPABILITY_TARGET_KINDS = Object.freeze(['any', 'mint', 'service', 'destination']);
const TARGET_KIND_SET = new Set(CAPABILITY_TARGET_KINDS);

export const HOLDER_KINDS = Object.freeze(['skill', 'strategy', 'integration', 'manual']);
const HOLDER_KIND_SET = new Set(HOLDER_KINDS);

const MAX_TARGETS = 50;
const MAX_LABEL = 120;
const MAX_TTL_SECONDS = 366 * 24 * 60 * 60; // a year — capabilities are always time-boxed
const MIN_TTL_SECONDS = 60; // a grant that expires in <1min is almost certainly a mistake

// An issuance-input breach: surfaced as a 400 (bad request) rather than the 403 a
// runtime spend denial uses. Reuses SpendLimitError so callers can treat capability
// and policy errors uniformly; only the status differs.
function capInvalid(message, detail = {}) {
	const e = new SpendLimitError('invalid', message, detail);
	e.status = 400;
	return e;
}

function nowMs(now) {
	// Date.now() is forbidden in some sandboxes; callers may inject `now`. Default
	// to the real clock at runtime (server code, not a workflow script).
	return now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now();
}

function numOrNull(v) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}

function cleanStr(v, max = 200) {
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Normalize a service allow entry to a bare lowercase host. Accepts a full URL, a
// scheme-less host, or a host:port — anything else is dropped. So an owner can
// type "api.weather.com", "https://api.weather.com/v1" or "weather.com" and the
// stored allowlist is a canonical set of hosts to match a payment target against.
function normalizeServiceHost(raw) {
	const s = cleanStr(raw, 253).toLowerCase();
	if (!s) return '';
	try {
		const u = new URL(s.includes('://') ? s : `https://${s}`);
		return u.hostname || '';
	} catch {
		return '';
	}
}

/**
 * Coerce arbitrary issuance input into a clean, bounded capability scope. Throws
 * CapabilityError('invalid', …) when the request can't describe a real, useful
 * leash — issuance must fail safe (no half-defined grant ever reaches the DB).
 *
 * @returns {{ actions, perUseUsd, aggregateUsd, targetKind, targets, expiresAt }}
 */
export function normalizeCapabilityInput(raw, { now } = {}) {
	const r = raw && typeof raw === 'object' ? raw : {};

	const actions = [...new Set(
		(Array.isArray(r.actions) ? r.actions : [])
			.map((a) => cleanStr(a, 16).toLowerCase())
			.filter((a) => ACTION_SET.has(a)),
	)];
	if (actions.length === 0) {
		throw capInvalid('A capability must allow at least one action (trade, snipe, or x402).', { field: 'actions' });
	}

	const perUseUsd = numOrNull(r.per_use_usd ?? r.perUseUsd);
	const aggregateUsd = numOrNull(r.aggregate_usd ?? r.aggregateUsd);
	// A capability with no ceiling at all isn't a leash — it would only narrow by
	// action/target/expiry, which is fine, but most callers want a budget. Require
	// at least ONE bound (ceiling or a non-'any' target) so "least privilege" is
	// real and the owner can't accidentally mint an effectively-unbounded grant.
	let targetKind = cleanStr(r.target_kind ?? r.targetKind ?? 'any', 16).toLowerCase();
	if (!TARGET_KIND_SET.has(targetKind)) targetKind = 'any';

	let targets = [];
	if (targetKind !== 'any') {
		const rawTargets = Array.isArray(r.targets) ? r.targets : [];
		const mapped = rawTargets
			.map((t) => (targetKind === 'service' ? normalizeServiceHost(t) : cleanStr(t, 64)))
			.filter(Boolean);
		targets = [...new Set(mapped)].slice(0, MAX_TARGETS);
		if (targets.length === 0) {
			throw capInvalid(`A "${targetKind}" capability needs at least one allowed target.`, { field: 'targets' });
		}
	}

	const hasBound = perUseUsd != null || aggregateUsd != null || targetKind !== 'any';
	if (!hasBound) {
		throw capInvalid('A capability must set a spend ceiling or a target allowlist — otherwise it grants no narrower authority than the wallet itself.', { field: 'ceiling' });
	}
	if (perUseUsd != null && aggregateUsd != null && perUseUsd > aggregateUsd + 1e-9) {
		throw capInvalid('The per-use ceiling cannot exceed the total budget.', { field: 'per_use_usd' });
	}

	// Expiry: a capability is ALWAYS time-boxed. Accept either an absolute
	// `expires_at` (ISO) or a `ttl_seconds`; clamp to a sane window.
	const base = nowMs(now);
	let expiresAt;
	if (r.expires_at || r.expiresAt) {
		const t = new Date(r.expires_at || r.expiresAt).getTime();
		if (!Number.isFinite(t)) throw capInvalid('expires_at is not a valid date.', { field: 'expires_at' });
		expiresAt = new Date(t);
	} else {
		let ttl = Number(r.ttl_seconds ?? r.ttlSeconds);
		if (!Number.isFinite(ttl) || ttl <= 0) ttl = 24 * 60 * 60; // sensible default: 24h
		ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(ttl)));
		expiresAt = new Date(base + ttl * 1000);
	}
	if (expiresAt.getTime() <= base) {
		throw capInvalid('A capability must expire in the future.', { field: 'expires_at' });
	}
	if (expiresAt.getTime() - base > MAX_TTL_SECONDS * 1000 + 1000) {
		throw capInvalid('A capability can last at most one year.', { field: 'expires_at' });
	}

	return { actions: actions.sort(), perUseUsd, aggregateUsd, targetKind, targets: targets.sort(), expiresAt };
}

// ── tamper-evidence (HMAC over the immutable scope) ────────────────────────────

/**
 * Deterministic canonical string of a grant's SECURITY-relevant, immutable scope.
 * Anything that changes what the grant authorizes is in here; pure-display fields
 * (label) and mutable lifecycle fields (revoked_at, use_count) are not — so a
 * revoke doesn't need a re-sign, but editing actions/targets/ceilings/expiry/
 * holder does invalidate the HMAC.
 */
export function canonicalScope(cap) {
	const expISO = cap.expires_at instanceof Date
		? cap.expires_at.toISOString()
		: new Date(cap.expires_at).toISOString();
	return JSON.stringify([
		'cap-v1',
		String(cap.id),
		String(cap.agent_id),
		String(cap.holder_kind || 'manual'),
		cap.holder_ref ? String(cap.holder_ref) : '',
		[...(cap.actions || [])].sort(),
		cap.per_use_usd == null ? null : Number(cap.per_use_usd),
		cap.aggregate_usd == null ? null : Number(cap.aggregate_usd),
		String(cap.target_kind || 'any'),
		[...(cap.targets || [])].sort(),
		expISO,
	]);
}

function capabilitySecret() {
	const s = env.WALLET_CAPABILITY_SECRET;
	if (!s || String(s).length < 8) {
		// Never sign with a weak/empty key — that would let a DB-write attacker forge
		// grants. Fail safe: refuse to mint rather than mint an unforgeable-in-name-only grant.
		{ const e = new SpendLimitError('config', 'Capability signing is not configured (WALLET_CAPABILITY_SECRET).'); e.status = 503; throw e; }
	}
	return String(s);
}

export function signGrant(cap) {
	return createHmac('sha256', capabilitySecret()).update(canonicalScope(cap)).digest('hex');
}

/** Constant-time verification that a stored grant's HMAC matches its current scope. */
export function verifyGrant(cap) {
	const expected = signGrant(cap);
	const got = String(cap.grant_sig || '');
	if (got.length !== expected.length) return false;
	try {
		return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'));
	} catch {
		return false;
	}
}

// ── pure scope predicates (unit-testable; no DB, no clock side effects) ─────────

/** Live = signed scope verifies, not revoked, not expired. */
export function capabilityLive(cap, { now } = {}) {
	if (!cap) return { ok: false, reason: 'not_found' };
	if (!verifyGrant(cap)) return { ok: false, reason: 'tampered' };
	if (cap.revoked_at) return { ok: false, reason: 'revoked' };
	const exp = cap.expires_at instanceof Date ? cap.expires_at.getTime() : new Date(cap.expires_at).getTime();
	if (!Number.isFinite(exp) || exp <= nowMs(now)) return { ok: false, reason: 'expired' };
	return { ok: true };
}

export function capabilityCoversAction(cap, action) {
	return Array.isArray(cap?.actions) && cap.actions.includes(action);
}

/**
 * Does the grant's target allowlist cover this spend's target? 'any' covers
 * everything; 'mint'/'destination' need an exact base58 match; 'service' matches
 * the host of the payment target (so "api.x.com" covers https://api.x.com/v1/…).
 */
export function capabilityCoversTarget(cap, target) {
	const kind = cap?.target_kind || 'any';
	if (kind === 'any') return true;
	const list = Array.isArray(cap?.targets) ? cap.targets : [];
	if (list.length === 0) return false;
	const t = typeof target === 'string' ? target.trim() : '';
	if (!t) return false;
	if (kind === 'service') {
		const host = normalizeServiceHost(t);
		return host ? list.includes(host) : false;
	}
	return list.includes(t);
}

/** Per-use ceiling. Blocked when this single spend exceeds the cap. */
export function checkPerUse(cap, usdValue) {
	if (cap?.per_use_usd == null) return null;
	if (typeof usdValue !== 'number' || !Number.isFinite(usdValue)) return null;
	if (usdValue > Number(cap.per_use_usd) + 1e-9) {
		return { reason: 'per_use_exceeded', detail: { usd: usdValue, per_use_usd: Number(cap.per_use_usd) } };
	}
	return null;
}

/** Aggregate (lifetime) ceiling. Blocked when prior spend + this spend exceeds it. */
export function checkAggregate(spentUsd, usdValue, cap) {
	if (cap?.aggregate_usd == null) return null;
	if (typeof usdValue !== 'number' || !Number.isFinite(usdValue)) return null;
	const spent = Number(spentUsd) || 0;
	if (spent + usdValue > Number(cap.aggregate_usd) + 1e-9) {
		return { reason: 'aggregate_exceeded', detail: { usd: usdValue, spent_usd: spent, aggregate_usd: Number(cap.aggregate_usd) } };
	}
	return null;
}

/**
 * Compose every read-only check a capability must pass for one spend EXCEPT the
 * aggregate ceiling (which needs the live ledger total and an advisory lock — see
 * reserveCapabilitySpend). Returns null when in scope, or a structured
 * { reason, detail } when the spend is outside the leash. Pure + synchronous.
 *
 * @param {object} o
 * @param {object} o.cap        the capability row
 * @param {string} o.action     trade | snipe | x402
 * @param {string} [o.target]   mint / service URL / destination of this spend
 * @param {number} [o.usdValue] USD value of this spend (null = unpriceable)
 * @param {number|Date} [o.now]
 */
export function evaluateCapabilityScope({ cap, action, target, usdValue, now }) {
	const live = capabilityLive(cap, { now });
	if (!live.ok) return { reason: live.reason, detail: {} };
	if (!capabilityCoversAction(cap, action)) {
		return { reason: 'action_not_allowed', detail: { action, allowed: cap.actions || [] } };
	}
	if (!capabilityCoversTarget(cap, target)) {
		return { reason: 'target_not_allowed', detail: { target: target ?? null, target_kind: cap.target_kind } };
	}
	const perUse = checkPerUse(cap, usdValue);
	if (perUse) return perUse;
	return null;
}

// ── boundary message mapping ────────────────────────────────────────────────────

const CAP_MESSAGE = {
	not_found: () => 'No capability authorizes this action. Issue a scoped session key under Access, or remove the requirement.',
	tampered: () => 'This capability failed its integrity check and was rejected. Revoke it and issue a fresh one.',
	revoked: () => 'This capability has been revoked. Issue a new one under Access to allow this action.',
	expired: () => 'This capability has expired. Issue a new one under Access to allow this action.',
	action_not_allowed: (d) => `This capability does not allow ${d.action} actions (it allows: ${(d.allowed || []).join(', ') || 'none'}).`,
	target_not_allowed: (d) => `This capability is restricted to specific ${d.target_kind === 'service' ? 'services' : d.target_kind === 'mint' ? 'mints' : 'destinations'} and does not cover this one.`,
	per_use_exceeded: (d) => `This $${Number(d.usd).toFixed(2)} spend is over the capability's $${Number(d.per_use_usd).toFixed(2)} per-use limit.`,
	aggregate_exceeded: (d) => `This spend would bring the capability's total to $${(Number(d.spent_usd) + Number(d.usd)).toFixed(2)}, over its $${Number(d.aggregate_usd).toFixed(2)} budget.`,
	capability_required: () => 'This wallet requires a scoped capability for every autonomous spend, and none covers this action. Issue one under Access.',
};

/** Turn a capability reason into a CapabilityError ready for the boundary. */
export function capabilityError(reason, detail = {}) {
	const msg = (CAP_MESSAGE[reason] || (() => `Action not permitted by capability (${reason}).`))(detail);
	return new SpendLimitError(reason, msg, detail);
}

// ── DB: issuance + lifecycle ────────────────────────────────────────────────────

function shapeRow(row) {
	if (!row) return null;
	return {
		...row,
		actions: Array.isArray(row.actions) ? row.actions : [],
		targets: Array.isArray(row.targets) ? row.targets : [],
		per_use_usd: row.per_use_usd == null ? null : Number(row.per_use_usd),
		aggregate_usd: row.aggregate_usd == null ? null : Number(row.aggregate_usd),
	};
}

/**
 * Mint a capability. Validates + bounds the scope, signs it (tamper-evidence),
 * inserts the row, and writes a custody audit event. The owner-check is the
 * caller's responsibility (the endpoint gates ownership before calling).
 */
export async function mintCapability({
	agentId, userId, label, holderKind = 'manual', holderRef = null,
	actions, perUseUsd, aggregateUsd, targetKind, targets, expiresAt, ttlSeconds, meta = {}, now,
}) {
	const scope = normalizeCapabilityInput(
		{ actions, per_use_usd: perUseUsd, aggregate_usd: aggregateUsd, target_kind: targetKind, targets, expires_at: expiresAt, ttl_seconds: ttlSeconds },
		{ now },
	);
	const kind = HOLDER_KIND_SET.has(holderKind) ? holderKind : 'manual';
	const id = randomUUID();
	const cap = {
		id,
		agent_id: agentId,
		holder_kind: kind,
		holder_ref: holderRef ? cleanStr(holderRef, 128) : null,
		actions: scope.actions,
		per_use_usd: scope.perUseUsd,
		aggregate_usd: scope.aggregateUsd,
		target_kind: scope.targetKind,
		targets: scope.targets,
		expires_at: scope.expiresAt,
	};
	const grantSig = signGrant(cap);
	const cleanLabel = cleanStr(label, MAX_LABEL) || defaultLabel(kind, holderRef, scope.actions);

	const [row] = await sql`
		INSERT INTO agent_wallet_capabilities
			(id, agent_id, user_id, label, holder_kind, holder_ref, actions, per_use_usd,
			 aggregate_usd, target_kind, targets, expires_at, grant_sig, meta)
		VALUES (
			${id}, ${agentId}, ${userId}, ${cleanLabel}, ${kind}, ${cap.holder_ref},
			${scope.actions}, ${scope.perUseUsd}, ${scope.aggregateUsd}, ${scope.targetKind},
			${scope.targets}, ${scope.expiresAt.toISOString()}, ${grantSig},
			${JSON.stringify(meta || {})}::jsonb
		)
		RETURNING *
	`;

	await recordCustodyEvent({
		agentId, userId, eventType: 'capability_mint', category: null,
		reason: 'capability_minted', capabilityId: id,
		meta: {
			label: cleanLabel, holder_kind: kind, holder_ref: cap.holder_ref,
			actions: scope.actions, per_use_usd: scope.perUseUsd, aggregate_usd: scope.aggregateUsd,
			target_kind: scope.targetKind, targets: scope.targets, expires_at: scope.expiresAt.toISOString(),
		},
	}).catch((e) => console.warn('[capabilities] mint custody record failed', e?.message));

	return shapeRow(row);
}

function defaultLabel(kind, holderRef, actions) {
	const verb = actions.join('/');
	if (kind === 'strategy') return `Strategy · ${verb}`;
	if (kind === 'integration') return `Integration · ${verb}`;
	if (kind === 'skill') return `Skill · ${verb}`;
	return `${verb} capability`;
}

export async function getCapability(id) {
	const [row] = await sql`SELECT * FROM agent_wallet_capabilities WHERE id = ${id}`;
	return shapeRow(row);
}

/** Sum the priced spend a capability has consumed (its aggregate-ceiling ledger). */
export async function capabilitySpentUsd(id) {
	const [row] = await sql`
		SELECT COALESCE(SUM(usd), 0)::float8 AS usd
		FROM agent_custody_events
		WHERE capability_id = ${id}
		  AND status IN ('ok', 'pending', 'confirmed')
		  AND usd IS NOT NULL
	`;
	return Number(row?.usd || 0);
}

/**
 * List a wallet's capabilities for the owner Access surface, each decorated with
 * its live status and how much of its budget is spent. Newest first.
 */
export async function listCapabilities(agentId, { includeRevoked = true, now } = {}) {
	const rows = await sql`
		SELECT c.*, COALESCE(s.spent, 0)::float8 AS spent_usd, COALESCE(s.uses, 0)::int AS spend_count
		FROM agent_wallet_capabilities c
		LEFT JOIN (
			SELECT capability_id, SUM(usd) AS spent, COUNT(*) AS uses
			FROM agent_custody_events
			WHERE capability_id IS NOT NULL
			  AND status IN ('ok', 'pending', 'confirmed')
			GROUP BY capability_id
		) s ON s.capability_id = c.id
		WHERE c.agent_id = ${agentId}
		  ${includeRevoked ? sql`` : sql`AND c.revoked_at IS NULL`}
		ORDER BY c.created_at DESC
		LIMIT 200
	`;
	const t = nowMs(now);
	return rows.map((row) => {
		const cap = shapeRow(row);
		const live = capabilityLive(cap, { now: t });
		const status = live.ok ? 'active' : live.reason; // active | revoked | expired | tampered
		return {
			id: cap.id,
			label: cap.label,
			holder_kind: cap.holder_kind,
			holder_ref: cap.holder_ref,
			actions: cap.actions,
			per_use_usd: cap.per_use_usd,
			aggregate_usd: cap.aggregate_usd,
			target_kind: cap.target_kind,
			targets: cap.targets,
			expires_at: cap.expires_at,
			revoked_at: cap.revoked_at,
			revoked_reason: cap.revoked_reason,
			created_at: cap.created_at,
			last_used_at: cap.last_used_at,
			use_count: cap.use_count,
			spent_usd: Number(row.spent_usd || 0),
			spend_count: Number(row.spend_count || 0),
			status,
		};
	});
}

/**
 * Resolve the best live capability that covers an autonomous spend for a holder.
 * Autonomous callers (sniper, x402) use this to FIND the grant to present without
 * the owner threading an id through every call. Prefers a holder_ref match, then
 * any holder; among candidates picks the one expiring soonest with budget left, so
 * a tight short-lived grant is consumed before a looser one. Returns null when no
 * live capability covers the action+target.
 */
export async function resolveCapabilityForSpend({ agentId, action, holderRef = null, target = null, usdValue = null, now }) {
	const rows = await sql`
		SELECT * FROM agent_wallet_capabilities
		WHERE agent_id = ${agentId}
		  AND revoked_at IS NULL
		  AND expires_at > now()
		  AND ${action} = ANY(actions)
		ORDER BY (holder_ref IS NOT DISTINCT FROM ${holderRef}) DESC, expires_at ASC
		LIMIT 50
	`;
	for (const raw of rows) {
		const cap = shapeRow(raw);
		const scope = evaluateCapabilityScope({ cap, action, target, usdValue, now });
		if (scope) continue; // out of scope (target/per-use/integrity) — try the next
		return cap;
	}
	return null;
}

/** Revoke one capability immediately (owner-gated by the caller). Idempotent. */
export async function revokeCapability(id, { agentId, userId, reason = 'owner_revoked' } = {}) {
	const [row] = await sql`
		UPDATE agent_wallet_capabilities
		SET revoked_at = now(), revoked_reason = ${cleanStr(reason, 80) || 'owner_revoked'}, updated_at = now()
		WHERE id = ${id}
		  AND ${agentId}::uuid IS NOT DISTINCT FROM agent_id
		  AND revoked_at IS NULL
		RETURNING id, label
	`;
	if (!row) return null;
	await recordCustodyEvent({
		agentId, userId, eventType: 'capability_revoke', capabilityId: id,
		reason: 'capability_revoked', meta: { label: row.label, reason },
	}).catch((e) => console.warn('[capabilities] revoke custody record failed', e?.message));
	return row;
}

/** Revoke every live capability for an agent at once ("kill all"). Returns count. */
export async function revokeAllCapabilities(agentId, userId, reason = 'owner_revoked_all') {
	const rows = await sql`
		UPDATE agent_wallet_capabilities
		SET revoked_at = now(), revoked_reason = ${cleanStr(reason, 80) || 'owner_revoked_all'}, updated_at = now()
		WHERE agent_id = ${agentId} AND revoked_at IS NULL
		RETURNING id
	`;
	if (rows.length) {
		await recordCustodyEvent({
			agentId, userId, eventType: 'capability_revoke', reason: 'capability_revoked_all',
			meta: { count: rows.length, reason },
		}).catch((e) => console.warn('[capabilities] revoke-all custody record failed', e?.message));
	}
	return rows.length;
}

// ── hot path: atomic scoped reserve ─────────────────────────────────────────────

/**
 * Atomically verify a capability covers a spend AND reserve a pending custody row
 * against its aggregate ceiling (and, when supplied, the wallet daily and
 * per-counterparty ceilings), under per-capability + per-agent advisory locks. Every
 * wallet-wide ceiling reserveSpendUsd meters has to be metered HERE too: this branch
 * replaces that reserve, so a cap it forgot would be a cap a capability-authorized
 * spend simply does not have. This is the capability analogue
 * of reserveSpendUsd: check + reserve are ONE statement, so concurrent uses can
 * never both pass on the same stale total and overspend a leash.
 *
 * The capability is RE-LOADED inside the locked statement, so a revoke or a spend
 * that landed a microsecond earlier is always seen — revocation can't be raced.
 *
 * Returns { reservationId, capability, spentBefore }. Finalize with
 * updateCustodyEvent(reservationId, { status, signature }) after settlement, or
 * releaseSpendReservation(reservationId) if the spend never moved.
 *
 * @throws {CapabilityError} on integrity / scope / per-use / aggregate breach.
 */
export async function reserveCapabilitySpend({
	capabilityId, agentId, userId, action, target = null, usdValue,
	dailyUsd = null, counterpartyDailyUsd = null,
	network = 'mainnet', asset = null, destination = null, rowMeta = {}, now,
}) {
	const cap = await getCapability(capabilityId);
	if (!cap || String(cap.agent_id) !== String(agentId)) throw capabilityError('not_found', {});

	// Static scope checks first (cheap, no lock): integrity, expiry, revoked at read
	// time, action, target, per-use. The authoritative revoke/expiry re-check happens
	// again inside the locked statement below so a concurrent revoke can't slip through.
	const scope = evaluateCapabilityScope({ cap, action, target, usdValue, now });
	if (scope) throw capabilityError(scope.reason, scope.detail);

	const hasUsd = typeof usdValue === 'number' && Number.isFinite(usdValue) && usdValue >= 0;
	const metaJson = JSON.stringify({ ...(rowMeta || {}), action, target: target ?? null });

	// The per-counterparty ceiling only has something to meter when the spend names
	// a recipient; an unaddressed spend falls back to the wallet-wide ceilings.
	const cpCap = destination ? counterpartyDailyUsd : null;
	const cpDestination = cpCap != null ? destination : null;

	// No priceable amount and no metered cap → nothing to meter; still write the
	// pending row tagged with the capability so it shows on the leash + audit trail.
	// (Per-use was already checked above; an unpriceable spend can't gate a USD cap.)
	if (!hasUsd || (cap.aggregate_usd == null && dailyUsd == null && cpCap == null)) {
		const reservationId = await reserveUnmetered({ cap, agentId, userId, action, network, asset, destination, usd: hasUsd ? usdValue : null, metaJson });
		if (reservationId == null) throw capabilityError('revoked', {}); // lost the revoke race
		return { reservationId, capability: cap, spentBefore: null };
	}

	// Atomic metered reserve. Two advisory locks (capability + agent) serialize
	// concurrent spends touching this leash and/or this wallet's daily cap. The
	// INSERT…SELECT materializes the pending row ONLY when, at this instant, the
	// capability is still live AND both ceilings have room. `live` re-reads the row
	// under the lock, so a revoke/expiry that landed first is always honored.
	const aggCap = cap.aggregate_usd == null ? null : Number(cap.aggregate_usd);
	const dCap = dailyUsd == null ? null : Number(dailyUsd);
	const rows = await sql`
		WITH lock_cap AS (
			SELECT pg_advisory_xact_lock(hashtextextended(${'cap:' + String(capabilityId)}, 0))
		),
		lock_agent AS (
			SELECT pg_advisory_xact_lock(hashtextextended(${String(agentId)}, 0))
		),
		live AS (
			SELECT id FROM agent_wallet_capabilities
			WHERE id = ${capabilityId} AND revoked_at IS NULL AND expires_at > now()
		),
		cap_spent AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE capability_id = ${capabilityId}
			  AND status IN ('ok', 'pending', 'confirmed') AND usd IS NOT NULL
		),
		day_spent AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId} AND network = ${network}
			  AND event_type = 'spend' AND status IN ('ok', 'pending', 'confirmed')
			  AND usd IS NOT NULL AND created_at > now() - interval '24 hours'
		),
		cp_spent AS (
			SELECT COALESCE(SUM(usd), 0)::float8 AS s
			FROM agent_custody_events
			WHERE agent_id = ${agentId} AND network = ${network}
			  AND event_type = 'spend' AND destination = ${cpDestination}
			  AND status IN ('ok', 'pending', 'confirmed')
			  AND usd IS NOT NULL AND created_at > now() - interval '24 hours'
		)
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset, usd, destination, status, capability_id, meta)
		SELECT ${agentId}, ${userId ?? null}, 'spend', ${action}, ${network}, ${asset},
		       ${usdValue}, ${destination ?? null}, 'pending', ${capabilityId}, ${metaJson}::jsonb
		FROM cap_spent, day_spent, cp_spent, lock_cap, lock_agent
		WHERE (SELECT count(*) FROM live) = 1
		  AND (${aggCap}::float8 IS NULL OR cap_spent.s + ${usdValue}::float8 <= ${aggCap}::float8 + 1e-9)
		  AND (${dCap}::float8 IS NULL OR day_spent.s + ${usdValue}::float8 <= ${dCap}::float8 + 1e-9)
		  AND (${cpCap}::float8 IS NULL OR cp_spent.s + ${usdValue}::float8 <= ${cpCap}::float8 + 1e-9)
		RETURNING id, (SELECT s FROM cap_spent) AS cap_before, (SELECT s FROM day_spent) AS day_before
	`;

	if (!rows.length) {
		// Distinguish WHY nothing inserted so the boundary message is honest: a
		// concurrent revoke/expiry vs. an exhausted ceiling. Re-read outside the lock.
		const fresh = await getCapability(capabilityId);
		const liveNow = capabilityLive(fresh, { now });
		if (!liveNow.ok) throw capabilityError(liveNow.reason, {});
		const spent = await capabilitySpentUsd(capabilityId);
		const agg = checkAggregate(spent, usdValue, cap);
		if (agg) throw capabilityError(agg.reason, agg.detail);
		// Otherwise a wallet-wide ceiling rejected it. Name the right one: telling an
		// owner to wait out a daily window they never hit hides a concentrated payee.
		if (cpCap != null) {
			const cpSpent = await getCounterpartySpendUsd(agentId, destination, network);
			if (cpSpent + usdValue > cpCap + 1e-9) {
				throw new SpendLimitError(
					'counterparty_daily_exceeded',
					`This spend would bring today’s spend to this counterparty to $${(cpSpent + usdValue).toFixed(2)}, over the per-counterparty limit of $${cpCap.toFixed(2)}.`,
					{ usd: usdValue, destination, counterparty_spent_usd: cpSpent, per_counterparty_daily_usd: cpCap },
				);
			}
		}
		throw new SpendLimitError('daily_exceeded', `This spend would exceed the wallet's daily limit of $${Number(dCap).toFixed(2)}.`, { spent_usd: 0, daily_usd: dCap });
	}

	// Best-effort usage stats (not on the spend hot path's critical correctness).
	void sql`UPDATE agent_wallet_capabilities SET use_count = use_count + 1, last_used_at = now(), updated_at = now() WHERE id = ${capabilityId}`
		.catch(() => {});

	return { reservationId: rows[0].id, capability: cap, spentBefore: Number(rows[0].cap_before || 0) };
}

// Unmetered reserve: a capability spend with no USD ceiling to meter. Still gated
// on the capability being live at insert time (so a revoke is never raced) and
// tagged with capability_id for the audit trail + leash UI.
async function reserveUnmetered({ cap, agentId, userId, action, network, asset, destination, usd, metaJson }) {
	const rows = await sql`
		WITH lock_cap AS (
			SELECT pg_advisory_xact_lock(hashtextextended(${'cap:' + String(cap.id)}, 0))
		),
		live AS (
			SELECT id FROM agent_wallet_capabilities
			WHERE id = ${cap.id} AND revoked_at IS NULL AND expires_at > now()
		)
		INSERT INTO agent_custody_events
			(agent_id, user_id, event_type, category, network, asset, usd, destination, status, capability_id, meta)
		SELECT ${agentId}, ${userId ?? null}, 'spend', ${action}, ${network}, ${asset},
		       ${usd}, ${destination ?? null}, 'pending', ${cap.id}, ${metaJson}::jsonb
		FROM live, lock_cap
		WHERE (SELECT count(*) FROM live) = 1
		RETURNING id
	`;
	if (!rows.length) return null;
	void sql`UPDATE agent_wallet_capabilities SET use_count = use_count + 1, last_used_at = now(), updated_at = now() WHERE id = ${cap.id}`
		.catch(() => {});
	return rows[0].id;
}
