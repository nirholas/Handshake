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

const { generateSearchQueries, analyzeResults, extractJsonArray } = await import(
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

// The response reader both LLM stages share. The regex it replaced was
// non-greedy, so it stopped at the FIRST "]" in the response and handed the
// stages garbage, which they swallowed silently. These pin the shapes real
// providers actually emit.
describe('extractJsonArray', () => {
	const FENCED = ['```json', '["one","two"]', '```'].join('\n');

	it('reads a bare array', () => {
		expect(extractJsonArray('["a","b"]')).toEqual(['a', 'b']);
	});

	it('ignores a reasoning block that contains its own brackets', () => {
		const text =
			'<think>The user wants [three] queries. Let me list [a, b].</think>\n' +
			'["height of napoleon","napoleon height myth","napoleon 5 foot 7"]';
		expect(extractJsonArray(text)).toEqual([
			'height of napoleon',
			'napoleon height myth',
			'napoleon 5 foot 7',
		]);
	});

	it('ignores an unterminated reasoning block', () => {
		expect(extractJsonArray('<think>still thinking about [x]')).toBeNull();
	});

	it('is not closed early by a bracket inside a string', () => {
		const text = '[{"excerpt":"see note [4] below","stance":"partial"}]';
		expect(extractJsonArray(text)).toEqual([
			{ excerpt: 'see note [4] below', stance: 'partial' },
		]);
	});

	it('is not closed early by an escaped quote inside a string', () => {
		const text = String.raw`[{"excerpt":"he said \"about 330 m\" [sic]","stance":"supports"}]`;
		expect(extractJsonArray(text)[0].stance).toBe('supports');
	});

	it('steps past a leading citation marker to the real payload', () => {
		expect(extractJsonArray('Per [1], here it is: ["one","two"]', { of: 'string' })).toEqual([
			'one',
			'two',
		]);
		// Without a declared shape the citation IS a well-formed array, so it wins.
		expect(extractJsonArray('Per [1], here it is: ["one","two"]')).toEqual([1]);
	});

	it('reads through a markdown code fence', () => {
		expect(extractJsonArray(FENCED)).toEqual(['one', 'two']);
	});

	it('returns null when there is no array at all', () => {
		expect(extractJsonArray('I cannot help with that.')).toBeNull();
		expect(extractJsonArray('')).toBeNull();
		expect(extractJsonArray(null)).toBeNull();
	});

	it('returns null on a truncated array rather than a half-read one', () => {
		expect(extractJsonArray('[{"excerpt":"cut off mid')).toBeNull();
	});
});

// A provider that ANSWERS and is not understood is a different failure from a
// provider that never answered, but both used to end in the same silent
// all-neutral fallback: verdict "insufficient", no degradation reported, the
// result cached for seven days, and the accuracy benchmark scoring it as a real
// verdict. A live check on 2026-09-02 hit exactly that: five real sources,
// 1476 spent tokens, every stance neutral, nothing flagged.
describe('unreadable provider output is reported, not swallowed', () => {
	it('analyzeResults degrades when the stance turn cannot be parsed', async () => {
		llmComplete.mockResolvedValue({
			text: 'I looked at the sources and they seem fine.',
			usage: { input: 900, output: 40 },
		});

		const out = await analyzeResults('some claim', RESULTS);

		expect(out.analyses.every((a) => a.stance === 'neutral')).toBe(true);
		expect(out.degraded).toMatch(/stance extraction unreadable/i);
		// The tokens were really spent, so they are really reported.
		expect(out.tokens).toBe(940);
	});

	it('analyzeResults degrades on an empty array rather than inventing neutrality', async () => {
		llmComplete.mockResolvedValue({ text: '[]', usage: { input: 10, output: 2 } });

		const out = await analyzeResults('some claim', RESULTS);

		expect(out.degraded).toMatch(/stance extraction unreadable/i);
	});

	it('analyzeResults reads a fenced, reasoning-wrapped answer without degrading', async () => {
		llmComplete.mockResolvedValue({
			text: [
				'<think>Result [1] is on point.</think>',
				'```json',
				'[{"excerpt":"true only at high doses [see table]","stance":"partial"},',
				'{"excerpt":"unrelated","stance":"neutral"}]',
				'```',
			].join('\n'),
			usage: { input: 100, output: 20 },
		});

		const out = await analyzeResults('some claim', RESULTS);

		expect(out.analyses.map((a) => a.stance)).toEqual(['partial', 'neutral']);
		expect(out.degraded).toBeUndefined();
	});

	it('generateSearchQueries keeps all three angles through a reasoning block', async () => {
		llmComplete.mockResolvedValue({
			text: '<think>I need [3] angles.</think>["angle one","angle two","angle three"]',
			usage: { input: 50, output: 20 },
		});

		const out = await generateSearchQueries('A claim about something');

		expect(out.queries).toEqual(['angle one', 'angle two', 'angle three']);
		expect(out.degraded).toBeUndefined();
	});

	it('generateSearchQueries degrades when nothing usable can be read', async () => {
		llmComplete.mockResolvedValue({ text: 'Sorry:', usage: { input: 10, output: 3 } });
		const claim = 'A claim about something';

		const out = await generateSearchQueries(claim);

		expect(out.queries).toEqual([claim]);
		expect(out.degraded).toMatch(/query generation unreadable/i);
	});
});

// Shape is what separates the payload from the noise around it: the query stage
// wants strings, the stance stage wants objects, and a citation marker is
// neither of those even though it parses.
describe('extractJsonArray shape filter', () => {
	it('skips a numeric citation to reach an array of the requested shape', () => {
		const text = 'As shown in [12], the stances are: [{"excerpt":"x","stance":"supports"}]';
		expect(extractJsonArray(text, { of: 'object' })).toEqual([
			{ excerpt: 'x', stance: 'supports' },
		]);
	});

	it('returns null when no candidate has the requested shape', () => {
		expect(extractJsonArray('see [1] and [2]', { of: 'string' })).toBeNull();
	});

	it('surfaces an empty array so the caller can call it a degradation', () => {
		expect(extractJsonArray('Nothing to report: []', { of: 'object' })).toEqual([]);
	});

	it('prefers a shaped array over an earlier empty one', () => {
		expect(extractJsonArray('[] then ["a","b"]', { of: 'string' })).toEqual(['a', 'b']);
	});
});
