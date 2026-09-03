/**
 * Alpha-drip: tiered release of a leader's OWN copy signal. PURE: no DB, no network.
 *
 * A leader's edge decays in seconds, so the thing worth selling is not only a
 * share of the profit but the LATENCY: $THREE holders in higher tiers see the
 * copy intent first, everyone else after a leader-set delay. That is a real
 * reason to hold $THREE and a real product the leader can sell, and unlike a
 * private signal group it is enforced by the fanout instead of by trust.
 *
 * Two rules are structural, not stylistic, and every caller depends on them:
 *
 *   1. A drip delays the REVEAL, never the RECORD. The intent row is written in
 *      full at fanout time and the leader's public track record is untouched, so
 *      there are no hidden trades, only delayed ones. Nothing here can express
 *      "do not disclose".
 *   2. Delay never increases with tier. A higher-tier holder can never wait longer
 *      than a lower-tier one, so paying more can only ever help.
 *
 * The leader gates their OWN self-produced signal. Nothing here touches, delays,
 * or reorders anybody else's orderflow, and `dripDisclosure()` states that in
 * plain English on every subscribing surface.
 */

import { TIERS, tierForUsd } from './three-tier.js';

/** Hard ceiling on any delay a leader can set, public tier included. */
export const MAX_DELAY_SEC = 900;

/** Ordered low→high tier ids, the vocabulary a schedule may use. */
export const TIER_IDS = Object.freeze(TIERS.map((t) => t.id));

const LEVEL_BY_ID = new Map(TIERS.map((t) => [t.id, t.level]));
const TIER_BY_ID = new Map(TIERS.map((t) => [t.id, t]));

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/**
 * Validate + normalize a leader's release schedule.
 *
 * Accepts a sparse array: a leader prices the tiers they care about and the rest
 * inherit. The result is sorted high→low tier level so `planRelease` can walk it
 * once, and is guaranteed monotonic (rule 2 above).
 *
 * @param {object} raw { enabled, schedule: [{tier, delay_sec, max_copy_size_sol}], public_delay_sec, disclosure, capacity_note }
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function normalizeDripConfig(raw = {}) {
	const publicDelay = raw.public_delay_sec == null || raw.public_delay_sec === '' ? 0 : int(raw.public_delay_sec);
	if (!Number.isFinite(publicDelay) || publicDelay < 0) return { ok: false, error: 'public_delay_sec must be zero or more seconds' };
	if (publicDelay > MAX_DELAY_SEC) return { ok: false, error: `public_delay_sec cannot exceed ${MAX_DELAY_SEC} seconds` };

	const rows = Array.isArray(raw.schedule) ? raw.schedule : [];
	if (rows.length > TIER_IDS.length) return { ok: false, error: 'schedule has more entries than there are tiers' };

	const seen = new Set();
	const entries = [];
	for (const row of rows) {
		const tier = typeof row?.tier === 'string' ? row.tier.trim().toLowerCase() : '';
		if (!LEVEL_BY_ID.has(tier)) return { ok: false, error: `unknown tier "${row?.tier}" (expected one of ${TIER_IDS.join(', ')})` };
		if (seen.has(tier)) return { ok: false, error: `tier "${tier}" appears more than once` };
		seen.add(tier);

		const delay = row.delay_sec == null || row.delay_sec === '' ? 0 : int(row.delay_sec);
		if (!Number.isFinite(delay) || delay < 0) return { ok: false, error: `delay_sec for "${tier}" must be zero or more seconds` };
		if (delay > MAX_DELAY_SEC) return { ok: false, error: `delay_sec for "${tier}" cannot exceed ${MAX_DELAY_SEC} seconds` };

		let cap = null;
		if (row.max_copy_size_sol != null && row.max_copy_size_sol !== '') {
			cap = num(row.max_copy_size_sol);
			if (!Number.isFinite(cap) || cap <= 0) return { ok: false, error: `max_copy_size_sol for "${tier}" must be greater than 0` };
			cap = Math.round(cap * 1e6) / 1e6;
		}
		entries.push({ tier, delay_sec: delay, max_copy_size_sol: cap });
	}

	// High tier first: the order planRelease walks and the order a UI reads best.
	entries.sort((a, b) => LEVEL_BY_ID.get(b.tier) - LEVEL_BY_ID.get(a.tier));

	// Rule 2: paying more can never buy a longer wait. Checked against the public
	// delay too, since everything below the lowest priced tier falls through to it.
	let prev = 0;
	for (const e of entries) {
		if (e.delay_sec < prev) {
			return { ok: false, error: `delay for "${e.tier}" is shorter than a higher tier's. A higher tier can never wait longer` };
		}
		prev = e.delay_sec;
	}
	if (entries.length && publicDelay < prev) {
		return { ok: false, error: 'public_delay_sec cannot be shorter than a paid tier\'s delay' };
	}

	const enabled = raw.enabled === true || raw.enabled === 'true';
	if (enabled && !entries.length && publicDelay === 0) {
		return { ok: false, error: 'enable a drip only with at least one tier delay or a public delay set' };
	}

	const text = (v, max) => {
		const s = v == null ? '' : String(v).trim();
		return s ? s.slice(0, max) : null;
	};

	return {
		ok: true,
		value: {
			enabled,
			schedule: entries,
			public_delay_sec: publicDelay,
			disclosure: text(raw.disclosure, 280),
			capacity_note: text(raw.capacity_note, 280),
		},
	};
}

/**
 * Resolve one copier's release for a leader's signal.
 *
 * A tier with no explicit entry inherits the nearest LOWER priced tier (holding
 * more is never worse), and anything under the lowest priced tier waits the
 * public delay.
 *
 * @param {object} config normalized config from `normalizeDripConfig` (or null/disabled)
 * @param {string} tierId the copier's current $THREE tier id
 * @returns {{ delay_sec:number, tier:string, matched_tier:string|null, max_copy_size_sol:number|null }}
 */
export function planRelease(config, tierId) {
	const tier = LEVEL_BY_ID.has(tierId) ? tierId : TIER_IDS[0];
	if (!config?.enabled) return { delay_sec: 0, tier, matched_tier: null, max_copy_size_sol: null };

	const level = LEVEL_BY_ID.get(tier);
	const entries = Array.isArray(config.schedule) ? config.schedule : [];
	// Entries are high→low, so the first one at or below the copier's level is the
	// best price they qualify for.
	const match = entries.find((e) => LEVEL_BY_ID.get(e.tier) <= level);

	if (!match) {
		const publicDelay = Math.min(Math.max(int(config.public_delay_sec) || 0, 0), MAX_DELAY_SEC);
		return { delay_sec: publicDelay, tier, matched_tier: null, max_copy_size_sol: null };
	}
	return {
		delay_sec: Math.min(Math.max(match.delay_sec, 0), MAX_DELAY_SEC),
		tier,
		matched_tier: match.tier,
		max_copy_size_sol: match.max_copy_size_sol ?? null,
	};
}

/** Convenience: resolve a release straight from the USD value of $THREE held. */
export function planReleaseForUsd(config, usdHeld) {
	return planRelease(config, tierForUsd(usdHeld).id);
}

/**
 * The disclosure shown to every copier before they subscribe. A leader may
 * override the wording, but never the standing sentence that says what a drip is
 * and what it is not. That sentence is appended regardless.
 */
export function dripDisclosure(config) {
	const standing =
		'This is the leader gating their own call as a subscription. It is not privileged access to anyone else\'s orderflow, and every trade still lands in the leader\'s public track record.';
	if (!config?.enabled) return null;
	const custom = config.disclosure ? `${config.disclosure} ` : '';
	return `${custom}${standing}`;
}

/**
 * Human summary of a schedule, longest wait last: "Gold+ instant, Bronze+ after
 * 20s, everyone else after 60s."
 */
export function describeSchedule(config) {
	if (!config?.enabled) return 'Every copier gets this leader\'s signal at the same moment.';
	const parts = [];
	for (const e of config.schedule) {
		const label = TIER_BY_ID.get(e.tier)?.label || e.tier;
		parts.push(`${label}+ ${e.delay_sec === 0 ? 'instant' : `after ${formatDelay(e.delay_sec)}`}`);
	}
	const pub = Math.max(int(config.public_delay_sec) || 0, 0);
	parts.push(`everyone else ${pub === 0 ? 'instant' : `after ${formatDelay(pub)}`}`);
	return `${parts.join(', ')}.`;
}

/** "45s" / "2m 30s": the one format every drip surface prints. */
export function formatDelay(sec) {
	const s = Math.max(0, int(sec) || 0);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const r = s % 60;
	return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * Fairness check against how fast the leader's edge actually decays. When the
 * longest wait outruns the edge's half-life, the slowest tier is being sold a
 * signal that is already spent. Say so instead of shipping it quietly.
 *
 * @returns {{ fair: boolean, longest_delay_sec: number, warning: string|null }}
 */
export function assessFairness(config, edgeHalflifeSec) {
	const longest = maxDelaySec(config);
	const half = num(edgeHalflifeSec);
	if (!config?.enabled || longest === 0) return { fair: true, longest_delay_sec: longest, warning: null };
	if (!Number.isFinite(half) || half <= 0) return { fair: true, longest_delay_sec: longest, warning: null };
	if (longest <= half) return { fair: true, longest_delay_sec: longest, warning: null };
	return {
		fair: false,
		longest_delay_sec: longest,
		warning: `The slowest tier waits ${formatDelay(longest)} but this leader's edge halves in about ${formatDelay(Math.round(half))}. Shorten the delay or release to everyone at once.`,
	};
}

/** The longest any copier waits under this config. */
export function maxDelaySec(config) {
	if (!config?.enabled) return 0;
	const delays = (config.schedule || []).map((e) => e.delay_sec || 0);
	delays.push(int(config.public_delay_sec) || 0);
	return Math.max(0, ...delays);
}

/**
 * Clamp a sized copy order to the tier's capacity allowance.
 *
 * A leader with real size has finite capacity: if the earliest tier copies the
 * full order, the fills the later tiers get are the ones the early tier already
 * moved through. `max_copy_size_sol` is how a leader splits that, so it is
 * applied AFTER the copy engine has sized and gated the order, never before:
 * the copier's own caps still bind first.
 *
 * A cap that pushes an order under the copier's minimum is a skip, not a dust
 * fill: the copier said what is too small to be worth signing.
 *
 * @returns {{ ok: true, order_sol: number, capped: boolean }
 *          | { ok: false, reason: 'drip_capacity_cap', detail: string }}
 */
export function applyCapacityCap(orderSol, capSol, minOrderSol = 0) {
	const order = num(orderSol);
	if (!Number.isFinite(order) || order <= 0) return { ok: true, order_sol: orderSol, capped: false };
	const cap = num(capSol);
	if (!Number.isFinite(cap) || cap <= 0 || order <= cap) return { ok: true, order_sol: order, capped: false };

	const capped = Math.round(cap * 1e6) / 1e6;
	const min = num(minOrderSol);
	if (Number.isFinite(min) && min > 0 && capped < min) {
		return {
			ok: false,
			reason: 'drip_capacity_cap',
			detail: `This leader caps your tier at ${capped} SOL per copy, below your ${min} SOL minimum.`,
		};
	}
	return { ok: true, order_sol: capped, capped: true };
}

/**
 * Hide the tradeable content of an intent the copier's seat has not reached yet.
 *
 * The row exists, the copier knows WHO traded and that something fired. What
 * they do not get early is the coin and the size, which is the whole thing the
 * ladder sells. Masking happens on the way OUT rather than in the query so the
 * record stays complete in the database and the same row unmasks itself the
 * moment its reveal passes.
 *
 * Only a pending intent can be masked: once acted, dismissed, skipped, or
 * expired it is history, and history is never hidden from the person it
 * belongs to.
 */
export function maskUnreleasedIntent(row, now = Date.now()) {
	const visibleAt = row?.visible_at ? new Date(row.visible_at).getTime() : null;
	if (row?.status !== 'pending' || !visibleAt || visibleAt <= now) {
		return { ...row, locked: false, unlocks_in_sec: 0 };
	}
	const {
		mint, symbol, name, planned_sol, leader_entry_sol, safety, quote, leader_buy_sig,
		...rest
	} = row;
	return {
		...rest,
		mint: null, symbol: null, name: null,
		planned_sol: null, leader_entry_sol: null,
		safety: null, quote: null, leader_buy_sig: null,
		locked: true,
		unlocks_at: new Date(visibleAt).toISOString(),
		unlocks_in_sec: Math.max(0, Math.ceil((visibleAt - now) / 1000)),
	};
}

/** Config shape for a leader who has never set one up. */
export function emptyDripConfig() {
	return { enabled: false, schedule: [], public_delay_sec: 0, disclosure: null, capacity_note: null };
}
