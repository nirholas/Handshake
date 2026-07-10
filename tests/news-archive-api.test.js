// Coverage for api/news/archive.js — the GCS-backed historical archive
// endpoint. Tests param validation, stats/months/trending modes, the
// newest-first month scan with honest coverage reporting, and filter
// predicates. GCS is mocked; record shapes mirror the real corpus schema.

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

const { default: handler } = await import('../api/news/archive.js');

function fakeRes() {
	return { setHeader() {}, end() {}, statusCode: 200 };
}
function call(url) {
	const res = fakeRes();
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res);
}

function record(over = {}) {
	return {
		id: Math.random().toString(16).slice(2, 18),
		schema_version: '2.0.0',
		title: 'Bitcoin ETF sees inflows',
		link: 'https://example.com/a',
		canonical_link: 'https://example.com/a',
		description: 'Spot ETF products absorbed inflows.',
		source: 'CoinDesk',
		source_key: 'coindesk',
		category: 'general',
		pub_date: '2025-12-02T10:00:00.000Z',
		first_seen: '2025-12-02T10:00:00.000Z',
		tickers: ['BTC'],
		tags: ['etf'],
		sentiment: { score: 0.4, label: 'positive', confidence: 0.7 },
		market_context: null,
		meta: { language: 'en', is_breaking: false, word_count: 12 },
		...over,
	};
}
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n');

const STATS = {
	version: '2.0.0',
	total_articles: 662047,
	total_with_date: 487690,
	total_with_url: 340047,
	first_article_date: '2017-09-23T10:00:42.000Z',
	last_article_date: '2025-12-03T10:28:51.000Z',
	sources: { odaily: 316016, coindesk: 2108 },
};
const LISTING = {
	items: [
		{ name: 'articles/2025-10.jsonl' },
		{ name: 'articles/2025-11.jsonl' },
		{ name: 'articles/2025-12.jsonl' },
		{ name: 'articles/unknown-date-part1.jsonl' },
	],
};

const MONTHS = {
	'2025-12': jsonl([
		record(),
		record({
			id: 'aaaaaaaaaaaaaaaa',
			title: 'JTO短时跌破2 USDT',
			link: 'https://odaily.news/1',
			canonical_link: 'https://odaily.news/1',
			source: 'Odaily 星球日报',
			source_key: 'odaily',
			pub_date: '2025-12-01T05:00:00.000Z',
			first_seen: '2025-12-01T05:00:00.000Z',
			tickers: ['USDT', 'JTO'],
			sentiment: { score: -0.4, label: 'negative', confidence: 0.7 },
			meta: { language: 'zh', is_breaking: false, word_count: 20 },
		}),
	]),
	'2025-11': jsonl([
		record({
			id: 'bbbbbbbbbbbbbbbb',
			title: 'Solana hits new high',
			link: 'https://example.com/sol',
			canonical_link: 'https://example.com/sol',
			pub_date: '2025-11-10T10:00:00.000Z',
			first_seen: '2025-11-10T10:00:00.000Z',
			tickers: ['SOL'],
		}),
	]),
	'2025-10': jsonl([record({ id: 'cccccccccccccccc', pub_date: '2025-10-05T10:00:00.000Z', first_seen: '2025-10-05T10:00:00.000Z' })]),
};

const originalFetch = global.fetch;

beforeEach(() => {
	global.fetch = vi.fn(async (url) => {
		const u = String(url);
		if (u.includes('/storage/v1/b/')) return { ok: true, json: async () => LISTING };
		if (u.endsWith('/meta/stats.json')) return { ok: true, json: async () => STATS };
		const m = u.match(/articles\/(\d{4}-\d{2})\.jsonl$/);
		if (m && MONTHS[m[1]]) return { ok: true, text: async () => MONTHS[m[1]] };
		return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
	});
});
afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('GET /api/news/archive', () => {
	it('stats=true returns corpus stats and the month range', async () => {
		const res = await call('/api/news/archive?stats=true');
		expect(res._json.status).toBe(200);
		expect(res._json.body.stats.total_articles).toBe(662047);
		expect(res._json.body.stats.undated_articles).toBe(662047 - 487690);
		expect(res._json.body.months).toEqual({ first: '2025-10', last: '2025-12', count: 3 });
	});

	it('months=true lists YYYY-MM months only (unknown-date files excluded)', async () => {
		const res = await call('/api/news/archive?months=true');
		expect(res._json.body.months).toEqual(['2025-10', '2025-11', '2025-12']);
	});

	it('trending=true counts tickers over the newest months', async () => {
		const res = await call('/api/news/archive?trending=true');
		const tickers = res._json.body.trending.map((t) => t.ticker);
		expect(tickers).toEqual(expect.arrayContaining(['BTC', 'SOL', 'USDT']));
	});

	it('rejects malformed dates and bad enums', async () => {
		expect((await call('/api/news/archive?start_date=2024')). _json.status).toBe(400);
		expect((await call('/api/news/archive?start_date=2024-02-01&end_date=2024-01-01'))._json.status).toBe(400);
		expect((await call('/api/news/archive?sentiment=angry'))._json.status).toBe(400);
		expect((await call('/api/news/archive?lang=fr'))._json.status).toBe(400);
	});

	it('queries newest→oldest, sorted by pub_date desc, with coverage report', async () => {
		const res = await call('/api/news/archive?limit=10');
		const { body } = res._json;
		expect(body.articles.length).toBe(4);
		expect(body.articles[0].pub_date >= body.articles[1].pub_date).toBe(true);
		expect(body.scanned.complete).toBe(true);
		expect(body.scanned.months).toEqual(expect.arrayContaining(['2025-12', '2025-11', '2025-10']));
		expect(body.has_more).toBe(false);
	});

	it('filters by ticker + lang + sentiment', async () => {
		const res = await call('/api/news/archive?ticker=JTO&lang=zh&sentiment=negative');
		const { body } = res._json;
		expect(body.total_scanned_matches).toBe(1);
		expect(body.articles[0].lang).toBe('zh');
		expect(body.articles[0].tickers).toContain('JTO');
	});

	it('respects a date-bounded month window', async () => {
		const res = await call('/api/news/archive?start_date=2025-11-01&end_date=2025-11-30');
		const { body } = res._json;
		expect(body.scanned.months).toEqual(['2025-11']);
		expect(body.total_scanned_matches).toBe(1);
		expect(body.articles[0].title).toContain('Solana');
	});

	it('returns an empty result with a hint when the range has no months', async () => {
		const res = await call('/api/news/archive?start_date=2010-01-01&end_date=2010-12-31');
		expect(res._json.body.articles).toEqual([]);
		expect(res._json.body.scanned.complete).toBe(true);
	});

	it('502s with archive_unavailable when GCS is unreachable and nothing is cached', async () => {
		// Fresh module instance — the long-lived handler above has months warm in
		// its LRU (serving from cache during an outage is the desired behavior).
		vi.resetModules();
		const { default: coldHandler } = await import('../api/news/archive.js');
		global.fetch = vi.fn(async () => {
			throw new Error('network down');
		});
		const res = fakeRes();
		await coldHandler({ method: 'GET', url: '/api/news/archive?limit=5', headers: {} }, res);
		expect(res._json.status).toBe(502);
		expect(res._json.body.error).toBe('archive_unavailable');
	});
});
