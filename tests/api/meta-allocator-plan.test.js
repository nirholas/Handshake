// buildAllocationPlan() is what /api/meta-allocator returns to a user asking how
// to split a budget across verified leader agents. Its contract is that it
// always answers with a real basket: the LLM shapes the narrative, and the
// deterministic allocator underneath guarantees an answer when the model does
// not give one.
//
// The gap was a model that replies with a syntactically valid but empty plan.
// `{"allocations": [], "excluded": []}` passed the Array.isArray check, so it
// was accepted verbatim and the endpoint served a plan with zero rows and zero
// exclusions while eight leaders qualified. Observed live on 2026-08-16. An
// empty allocation set is the model declining, not deciding, so it has to fall
// through to the deterministic allocator like any other non-answer.
//
// Only the LLM chain is stubbed; the allocator, the scoring, and the profile
// rules are the real ones.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const llmComplete = vi.fn();
const llmConfigured = vi.fn(() => true);

vi.mock('../../api/_lib/llm.js', () => {
	class LlmUnavailableError extends Error {}
	return { llmComplete, llmConfigured, LlmUnavailableError };
});

vi.mock('../../api/_lib/db.js', () => ({ sql: () => Promise.resolve([]) }));

const { buildAllocationPlan } = await import('../../api/_lib/meta-allocator.js');

// Four leaders spread over three correlation groups, all past the profile bars.
const leaders = ['alpha', 'bravo', 'charlie', 'delta'].map((name, i) => ({
	agent_id: `00000000-0000-4000-8000-00000000000${i}`,
	name,
	settled: 40 + i,
	wins: 20 + i,
	win_rate_pct: 50 + i,
	roi_pct: 12 - i,
	pnl_sol: 1.5 - i * 0.1,
	max_drawdown_pct: 5 + i,
	capacity_quote: 10,
	follower_outcome_pnl: 0.4,
	followers: 3,
	active_followers: 2,
	correlation_group: ['momentum', 'moonshot', 'scalp', 'momentum'][i],
	risk_adjusted_score: 40 - i * 3,
}));

const plan = (over = {}) =>
	buildAllocationPlan({ budgetQuote: 5, riskProfile: 'balanced', leaders, ...over });

beforeEach(() => {
	llmComplete.mockReset();
	llmConfigured.mockReturnValue(true);
});

describe('buildAllocationPlan', () => {
	it('falls back to the deterministic basket when the model allocates to nobody', async () => {
		llmComplete.mockResolvedValue({ text: '{"allocations": [], "excluded": []}' });
		const out = await plan();
		expect(out.source).toBe('deterministic');
		expect(out.allocations.length).toBeGreaterThan(0);
		expect(out.leaders_considered).toBe(leaders.length);
	});

	it('uses the model plan when it actually allocates', async () => {
		llmComplete.mockResolvedValue({
			text: JSON.stringify({
				allocations: [
					{ agent_id: leaders[0].agent_id, weight_pct: 60, why: 'steadiest record' },
					{ agent_id: leaders[1].agent_id, weight_pct: 40, why: 'different style' },
				],
				excluded: [{ agent_id: leaders[3].agent_id, reason: 'same group as the top pick' }],
				rebalance_rule: 'Rebalance monthly.',
				caution: 'Past results are not future ones.',
			}),
		});
		const out = await plan();
		expect(out.source).toBe('llm');
		expect(out.allocations).toHaveLength(2);
	});

	it('falls back when the model returns prose instead of a plan', async () => {
		llmComplete.mockResolvedValue({ text: 'I cannot advise on this.' });
		const out = await plan();
		expect(out.source).toBe('deterministic');
		expect(out.allocations.length).toBeGreaterThan(0);
	});

	it('falls back when the model errors', async () => {
		llmComplete.mockRejectedValue(new Error('provider 429'));
		const out = await plan();
		expect(out.source).toBe('deterministic');
		expect(out.allocations.length).toBeGreaterThan(0);
	});

	it('weights always sum to 100 and every leader is allocated or excluded', async () => {
		llmComplete.mockResolvedValue({ text: '{"allocations": []}' });
		const out = await plan();
		const sum = out.allocations.reduce((s, a) => s + a.weight_pct, 0);
		expect(Math.round(sum)).toBe(100);
		expect(out.allocations.length + out.excluded.length).toBe(leaders.length);
	});

	it('says so plainly when no leader clears the profile bar', async () => {
		llmConfigured.mockReturnValue(false);
		const out = await plan({ leaders: [{ ...leaders[0], settled: 0 }] });
		expect(out.source).toBe('empty');
		expect(out.allocations).toEqual([]);
		expect(out.rebalance_rule).toMatch(/no verified leaders/i);
	});
});
