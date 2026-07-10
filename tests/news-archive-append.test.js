// Coverage for api/cron/news-archive-append.js — the hourly continuous
// archiver. Verifies the cron gate, dry-run accounting, id-dedupe against the
// existing month object, month-scoping of stale feed items, the enriched
// record schema, and the generation-guarded GCS writes. All I/O mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({
	wrapCron: (fn) => fn,
	method: () => true,
	json: (res, status, body) => {
		res._json = { status, body };
		return res;
	},
	error: (res, status, code, message) => {
		res._json = { status, body: { error: code, message } };
		return res;
	},
}));
vi.mock('../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../api/_lib/crypto.js', () => ({
	constantTimeEquals: (a, b) => a === b,
}));
vi.mock('../api/_lib/gcp-auth.js', () => ({
	getGcpAccessToken: vi.fn(async () => 'gcs-token'),
}));
vi.mock('../api/_lib/coingecko.js', () => ({
	geckoFetch: vi.fn(async (path) =>
		path.startsWith('/global')
			? { data: { total_market_cap: { usd: 2.2e12 }, market_cap_percentage: { btc: 56.3 } } }
			: { bitcoin: { usd: 64000 }, ethereum: { usd: 1800 }, solana: { usd: 80 } },
	),
}));

const NOW_MONTH = new Date().toISOString().slice(0, 7);
const LIVE = [
	{
		id: 'aaaaaaaaaaaaaaaa', title: 'BTC rallies', link: 'https://x.com/a', description: 'Bitcoin gains 5%',
		image: null, author: null, source: 'CoinDesk', source_key: 'coindesk', category: 'general',
		pub_date: `${NOW_MONTH}-05T10:00:00.000Z`, tickers: ['BTC'],
		sentiment: { score: 0.4, label: 'positive', confidence: 0.7 },
	},
	{
		id: 'bbbbbbbbbbbbbbbb', title: 'Already archived story', link: 'https://x.com/b', description: null,
		image: null, author: null, source: 'Decrypt', source_key: 'decrypt', category: 'general',
		pub_date: `${NOW_MONTH}-04T10:00:00.000Z`, tickers: [],
		sentiment: { score: 0, label: 'neutral', confidence: 0.5 },
	},
	{
		id: 'cccccccccccccccc', title: 'Stale backlog item', link: 'https://x.com/c', description: null,
		image: null, author: null, source: 'Protos', source_key: 'protos', category: 'journalism',
		pub_date: '2020-01-01T10:00:00.000Z', tickers: [],
		sentiment: { score: 0, label: 'neutral', confidence: 0.5 },
	},
];
vi.mock('../api/_lib/news.js', () => ({
	getNews: vi.fn(async () => ({ articles: LIVE, total: LIVE.length, sources_ok: 37, sources_total: 38 })),
}));

const { default: handler } = await import('../api/cron/news-archive-append.js');

function call(url, auth = 'Bearer s3cret') {
	const res = { setHeader() {}, end() {}, statusCode: 200 };
	return handler({ method: 'GET', url, headers: { authorization: auth } }, res).then(() => res);
}

const originalFetch = global.fetch;
let writes;

beforeEach(() => {
	process.env.CRON_SECRET = 's3cret';
	writes = [];
	global.fetch = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		if (opts.method === 'POST') {
			writes.push({ url: u, body: String(opts.body), headers: opts.headers });
			return { ok: true, status: 200, json: async () => ({ generation: '2' }), text: async () => '' };
		}
		// existing month object holds article b already
		if (u.includes(`articles%2F${NOW_MONTH}.jsonl`) && !u.includes('alt=media')) {
			return { ok: true, status: 200, json: async () => ({ generation: '41' }) };
		}
		if (u.includes(`articles%2F${NOW_MONTH}.jsonl`) && u.includes('alt=media')) {
			return { ok: true, status: 200, text: async () => `${JSON.stringify({ id: 'bbbbbbbbbbbbbbbb' })}\n` };
		}
		if (u.includes('meta%2Fstats.json') && !u.includes('alt=media')) {
			return { ok: true, status: 200, json: async () => ({ generation: '7' }) };
		}
		if (u.includes('meta%2Fstats.json') && u.includes('alt=media')) {
			return {
				ok: true, status: 200,
				text: async () => JSON.stringify({
					total_articles: 662047, total_with_url: 340047, total_with_date: 487690,
					total_with_description: 27791, last_article_date: '2025-12-03T10:28:51.000Z',
					sources: { coindesk: 2108 },
				}),
			};
		}
		if (u.includes('alternative.me')) {
			return { ok: true, status: 200, json: async () => ({ data: [{ value: '23' }] }) };
		}
		return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
	});
});
afterEach(() => {
	delete process.env.CRON_SECRET;
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('GET /api/cron/news-archive-append', () => {
	it('rejects a bad cron secret', async () => {
		const res = await call('/api/cron/news-archive-append', 'Bearer wrong');
		expect(res._json.status).toBe(401);
	});

	it('dry_run reports counts without any GCS write', async () => {
		const res = await call('/api/cron/news-archive-append?dry_run=1');
		expect(res._json.status).toBe(200);
		expect(res._json.body.dry_run).toBe(true);
		// dry run skips the existing-object read, so all in-month items count
		expect(res._json.body.appended).toBe(2);
		expect(writes).toHaveLength(0);
	});

	it('appends only new in-month articles, schema-complete, generation-guarded', async () => {
		const res = await call('/api/cron/news-archive-append');
		expect(res._json.status).toBe(200);
		expect(res._json.body.appended).toBe(1); // b deduped, c out-of-month
		const monthWrite = writes.find((w) => w.url.includes(`articles%2F${NOW_MONTH}.jsonl`));
		expect(monthWrite).toBeTruthy();
		expect(monthWrite.url).toContain('ifGenerationMatch=41');
		const lines = monthWrite.body.trim().split('\n');
		expect(lines).toHaveLength(2); // existing line + 1 appended
		const rec = JSON.parse(lines[1]);
		expect(rec).toMatchObject({
			id: 'aaaaaaaaaaaaaaaa',
			schema_version: '2.0.0',
			source_key: 'coindesk',
			tickers: ['BTC'],
			content_hash: 'aaaaaaaaaaaaaaaa',
		});
		expect(rec.market_context.btc_price).toBe(64000);
		expect(rec.market_context.fear_greed_index).toBe(23);
		expect(rec.meta.language).toBe('en');
		expect(rec.meta.import_source).toBe('three.ws-live-archiver');
	});

	it('updates corpus stats after an append', async () => {
		await call('/api/cron/news-archive-append');
		const statsWrite = writes.find((w) => w.url.includes('meta%2Fstats.json'));
		expect(statsWrite).toBeTruthy();
		expect(statsWrite.url).toContain('ifGenerationMatch=7');
		const stats = JSON.parse(statsWrite.body);
		expect(stats.total_articles).toBe(662048);
		expect(stats.sources.coindesk).toBe(2109);
		expect(stats.last_article_date).toBe(`${NOW_MONTH}-05T10:00:00.000Z`);
	});
});
