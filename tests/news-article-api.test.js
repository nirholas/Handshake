// Coverage for api/news/article.js — the reader endpoint's input boundary and
// its write into the durable knowledge base.
//
// Two guarantees are load-bearing and both were previously unenforced:
//   1. `url` must be a web link. `new URL()` parses javascript:/file:/data:
//      URLs happily, and the extraction ladder then refuses them rung by rung,
//      which used to surface as a 200 carrying an empty "Untitled" article.
//   2. Only a story with real extracted body text is recorded to the corpus the
//      3D agents ground on. The endpoint is public and unauthenticated and the
//      caller supplies url/title/source, so recording every request turned a
//      single GET into a permanent knowledge row with an attacker-chosen
//      headline.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	json: (res, status, body, headers = {}) => {
		res._json = { status, body, headers };
		return res;
	},
	error: (res, status, code, message) => {
		res._json = { status, body: { error: code, message } };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { marketFeedIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: vi.fn(),
	llmConfigured: vi.fn(() => false),
}));

const extractArticle = vi.fn();
vi.mock('../api/_lib/article-extract.js', () => ({ extractArticle: (...a) => extractArticle(...a) }));

const recordExtraction = vi.fn(async () => {});
const getExtraction = vi.fn(async () => null);
vi.mock('../api/_lib/news-knowledge-store.js', () => ({
	recordExtraction: (...a) => recordExtraction(...a),
	getExtraction: (...a) => getExtraction(...a),
}));

vi.mock('../api/_lib/news-coins.js', () => ({ enrichTickers: vi.fn(async () => []) }));

const findArticle = vi.fn(async () => null);
const getNews = vi.fn(async () => ({ articles: [], total: 0, sources_ok: 1, sources_total: 1 }));
vi.mock('../api/_lib/news.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		findArticle: (...a) => findArticle(...a),
		getNews: (...a) => getNews(...a),
	};
});

const { default: handler } = await import('../api/news/article.js');

function call(url) {
	const res = { setHeader() {}, end() {}, statusCode: 200 };
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res._json);
}

const PARAS = [
	'Regulated venues took share as oversight tightened across the region this quarter.',
	'The regulator published its final rulebook on Tuesday after a year of consultation.',
	'Exchanges that registered early reported the largest inflows of the period.',
];

beforeEach(() => {
	extractArticle.mockReset();
	recordExtraction.mockReset();
	getExtraction.mockReset().mockResolvedValue(null);
	findArticle.mockReset().mockResolvedValue(null);
	getNews.mockReset().mockResolvedValue({ articles: [], total: 0, sources_ok: 1, sources_total: 1 });
});
afterEach(() => vi.clearAllMocks());

describe('url validation', () => {
	it('rejects a missing url', async () => {
		const out = await call('/api/news/article');
		expect(out.status).toBe(400);
		expect(out.body.error).toBe('bad_url');
	});

	it('rejects a relative or unparseable url', async () => {
		const out = await call('/api/news/article?url=notaurl');
		expect(out.status).toBe(400);
		expect(out.body.error).toBe('bad_url');
	});

	for (const scheme of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi']) {
		it(`rejects the non-web scheme in ${scheme.split(':')[0]}:`, async () => {
			const out = await call(`/api/news/article?url=${encodeURIComponent(scheme)}`);
			expect(out.status).toBe(400);
			expect(out.body.error).toBe('bad_url');
			// The refusal happens at the boundary — nothing is fetched, nothing
			// reaches the corpus.
			expect(extractArticle).not.toHaveBeenCalled();
			expect(recordExtraction).not.toHaveBeenCalled();
		});
	}

	it('accepts an https article link', async () => {
		extractArticle.mockResolvedValue({ paragraphs: PARAS, extraction: 'page', blocked_reason: null, html: null });
		const out = await call('/api/news/article?url=https%3A%2F%2Fpublisher.example%2Fstory');
		expect(out.status).toBe(200);
		expect(out.body.extraction).toBe('page');
		expect(out.body.paragraphs.length).toBeGreaterThan(0);
	});
});

describe('knowledge-base write gate', () => {
	// A distinct URL per case: the handler keeps a 30-minute in-process cache
	// keyed by URL, and a cache hit short-circuits before the write.
	it('records a story that yielded real body text', async () => {
		extractArticle.mockResolvedValue({ paragraphs: PARAS, extraction: 'page', blocked_reason: null, html: null });
		await call('/api/news/article?url=https%3A%2F%2Fpublisher.example%2Fstory-recorded');
		expect(recordExtraction).toHaveBeenCalledTimes(1);
		expect(recordExtraction.mock.calls[0][0].content_chars).toBeGreaterThan(0);
	});

	it('does not record a zero-content preview, however the caller labels it', async () => {
		extractArticle.mockResolvedValue({
			paragraphs: [],
			extraction: 'preview',
			blocked_reason: 'publisher blocked the fetch',
			html: null,
		});
		const out = await call(
			'/api/news/article?url=https%3A%2F%2Fpublisher.example%2Fblocked&title=Attacker%20chosen%20headline&source=Reuters',
		);
		// The reader still gets an honest preview response...
		expect(out.status).toBe(200);
		expect(out.body.extraction).toBe('preview');
		expect(out.body.blocked_reason).toBe('publisher blocked the fetch');
		expect(out.body.content_chars).toBe(0);
		// ...but nothing enters the corpus the agents ground on.
		expect(recordExtraction).not.toHaveBeenCalled();
	});
});
