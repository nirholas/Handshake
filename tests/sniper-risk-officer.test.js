import { describe, it, expect, vi } from 'vitest';

// The officer's ledger writes are fire-and-forget; the pure logic under test
// never touches the DB or the network, so a no-op `sql` is enough to import it.
vi.mock('../api/_lib/db.js', () => ({
	sql: () => Promise.resolve([]),
	LAMPORTS_PER_SOL: 1_000_000_000,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/llm.js', () => ({ llmComplete: () => Promise.reject(new Error('offline')) }));

import {
	parseReview,
	applyReview,
	resolveRiskOfficerLevel,
	reviewBrief,
	RISK_OFFICER_LEVELS,
} from '../workers/agent-sniper/risk-officer.js';

const SOL = 1_000_000_000n;

describe('resolveRiskOfficerLevel', () => {
	it('defaults to shadow so enforcement is never armed by accident', () => {
		expect(resolveRiskOfficerLevel({}, undefined)).toBe('shadow');
		expect(resolveRiskOfficerLevel({}, '')).toBe('shadow');
	});
	it('takes the env default when the strategy has no opinion', () => {
		expect(resolveRiskOfficerLevel({}, 'enforce')).toBe('enforce');
		expect(resolveRiskOfficerLevel({}, 'OFF')).toBe('off');
	});
	it('lets the per-strategy column override the env default', () => {
		expect(resolveRiskOfficerLevel({ risk_officer_level: 'enforce' }, 'off')).toBe('enforce');
		expect(resolveRiskOfficerLevel({ risk_officer_level: 'off' }, 'enforce')).toBe('off');
	});
	it('degrades an unrecognised value to shadow rather than enforcing it', () => {
		expect(resolveRiskOfficerLevel({ risk_officer_level: 'strict' }, 'enforce')).toBe('shadow');
		expect(RISK_OFFICER_LEVELS).toEqual(['off', 'shadow', 'enforce']);
	});
});

describe('parseReview', () => {
	it('parses a clean veto', () => {
		const r = parseReview('{"veto":true,"severity":"block","reasons":["creator rugged 3 prior launches"],"size_adjustment":null}');
		expect(r).toEqual({ veto: true, severity: 'block', reasons: ['creator rugged 3 prior launches'], sizeAdjustmentSol: null });
	});
	it('unwraps a ```json fence and surrounding prose', () => {
		const r = parseReview('Here is my review:\n```json\n{"veto":false,"severity":"none","reasons":[]}\n```');
		expect(r.severity).toBe('none');
		expect(r.veto).toBe(false);
	});
	it('normalizes veto to agree with severity', () => {
		// Models routinely disagree with themselves across the two fields.
		expect(parseReview('{"veto":true,"severity":"caution","reasons":["thin book"]}').veto).toBe(false);
		expect(parseReview('{"veto":false,"severity":"block","reasons":["mint authority live"]}').veto).toBe(true);
	});
	it('infers severity from the veto flag when severity is missing or junk', () => {
		expect(parseReview('{"veto":true,"reasons":["top-10 hold 82%"]}').severity).toBe('block');
		expect(parseReview('{"veto":false,"severity":"kinda","reasons":[]}').severity).toBe('none');
	});
	it('downgrades a block that cites nothing — a veto must name a fact', () => {
		const r = parseReview('{"veto":true,"severity":"block","reasons":[]}');
		expect(r.severity).toBe('caution');
		expect(r.veto).toBe(false);
	});
	it('drops a non-positive size adjustment', () => {
		expect(parseReview('{"severity":"caution","reasons":["x"],"size_adjustment":0}').sizeAdjustmentSol).toBeNull();
		expect(parseReview('{"severity":"caution","reasons":["x"],"size_adjustment":-1}').sizeAdjustmentSol).toBeNull();
		expect(parseReview('{"severity":"caution","reasons":["x"],"size_adjustment":"big"}').sizeAdjustmentSol).toBeNull();
	});
	it('returns null on unusable output so the caller fails open', () => {
		expect(parseReview('')).toBeNull();
		expect(parseReview('I refuse to answer.')).toBeNull();
		expect(parseReview('{not json at all}')).toBeNull();
	});
});

describe('applyReview', () => {
	const block = { veto: true, severity: 'block', reasons: ['creator rugged 3 prior launches'], sizeAdjustmentSol: null };
	const cut = { veto: false, severity: 'caution', reasons: ['price impact eats the edge'], sizeAdjustmentSol: 0.05 };
	const base = { perTradeLamports: SOL / 10n, minTradeLamports: 10_000n }; // 0.1 SOL proposed

	it('is a no-op in shadow — the whole point of the default level', () => {
		const d = applyReview({ ...base, review: block, level: 'shadow' });
		expect(d.blocked).toBe(false);
		expect(d.resized).toBe(false);
		expect(d.sizeLamports).toBe(SOL / 10n);
	});
	it('is a no-op when the officer is off', () => {
		expect(applyReview({ ...base, review: block, level: 'off' }).blocked).toBe(false);
	});
	it('blocks on a block severity under enforce', () => {
		const d = applyReview({ ...base, review: block, level: 'enforce' });
		expect(d.blocked).toBe(true);
		expect(d.reason).toBe('creator rugged 3 prior launches');
	});
	it('never blocks on a caution alone', () => {
		const caution = { veto: false, severity: 'caution', reasons: ['thin socials'], sizeAdjustmentSol: null };
		expect(applyReview({ ...base, review: caution, level: 'enforce' }).blocked).toBe(false);
	});
	it('fails open when the reviewer was unavailable', () => {
		expect(applyReview({ ...base, review: null, level: 'enforce' }).blocked).toBe(false);
		expect(applyReview({ ...base, review: { ...block, degraded: true }, level: 'enforce' }).blocked).toBe(false);
	});
	it('shrinks the trade to a smaller suggested size', () => {
		const d = applyReview({ ...base, review: cut, level: 'enforce' });
		expect(d.resized).toBe(true);
		expect(d.sizeLamports).toBe(50_000_000n); // 0.05 SOL
	});
	it('REFUSES to upsize — an adversarial reviewer may only reduce risk', () => {
		const bigger = { ...cut, sizeAdjustmentSol: 5 };
		const d = applyReview({ ...base, review: bigger, level: 'enforce' });
		expect(d.resized).toBe(false);
		expect(d.sizeLamports).toBe(SOL / 10n);
	});
	it('clamps a sub-minimum suggestion up to the floor instead of aborting', () => {
		// The officer asked for less risk, not for no trade.
		const dust = { ...cut, sizeAdjustmentSol: 0.000000001 };
		const d = applyReview({ ...base, review: dust, level: 'enforce' });
		expect(d.blocked).toBe(false);
		expect(d.resized).toBe(true);
		expect(d.sizeLamports).toBe(10_000n);
	});
	it('is a no-op when the floor already equals the proposed size', () => {
		const d = applyReview({ review: { ...cut, sizeAdjustmentSol: 0.000000001 }, level: 'enforce', perTradeLamports: 10_000n, minTradeLamports: 10_000n });
		expect(d.resized).toBe(false);
		expect(d.sizeLamports).toBe(10_000n);
	});
});

describe('reviewBrief', () => {
	const mint = {
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		symbol: 'THREE', name: 'three.ws', market_cap_usd: 42_137.4,
		creator_launches: 2, creator_graduated: 1, entry_trigger: 'new_mint',
	};
	const brief = reviewBrief({
		mint, sizeSol: 0.1, budgetLeftSol: 0.4, slotsLeft: 2,
		priceImpactPct: 3.14159, firewall: { verdict: 'allow', score: 91 },
		agentReason: 'clean creator, real two-sided book',
	});

	it('states the proposal, the thesis and the remaining mandate', () => {
		expect(brief).toContain('PROPOSED: BUY 0.1000 SOL of THREE');
		expect(brief).toContain('clean creator, real two-sided book');
		expect(brief).toContain('daily budget left: 0.4000 SOL');
		expect(brief).toContain('open position slots left: 2');
	});
	it('carries the real facts, rounded not invented', () => {
		expect(brief).toContain('market_cap_usd: 42137');
		expect(brief).toContain('price_impact_pct: 3.142');
		expect(brief).toContain('safety_firewall_verdict: allow');
	});
	it('OMITS facts the caller does not have rather than guessing them', () => {
		// A fabricated holder count is exactly what an adversarial reviewer would
		// (correctly) veto on, so absent fields must never appear at all.
		expect(brief).not.toContain('twitter');
		expect(brief).not.toContain('dev_initial_buy_sol');
		expect(brief).not.toContain('null');
	});
	it('says so plainly when a rule-based entry carries no thesis', () => {
		const b = reviewBrief({ mint, sizeSol: 0.1, budgetLeftSol: 0.4, slotsLeft: 1, priceImpactPct: 1, firewall: null, agentReason: null });
		expect(b).toContain('(rule-based entry, no stated thesis)');
	});
});
