// /api/coin/news: the related-news rail must not throw away articles it holds.
//
// The endpoint gated its 502 on `sources_ok` — publishers whose LAST refresh
// succeeded. That is a different question from "do we have anything to show":
// the aggregator also serves recent-but-not-just-refreshed copies, so a rail
// holding eight real articles could report zero ok sources and 502, discarding
// them and rendering the page's error state over live content. These tests pin
// the corrected gate: articles win, and only an empty-handed fan-out is an
// outage.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: async () => ({ success: true }) },
	clientIp: () => '203.0.113.1',
}));

const searchNews = vi.fn();
vi.mock('../../api/_lib/news.js', () => ({ searchNews: (...a) => searchNews(...a) }));

const news = (await import('../../api/coin/news.js')).default;

const article = (title) => ({
	id: `id-${title}`,
	title,
	link: 'https://example.com/a',
	description: 'desc',
	image: null,
	source: 'Publisher',
	pub_date: '2026-07-29T00:00:00Z',
});

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(query) {
	const res = makeRes();
	await news({ url: `/api/coin/news?${query}`, method: 'GET', headers: {} }, res);
	return { res, body: JSON.parse(res._body) };
}

describe('/api/coin/news outage gate', () => {
	beforeEach(() => searchNews.mockReset());

	it('serves articles held from a stale-but-usable cache, even with zero ok sources', async () => {
		searchNews.mockResolvedValue({ articles: [article('One'), article('Two')], total: 2, sources_ok: 0, sources_total: 158 });
		const { res, body } = await call('q=Solana&limit=8');
		expect(res.statusCode).toBe(200);
		expect(body.articles).toHaveLength(2);
		expect(body.articles[0].published_at).toBe('2026-07-29T00:00:00Z');
	});

	it('answers 200 with an empty rail when publishers are healthy but nothing matches', async () => {
		searchNews.mockResolvedValue({ articles: [], total: 0, sources_ok: 40, sources_total: 158 });
		const { res, body } = await call('q=SomeUnknownCoin&limit=8');
		expect(res.statusCode).toBe(200);
		expect(body.articles).toEqual([]);
	});

	it('still reports a genuinely empty-handed fan-out as an outage', async () => {
		searchNews.mockResolvedValue({ articles: [], total: 0, sources_ok: 0, sources_total: 158 });
		const { res, body } = await call('q=Solana&limit=8');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});

	it('maps a hard aggregator reject to the same 502, not a generic 500', async () => {
		// Before this was caught here it bubbled to wrap(), which answers a generic
		// `internal_error` AND pages ops with an "unhandled 5xx" alert for what is
		// an ordinary publisher-feed outage.
		searchNews.mockRejectedValue(new Error('fan-out failed: getaddrinfo ENOTFOUND'));
		const { res, body } = await call('q=Solana&limit=8');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
		expect(body.ref).toBeUndefined();
	});

	it('still rejects a missing query', async () => {
		const { res, body } = await call('limit=8');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_query');
		expect(searchNews).not.toHaveBeenCalled();
	});
});
