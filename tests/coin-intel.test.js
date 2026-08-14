import { describe, it, expect } from 'vitest';

import {
	computeSignals, aggregateWallets, bundleScore, summarizeRisk,
	bubblemapConnectivity, freshWalletRatio, _internals,
} from '../workers/agent-sniper/intel/signals.js';
import { heuristicClassify, _internals as classifyInternals } from '../workers/agent-sniper/intel/classify.js';
import { scoreIntel } from '../workers/agent-sniper/scorer.js';
import { applyGraduationTruth, correlation, deriveOutcome, learnedScore } from '../workers/agent-sniper/intel/learn.js';

const SOL = _internals.LAMPORTS_PER_SOL;

// Build a trade list helper. ts is ms-from-base; trader keyed by tag.
function trades(specs, baseTs = 1_000_000) {
	return specs.map((s, i) => ({
		trader: s.w,
		isBuy: s.buy !== false,
		lamports: Math.round((s.sol ?? 0.5) * SOL),
		baseAmount: s.base ?? 1000,
		ts: baseTs + (s.t ?? i * 1000),
		signature: `sig${i}`,
	}));
}

describe('aggregateWallets', () => {
	it('sums buys and sells per wallet', () => {
		const agg = aggregateWallets(trades([
			{ w: 'A', sol: 1 },
			{ w: 'A', sol: 0.5 },
			{ w: 'A', sol: 0.3, buy: false },
			{ w: 'B', sol: 2 },
		]));
		expect(agg.size).toBe(2);
		expect(agg.get('A').buyCount).toBe(2);
		expect(agg.get('A').sellCount).toBe(1);
		expect(agg.get('A').buyLamports).toBe(1.5 * SOL);
		expect(agg.get('A').sellLamports).toBe(0.3 * SOL);
		expect(agg.get('B').buyLamports).toBe(2 * SOL);
	});
});

describe('bundleScore', () => {
	it('scores a clustered identical-size launch burst high', () => {
		// 8 distinct wallets all buying ~0.5 SOL within the first 2s = bundle.
		const burst = trades(
			Array.from({ length: 8 }, (_, i) => ({ w: `bot${i}`, sol: 0.5, t: i * 200 })),
		);
		expect(bundleScore(burst)).toBeGreaterThan(0.5);
	});

	it('scores spread-out varied organic buys low', () => {
		// Varied sizes, spread across 60s, distinct wallets = organic.
		const organic = trades(
			Array.from({ length: 10 }, (_, i) => ({ w: `human${i}`, sol: 0.1 + i * 0.13, t: i * 6000 })),
		);
		expect(bundleScore(organic)).toBeLessThan(0.4);
	});

	it('returns 0 with too few buys to judge', () => {
		expect(bundleScore(trades([{ w: 'A' }, { w: 'B' }]))).toBe(0);
	});
});

describe('computeSignals', () => {
	it('flags a bundle launch and gives it a low quality score', () => {
		const t = trades(Array.from({ length: 8 }, (_, i) => ({ w: `bot${i}`, sol: 0.5, t: i * 150 })));
		const { signals, quality_score, risk_flags } = computeSignals({
			mint: 'M', creator: 'dev', firstSeenAtMs: 1_000_000, endedAtMs: 1_090_000,
			devBuyLamports: 0.5 * SOL, trades: t,
		});
		expect(signals.bundle_score).toBeGreaterThan(0.5);
		expect(risk_flags).toContain('bundle_launch');
		expect(quality_score).toBeLessThan(50);
	});

	it('rewards a diverse, spread-out organic launch', () => {
		const t = trades(Array.from({ length: 14 }, (_, i) => ({ w: `human${i}`, sol: 0.1 + (i % 5) * 0.2, t: i * 5000 })));
		const { signals, quality_score } = computeSignals({
			mint: 'M', creator: 'dev', firstSeenAtMs: 1_000_000, endedAtMs: 1_090_000, trades: t,
		});
		expect(signals.unique_buyers).toBe(14);
		expect(signals.organic_score).toBeGreaterThan(0.4);
		expect(quality_score).toBeGreaterThan(40);
	});

	it('detects a dev dump', () => {
		const t = trades([
			{ w: 'dev', sol: 1 },
			{ w: 'buyer1', sol: 0.5 },
			{ w: 'dev', sol: 0.9, buy: false },
		]);
		const { signals, risk_flags } = computeSignals({
			mint: 'M', creator: 'dev', firstSeenAtMs: 1_000_000, endedAtMs: 1_090_000, trades: t,
		});
		expect(signals.dev_sold).toBe(true);
		expect(risk_flags).toContain('dev_dumped');
	});

	it('flags single-whale concentration', () => {
		const t = trades([
			{ w: 'whale', sol: 50 },
			{ w: 'a', sol: 0.2 },
			{ w: 'b', sol: 0.2 },
		]);
		const { signals, risk_flags } = computeSignals({
			mint: 'M', creator: 'dev', firstSeenAtMs: 1_000_000, endedAtMs: 1_090_000, trades: t,
		});
		expect(signals.concentration_top1).toBeGreaterThan(0.5);
		expect(risk_flags).toContain('single_whale');
	});

	it('leaves wallet-graph signals null without enrichment (no fake data)', () => {
		const t = trades([{ w: 'a' }, { w: 'b' }, { w: 'c' }, { w: 'd' }]);
		const { signals } = computeSignals({
			mint: 'M', creator: 'dev', firstSeenAtMs: 1_000_000, endedAtMs: 1_090_000, trades: t,
		});
		expect(signals.fresh_wallet_ratio).toBeNull();
		expect(signals.bubblemap_connectivity).toBeNull();
	});
});

describe('wallet-graph enrichment', () => {
	it('computes bubblemap connectivity from a shared funder', () => {
		const agg = aggregateWallets(trades([{ w: 'a' }, { w: 'b' }, { w: 'c' }, { w: 'd' }]));
		const meta = new Map([
			['a', { funder: 'X' }], ['b', { funder: 'X' }],
			['c', { funder: 'X' }], ['d', { funder: 'Y' }],
		]);
		expect(bubblemapConnectivity(agg, meta)).toBe(0.75); // 3 of 4 share funder X
	});

	it('computes fresh-wallet ratio from prior tx counts', () => {
		const agg = aggregateWallets(trades([{ w: 'a' }, { w: 'b' }, { w: 'c' }, { w: 'd' }]));
		const meta = new Map([
			['a', { priorTxCount: 0 }], ['b', { priorTxCount: 1 }],
			['c', { priorTxCount: 50 }], ['d', { priorTxCount: 200 }],
		]);
		expect(freshWalletRatio(agg, meta)).toBe(0.5); // a,b fresh
	});
});

describe('summarizeRisk', () => {
	it('clamps the quality score to 0..100', () => {
		const { quality_score } = summarizeRisk({
			organic_score: 1, bundle_score: 0, concentration_top1: 0,
			dev_sold: false, fresh_wallet_ratio: null, unique_buyers: 100,
		});
		expect(quality_score).toBeLessThanOrEqual(100);
		expect(quality_score).toBeGreaterThanOrEqual(0);
	});
});

describe('normalizedEntropy', () => {
	it('is 1 for a perfectly even distribution and ~0 for a spike', () => {
		expect(_internals.normalizedEntropy([5, 5, 5, 5])).toBeCloseTo(1, 5);
		expect(_internals.normalizedEntropy([10, 0, 0, 0])).toBe(0);
	});
});

describe('heuristicClassify', () => {
	it('classifies by keyword and always returns a category', () => {
		expect(heuristicClassify({ name: 'Doge Killer', symbol: 'DOGE' }).category).toBe('animal');
		expect(heuristicClassify({ description: 'an autonomous AI agent coin' }).category).toBe('ai');
		expect(heuristicClassify({ name: 'Trump 2024' }).category).toBe('political');
		expect(heuristicClassify({}).category).toBe('unknown');
	});

	it('only uses the known category set', () => {
		const c = heuristicClassify({ name: 'random thing here' });
		expect(classifyInternals.CATEGORIES).toContain(c.category);
	});
});

describe('scoreIntel', () => {
	const baseRec = {
		quality_score: 80, category: 'meme', twitter: 't',
		risk_flags: [], signals: { organic_score: 0.7, bundle_score: 0.1, concentration_top1: 0.2, dev_sold: false },
	};

	it('passes a clean coin and scores it', () => {
		const r = scoreIntel(baseRec, { min_quality_score: 60 }, null);
		expect(r.pass).toBe(true);
		expect(r.score).toBeGreaterThan(0);
	});

	it('vetoes below the quality floor', () => {
		const r = scoreIntel({ ...baseRec, quality_score: 40 }, { min_quality_score: 60 });
		expect(r.pass).toBe(false);
		expect(r.reasons[0]).toContain('quality_below_min');
	});

	it('vetoes a bundle above the cap', () => {
		const r = scoreIntel({ ...baseRec, signals: { ...baseRec.signals, bundle_score: 0.8 } }, { max_bundle_score: 0.5 });
		expect(r.pass).toBe(false);
		expect(r.reasons[0]).toContain('bundle_above_max');
	});

	it('vetoes a dev dump by default', () => {
		const r = scoreIntel({ ...baseRec, signals: { ...baseRec.signals, dev_sold: true } }, {});
		expect(r.pass).toBe(false);
		expect(r.reasons).toContain('dev_dumped');
	});

	it('respects category allowlist', () => {
		const r = scoreIntel(baseRec, { allowed_categories: ['ai', 'tech'] });
		expect(r.pass).toBe(false);
		expect(r.reasons[0]).toContain('category_excluded');
	});

	it('blends learned weights into the score when available', () => {
		const weights = { organic_score: 0.9, bundle_score: -0.9 };
		const withLearned = scoreIntel(baseRec, {}, weights);
		const without = scoreIntel(baseRec, {}, null);
		expect(withLearned.score).not.toBe(without.score);
		expect(withLearned.reasons.some((r) => r.startsWith('learned:'))).toBe(true);
	});
});

describe('correlation', () => {
	it('is +1 for a perfectly increasing relationship', () => {
		expect(correlation([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]])).toBeCloseTo(1, 5);
	});
	it('is -1 for a perfectly decreasing relationship', () => {
		expect(correlation([[0, 1], [1, 0.75], [2, 0.5], [3, 0.25], [4, 0]])).toBeCloseTo(-1, 5);
	});
	it('returns 0 with too few samples', () => {
		expect(correlation([[1, 1], [2, 0]])).toBe(0);
	});
	it('returns 0 with no variance', () => {
		expect(correlation([[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]])).toBe(0);
	});
});

describe('deriveOutcome', () => {
	it('labels a graduated coin', () => {
		const o = deriveOutcome({ complete: true, usd_market_cap: 90000, market_cap: 400 }, 50);
		expect(o.outcome).toBe('graduated');
		expect(o.graduated).toBe(true);
	});
	it('labels a pump by ATH multiple', () => {
		// first-seen 50 SOL mc; ath 250 USD / (100usd/400sol price) ... craft a 5x.
		const o = deriveOutcome({ usd_market_cap: 20000, market_cap: 100, ath_market_cap: 100000 }, 100);
		expect(o.outcome).toBe('pumped');
	});
	it('labels a rug when market cap collapses', () => {
		const o = deriveOutcome({ usd_market_cap: 1500, market_cap: 8 }, 100);
		expect(o.outcome).toBe('rugged');
		expect(o.rugged).toBe(true);
	});
	it('a pump that then collapsed keeps outcome pumped but IS flagged rugged', () => {
		// ATH 5× (good entry for the learner's question) but now sub-$3k — win-rate
		// metrics must see rugged=true so the spike doesn't count as a clean win.
		const o = deriveOutcome({ usd_market_cap: 1000, market_cap: 5, ath_market_cap: 100000 }, 100);
		expect(o.outcome).toBe('pumped');
		expect(o.rugged).toBe(true);
	});
	it('a graduated coin is never flagged rugged off a stale bonding-curve mark', () => {
		const o = deriveOutcome({ complete: true, usd_market_cap: 1000, market_cap: 5 }, 100);
		expect(o.graduated).toBe(true);
		expect(o.rugged).toBe(false);
	});
	it('returns unknown when the coin cannot be fetched', () => {
		expect(deriveOutcome(null, 100).outcome).toBe('unknown');
	});
});

describe('applyGraduationTruth', () => {
	it('leaves the derived outcome alone when we indexed no graduation', () => {
		const derived = deriveOutcome({ usd_market_cap: 20000, market_cap: 100 }, 100);
		expect(applyGraduationTruth(derived, null)).toEqual(derived);
		expect(applyGraduationTruth(derived, undefined)).toEqual(derived);
	});

	it('rescues a coin the pump.fun lookup could not answer for', () => {
		// The exact production hole: fetchCoin returns null on a 429, deriveOutcome
		// can only say 'unknown', and our own graduation index knows better.
		const o = applyGraduationTruth(deriveOutcome(null, 100), { ath_market_cap: 250000, market_cap_usd: 90000 });
		expect(o.outcome).toBe('graduated');
		expect(o.graduated).toBe(true);
		expect(o.ath_market_cap_usd).toBe(250000);
		expect(o.last_market_cap_usd).toBe(90000);
	});

	it('never flags a graduated coin as rugged', () => {
		// A stale sub-$3k bonding-curve mark makes deriveOutcome call it rugged.
		const derived = deriveOutcome({ usd_market_cap: 1000, market_cap: 5 }, 100);
		expect(derived.rugged).toBe(true);
		expect(applyGraduationTruth(derived, { ath_market_cap: 300000 }).rugged).toBe(false);
	});

	it('keeps the live market caps when the lookup did answer', () => {
		const derived = deriveOutcome({ complete: true, usd_market_cap: 90000, market_cap: 400 }, 50);
		const o = applyGraduationTruth(derived, { ath_market_cap: 1, market_cap_usd: 2 });
		expect(o.last_market_cap_usd).toBe(90000);
		expect(o.ath_market_cap_usd).toBe(90000);
	});

	it('ignores non-numeric caps on the graduation row', () => {
		const o = applyGraduationTruth(deriveOutcome(null, 100), { ath_market_cap: null, market_cap_usd: undefined });
		expect(o.outcome).toBe('graduated');
		expect(o.ath_market_cap_usd).toBeNull();
		expect(o.last_market_cap_usd).toBeNull();
	});
});

describe('learnedScore', () => {
	it('returns null without weights', () => {
		expect(learnedScore({ organic_score: 0.5 }, null)).toBeNull();
	});
	it('returns a 0..1 score with weights', () => {
		const s = learnedScore({ organic_score: 0.9, bundle_score: 0.1 }, { organic_score: 0.8, bundle_score: -0.8 });
		expect(s).toBeGreaterThan(0);
		expect(s).toBeLessThanOrEqual(1);
	});
});
