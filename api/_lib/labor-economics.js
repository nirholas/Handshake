// Pure economics for the Agent Labor Market (Moonshot 01) — zero imports, so the
// scoring, reputation, negotiation, and settlement-split math can be unit-tested
// in isolation and reused identically by the data layer, the autonomy engine, and
// the settler. No floats touch atomic amounts: every $THREE quantity is a BigInt.

// $THREE decimals (6). Read from env so a non-default deployment stays exact;
// kept import-free on purpose (this module must not pull the DB/config graph).
const TOKEN_DECIMALS = (() => {
	const n = Number(process.env.THREE_TOKEN_DECIMALS);
	return Number.isInteger(n) && n >= 0 && n <= 18 ? n : 6;
})();
export const ATOMICS_PER_TOKEN = 10n ** BigInt(TOKEN_DECIMALS);

// Transparent award-score weights, published in the API so posters see why a bid
// won: deeper discount vs the escrowed reward, faster ETA, higher reputation.
export const SCORE_WEIGHTS = Object.freeze({ price: 0.45, eta: 0.2, reputation: 0.35 });
// ETA worth half its max — one hour.
export const ETA_HALF_LIFE_S = 3600;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const round4 = (n) => Math.round(n * 1e4) / 1e4;

export function toBig(v) {
	if (typeof v === 'bigint') return v;
	if (v == null) return 0n;
	return BigInt(String(v).split('.')[0]); // numeric(40,0) arrives as a string
}

export function atomicsToThree(atomics) {
	return Number(toBig(atomics)) / Number(ATOMICS_PER_TOKEN);
}
export function threeToAtomics(three) {
	const n = Number(three);
	if (!Number.isFinite(n) || n < 0) return 0n;
	return BigInt(Math.round(n * Number(ATOMICS_PER_TOKEN)));
}

/**
 * Strict atomic-amount parse for UNTRUSTED input (request bodies). Returns a
 * non-negative BigInt, or null when the value is not a whole number of atomics.
 * toBig() above trusts its caller (it reads numeric(40,0) columns back) and
 * throws a SyntaxError on junk, which reaches an API client as an opaque 500.
 * Every endpoint boundary parses through this instead and answers 400.
 */
export function parseAtomics(value) {
	if (typeof value === 'bigint') return value >= 0n ? value : null;
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
	if (typeof value !== 'string') return null;
	const s = value.trim();
	return /^\d+$/.test(s) ? BigInt(s) : null;
}

/**
 * Strict $THREE-denominated parse for untrusted input: returns atomics, or null
 * when the value is missing or not a finite non-negative number. Separating
 * "not a number" from zero lets the caller say which of the two went wrong.
 */
export function parseThree(value) {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(typeof value === 'string' ? value.trim() : value);
	if (!Number.isFinite(n) || n < 0) return null;
	return BigInt(Math.round(n * Number(ATOMICS_PER_TOKEN)));
}

/**
 * Transparent award score in [0,1]. Deterministic and explainable. A bid at or
 * above the full reward earns no price credit; a free, instant bid from a
 * perfect-reputation worker approaches 1.
 */
export function scoreBid({ priceAtomics, rewardAtomics, etaSeconds, reputation = 0.5 }) {
	const reward = toBig(rewardAtomics);
	const price = toBig(priceAtomics);
	if (reward <= 0n) return 0;
	const ratio = Number(price) / Number(reward);
	const priceScore = clamp01(1 - ratio);
	const eta = Number.isFinite(etaSeconds) && etaSeconds > 0 ? etaSeconds : ETA_HALF_LIFE_S;
	const etaScore = ETA_HALF_LIFE_S / (ETA_HALF_LIFE_S + eta);
	const repScore = clamp01(Number(reputation) || 0);
	const score =
		SCORE_WEIGHTS.price * priceScore +
		SCORE_WEIGHTS.eta * etaScore +
		SCORE_WEIGHTS.reputation * repScore;
	return round4(score);
}

/** Reputation in [0,1] from settled/failed counts. New agents get a neutral 0.5
 *  prior so they can still win on price + speed (no cold-start lockout). */
export function reputationFromStats({ settled = 0, failed = 0 } = {}) {
	const done = Number(settled) + Number(failed);
	const successRate = done > 0 ? Number(settled) / done : 0.5;
	const volume = Math.min(1, Number(settled) / 10);
	return round4(0.7 * successRate + 0.3 * volume);
}

/** Default skill royalty (bps of the awarded amount) routed to the skill author. */
export function defaultRoyaltyBps() {
	const raw = Number(process.env.LABOR_SKILL_ROYALTY_BPS);
	if (Number.isFinite(raw) && raw >= 0 && raw <= 5000) return Math.round(raw);
	return 1000; // 10%
}

/**
 * Exact-integer settlement split. The worker is paid its awarded bid; the author
 * takes a royalty out of that; the difference between the escrowed reward and the
 * (lower) awarded bid refunds to the poster. The three legs ALWAYS sum to exactly
 * the escrowed reward — no $THREE dust is created or lost.
 */
export function settlementSplit({ rewardAtomics, awardedAtomics, royaltyBps = defaultRoyaltyBps(), hasAuthor = false }) {
	const reward = toBig(rewardAtomics);
	let awarded = toBig(awardedAtomics);
	if (awarded > reward) awarded = reward;
	if (awarded < 0n) awarded = 0n;
	const bps = BigInt(Math.max(0, Math.min(5000, Math.round(royaltyBps))));
	const royalty = hasAuthor ? (awarded * bps) / 10_000n : 0n;
	const worker = awarded - royalty;
	const posterRefund = reward - awarded;
	return { workerAtomics: worker, royaltyAtomics: royalty, posterRefundAtomics: posterRefund };
}

/**
 * The price an autonomous worker bids: never above the escrowed reward or its own
 * max-bid ceiling, discounted off that ceiling by reputation (proven workers hold
 * nearer the ceiling at 0.98×, new workers discount to 0.80× to win on price).
 */
export function negotiationPrice({ rewardAtomics, maxBidAtomics = null, reputation = 0.5 }) {
	const reward = toBig(rewardAtomics);
	const ceiling = maxBidAtomics != null && toBig(maxBidAtomics) < reward ? toBig(maxBidAtomics) : reward;
	const rep = clamp01(Number(reputation) || 0);
	const factorBps = BigInt(Math.round((0.8 + 0.18 * rep) * 10_000)); // 8000..9800
	let price = (ceiling * factorBps) / 10_000n;
	if (price < 1n) price = 1n;
	if (price > reward) price = reward;
	return price;
}

/** Promised turnaround: faster the higher the reputation (2h → 30m). */
export function etaForReputation(reputation = 0.5) {
	const rep = clamp01(Number(reputation) || 0);
	return Math.round(7200 - 5400 * rep);
}
