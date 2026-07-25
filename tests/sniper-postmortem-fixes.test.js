/**
 * The three fixes the published fleet audit demanded
 * (three.ws/blog/autonomous-trading-experiment) and their exact rationale:
 *
 *   1. llmVerdictGate — "0.9-plus verdicts went winless" (overconfidence
 *      ceiling) and "the failover chain answering most calls muddied the
 *      model-vs-model comparison" (named-model strictness).
 *   2. liquidity-decay exit — "dead coins stop squatting on concurrency slots
 *      for half an hour".
 *   3. classifyLoopHealth — "two closed loops looked alive for two days while
 *      doing nothing, behind green health checks. Count rows, not status codes."
 */

import { describe, expect, it } from 'vitest';
import { llmVerdictGate } from '../workers/agent-sniper/llm-judge.js';
import { decideLiquidityDecay, updateStaleClock } from '../workers/agent-sniper/exit-logic.js';
import { LOOPS, classifyLlmRouting, classifyLoopHealth, describeStale, findWalletlessArms } from '../api/_lib/sniper-loops-health.js';

describe('llmVerdictGate', () => {
	const strat = { llm_min_confidence: 0.65, llm_max_confidence: 0.9, llm_strict_model: false };
	const verdict = (over) => ({ buy: true, confidence: 0.75, model: 'x-ai/grok-4.3', ...over });

	it('passes the audit sweet spot (the 0.7 band was the best performer)', () => {
		expect(llmVerdictGate(verdict({ confidence: 0.7 }), strat)).toEqual({ pass: true, reason: 'ok' });
		expect(llmVerdictGate(verdict({ confidence: 0.89 }), strat).pass).toBe(true);
	});

	it('rejects the winless overconfidence band at and above the ceiling', () => {
		expect(llmVerdictGate(verdict({ confidence: 0.9 }), strat)).toEqual({ pass: false, reason: 'overconfident' });
		expect(llmVerdictGate(verdict({ confidence: 0.99 }), strat).reason).toBe('overconfident');
	});

	it('keeps the classic floor', () => {
		expect(llmVerdictGate(verdict({ confidence: 0.6 }), strat).reason).toBe('below_floor');
		expect(llmVerdictGate(verdict({ confidence: 0.4 }), { llm_min_confidence: null }).reason).toBe('below_floor'); // default 0.6
	});

	it('no ceiling configured = unchanged historical behavior', () => {
		expect(llmVerdictGate(verdict({ confidence: 0.99 }), { llm_min_confidence: 0.65 }).pass).toBe(true);
	});

	it('a strict arm refuses to trade on a fallback model verdict', () => {
		const strict = { ...strat, llm_strict_model: true };
		expect(llmVerdictGate(verdict({ model: 'fallback:groq#instant' }), strict)).toEqual({ pass: false, reason: 'fallback_model' });
		expect(llmVerdictGate(verdict({ model: 'fallback:ovh' }), strict).pass).toBe(false);
		// The named model itself still trades.
		expect(llmVerdictGate(verdict(), strict).pass).toBe(true);
	});

	it('a non-strict arm accepts a fallback verdict (the auto arm is any-model by design)', () => {
		expect(llmVerdictGate(verdict({ model: 'fallback:ovh' }), strat).pass).toBe(true);
	});

	it('never buys on a skip or a malformed verdict', () => {
		expect(llmVerdictGate(verdict({ buy: false }), strat).reason).toBe('no_buy');
		expect(llmVerdictGate(null, strat).reason).toBe('no_buy');
		expect(llmVerdictGate(verdict({ confidence: NaN }), strat).reason).toBe('below_floor');
	});
});

describe('liquidity-decay clock', () => {
	const ENTRY = 1_000_000;
	const T = 1_700_000_000_000;

	it('starts the clock when an underwater value stops moving', () => {
		expect(updateStaleClock(800_000, 800_000, ENTRY, null, T)).toBe(T);
	});

	it('keeps the original start while the value stays frozen', () => {
		expect(updateStaleClock(800_000, 800_000, ENTRY, T - 120_000, T)).toBe(T - 120_000);
	});

	it('resets on ANY movement — one trade is not dead liquidity', () => {
		expect(updateStaleClock(800_000, 800_001, ENTRY, T - 120_000, T)).toBe(null);
	});

	it('never runs in profit — quiet winners belong to the exit ladder', () => {
		expect(updateStaleClock(1_500_000, 1_500_000, ENTRY, null, T)).toBe(null);
		expect(updateStaleClock(1_500_000, 1_500_000, ENTRY, T - 999_999, T)).toBe(null);
	});

	it('never starts on the first sweep (no previous value to compare)', () => {
		expect(updateStaleClock(null, 800_000, ENTRY, null, T)).toBe(null);
	});

	it('fires the exit only after the threshold', () => {
		expect(decideLiquidityDecay(T - 299_000, 300, T)).toBe(false);
		expect(decideLiquidityDecay(T - 300_000, 300, T)).toBe(true);
		expect(decideLiquidityDecay(T - 3_600_000, 300, T)).toBe(true);
	});

	it('is disabled by a zero threshold and a null clock', () => {
		expect(decideLiquidityDecay(T - 999_999, 0, T)).toBe(false);
		expect(decideLiquidityDecay(null, 300, T)).toBe(false);
	});
});

describe('classifyLoopHealth (count rows, not status codes)', () => {
	const NOW = 1_700_000_000_000;
	const probe = (name, ageMs) => ({ name, lastAt: ageMs == null ? null : new Date(NOW - ageMs).toISOString() });

	it('declares every audited loop', () => {
		const names = LOOPS.map((l) => l.name);
		// The two loops that silently died in the audit MUST be covered.
		expect(names).toContain('optimizer');
		expect(names).toContain('evolution');
		expect(names).toContain('intel-weight-training');
		expect(names).toContain('outcome-labeling');
		expect(names).toContain('llm-judging');
		expect(names).toContain('oracle-scoring');
	});

	it('passes loops with fresh rows', () => {
		const { ok, stale } = classifyLoopHealth([probe('optimizer', 3600_000), probe('oracle-scoring', 60_000)], NOW);
		expect(stale).toHaveLength(0);
		expect(ok.map((o) => o.name).sort()).toEqual(['optimizer', 'oracle-scoring']);
	});

	it('flags a loop whose freshest row is too old', () => {
		const { stale } = classifyLoopHealth([probe('optimizer', 27 * 3600_000)], NOW);
		expect(stale).toHaveLength(1);
		expect(stale[0].name).toBe('optimizer');
		expect(stale[0].why).toMatch(/silently died/);
	});

	it('treats a loop with NO rows ever as the worst stale, not a pass', () => {
		const { stale } = classifyLoopHealth([probe('evolution', null), probe('optimizer', 27 * 3600_000)], NOW);
		expect(stale[0].name).toBe('evolution'); // Infinity sorts first
		expect(stale[0].ageMs).toBe(Infinity);
		expect(describeStale(stale[0])).toMatch(/NEVER produced a row/);
	});

	it('uses each loop’s own cadence-derived limit', () => {
		// 40 minutes: fine for the 26h optimizer, stale for the 30m oracle scorer.
		const { ok, stale } = classifyLoopHealth([probe('optimizer', 40 * 60_000), probe('oracle-scoring', 40 * 60_000)], NOW);
		expect(ok.map((o) => o.name)).toEqual(['optimizer']);
		expect(stale.map((s) => s.name)).toEqual(['oracle-scoring']);
	});

	it('ignores unknown probes rather than crashing the watchdog', () => {
		const { ok, stale } = classifyLoopHealth([probe('not-a-loop', 0)], NOW);
		expect(ok).toHaveLength(0);
		expect(stale).toHaveLength(0);
	});
});

describe('classifyLlmRouting (the zero-credit OpenRouter outage class)', () => {
	it('alarms when fallbacks absorb nearly all verdicts', () => {
		const r = classifyLlmRouting({ total: 100, fallback: 98 });
		expect(r.degraded).toBe(true);
		expect(r.share).toBeCloseTo(0.98);
		expect(r.detail).toMatch(/OpenRouter credits/);
	});

	it('stays quiet on a healthy mix', () => {
		expect(classifyLlmRouting({ total: 100, fallback: 20 }).degraded).toBe(false);
	});

	it('never alarms on a thin sample', () => {
		const r = classifyLlmRouting({ total: 5, fallback: 5 });
		expect(r.degraded).toBe(false);
		expect(r.share).toBe(null);
	});

	it('sits exactly on the 90% line', () => {
		expect(classifyLlmRouting({ total: 100, fallback: 90 }).degraded).toBe(true);
		expect(classifyLlmRouting({ total: 100, fallback: 89 }).degraded).toBe(false);
	});

	it('survives missing input', () => {
		expect(classifyLlmRouting(null).degraded).toBe(false);
		expect(classifyLlmRouting({}).degraded).toBe(false);
	});
});

describe('findWalletlessArms (the oracle-strict zombie class)', () => {
	const arm = (over) => ({
		strategy_id: 'S1', label: 'oracle-strict', enabled: true,
		wallet: null, daily_budget_lamports: '45957000', ...over,
	});

	it('flags an enabled arm with no wallet — the exact production failure', () => {
		const z = findWalletlessArms([arm()]);
		expect(z).toHaveLength(1);
		expect(z[0].label).toBe('oracle-strict');
		expect(z[0].budgetSol).toBeCloseTo(0.045957);
	});

	it('treats a blank address like a missing one', () => {
		expect(findWalletlessArms([arm({ wallet: '  ' })])).toHaveLength(1);
	});

	it('passes funded arms and ignores disabled ones', () => {
		expect(findWalletlessArms([
			arm({ wallet: 'HBgNvnffvbKRzE1vgmvTfKLNq2taETKZJDpZRHcAm8Ca' }),
			arm({ enabled: false }),
		])).toHaveLength(0);
	});

	it('never throws on empty or missing input', () => {
		expect(findWalletlessArms([])).toEqual([]);
		expect(findWalletlessArms(null)).toEqual([]);
	});
});
