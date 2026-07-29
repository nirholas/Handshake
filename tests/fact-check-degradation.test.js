// The fact-checker's degradation contract.
//
// Both LLM stages ship a designed fallback (search the claim itself; mark every
// stance neutral). Those fallbacks used to be reachable ONLY when a provider
// returned unparseable text — when the provider chain itself failed or ran out
// of budget, the error propagated out of the stage and killed the whole check,
// so the request that most needed the fallback was the one that never got it.
// Production saw that as 40-60s hangs ending in a 502 carrying nothing, on
// claims the pipeline already had real sources for.
//
// These tests pin the repaired behaviour: a stage that cannot reach a provider
// degrades, reports that it degraded, and lets the check finish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const llmComplete = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({ llmComplete: (...a) => llmComplete(...a) }));

const { generateSearchQueries, analyzeResults } = await import(
	'../agents/fact-checker/src/llm-verdict.js'
);
const { searchAll } = await import('../agents/fact-checker/src/search-sources.js');

const RESULTS = [
	{ url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', title: 'Eiffel Tower', snippet: 'A tower in Paris.' },
	{ url: 'https://www.britannica.com/topic/Eiffel-Tower', title: 'Eiffel Tower', snippet: 'Paris landmark.' },
];

beforeEach(() => {
	llmComplete.mockReset();
});

describe('generateSearchQueries degradation', () => {
	it('falls back to the claim itself when every provider fails', async () => {
		llmComplete.mockRejectedValue(
			Object.assign(new Error('openai 429: billing_not_active'), { status: 502 }),
		);
		const claim = 'The Eiffel Tower is located in Paris, France.';

		const out = await generateSearchQueries(claim);

		expect(out.queries).toEqual([claim]);
		expect(out.tokens).toBe(0);
		expect(out.degraded).toMatch(/query generation unavailable/i);
	});

	it('does not start a provider turn it has no budget to finish', async () => {
		llmComplete.mockResolvedValue({ text: '["a","b","c"]', usage: { input: 1, output: 1 } });

		const out = await generateSearchQueries('A claim about something', { budgetMs: 200 });

		expect(llmComplete).not.toHaveBeenCalled();
		expect(out.degraded).toMatch(/no budget/i);
		expect(out.queries).toEqual(['A claim about something']);
	});

	it('passes the caller budget through as the chain timeout', async () => {
		llmComplete.mockResolvedValue({ text: '["one","two","three"]', usage: { input: 5, output: 5 } });

		const out = await generateSearchQueries('A claim', { budgetMs: 9_000 });

		expect(llmComplete).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 9_000 }));
		expect(out.queries).toEqual(['one', 'two', 'three']);
		expect(out.degraded).toBeUndefined();
	});
});

describe('analyzeResults degradation', () => {
	it('marks every stance neutral when every provider fails', async () => {
		llmComplete.mockRejectedValue(new Error('all providers exhausted'));

		const out = await analyzeResults('some claim', RESULTS);

		expect(out.analyses).toHaveLength(RESULTS.length);
		expect(out.analyses.every((a) => a.stance === 'neutral')).toBe(true);
		expect(out.tokens).toBe(0);
		expect(out.degraded).toMatch(/stance extraction unavailable/i);
	});

	it('still parses a healthy provider response without flagging degradation', async () => {
		llmComplete.mockResolvedValue({
			text: '[{"excerpt":"A tower in Paris","stance":"supports"},{"excerpt":"Paris landmark","stance":"supports"}]',
			usage: { input: 100, output: 20 },
		});

		const out = await analyzeResults('some claim', RESULTS);

		expect(out.analyses.map((a) => a.stance)).toEqual(['supports', 'supports']);
		expect(out.degraded).toBeUndefined();
		expect(out.tokens).toBe(120);
	});
});

// The search chain is driven entirely through fetch, so stubbing fetch controls
// every rung (Wikipedia and DuckDuckGo are the keyless fallbacks that run when
// no provider key and no Vertex project are configured, which is the shape these
// tests pin).
describe('searchAll deadline', () => {
	const realFetch = globalThis.fetch;
	const realEnv = { ...process.env };

	beforeEach(() => {
		for (const k of ['BRAVE_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'SERPER_API_KEY', 'GOOGLE_CLOUD_PROJECT']) {
			delete process.env[k];
		}
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		process.env = { ...realEnv };
	});

	const wikiPayload = (title) => ({
		ok: true,
		status: 200,
		json: async () => ({
			query: { pages: { 1: { index: 1, title, extract: `${title} is a real thing described here.` } } },
		}),
	});

	it('gives up on a stalled query instead of holding the sweep open', async () => {
		// Every rung hangs. Before the budget existed this sat until the edge cut
		// the request off at 60s and the caller got a 502 carrying nothing.
		globalThis.fetch = vi.fn(() => new Promise(() => {}));

		const started = Date.now();
		const out = await searchAll(['q1', 'q2'], { budgetMs: 150 });
		const elapsed = Date.now() - started;

		expect(out).toEqual([]);
		expect(elapsed).toBeLessThan(3_000);
	});

	it('keeps evidence from the queries that did answer in time', async () => {
		globalThis.fetch = vi.fn((url) =>
			String(url).includes('fast')
				? Promise.resolve(wikiPayload('Fast Result'))
				: new Promise(() => {}),
		);

		const out = await searchAll(['fast', 'slow'], { budgetMs: 200 });

		expect(out).toHaveLength(1);
		expect(out[0].title).toBe('Fast Result');
	});

	it('returns full results when the sweep finishes inside the budget', async () => {
		globalThis.fetch = vi.fn(() => Promise.resolve(wikiPayload('Prompt Result')));

		const out = await searchAll(['q1'], { budgetMs: 5_000 });

		expect(out).toHaveLength(1);
		expect(out[0].title).toBe('Prompt Result');
	});
});
