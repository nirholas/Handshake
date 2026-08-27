/**
 * Grounded web search (api/_lib/web-search.js): request budget + failure detail.
 *
 * /api/web-search answered 502 on every production query on 2026-08-16. The
 * request asked Vertex Gemini 2.5 Flash for a grounded answer with a flat
 * maxOutputTokens of 1024 and no thinking cap. Gemini 2.5 reasons by default and
 * bills those tokens against maxOutputTokens WITHOUT returning them (the exact
 * behaviour api/_lib/vertex-gemini.js already documents and funds around on the
 * OpenAI-compat path), so the reply came back with no text and no grounding
 * chunks, groundedSearch threw "empty grounded response", and the handler turned
 * that into a 502.
 *
 * These tests pin the two halves of the repair: the reasoning cap is declared AND
 * funded on top of the visible budget, and an empty response now names its own
 * cause so the next 502 is diagnosable from one log line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The module mints a real GCP OAuth token at call time; the tests are about the
// request body and the failure reporting, so stub the token out.
vi.mock('../../api/_lib/gcp-auth.js', () => ({ getGcpAccessToken: async () => 'test-token' }));

const { groundedSearch, webSearchAvailable, _resetWebSearchMemory } = await import('../../api/_lib/web-search.js');

const OLD_ENV = { ...process.env };

function jsonResponse(body, ok = true, status = 200) {
	return {
		ok,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

beforeEach(() => {
	process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
	process.env.VERTEX_GEMINI_THINKING_BUDGET = '512';
});

afterEach(() => {
	process.env = { ...OLD_ENV };
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('groundedSearch request shape', () => {
	it('is gated by GOOGLE_CLOUD_PROJECT', () => {
		expect(webSearchAvailable()).toBe(true);
		delete process.env.GOOGLE_CLOUD_PROJECT;
		expect(webSearchAvailable()).toBe(false);
	});

	it('caps reasoning and funds it ON TOP of the visible answer budget', async () => {
		let sent;
		vi.stubGlobal('fetch', async (_url, init) => {
			sent = JSON.parse(init.body);
			return jsonResponse({
				candidates: [
					{
						content: { parts: [{ text: 'Solana is a high-throughput L1.' }] },
						groundingMetadata: {
							groundingChunks: [{ web: { uri: 'https://solana.com', title: 'Solana', domain: 'solana.com' } }],
							webSearchQueries: ['what is solana'],
						},
					},
				],
			});
		});

		const out = await groundedSearch('what is solana');
		expect(out.answer).toContain('Solana');
		expect(out.sources).toHaveLength(1);

		const cfg = sent.generationConfig;
		expect(cfg.thinkingConfig.thinkingBudget).toBe(512);
		// The reasoning cap must be additional, never carved out of the caller's
		// answer budget: that subtraction is what emptied the response.
		expect(cfg.maxOutputTokens).toBeGreaterThan(512);
		expect(cfg.maxOutputTokens).toBe(1024 + 512);
		expect(sent.tools).toEqual([{ googleSearch: {} }]);
	});

	it('honours a VERTEX_GEMINI_THINKING_BUDGET override', async () => {
		process.env.VERTEX_GEMINI_THINKING_BUDGET = '0';
		let sent;
		vi.stubGlobal('fetch', async (_url, init) => {
			sent = JSON.parse(init.body);
			return jsonResponse({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] });
		});

		await groundedSearch('q');
		expect(sent.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
		expect(sent.generationConfig.maxOutputTokens).toBe(1024);
	});
});

describe('groundedSearch failure reporting', () => {
	it('names the finish reason when the model returns neither text nor sources', async () => {
		vi.stubGlobal('fetch', async () =>
			jsonResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }),
		);

		await expect(groundedSearch('q')).rejects.toThrow(/finishReason=MAX_TOKENS/);
	});

	it('names a prompt-level block reason', async () => {
		vi.stubGlobal('fetch', async () => jsonResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }));

		await expect(groundedSearch('q')).rejects.toThrow(/promptBlockReason=SAFETY/);
	});

	it('surfaces an upstream non-2xx with its status', async () => {
		vi.stubGlobal('fetch', async () => jsonResponse({ error: 'nope' }, false, 403));

		await expect(groundedSearch('q')).rejects.toThrow(/upstream 403/);
	});

	it('refuses an empty query before spending a token', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		await expect(groundedSearch('   ')).rejects.toThrow(/empty query/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

// A single-provider surface cannot fail over, but it can remember. The line
// that matters is WHICH failures a memory is allowed to cover: an unreachable
// provider, yes; a safety block or an empty answer, never, because replaying an
// older answer over one of those quietly overturns a decision made on purpose.
describe('groundedSearch availability memory', () => {
	const answered = (text) =>
		jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });

	beforeEach(() => {
		_resetWebSearchMemory();
	});

	it('serves a remembered answer when the provider is unreachable', async () => {
		vi.stubGlobal('fetch', async () => answered('cached answer'));
		const live = await groundedSearch('memory-q');
		expect(live.answer).toBe('cached answer');
		expect(live.stale).toBeUndefined();

		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		const stale = await groundedSearch('memory-q');
		expect(stale.answer).toBe('cached answer');
		expect(stale.stale).toBe(true);
		expect(stale.as_of).toBeTruthy();
	});

	it('serves a remembered answer through a 503, but never through a safety block', async () => {
		vi.stubGlobal('fetch', async () => answered('cached answer'));
		await groundedSearch('memory-q2');

		vi.stubGlobal('fetch', async () => jsonResponse({ error: 'busy' }, false, 503));
		expect((await groundedSearch('memory-q2')).stale).toBe(true);

		vi.stubGlobal('fetch', async () =>
			jsonResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
		);
		await expect(groundedSearch('memory-q2')).rejects.toThrow(/promptBlockReason=SAFETY/);
	});

	it('rethrows when the provider is unreachable and nothing was ever remembered', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		await expect(groundedSearch('never-seen')).rejects.toThrow(/fetch failed/);
	});
});
