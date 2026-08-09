// Oracle conviction engine v2: unit tests.
//
// The engine is the product's brain, so its behavior is pinned here: the fitted
// model drives the score, probability maps to the public tier ladder through
// fixed anchors, the smart-money overlay adjusts in log-odds, and the one
// surviving hard cap (serial-rugger creator) ceilings the final score.

import { describe, it, expect } from 'vitest';
import {
	convict,
	evaluateModel,
	smartMoneyOverlay,
	scoreFromProbability,
	MODEL,
	PILLAR_WEIGHTS,
	WEIGHTS,
	tierTone,
} from '../../api/_lib/oracle/conviction.js';
import { archetypeFor, isProven, isFlagged } from '../../api/_lib/oracle/archetype.js';

// A launch whose raw signals sit in the model's empirically-best buckets
// (audit 2026-08-09: organic >=0.8 -> 59.7% good, 40+ unique buyers -> 80%,
// buy volume >=25 SOL -> 70.2%, snipe 0.1-0.3 -> 42.1%).
const strongLaunch = () => ({
	category: 'animal',
	launch: {
		organic_score: 0.85,
		bundle_score: 0.15,
		snipe_ratio: 0.2,
		coordination_score: 0.15,
		timing_entropy: 0.7,
		concentration_top1: 0.1,
		concentration_top10: 0.5,
		unique_buyers: 55,
		buy_sell_ratio: 2.5,
		buy_volume_sol: 30,
		largest_buy_sol: 6,
		avg_buy_sol: 0.6,
		dev_buy_sol: 0.3,
		mc_sol_first_seen: 29,
		dev_sold: false,
	},
	creator: { launches: 4, launchWins: 2 },
	smartMoney: { notable: [] },
});

// The empirically-worst buckets (organic <0.2 -> 1.3% good, no buyers, dead cap).
const deadLaunch = () => ({
	category: 'tech',
	launch: {
		organic_score: 0.1,
		bundle_score: 0.6,
		snipe_ratio: 0.8,
		coordination_score: 0.4,
		timing_entropy: 0.05,
		concentration_top1: 0.02,
		concentration_top10: 0.1,
		unique_buyers: 0,
		buy_volume_sol: 0.1,
		largest_buy_sol: 0.05,
		avg_buy_sol: 0.01,
		dev_buy_sol: 0,
		mc_sol_first_seen: 27,
		dev_sold: false,
	},
	creator: { launches: 0, launchWins: 0 },
	smartMoney: { notable: [] },
});

describe('model', () => {
	it('ships provenance: version, fit date, training size, base rate', () => {
		expect(MODEL.version).toBeGreaterThanOrEqual(2);
		expect(MODEL.training_rows).toBeGreaterThan(50_000);
		expect(MODEL.base_good_rate).toBeGreaterThan(0);
		expect(MODEL.base_good_rate).toBeLessThan(0.5);
		expect(Number.isFinite(MODEL.intercept)).toBe(true);
	});

	it('every bucket weight carries its sample size and observed good-rate', () => {
		for (const f of MODEL.features) {
			for (const [bucket, stats] of Object.entries(f.buckets)) {
				expect(Number.isFinite(stats.w), `${f.key} ${bucket} w`).toBe(true);
				expect(stats.n, `${f.key} ${bucket} n`).toBeGreaterThan(0);
				expect(stats.good_rate).toBeGreaterThanOrEqual(0);
				expect(stats.good_rate).toBeLessThanOrEqual(1);
			}
		}
	});

	it('derived pillar weights sum to 1', () => {
		const sum = Object.values(PILLAR_WEIGHTS).reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(1, 1);
		expect(WEIGHTS).toBe(PILLAR_WEIGHTS); // legacy alias
	});
});

describe('scoreFromProbability', () => {
	it('lands each tier boundary exactly on its probability anchor', () => {
		const a = MODEL.tier_probability_anchors;
		expect(scoreFromProbability(a.watch)).toBe(34);
		expect(scoreFromProbability(a.lean)).toBe(56);
		expect(scoreFromProbability(a.strong)).toBe(72);
		expect(scoreFromProbability(a.prime)).toBe(86);
	});

	it('is monotone and clamped', () => {
		expect(scoreFromProbability(0)).toBe(0);
		expect(scoreFromProbability(1)).toBe(100);
		expect(scoreFromProbability(-1)).toBe(0);
		expect(scoreFromProbability(2)).toBe(100);
		let prev = -1;
		for (let p = 0; p <= 1.0001; p += 0.01) {
			const s = scoreFromProbability(p);
			expect(s).toBeGreaterThanOrEqual(prev);
			prev = s;
		}
	});
});

describe('evaluateModel', () => {
	it('reads raw launch signals and produces a finite fused probability', () => {
		const out = evaluateModel(strongLaunch());
		expect(Number.isFinite(out.z)).toBe(true);
		expect(out.p).toBeGreaterThan(0);
		expect(out.p).toBeLessThan(1);
		expect(out.hits.length).toBe(MODEL.features.length);
	});

	it('scores strong evidence far above dead evidence', () => {
		const strong = evaluateModel(strongLaunch());
		const dead = evaluateModel(deadLaunch());
		expect(strong.p).toBeGreaterThan(dead.p * 5);
	});

	it('tolerates an empty intel without throwing or NaN', () => {
		const out = evaluateModel({});
		expect(Number.isFinite(out.p)).toBe(true);
	});

	it('falls back to derived CoinIntel fields when raw signals are absent', () => {
		const viaRaw = evaluateModel({ launch: { organic_score: 0.85 } });
		const viaDerived = evaluateModel({ structure: { organicScore: 85 } });
		// Same bucket hit either way.
		const rawHit = viaRaw.hits.find((h) => h.key === 'organic_score');
		const derivedHit = viaDerived.hits.find((h) => h.key === 'organic_score');
		expect(rawHit.bucket).toBe(derivedHit.bucket);
	});

	it('computes buy_sell_ratio from behavior counts when the raw signal is missing', () => {
		const out = evaluateModel({ behavior: { buyCount: 30, sellCount: 10 } });
		const hit = out.hits.find((h) => h.key === 'buy_sell_ratio');
		expect(hit.bucket).toBe('2-4');
	});
});

describe('smartMoneyOverlay', () => {
	it('rewards proven wallets and proven-money share', () => {
		const out = smartMoneyOverlay({
			smartWalletCount: 3,
			provenBuyLamports: 5e9,
			totalBuyLamports: 1e10,
			notable: [{ wallet: 'a', label: 'smart_money', score: 88 }],
		});
		expect(out.z).toBeGreaterThan(0);
		expect(out.reasons.join(' ')).toMatch(/smart-money/);
	});

	it('drags on flagged (rugger/dumper) wallets', () => {
		const out = smartMoneyOverlay({
			notable: [
				{ wallet: 'r', label: 'rugger', score: 10 },
				{ wallet: 'd', label: 'dumper', score: 20 },
			],
		});
		expect(out.z).toBeLessThan(0);
		expect(out.reasons.join(' ')).toMatch(/flagged/);
	});

	it('penalizes smart money already exiting', () => {
		const holding = smartMoneyOverlay({ provenBuyLamports: 1e10, provenSellLamports: 0 });
		const exiting = smartMoneyOverlay({ provenBuyLamports: 1e10, provenSellLamports: 6e9 });
		expect(exiting.z).toBeLessThan(holding.z);
	});

	it('caps a serial-rugger creator at 45', () => {
		const out = smartMoneyOverlay({}, { launches: 5, launchWins: 0 });
		expect(out.cap).toBe(45);
		expect(out.z).toBeLessThan(0);
	});

	it('a flagged creator label caps too', () => {
		const out = smartMoneyOverlay({}, { label: 'rugger', launches: 1, launchWins: 0 });
		expect(out.cap).toBe(45);
	});

	it('a dumping creator drags without capping', () => {
		const out = smartMoneyOverlay({}, { launches: 3, launchWins: 1, dumpRate: 0.7 });
		expect(out.z).toBeLessThan(0);
		expect(out.cap).toBe(100);
	});
});

describe('convict (fusion)', () => {
	it('a launch in the best-evidence buckets reads strong or prime', () => {
		const v = convict(strongLaunch());
		expect(['strong', 'prime']).toContain(v.tier);
		expect(v.score).toBeGreaterThanOrEqual(72);
	});

	it('a dead launch reads avoid/watch', () => {
		const v = convict(deadLaunch());
		expect(['avoid', 'watch']).toContain(v.tier);
	});

	it('a serial-rugger creator ceilings the FINAL score, never above watch', () => {
		const intel = strongLaunch();
		intel.creator = { launches: 6, launchWins: 0 };
		const v = convict(intel);
		expect(v.score).toBeLessThanOrEqual(45);
		expect(v.pedigreeCap).toBe(45);
		expect(v.badges).toContain('pedigree-flag');
		expect(v.badges).not.toContain('prime');
	});

	it('smart money lifts the fused score', () => {
		const base = convict(strongLaunch());
		const withSm = strongLaunch();
		withSm.smartMoney = {
			smartWalletCount: 5,
			provenBuyLamports: 5e9,
			totalBuyLamports: 1e10,
			notable: [{ wallet: 'a', label: 'smart_money', score: 88 }],
		};
		const v = convict(withSm);
		expect(v.probability).toBeGreaterThanOrEqual(base.probability);
		expect(v.badges).toContain('smart-money');
	});

	it('flagged wallets pull a coin down', () => {
		const clean = convict(strongLaunch());
		const dirty = strongLaunch();
		dirty.smartMoney = {
			notable: [
				{ wallet: 'r', label: 'rugger', score: 5 },
				{ wallet: 'd', label: 'dumper', score: 10 },
				{ wallet: 'e', label: 'rugger', score: 8 },
			],
		};
		// The strong fixture saturates the 0-100 score line, so assert on the
		// underlying probability, which is strictly monotone in the log-odds.
		expect(convict(dirty).probability).toBeLessThan(clean.probability);
	});

	it('score equals the probability mapped through the tier anchors (no cap case)', () => {
		const v = convict(strongLaunch());
		expect(v.score).toBe(scoreFromProbability(v.probability));
	});

	it('returns a transparent breakdown: pillars, reasons quoting observed rates, provenance', () => {
		const v = convict(strongLaunch());
		for (const k of ['pedigree', 'structure', 'narrative', 'momentum']) {
			expect(v.pillars[k]).toBeGreaterThanOrEqual(0);
			expect(v.pillars[k]).toBeLessThanOrEqual(100);
		}
		expect(v.reasons.length).toBeGreaterThan(0);
		expect(v.reasons.some((r) => /% of similar launches worked/.test(r.text))).toBe(true);
		expect(v.model.training_rows).toBe(MODEL.training_rows);
		expect(v.weights).toBe(PILLAR_WEIGHTS);
	});

	it('is deterministic: same input, same score', () => {
		const a = convict(strongLaunch());
		const b = convict(strongLaunch());
		expect(a.score).toBe(b.score);
		expect(a.probability).toBe(b.probability);
	});

	it('reports high confidence on fully-populated intel and low on an empty one', () => {
		const full = convict(strongLaunch());
		const empty = convict({});
		expect(full.confidence).toBeGreaterThan(empty.confidence);
		expect(empty.confidenceLabel).toBe('low');
		expect(empty.badges).toContain('thin-data');
	});

	it('an empty intel object does not throw and reads low', () => {
		const v = convict({});
		expect(v.score).toBeGreaterThanOrEqual(0);
		expect(v.score).toBeLessThanOrEqual(100);
		expect(['avoid', 'watch']).toContain(v.tier);
	});

	it('unknown pedigree no longer ceilings the verdict: evidence can reach strong without wallet data', () => {
		// v1's unknown-pedigree cap made Strong unreachable (202k live scores,
		// max ever 69). v2: strong observed evidence outranks missing wallet data.
		const intel = strongLaunch();
		intel.creator = {};
		intel.smartMoney = {};
		const v = convict(intel);
		expect(v.score).toBeGreaterThanOrEqual(72);
	});
});

describe('archetypes', () => {
	it('resolves known labels and tolerates unknowns', () => {
		expect(archetypeFor('smart_money').tone).toBe('good');
		expect(archetypeFor('rugger').tone).toBe('bad');
		expect(archetypeFor(null).label).toBe('unproven');
		expect(archetypeFor('garbage').label).toBe('unproven');
	});

	it('isProven / isFlagged match the pedigree rules', () => {
		expect(isProven('smart_money')).toBe(true);
		expect(isProven('kol')).toBe(true);
		expect(isProven('neutral', 80)).toBe(true);
		expect(isProven('neutral', 10)).toBe(false);
		expect(isFlagged('rugger')).toBe(true);
		expect(isFlagged('dumper')).toBe(true);
		expect(isFlagged('smart_money')).toBe(false);
	});
});

describe('tierTone', () => {
	it('maps tiers to UI tones', () => {
		expect(tierTone('prime')).toBe('good');
		expect(tierTone('strong')).toBe('good');
		expect(tierTone('lean')).toBe('warn');
		expect(tierTone('watch')).toBe('neutral');
		expect(tierTone('avoid')).toBe('bad');
	});
});
