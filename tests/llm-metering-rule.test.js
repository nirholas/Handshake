// The metering rule the audit script enforces (npm run audit:llm-metering).
//
// Tested here rather than only against the live ledger, because the failure
// this guards against is a lane REPORTING zero, and the only honest way to
// prove the guard fires is to feed it that exact shape. Writing a fake row into
// the production usage_events table to prove a check works is not a test, it is
// a data-integrity problem.

import { describe, it, expect } from 'vitest';
import { classifyMeteringLane } from '../api/_lib/llm-metering-rule.js';

describe('a spending lane that reports exactly $0 fails', () => {
	it('fails the OpenRouter paid mirror reporting zero (the live regression)', () => {
		const v = classifyMeteringLane({
			provider: 'openrouter',
			model: 'anthropic/claude-opus-5',
			tokens: 1_200_000,
			costMicroUsd: 0,
		});
		expect(v.status).toBe('fail');
		expect(v.reason).toMatch(/exactly \$0/);
	});

	it('fails a paid first-party lane reporting zero', () => {
		expect(classifyMeteringLane({ provider: 'anthropic', model: 'claude-sonnet-5', tokens: 5000, costMicroUsd: 0 }).status).toBe('fail');
		expect(classifyMeteringLane({ provider: 'openai', model: 'gpt-5.4-nano', tokens: 5000, costMicroUsd: 0 }).status).toBe('fail');
	});

	it('fails the credits-billed Vertex lanes reporting zero', () => {
		expect(classifyMeteringLane({ provider: 'vertex-gemini', model: 'google/gemini-2.5-flash', tokens: 5000, costMicroUsd: 0 }).status).toBe('fail');
		expect(classifyMeteringLane({ provider: 'vertex-anthropic', model: 'claude-sonnet-5', tokens: 5000, costMicroUsd: 0 }).status).toBe('fail');
	});

	it('passes the same lane once it reports a real cost', () => {
		const v = classifyMeteringLane({ provider: 'openrouter', model: 'anthropic/claude-opus-5', tokens: 1_200_000, costMicroUsd: 4_312 });
		expect(v.status).toBe('ok');
		expect(v.free).toBe(false);
	});
});

describe('an unknown cost is a failure, not a quiet zero', () => {
	it('fails a lane with any unpriced call and names the fix', () => {
		const v = classifyMeteringLane({ provider: 'openrouter', model: 'newvendor/brand-new', tokens: 900, costMicroUsd: 0, unpricedCalls: 3 });
		expect(v.status).toBe('fail');
		expect(v.reason).toMatch(/UNKNOWN cost/);
		expect(v.reason).toMatch(/newvendor\/brand-new/);
	});

	it('fails even when other calls on the lane were priced', () => {
		expect(classifyMeteringLane({ provider: 'anthropic', model: 'claude-opus-5', tokens: 900, costMicroUsd: 50_000, unpricedCalls: 1 }).status).toBe('fail');
	});
});

describe('genuinely free lanes may report $0', () => {
	for (const [provider, model] of [
		['groq', 'llama-3.3-70b-versatile'],
		['groq#instant', 'llama-3.1-8b-instant'],
		['openrouter', 'google/gemma-4-31b-it:free'],
		['openrouter#3', 'google/gemma-4-31b-it:free'],
		['nvidia', 'meta/llama-3.3-70b-instruct'],
		['ovh', 'Meta-Llama-3_3-70B-Instruct'],
		['pollinations', 'openai-fast'],
		['cerebras', 'llama-3.3-70b'],
		['gemini', 'gemini-2.5-flash-lite'],
	]) {
		it(`passes ${provider}/${model} at zero`, () => {
			const v = classifyMeteringLane({ provider, model, tokens: 500_000, costMicroUsd: 0 });
			expect(v.status).toBe('ok');
			expect(v.free).toBe(true);
		});
	}

	it('fails a free lane that somehow booked spend', () => {
		const v = classifyMeteringLane({ provider: 'groq', model: 'llama-3.3-70b-versatile', tokens: 100, costMicroUsd: 42 });
		expect(v.status).toBe('fail');
		expect(v.reason).toMatch(/classified free/);
	});
});

describe('attribution', () => {
	it('fails tokens served with no provider recorded', () => {
		expect(classifyMeteringLane({ provider: null, model: null, tokens: 1000, costMicroUsd: 0 }).status).toBe('fail');
	});

	it('skips a zero-token event with no provider (nothing reached an upstream)', () => {
		const v = classifyMeteringLane({ provider: null, model: null, tokens: 0, costMicroUsd: 0, unpricedCalls: 33 });
		expect(v.status).toBe('skip');
	});
});
