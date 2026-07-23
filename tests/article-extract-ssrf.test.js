// Regression guard for the 2026-07-23 security audit fix in
// api/_lib/article-extract.js. The public /api/news/article?url= endpoint
// fetches a fully caller-controlled URL; the extractor used to guard it with
// a local check that validated only the FIRST DNS answer, pinned nothing, and
// followed redirects without re-validating any hop, so a public host could
// 302 the server into 169.254.169.254 or another internal address and the
// response text flowed back to the caller (and into the news knowledge base).
//
// Both fetch rungs must now go through the platform pinned guard
// (fetchSafePublicUrlPinned / assertSafePublicUrl in api/_lib/ssrf-guard.js),
// which validates every DNS answer, pins the socket to the checked IP, and
// re-validates every redirect hop. These tests fail if a raw
// redirect-following fetch ever returns to this module.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const pinned = vi.fn();
const assertSafe = vi.fn();

vi.mock('../api/_lib/ssrf-guard.js', () => ({
	fetchSafePublicUrlPinned: (...args) => pinned(...args),
	assertSafePublicUrl: (...args) => assertSafe(...args),
}));

import { fetchArticleHtml, fetchViaReader } from '../api/_lib/article-extract.js';

const MAX_BYTES = 5 * 1024 * 1024;

beforeEach(() => {
	pinned.mockReset();
	assertSafe.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchArticleHtml (rung 1)', () => {
	it('fetches only through the pinned guard, never raw fetch', async () => {
		const rawFetch = vi.fn();
		vi.stubGlobal('fetch', rawFetch);
		pinned.mockResolvedValueOnce(
			new Response('<html><body><p>story</p></body></html>', {
				status: 200,
				headers: { 'content-type': 'text/html' },
			}),
		);

		const html = await fetchArticleHtml('https://publisher.example/story');

		expect(pinned).toHaveBeenCalledTimes(1);
		expect(pinned).toHaveBeenCalledWith(
			'https://publisher.example/story',
			expect.objectContaining({
				headers: expect.objectContaining({ 'user-agent': expect.any(String) }),
			}),
			{ maxBytes: MAX_BYTES },
		);
		expect(rawFetch).not.toHaveBeenCalled();
		expect(html).toContain('story');
	});

	it('propagates a guard block instead of falling back to a direct fetch', async () => {
		const rawFetch = vi.fn();
		vi.stubGlobal('fetch', rawFetch);
		pinned.mockRejectedValueOnce(
			Object.assign(new Error('host resolves to a blocked range'), { code: 'ssrf_blocked' }),
		);

		await expect(
			fetchArticleHtml('http://169.254.169.254/latest/meta-data'),
		).rejects.toThrow(/blocked range/);
		expect(rawFetch).not.toHaveBeenCalled();
	});

	it('still enforces the html content-type contract', async () => {
		pinned.mockResolvedValueOnce(
			new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
		);
		await expect(fetchArticleHtml('https://publisher.example/data')).rejects.toThrow(
			/unsupported content type/,
		);
	});
});

describe('fetchViaReader (rung 2)', () => {
	it('validates the target BEFORE handing it to the reader service', async () => {
		assertSafe.mockResolvedValueOnce(undefined);
		pinned.mockResolvedValueOnce(
			new Response('Markdown Content:\n\nA perfectly ordinary paragraph of article prose, long enough to keep.', {
				status: 200,
			}),
		);

		await fetchViaReader('https://publisher.example/story');

		expect(assertSafe).toHaveBeenCalledWith('https://publisher.example/story');
		expect(pinned).toHaveBeenCalledTimes(1);
		expect(pinned.mock.calls[0][0]).toBe('https://r.jina.ai/https://publisher.example/story');
		expect(pinned.mock.calls[0][2]).toEqual({ maxBytes: MAX_BYTES });
	});

	it('never calls the reader service for a rejected target', async () => {
		assertSafe.mockRejectedValueOnce(
			Object.assign(new Error('url is not a valid URL'), { code: 'ssrf_blocked' }),
		);

		await expect(fetchViaReader('http://127.0.0.1:8080/internal')).rejects.toThrow();
		expect(pinned).not.toHaveBeenCalled();
	});
});
