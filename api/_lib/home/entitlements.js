/**
 * What a plan lets a house do, and the one thing no plan may ever stop it doing.
 *
 * ── The cost model, because it decides the shape of everything below ─────────
 *
 * The expensive thing in this lane is not an action. It is a HELD SOCKET. A
 * house that is connected and idle occupies heap on a Cloud Run instance for
 * the entire month whether or not anybody speaks to it, so a plan metered only
 * on actions would charge nothing for the dominant cost. That is why `homes`
 * is the first dimension here and why it is the one enforced at acquisition.
 *
 * Measured, not assumed (scripts/measure-home-entitlement-cost.mjs, 2026-09-03,
 * 16 real WebSocket connections against a real Home Assistant with 125
 * entities, priced against the production service shape and the live Cloud Run
 * SKUs from Google's own billing catalog):
 *
 *   302 KB heap / 262 KB RSS per live connection   →  $0.0155 per home per month
 *   23,036-byte room graph per stream event        →  $0.0066 per open stream per month
 *   an agent turn on the default free LLM chain    →  $0
 *   the same turn on Claude Sonnet 5               →  $0.0228
 *
 * The finding that number produces is worth stating plainly: **one agent turn on
 * a paid model costs more than a year of holding that house's socket.** The free
 * tier can therefore carry a genuinely connected home, and the limits below are
 * generous on connections and careful on paid-model turns, which is the opposite
 * of what the cost model looked like before it was measured.
 *
 * ── The five commitments ─────────────────────────────────────────────────────
 *
 * These are product commitments, not implementation details, and the first and
 * last are the ones to fight for if anybody pushes back:
 *
 *   1. A LIMIT NEVER BLOCKS A SAFETY ACTION. Over quota, past due, downgraded,
 *      suspended: a user can still lock their door, close their garage, close a
 *      water valve and arm their alarm. The safe direction is always free. A
 *      product that will not let someone lock up because they hit a quota is
 *      indefensible, and `isQuotaExempt` below is where that is enforced rather
 *      than promised. It delegates to the home-bridge package's own
 *      `isSafetyAction`, so the list of safe moves is a fact about Home
 *      Assistant kept in one place, never a copy in the billing code.
 *
 *   2. DOWNGRADING NEVER SILENTLY DISCONNECTS A HOUSE. Connections over the new
 *      limit are marked inactive with a written explanation and the user picks
 *      which to keep. Nothing is deleted, no credential is scrubbed, no action
 *      log loses its lineage. See `planDowngrade` and `applyDowngrade`.
 *
 *   3. A QUOTA IS SHOWN BEFORE IT IS HIT, on the manage surface, with the reset
 *      date. `describeEntitlements` returns exactly what that surface renders.
 *
 *   4. ENTERPRISE LIMITS ARE CONFIGURABLE PER ACCOUNT, not hardcoded, because
 *      that is what the sales conversation is. `home_plan_overrides` carries
 *      them and raising one is a row, never a deploy.
 *
 *   5. NOTHING ABOUT THE GATE IS A PAID FEATURE. Confirmations, the audit log's
 *      integrity and the role system's safety properties exist on every tier.
 *      Selling safety would be wrong and it would also make the free tier a
 *      liability. There is deliberately no dimension below for any of them, and
 *      there must never be one.
 *
 * ── Where the numbers come from ──────────────────────────────────────────────
 *
 * This module does NOT invent a fourth entitlement system. It reads the two that
 * already exist:
 *
 *   api/_lib/account-tier.js  the membership modes (user, beta, pro, holder,
 *                             three-dimensional) and the resolver over them.
 *   api/_lib/three-tier.js    the $THREE holder ladder and its `rateMultiplier`,
 *                             which is already defined as "scales free quotas".
 *
 * A member wears several badges at once, so a limit is the MAX across every
 * active badge, never the primary badge's alone: a Pro subscriber who also holds
 * $THREE must not lose Pro's connection limit because `holder` outranks `pro`.
 *
 * Every number is env-overridable (`HOME_LIMIT_<TIER>_<DIMENSION>`), so applying
 * an owner-approved price is a config change on a running service and not a
 * deploy. The defaults below are a PROPOSAL: see docs/home-plans.md.
 */

import { isSafetyAction, isSafetyMcpCall } from '@three-ws/home-bridge';

import { ACCOUNT_TIERS, detectHolder, resolveAccountTier } from '../account-tier.js';
import { sql } from '../db.js';
import { withDbRetry } from '../db-retry.js';
import { tierForUsd } from '../three-tier.js';

/** No limit. Chosen over `null` so a comparison never silently passes on a typo. */
export const UNLIMITED = Number.POSITIVE_INFINITY;

/**
 * The dimensions we meter, each with the measured cost that justifies metering
 * it at all. A dimension without a cost behind it is a dimension we should not
 * be charging for, so `costPerUnitUsd` is required and `costBasis` says how it
 * was read.
 *
 * `scalesWithHolding` marks the dimensions the $THREE ladder's `rateMultiplier`
 * applies to. Structural, sold-not-held dimensions (household members) are
 * deliberately excluded: holding a bag is not the same purchase as buying seats
 * for a hotel, and multiplying one by the other prices neither correctly.
 */
export const HOME_DIMENSIONS = Object.freeze({
	homes: Object.freeze({
		id: 'homes',
		label: 'Connected homes',
		unit: 'home',
		scope: 'account',
		period: 'concurrent',
		scalesWithHolding: true,
		costPerUnitUsd: 0.0155,
		costBasis: 'per month; 302 KB heap / 262 KB RSS per live WebSocket, 16 connections against a real Home Assistant, priced on the production 4 GiB / 2 vCPU shape at the live us-central1 Cloud Run rate',
		why: 'A connected house holds a socket for the whole month whether or not anyone speaks to it. This is the lane’s primary cost.',
	}),
	members: Object.freeze({
		id: 'members',
		label: 'Household members per home',
		unit: 'member',
		scope: 'home',
		period: 'concurrent',
		scalesWithHolding: false,
		costPerUnitUsd: 0,
		costBasis: 'no marginal infrastructure cost; a member is a row in home_members and shares the home’s single pooled socket',
		why: 'The enterprise dimension. A hotel or an office buys seats, and seats are the sales conversation, not a compute cost.',
	}),
	streams: Object.freeze({
		id: 'streams',
		label: 'Live streams per home',
		unit: 'stream',
		scope: 'home',
		period: 'concurrent',
		scalesWithHolding: true,
		costPerUnitUsd: 0.0066,
		costBasis: 'per month; a 23,036-byte room graph serialized once per 10 s, priced at the live us-central1 Cloud Run CPU and memory rates',
		why: 'A wall display left open all month is a subscriber we serialize the house to on every state change.',
	}),
	voiceMinutes: Object.freeze({
		id: 'voiceMinutes',
		label: 'Voice minutes',
		unit: 'minute',
		scope: 'account',
		period: 'month',
		scalesWithHolding: true,
		costPerUnitUsd: 0,
		costBasis: 'the default lanes are keyless: Edge Read Aloud TTS (api/_lib/tts-edge.js) and NVIDIA Riva ASR (api/_lib/asr-nvidia.js) both cost the platform nothing per utterance',
		why: 'Metered because a paid speech lane can be selected and because an unbounded always-listening satellite is an abuse surface, not because the default lane costs money.',
	}),
	agentTurns: Object.freeze({
		id: 'agentTurns',
		label: 'Agent turns',
		unit: 'turn',
		scope: 'account',
		period: 'month',
		scalesWithHolding: true,
		costPerUnitUsd: 0,
		costBasis: 'the default provider chain leads with platform-held free lanes (isFreeLane in api/_lib/llm-pricing.js); the same 6,359-token home prompt costs $0.0025 on Vertex Gemini 2.5 Flash and $0.0228 on Claude Sonnet 5 when a paid model is chosen',
		why: 'The room graph makes a home prompt large. On a paid model one turn costs more than a year of holding that house’s socket, so the turn is the dimension that actually needs a ceiling.',
	}),
	logRetentionDays: Object.freeze({
		id: 'logRetentionDays',
		label: 'Action-log retention',
		unit: 'day',
		scope: 'account',
		period: 'retention',
		scalesWithHolding: true,
		costPerUnitUsd: 0,
		costBasis: 'Neon row storage; a busy evening of voice control is a few dozen rows of a few hundred bytes each',
		why: 'A natural enterprise upsell: a hotel needs a year of attribution, a household needs last Tuesday. Length is the product, never the log’s integrity.',
		// A CEILING on what a user may set, never a value of its own. Order 15
		// (api/_lib/home/privacy.js) owns the per-home retention setting, its
		// default of 90 days and the purge that enforces it; this only caps how
		// high that setting may go. It is checked when the user changes the
		// setting and NEVER applied retroactively: shortening somebody's existing
		// audit trail for a billing reason would destroy their evidence, which is
		// the log's integrity, which commitment 5 puts out of reach of a plan.
		ceilingOnly: true,
	}),
	relayConnections: Object.freeze({
		id: 'relayConnections',
		label: 'Relay connections',
		unit: 'relay',
		scope: 'account',
		period: 'concurrent',
		scalesWithHolding: true,
		costPerUnitUsd: 0.0155,
		costBasis: 'the same held-socket cost as a direct home; a relay is an inbound socket instead of an outbound one',
		why: 'A LAN-only house reaches us through a sustained dial-out tunnel, which costs what a direct connection costs.',
	}),
});

/** Dimension ids, in the order the manage surface renders them. */
export const HOME_DIMENSION_IDS = Object.freeze(Object.keys(HOME_DIMENSIONS));

/**
 * The proposed defaults, per account-tier badge.
 *
 * PROPOSAL, not a decision. The mechanism is complete and every number here is
 * a config value: `HOME_LIMIT_PRO_HOMES=25` on the running service raises Pro's
 * connection limit with no deploy and no code change. See docs/home-plans.md for
 * the table put to the owner and the measured cost behind each row.
 *
 * The shape follows the cost: connections are cheap so the free tier gets a real
 * one, and turns are the dimension where a paid model can actually spend money
 * so that is where the tiers separate.
 */
const DEFAULT_LIMITS = Object.freeze({
	user: Object.freeze({
		homes: 1,
		members: 3,
		streams: 2,
		voiceMinutes: 300,
		agentTurns: 1000,
		logRetentionDays: 90,
		relayConnections: 1,
	}),
	beta: Object.freeze({
		homes: 2,
		members: 5,
		streams: 3,
		voiceMinutes: 600,
		agentTurns: 2500,
		logRetentionDays: 90,
		relayConnections: 1,
	}),
	pro: Object.freeze({
		homes: 5,
		members: 15,
		streams: 10,
		voiceMinutes: 3000,
		agentTurns: 15000,
		logRetentionDays: 365,
		relayConnections: 5,
	}),
	holder: Object.freeze({
		homes: 1,
		members: 3,
		streams: 2,
		voiceMinutes: 300,
		agentTurns: 1000,
		logRetentionDays: 90,
		relayConnections: 1,
	}),
	'three-dimensional': Object.freeze({
		homes: UNLIMITED,
		members: UNLIMITED,
		streams: UNLIMITED,
		voiceMinutes: UNLIMITED,
		agentTurns: UNLIMITED,
		// Not UNLIMITED: home_connections_retention_days_chk caps the stored value
		// at ten years, so an "unlimited" ceiling here would offer a number the
		// database refuses. A limit the schema cannot honour is a broken promise.
		logRetentionDays: 3650,
		relayConnections: UNLIMITED,
	}),
});

const TIER_IDS = Object.freeze(ACCOUNT_TIERS.map((t) => t.id));

/**
 * `HOME_LIMIT_<TIER>_<DIMENSION>`, upper snake case, e.g.
 * `HOME_LIMIT_THREE_DIMENSIONAL_AGENT_TURNS`. `unlimited` and `-1` both mean no
 * limit; anything unparseable is ignored so a typo degrades to the default
 * rather than to zero, which would lock an account out of its own house.
 */
function envLimit(tierId, dimensionId) {
	const key = `HOME_LIMIT_${screamingSnake(tierId)}_${screamingSnake(dimensionId)}`;
	const raw = process.env[key];
	if (raw == null || String(raw).trim() === '') return null;
	return parseLimit(raw);
}

function parseLimit(raw) {
	const s = String(raw).trim().toLowerCase();
	if (s === 'unlimited' || s === 'infinity' || s === '-1') return UNLIMITED;
	const n = Number.parseInt(s, 10);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function screamingSnake(id) {
	return String(id)
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[^A-Za-z0-9]+/g, '_')
		.toUpperCase();
}

/**
 * The configured limits for one badge, env overrides applied.
 * @param {string} tierId
 * @returns {Record<string, number>}
 */
export function limitsForTier(tierId) {
	const base = DEFAULT_LIMITS[tierId] || DEFAULT_LIMITS.user;
	const out = {};
	for (const dimension of HOME_DIMENSION_IDS) {
		const override = envLimit(tierId, dimension);
		out[dimension] = override == null ? base[dimension] : override;
	}
	return out;
}

/**
 * Merge a set of badges into one limit set by taking the max per dimension.
 *
 * Max, not the primary badge's value, because badges are additive: `holder`
 * outranks `pro` on the display ladder, and a Pro subscriber who also holds
 * $THREE must not lose Pro's connection limit by buying some of the coin.
 */
function mergeBadgeLimits(badgeIds) {
	const merged = {};
	for (const dimension of HOME_DIMENSION_IDS) merged[dimension] = 0;
	for (const id of badgeIds) {
		const limits = limitsForTier(id);
		for (const dimension of HOME_DIMENSION_IDS) {
			if (limits[dimension] > merged[dimension]) merged[dimension] = limits[dimension];
		}
	}
	return merged;
}

/**
 * One account's effective limits, and everything the manage surface needs to
 * explain them.
 *
 * Pure over its inputs so it unit-tests without a wallet RPC or a database:
 * `resolveHomeEntitlements` does the I/O and calls this.
 *
 * @param {{ account_tier?: string|null, plan?: string|null }} user
 * @param {object} [opts]
 * @param {{ isHolder: boolean, amount: number, usd: number }} [opts.holder]
 * @param {Record<string, number>|null} [opts.override] per-account overrides
 * @returns {{
 *   tier: object, badges: object[], holderTier: object, multiplier: number,
 *   limits: Record<string, number>, sources: Record<string, string>,
 *   dimensions: object,
 * }}
 */
export function computeEntitlements(user, { holder = { isHolder: false, amount: 0, usd: 0 }, override = null } = {}) {
	const account = resolveAccountTier(user, { holder });
	const badgeIds = account.badges.map((b) => b.id);
	const base = mergeBadgeLimits(badgeIds);

	// The $THREE ladder already models holding. Read its multiplier; never model
	// holding a second time with thresholds of our own.
	const holderTier = tierForUsd(holder.usd);
	const multiplier = Math.max(1, Number(holderTier.rateMultiplier) || 1);

	const limits = {};
	const sources = {};
	for (const dimension of HOME_DIMENSION_IDS) {
		let value = base[dimension];
		sources[dimension] = 'plan';
		if (HOME_DIMENSIONS[dimension].scalesWithHolding && multiplier > 1 && Number.isFinite(value)) {
			value = value * multiplier;
			sources[dimension] = 'holder-multiplier';
		}
		if (override && Object.prototype.hasOwnProperty.call(override, dimension)) {
			const parsed = typeof override[dimension] === 'number' ? override[dimension] : parseLimit(override[dimension]);
			// An override is the sales conversation, so it wins in both directions:
			// an enterprise deal can raise a limit and a fair-use agreement can cap
			// one. It is never silently ignored.
			if (parsed != null) {
				value = parsed;
				sources[dimension] = 'account-override';
			}
		}
		limits[dimension] = value;
	}

	return {
		tier: account.primary,
		badges: account.badges,
		plan: account.plan,
		holder,
		holderTier,
		multiplier,
		limits,
		sources,
		dimensions: HOME_DIMENSIONS,
	};
}

/**
 * The same thing, with the reads. Resolves the caller's on-chain $THREE standing
 * and their per-account override row.
 *
 * Fails toward the user on every read: an unreachable price oracle resolves a
 * holder to the Member floor rather than throwing, and an unreadable override
 * row falls back to the plan's limits rather than to zero.
 *
 * @param {{ id: string, account_tier?: string|null, plan?: string|null }} user
 * @param {object} [opts]
 * @param {string[]} [opts.walletAddresses]
 * @returns {Promise<object>}
 */
export async function resolveHomeEntitlements(user, { walletAddresses = [] } = {}) {
	const wallets = walletAddresses.length ? walletAddresses : [user?.wallet_address].filter(Boolean);
	const [holder, override] = await Promise.all([
		detectHolder(wallets).catch(() => ({ isHolder: false, amount: 0, usd: 0 })),
		getAccountOverride(user?.id).catch(() => null),
	]);
	const resolved = computeEntitlements(user, { holder, override: override?.limits || null });
	return { ...resolved, override };
}

/**
 * The same thing, from a user id alone, which is what every route actually has.
 *
 * Reads the account exactly the way /api/users/me/tier already does: the plan
 * and grant columns from `users`, plus every Solana wallet the account controls
 * (the login wallet and any linked ones), because $THREE may be held in any of
 * them and a holder who is only credited for one wallet is a holder we have
 * under-served.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function resolveHomeEntitlementsForUser(userId) {
	const rows = await withDbRetry(() => sql`
		select id, plan, account_tier, wallet_address
		from users
		where id = ${userId} and deleted_at is null
		limit 1
	`);
	const user = rows[0];
	if (!user) throw new Error('resolveHomeEntitlementsForUser: no such account');

	const linked = await withDbRetry(() => sql`
		select address from user_wallets
		where user_id = ${userId} and chain_type = 'solana'
	`).catch(() => []);

	const wallets = [user.wallet_address, ...linked.map((w) => w.address)].filter(Boolean);
	return resolveHomeEntitlements(user, { walletAddresses: wallets });
}

// ── Per-account overrides ────────────────────────────────────────────────────

/**
 * The enterprise row. One per account, set by an admin, with the reason on it,
 * because "why does this account have 400 homes" is a question somebody asks six
 * months later and the answer has to be in the row rather than in a memory.
 *
 * @param {string} userId
 * @returns {Promise<{ limits: Record<string, number>, note: string|null, setBy: string|null, updatedAt: string }|null>}
 */
export async function getAccountOverride(userId) {
	if (!userId) return null;
	const rows = await withDbRetry(() => sql`
		select limits, note, set_by, updated_at
		from home_plan_overrides
		where user_id = ${userId}
	`);
	if (!rows.length) return null;
	return {
		limits: rows[0].limits || {},
		note: rows[0].note || null,
		setBy: rows[0].set_by || null,
		updatedAt: rows[0].updated_at,
	};
}

/**
 * Write or replace an account's override. Only known dimensions survive, so a
 * typo in an admin form cannot install a limit nothing reads.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {Record<string, number|string>} input.limits
 * @param {string|null} [input.note] why this account has these limits
 * @param {string|null} [input.setBy] the admin's user id
 */
export async function setAccountOverride({ userId, limits, note = null, setBy = null }) {
	if (!userId) throw new Error('setAccountOverride: userId is required');
	const clean = {};
	for (const [key, value] of Object.entries(limits || {})) {
		if (!HOME_DIMENSIONS[key]) continue;
		const parsed = typeof value === 'number' && Number.isFinite(value) ? value : parseLimit(value);
		if (parsed != null) clean[key] = parsed === UNLIMITED ? 'unlimited' : parsed;
	}
	const rows = await withDbRetry(() => sql`
		insert into home_plan_overrides (user_id, limits, note, set_by)
		values (${userId}, ${JSON.stringify(clean)}::jsonb, ${note}, ${setBy})
		on conflict (user_id) do update set
			limits     = excluded.limits,
			note       = excluded.note,
			set_by     = excluded.set_by,
			updated_at = now()
		returning limits, note, set_by, updated_at
	`);
	return rows[0];
}

/** Remove an account's override, returning it to its plan's limits. */
export async function clearAccountOverride(userId) {
	if (!userId) return false;
	const rows = await withDbRetry(() => sql`
		delete from home_plan_overrides where user_id = ${userId} returning user_id
	`);
	return rows.length > 0;
}

// ── The safety exemption ─────────────────────────────────────────────────────

/**
 * Is this call one no commercial limit may ever refuse?
 *
 * COMMITMENT 1 LIVES HERE. Every enforcement point in the lane calls this first
 * and returns without consulting a counter when it answers true. There is no
 * tier, no override, no past-due state and no suspension in which locking a
 * door, closing a garage, closing a water valve or arming an alarm is refused
 * by this platform.
 *
 * The list of safe moves is NOT duplicated here. It comes from
 * `@three-ws/home-bridge`'s `isSafetyAction`, beside the gate it mirrors,
 * because what a lock can do is a fact about Home Assistant and not a fact about
 * a price list.
 *
 * @param {object} call
 * @param {string} [call.domain]
 * @param {string} [call.service]
 * @param {object} [call.attributes]
 * @param {string} [call.tool] an MCP tool name, when the call arrives on that channel
 * @param {object} [call.arguments] the MCP tool's arguments
 * @param {Array<object>} [call.entities] the live entity list, for MCP target resolution
 * @returns {boolean}
 */
export function isQuotaExempt(call = {}) {
	if (call.tool) return isSafetyMcpCall(call.tool, call.arguments || {}, call.entities || []);
	return isSafetyAction({ domain: call.domain, service: call.service, attributes: call.attributes || {} });
}

// ── Enforcement ──────────────────────────────────────────────────────────────

/**
 * A refusal a user can act on. Never a 500, never a bare "quota exceeded": it
 * names the limit, what they are using, when it resets, and what to do next.
 */
export class HomeQuotaError extends Error {
	/**
	 * @param {object} input
	 * @param {string} input.dimension
	 * @param {number} input.limit
	 * @param {number} input.used
	 * @param {string|null} [input.resetAt]
	 * @param {object} [input.tier]
	 * @param {string} [input.message]
	 */
	constructor({ dimension, limit, used, resetAt = null, tier = null, message = null }) {
		const meta = HOME_DIMENSIONS[dimension];
		super(message || defaultQuotaMessage({ dimension, limit, used, resetAt, tier }));
		this.name = 'HomeQuotaError';
		this.code = 'quota_exceeded';
		this.status = 402;
		this.dimension = dimension;
		this.dimensionLabel = meta?.label || dimension;
		this.limit = limit;
		this.used = used;
		this.resetAt = resetAt;
		this.tierId = tier?.id || null;
		this.upgradePath = '/pricing';
	}
}

function defaultQuotaMessage({ dimension, limit, used, resetAt, tier }) {
	const meta = HOME_DIMENSIONS[dimension];
	const label = (meta?.label || dimension).toLowerCase();
	const plan = tier?.label ? `Your ${tier.label} plan` : 'Your plan';
	const head = `${plan} covers ${limit} ${limit === 1 ? meta?.unit || label : plural(meta?.unit || label)}, and you are using ${used}.`;
	const tail = resetAt
		? `This resets on ${formatResetDate(resetAt)}. You can upgrade at three.ws/pricing to raise it now.`
		: 'Upgrade at three.ws/pricing to raise it, or free one up on your homes page.';
	const safe = 'Locking up, closing a garage or valve and arming an alarm are never affected by a limit.';
	return `${head} ${tail} ${safe}`;
}

function plural(unit) {
	return /s$/.test(unit) ? unit : `${unit}s`;
}

function formatResetDate(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return 'the start of next month';
	return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The one enforcement primitive. Every call site in the lane goes through it so
 * the safety exemption cannot be forgotten at one of them.
 *
 * @param {object} input
 * @param {object} input.entitlements from resolveHomeEntitlements
 * @param {string} input.dimension
 * @param {number} input.used current usage, exclusive of the request being made
 * @param {number} [input.cost] how many units this request consumes
 * @param {string|null} [input.resetAt]
 * @param {object|null} [input.call] the physical call, when there is one
 * @returns {{ allowed: true, exempt: boolean, remaining: number }}
 * @throws {HomeQuotaError}
 */
export function assertWithinLimit({ entitlements, dimension, used, cost = 1, resetAt = null, call = null }) {
	if (call && isQuotaExempt(call)) {
		return { allowed: true, exempt: true, remaining: Number.POSITIVE_INFINITY };
	}
	const limit = entitlements?.limits?.[dimension];
	if (limit == null) throw new Error(`assertWithinLimit: unknown dimension "${dimension}"`);
	if (!Number.isFinite(limit)) return { allowed: true, exempt: false, remaining: Number.POSITIVE_INFINITY };
	if (used + cost > limit) {
		throw new HomeQuotaError({ dimension, limit, used, resetAt, tier: entitlements.tier });
	}
	return { allowed: true, exempt: false, remaining: limit - used - cost };
}

/**
 * A paused home is not a broken home. It is a home the account's plan does not
 * currently cover, and the distinction is the whole of commitment 2: the row is
 * intact, the credential is intact, the log is intact, and the user can bring it
 * back by upgrading, by pausing a different house, or by changing their mind.
 */
export class HomePausedError extends Error {
	/**
	 * @param {object} input
	 * @param {string} input.label
	 * @param {string|null} [input.reason]
	 */
	constructor({ label, reason = null }) {
		super(
			`"${label}" is paused because your plan covers fewer connected homes than you have. ` +
			`${reason ? `${reason} ` : ''}` +
			'Nothing was deleted and nothing was disconnected: bring it back from your homes page, or pause a different home to make room. ' +
			'Locking up, closing a garage or valve and arming an alarm keep working on a paused home.',
		);
		this.name = 'HomePausedError';
		this.code = 'home_paused';
		this.status = 402;
		this.label = label;
		this.reason = reason;
		this.upgradePath = '/pricing';
	}
}

/**
 * The guard every action goes through, and the one place commitment 1 is
 * enforced on the write path.
 *
 * Order matters and it is the point: the safety exemption is checked FIRST, so
 * there is no plan state, no pause, no quota and no override in which locking a
 * door, closing a garage or a valve, or arming an alarm is refused. It is
 * checked before the home's state is even looked at, so a bug in the pause logic
 * cannot reach it.
 *
 * The exemption does not need a live socket. `isSafetyAction` classifies from
 * the domain and service alone, which is what makes this usable in exactly the
 * degraded states where a person most needs to lock up.
 *
 * @param {object} input
 * @param {{ label: string, deactivated_at?: string|null, deactivated_reason?: string|null }} input.home
 * @param {{ domain?: string, service?: string, tool?: string, arguments?: object, entities?: object[] }} input.call
 * @returns {{ allowed: true, exempt: boolean }}
 * @throws {HomePausedError}
 */
export function assertHomeActionAllowed({ home, call }) {
	if (isQuotaExempt(call)) return { allowed: true, exempt: true };
	if (home?.deactivated_at) {
		throw new HomePausedError({ label: home.label || 'This home', reason: home.deactivated_reason });
	}
	return { allowed: true, exempt: false };
}

/**
 * Can this home take another household member?
 *
 * Billed to the HOME'S OWNER, never to the person sending the invitation. An
 * admin inviting a house sitter is spending the owner's seats, and charging the
 * admin's own plan for them would mean a household's capacity changed depending
 * on which member happened to click the button.
 *
 * Counts the seats already taken plus the invitations already outstanding,
 * because an unspent invite is a seat that is about to be occupied and letting
 * ten of them through to a five-seat home just moves the refusal to the moment
 * somebody accepts, which is the worst possible time to discover it.
 *
 * @param {string} homeId
 * @returns {Promise<{ allowed: true, remaining: number }>}
 * @throws {HomeQuotaError}
 */
export async function assertMemberCapacity(homeId) {
	const rows = await withDbRetry(() => sql`
		select
			c.user_id                                                          as owner_id,
			(select count(*)::int from home_members m where m.home_id = c.id)  as members,
			(select count(*)::int from home_invites i
			   where i.home_id = c.id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
			                                                                   as pending
		from home_connections c
		where c.id = ${homeId}
	`);
	const row = rows[0];
	if (!row) throw new Error('assertMemberCapacity: no such home');

	const entitlements = await resolveHomeEntitlementsForUser(row.owner_id);
	return assertWithinLimit({
		entitlements,
		dimension: 'members',
		used: (row.members ?? 0) + (row.pending ?? 0),
	});
}

// ── The downgrade path ───────────────────────────────────────────────────────

/**
 * What a downgrade would do, without doing it.
 *
 * COMMITMENT 2 LIVES HERE. A downgrade never picks for the user and never
 * deletes: it names which homes exceed the new limit, keeps the oldest ones
 * active by default because they are the ones most likely to be the real house,
 * and hands the choice back.
 *
 * @param {Array<{ id: string, label: string, created_at: string, deactivated_at?: string|null }>} connections
 * @param {number} limit the new connection limit
 * @returns {{ overBy: number, limit: number, keep: object[], deactivate: object[], explanation: string }}
 */
export function planDowngrade(connections, limit) {
	const live = connections.filter((c) => !c.deactivated_at);
	if (!Number.isFinite(limit) || live.length <= limit) {
		return { overBy: 0, limit, keep: live, deactivate: [], explanation: '' };
	}
	const ordered = [...live].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
	const keep = ordered.slice(0, Math.max(0, limit));
	const deactivate = ordered.slice(Math.max(0, limit));
	const explanation =
		`Your plan now covers ${limit} connected ${limit === 1 ? 'home' : 'homes'} and you have ${live.length}. ` +
		`We have paused ${deactivate.map((c) => `"${c.label}"`).join(', ')} rather than disconnecting ${deactivate.length === 1 ? 'it' : 'them'}: ` +
		'nothing was deleted, your access tokens and your action logs are untouched, and you can swap which homes are active at any time. ' +
		'A paused home still answers safety actions: locking up, closing a garage or valve and arming an alarm keep working.';
	return { overBy: deactivate.length, limit, keep, deactivate, explanation };
}

/**
 * Carry out a downgrade plan. Marks rows inactive; deletes nothing, revokes
 * nothing, scrubs no credential.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string[]} input.deactivateIds
 * @param {string} input.reason
 * @returns {Promise<object[]>} the paused rows
 */
export async function applyDowngrade({ userId, deactivateIds, reason }) {
	if (!userId || !deactivateIds?.length) return [];
	return withDbRetry(() => sql`
		update home_connections
		set deactivated_at     = now(),
		    deactivated_reason = ${String(reason || 'Paused by a plan change.')},
		    updated_at         = now()
		where user_id = ${userId}
		  and id = any(${deactivateIds}::uuid[])
		  and revoked_at is null
		  and deactivated_at is null
		returning id, label, deactivated_at, deactivated_reason
	`);
}

/**
 * Bring a paused home back, refusing when doing so would exceed the limit. The
 * user swapping which houses are active is the whole point of pausing rather
 * than disconnecting, so this is the other half of commitment 2.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.homeId
 * @param {object} input.entitlements
 * @returns {Promise<object>}
 */
export async function reactivateConnection({ userId, homeId, entitlements }) {
	const active = await countActiveConnections(userId);
	assertWithinLimit({ entitlements, dimension: 'homes', used: active });
	const rows = await withDbRetry(() => sql`
		update home_connections
		set deactivated_at = null, deactivated_reason = null, updated_at = now()
		where user_id = ${userId} and id = ${homeId} and revoked_at is null
		returning id, label, deactivated_at
	`);
	if (!rows.length) throw new Error('reactivateConnection: no such home for this account');
	return rows[0];
}

/** How many of this account's homes are live right now. The `homes` gauge. */
export async function countActiveConnections(userId) {
	if (!userId) return 0;
	const rows = await withDbRetry(() => sql`
		select count(*)::int as n
		from home_connections
		where user_id = ${userId} and revoked_at is null and deactivated_at is null
	`);
	return rows[0]?.n ?? 0;
}

// ── The manage surface's view ────────────────────────────────────────────────

/**
 * The quota period. A UTC calendar month.
 *
 * The platform has no per-user plan billing period to key off (`users.plan` is a
 * column, not a subscription with a cycle), and inventing one here would be a
 * second billing clock that drifts from whatever the real one turns out to be.
 * A calendar month resets on a date every user can predict, it is the same
 * choice the per-IP image quota already made one rung down (a UTC day), and when
 * a real billing cycle lands this is one function to change.
 *
 * @param {Date} [now]
 * @returns {{ start: Date, end: Date, startIso: string, endIso: string, key: string }}
 */
export function quotaPeriod(now = new Date()) {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
	return {
		start,
		end,
		startIso: start.toISOString(),
		endIso: end.toISOString(),
		key: start.toISOString().slice(0, 7),
	};
}

/**
 * Everything the manage surface renders, in one object.
 *
 * COMMITMENT 3 LIVES HERE: a quota is shown before it is hit. Every dimension
 * comes back whether or not it is close to its ceiling, each with its usage, its
 * limit, the percentage, the reset date, and the measured cost that justifies
 * metering it, so the page can explain the limit rather than merely enforce it.
 *
 * Pure: it takes the usage rather than reading it, so the page's numbers and the
 * enforcement path's numbers come from one function and cannot disagree.
 *
 * @param {object} entitlements from resolveHomeEntitlements
 * @param {Record<string, number>} usage per-dimension current usage
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @returns {object}
 */
export function describeEntitlements(entitlements, usage = {}, { now = new Date() } = {}) {
	const period = quotaPeriod(now);
	const dimensions = HOME_DIMENSION_IDS.map((id) => {
		const meta = HOME_DIMENSIONS[id];
		const limit = entitlements.limits[id];
		const used = Number(usage[id]) || 0;
		const unlimited = !Number.isFinite(limit);
		return {
			id,
			label: meta.label,
			unit: meta.unit,
			scope: meta.scope,
			period: meta.period,
			why: meta.why,
			used,
			limit: unlimited ? null : limit,
			unlimited,
			remaining: unlimited ? null : Math.max(0, limit - used),
			percent: unlimited ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)),
			exceeded: !unlimited && used > limit,
			source: entitlements.sources[id],
			// A ceiling dimension is not consumed: sitting at it is the normal,
			// healthy state (the retention default IS the free ceiling), so the
			// surface must not paint it as "you are out of something".
			ceilingOnly: Boolean(meta.ceilingOnly),
			resetsAt: meta.period === 'month' ? period.endIso : null,
			costPerUnitUsd: meta.costPerUnitUsd,
			costBasis: meta.costBasis,
		};
	});

	return {
		tier: { id: entitlements.tier.id, label: entitlements.tier.label, color: entitlements.tier.color },
		badges: entitlements.badges.map((b) => ({ id: b.id, label: b.label, color: b.color })),
		plan: entitlements.plan,
		holder: {
			isHolder: entitlements.holder.isHolder,
			usd: entitlements.holder.usd,
			tier: entitlements.holderTier.label,
			multiplier: entitlements.multiplier,
		},
		override: entitlements.override
			? { note: entitlements.override.note, updatedAt: entitlements.override.updatedAt, dimensions: Object.keys(entitlements.override.limits || {}) }
			: null,
		period: { startsAt: period.startIso, resetsAt: period.endIso },
		dimensions,
		// Stated on the surface itself, not only in this file, because a user
		// reading their limits is exactly the person who needs to know which of
		// them can never apply to them.
		alwaysFree: [
			'Locking a door, closing a garage or gate, closing a water valve and arming an alarm are never refused by a limit, on any plan.',
			'Confirmation prompts, the action log and every role safety property are on every plan. Safety is not an upgrade.',
		],
		upgradePath: '/pricing',
	};
}
