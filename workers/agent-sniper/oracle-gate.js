// agent-sniper — Oracle conviction gate.
//
// Checked AFTER the pure scorers (scoreMint, scoreClaim, scoreIntel) pass.
// Only fires when a strategy has min_oracle_score set; skips silently when
// the coin has no Oracle score yet (e.g. brand-new mints that haven't been
// classified). Caches each result within a 30-second window so repeated
// lookups within a burst share one DB round-trip.
//
// Macro signal adjustment: reads oracle_intel_signals (populated by the
// x402 autonomous loop) to widen or tighten the min_oracle_score threshold
// based on current SOL/BTC/pump market sentiment.
//
// Per-coin sentiment adjustment: reads sniper_coin_sentiment (populated by the
// x402 Sniper Intel Enrichment loop, which pays /api/x402/crypto-intel for the
// coins the sniper is actively watching) to nudge the same threshold by THIS
// coin's own live market read. Both layers are clamped and fail-open.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';

const _cache = new Map(); // key → { score, firstSeenAt, ts }
const CACHE_TTL_MS = 30_000;

// A conviction score only GATES once the coin is old enough for the Oracle to
// have real data. Brand-new mints score 15-25 on thin defaults, which silently
// disqualified every min_oracle_score strategy from ever sniping a launch: the
// gate saw a "low score" where there was really "no signal yet". Younger than
// this, a below-threshold score is treated exactly like an unscored coin (fail
// open, logged); at or past it, the threshold bites for real.
const ORACLE_MATURITY_S = Math.max(0, Number(process.env.SNIPER_ORACLE_MATURITY_S || 900));

// Rugpull verdict cache (separate from the conviction cache).
const _rugCache = new Map(); // key → { rejected, score, level, ts }
const RUG_CACHE_TTL_MS = 30_000;
// A verdict only vetoes while it is this fresh — new mints move fast and the x402
// gate re-checks on its own cooldown, so a stale "rejected" must not block forever.
const RUG_FRESH_MINUTES = Number(process.env.SNIPER_RUGPULL_FRESH_MIN || 60);

// Macro signal cache — shared across all gate calls, refreshed every 2 min.
let _macroCache = null;
let _macroCacheTs = 0;
const MACRO_TTL_MS = 120_000;
// Settle signatures of the paid x402 calls behind the current macro adjustment,
// refreshed together with _macroCache. Surfaced on gate results so every trade
// decision carries the on-chain receipts of the signals that shaped it.
let _macroReceipts = [];

// Per-coin sentiment cache (separate from the conviction cache).
const _sentCache = new Map(); // key → { adj, ts }
const SENT_CACHE_TTL_MS = 30_000;
// A per-coin sentiment delta only applies while this fresh — the x402 enrichment
// loop re-reads on its own cooldown, so a stale read must not keep moving the bar.
const SENT_FRESH_MINUTES = Number(process.env.SNIPER_SENTIMENT_FRESH_MIN || 30);

function n(v) {
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

/**
 * Fetch recent macro signals from oracle_intel_signals and compute a
 * threshold adjustment in score points.
 *
 * Returns a number: positive = raise bar (bearish), negative = lower bar (bullish).
 * Returns 0 on any error (fail-open).
 */
async function getMacroAdjustment() {
	if (_macroCache !== null && Date.now() - _macroCacheTs < MACRO_TTL_MS) {
		return _macroCache;
	}
	try {
		const rows = await sql`
			select source_id, topic, signal, confidence, tx_signature, ts
			from oracle_intel_signals
			where topic in ('solana', 'bitcoin', 'pump')
			  and ts > now() - interval '1 hour'
			order by ts desc
		`;

		if (!rows.length) {
			_macroCache = 0;
			_macroCacheTs = Date.now();
			return 0;
		}

		// Latest signal per topic (rows already ordered desc by ts).
		const latest = {};
		for (const row of rows) {
			if (!latest[row.topic]) latest[row.topic] = row;
		}

		let adjustment = 0;
		const WEIGHTS = { solana: 1.2, bitcoin: 0.8, pump: 1.5 };
		const receipts = [];

		for (const [topic, row] of Object.entries(latest)) {
			const w = WEIGHTS[topic] ?? 1.0;
			const conf = n(row.confidence) ?? 50;
			const confFactor = conf / 100;
			const sig = (row.signal ?? '').toLowerCase();

			if (sig === 'bearish') {
				// Raise threshold — harder to snipe in bearish macro.
				adjustment += Math.round(10 * w * confFactor);
			} else if (sig === 'bullish') {
				// Lower threshold — easier to snipe in bullish macro.
				adjustment -= Math.round(5 * w * confFactor);
			}
			// 'neutral' → no adjustment.

			// Payment provenance: the settle signature of the x402 call that bought
			// this signal, so a trade decision can point at the exact on-chain
			// payment that informed it (journal + /sniper surfaces).
			if (sig === 'bearish' || sig === 'bullish') {
				receipts.push({ topic, signal: sig, tx_signature: row.tx_signature || null });
			}
		}

		// Clamp: never move the bar more than ±15 points.
		adjustment = Math.max(-15, Math.min(15, adjustment));
		_macroReceipts = receipts;
		_macroCache = adjustment;
		_macroCacheTs = Date.now();
		return adjustment;
	} catch (err) {
		log.warn('oracle gate macro signal error — no adjustment', { err: err?.message });
		_macroCache = 0;
		_macroCacheTs = Date.now();
		return 0;
	}
}

/**
 * Pre-snipe rugpull veto — platform-wide safety floor. Looks up the latest x402
 * Token Intel verdict for a mint (token_intel_risk, populated by
 * api/_lib/x402/pipelines/token-intel-gate.js) and rejects the snipe when a FRESH
 * high/critical verdict says rug. Fail-open: any error, a missing verdict, or a
 * stale one returns { reject: false }, so this can only ever make the sniper safer.
 *
 * @param {string} mint
 * @param {string} network
 * @returns {Promise<{ reject: boolean, score?: number, level?: string }>}
 */
export async function rugpullVeto(mint, network) {
	const cacheKey = `${network}:${mint}`;
	const cached = _rugCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < RUG_CACHE_TTL_MS) {
		return cached.rejected ? { reject: true, score: cached.score, level: cached.level } : { reject: false };
	}
	try {
		const [row] = await sql`
			select rugpull_score, risk_level, rejected
			from token_intel_risk
			where mint = ${mint} and network = ${network}
			  and checked_at > now() - make_interval(mins => ${RUG_FRESH_MINUTES})
			limit 1
		`;
		const rejected = row?.rejected === true;
		const score = row?.rugpull_score != null ? n(row.rugpull_score) : null;
		const level = row?.risk_level || null;
		_rugCache.set(cacheKey, { rejected, score, level, ts: Date.now() });
		if (_rugCache.size > 2000) {
			const cutoff = Date.now() - RUG_CACHE_TTL_MS;
			for (const [k, v] of _rugCache) if (v.ts < cutoff) _rugCache.delete(k);
		}
		return rejected ? { reject: true, score, level } : { reject: false };
	} catch (err) {
		// Table not present yet, or a transient DB fault — never block a snipe on it.
		if (!err?.message?.includes('does not exist')) {
			log.warn('rugpull veto db error — allowing snipe', { mint, err: err?.message });
		}
		return { reject: false };
	}
}

/**
 * Per-coin sentiment delta — folds the live Crypto Intel read into the snipe
 * threshold. Looks up the latest x402 sentiment for a mint (sniper_coin_sentiment,
 * populated by api/_lib/x402/pipelines/sniper-intel-enrich.js) and returns a
 * clamped score-point delta: positive raises the bar (bearish coin), negative
 * lowers it (bullish coin). Fail-open: any error, a missing row, or a stale one
 * returns 0, so this can only ever nudge — never block — a snipe.
 *
 * @param {string} mint
 * @param {string} network
 * @returns {Promise<number>}
 */
export async function coinSentimentAdjustment(mint, network) {
	const cacheKey = `${network}:${mint}`;
	const cached = _sentCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < SENT_CACHE_TTL_MS) return cached.adj;
	try {
		const [row] = await sql`
			select sentiment_adj
			from sniper_coin_sentiment
			where mint = ${mint} and network = ${network}
			  and checked_at > now() - make_interval(mins => ${SENT_FRESH_MINUTES})
			limit 1
		`;
		const adj = row?.sentiment_adj != null ? (n(row.sentiment_adj) ?? 0) : 0;
		const clamped = Math.max(-10, Math.min(10, adj));
		_sentCache.set(cacheKey, { adj: clamped, ts: Date.now() });
		if (_sentCache.size > 2000) {
			const cutoff = Date.now() - SENT_CACHE_TTL_MS;
			for (const [k, v] of _sentCache) if (v.ts < cutoff) _sentCache.delete(k);
		}
		return clamped;
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('coin sentiment db error — no adjustment', { mint, err: err?.message });
		}
		return 0;
	}
}

/**
 * Look up the Oracle conviction score for a mint and decide whether the
 * strategy's min_oracle_score threshold is met.
 *
 * The effective threshold = min_oracle_score + macro_adjustment + coin_sentiment,
 * where macro_adjustment is derived from oracle_intel_signals and coin_sentiment
 * from sniper_coin_sentiment (both populated by the x402 autonomous spend loop).
 *
 * Returns:
 *   { pass: true }                         — scored and above threshold (or no threshold)
 *   { pass: false, reason: string }         — scored and below threshold
 *   { pass: true, skipped: true }: no Oracle score yet, or a provisional
 *     below-threshold score on a coin younger than SNIPER_ORACLE_MATURITY_S; gate deferred
 *   All results include macro_adjustment when a threshold was evaluated.
 *
 * @param {string} mint
 * @param {string} network
 * @param {object} strat   agent_sniper_strategies row
 */
export async function oracleGate(mint, network, strat) {
	// Rugpull pre-snipe veto runs FIRST and unconditionally — a fresh high/critical
	// token-intel verdict auto-rejects the mint regardless of strategy settings.
	const rug = await rugpullVeto(mint, network);
	if (rug.reject) {
		return { pass: false, reason: `rugpull_risk:${rug.level || 'high'}:${rug.score ?? '?'}`, rugpull: rug };
	}

	const minScore = strat.min_oracle_score != null ? n(strat.min_oracle_score) : null;
	if (minScore == null) return { pass: true };

	const cacheKey = `${network}:${mint}`;
	const cached = _cache.get(cacheKey);
	let score;
	let firstSeenAt;
	if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
		score = cached.score;
		firstSeenAt = cached.firstSeenAt;
	} else {
		try {
			const [row] = await sql`
				select score, coin_first_seen_at from oracle_conviction
				where mint = ${mint} and network = ${network}
				limit 1
			`;
			score = row?.score != null ? n(row.score) : null;
			firstSeenAt = row?.coin_first_seen_at ? new Date(row.coin_first_seen_at).getTime() : null;
			_cache.set(cacheKey, { score, firstSeenAt, ts: Date.now() });
			// Prune the cache when it grows large.
			if (_cache.size > 2000) {
				const cutoff = Date.now() - CACHE_TTL_MS;
				for (const [k, v] of _cache) if (v.ts < cutoff) _cache.delete(k);
			}
		} catch (err) {
			log.warn('oracle gate db error — allowing snipe', { mint, err: err?.message });
			return { pass: true, skipped: true };
		}
	}

	if (score == null) {
		// Not yet scored — allow the snipe (Oracle lags new mints by design).
		return { pass: true, skipped: true };
	}

	// Apply macro signal + per-coin sentiment adjustments from x402 autonomous loop
	// intel. Macro is market-wide (SOL/BTC/pump); coinAdj is this coin's own read.
	const [macroAdj, coinAdj] = await Promise.all([
		getMacroAdjustment(),
		coinSentimentAdjustment(mint, network),
	]);
	const effectiveMin = minScore + macroAdj + coinAdj;

	if (score < effectiveMin) {
		// Provisional score on a coin the Oracle has barely seen → same treatment as
		// unscored: fail open. A minutes-old launch cannot have earned a meaningful
		// conviction score, and gating on the thin-data default (~15-25) meant a
		// min_oracle_score strategy could never snipe a launch at all.
		const coinAgeMs = firstSeenAt != null ? Date.now() - firstSeenAt : null;
		if (coinAgeMs != null && coinAgeMs < ORACLE_MATURITY_S * 1000) {
			return { pass: true, skipped: true, reason: `oracle_immature:${Math.round(coinAgeMs / 1000)}s<${ORACLE_MATURITY_S}s` };
		}
		const parts = [];
		if (macroAdj !== 0) parts.push(`macro:${macroAdj}`);
		if (coinAdj !== 0) parts.push(`coin:${coinAdj}`);
		const breakdown = parts.length ? `(base:${minScore}+${parts.join('+')})` : '';
		return {
			pass: false,
			reason: `oracle_below_min:${score}<${effectiveMin}${breakdown}`,
			macro_adjustment: macroAdj,
			coin_adjustment: coinAdj,
			...(macroAdj !== 0 && _macroReceipts.length ? { signal_receipts: _macroReceipts } : {}),
		};
	}

	return {
		pass: true,
		macro_adjustment: macroAdj,
		coin_adjustment: coinAdj,
		...(macroAdj !== 0 && _macroReceipts.length ? { signal_receipts: _macroReceipts } : {}),
	};
}
