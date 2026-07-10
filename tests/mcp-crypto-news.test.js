// Coverage for the FREE crypto-news MCP tool trio (`crypto_news`,
// `crypto_news_digest`, `crypto_news_archive`) — thin, honest views over the
// public three.ws news APIs. These tests guard:
//   - each descriptor advertises free-ness, is read-only, and quotes no price,
//   - the upstream response is slimmed without inventing fields,
//   - upstream 4xx self-correction hints (valid category lists) pass through
//     verbatim inside a toolError envelope (ok:false → isError),
//   - network failure becomes a designed toolError, never a throw,
//   - archive modes (search/stats/trending) hit the right query params.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildCryptoNewsTool } from '../mcp-server/src/tools/crypto-news.js';
import { buildCryptoNewsDigestTool } from '../mcp-server/src/tools/crypto-news-digest.js';
import { buildCryptoNewsArchiveTool } from '../mcp-server/src/tools/crypto-news-archive.js';

function res(status, body = {}) {
	return { status, ok: status >= 200 && status < 300, json: async () => body };
}
const structured = (envelope) => envelope.structuredContent;

const ARTICLE = {
	id: 'aaaaaaaaaaaaaaaa',
	title: 'Bitcoin ETF inflows hit record',
	link: 'https://example.com/etf',
	description: 'Spot products absorbed inflows.',
	image: null,
	source: 'CoinDesk',
	source_key: 'coindesk',
	category: 'general',
	pub_date: '2026-07-10T10:00:00.000Z',
	tickers: ['BTC'],
	sentiment: { score: 0.4, label: 'positive', confidence: 0.7 },
	lang: 'en',
};

describe('descriptors', () => {
	it.each([
		[buildCryptoNewsTool, 'crypto_news'],
		[buildCryptoNewsDigestTool, 'crypto_news_digest'],
		[buildCryptoNewsArchiveTool, 'crypto_news_archive'],
	])('%s is free, read-only, and quotes no USDC price', (build, name) => {
		const tool = build();
		expect(tool.name).toBe(name);
		expect(tool.description.toLowerCase()).toContain('free');
		expect(tool.description).not.toMatch(/\$[0-9]/);
		expect(tool.annotations.readOnlyHint).toBe(true);
		expect(tool.annotations.destructiveHint).toBe(false);
		expect(tool.handler).toBeTypeOf('function');
	});
});

describe('handlers', () => {
	let fetchMock;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('crypto_news slims articles and reports feed health', async () => {
		fetchMock.mockResolvedValue(
			res(200, { articles: [ARTICLE], total: 120, sources_ok: 180, sources_total: 192, fetched_at: 'now' }),
		);
		const out = structured(await buildCryptoNewsTool().handler({ q: 'etf', limit: 5 }));
		expect(out.ok).toBe(true);
		expect(out.total_matching).toBe(120);
		expect(out.sources_live).toBe('180/192');
		expect(out.articles[0]).toMatchObject({
			title: ARTICLE.title,
			link: ARTICLE.link,
			source: 'CoinDesk',
			tickers: ['BTC'],
			sentiment: 'positive',
		});
		// no invented fields — the slim shape only carries what upstream sent
		expect(out.articles[0]).not.toHaveProperty('id');
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain('/api/news/feed');
		expect(url).toContain('q=etf');
		expect(url).toContain('limit=5');
	});

	it('passes upstream self-correction hints through as a toolError', async () => {
		fetchMock.mockResolvedValue(
			res(400, { error: 'bad_category', message: 'unknown category "defii"', categories: ['defi', 'nft'] }),
		);
		const envelope = await buildCryptoNewsTool().handler({ category: 'defii' });
		expect(envelope.isError).toBe(true);
		const out = structured(envelope);
		expect(out.ok).toBe(false);
		expect(out.error).toBe('bad_category');
		expect(out.upstream.categories).toEqual(['defi', 'nft']); // the model can retry from this
	});

	it('network failure becomes a designed toolError, never a throw', async () => {
		fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
		const envelope = await buildCryptoNewsTool().handler({});
		expect(envelope.isError).toBe(true);
		expect(structured(envelope).error).toBe('news_api_unreachable');
	});

	it('crypto_news_digest returns narratives with real article links', async () => {
		fetchMock.mockResolvedValue(
			res(200, {
				window_hours: 24, mood: 'bullish', top_tickers: ['BTC'], articles_considered: 90,
				engine: 'llm', provider: 'groq', generated_at: 'now',
				narratives: [
					{
						title: 'ETF inflows break records', summary: 'Two outlets report.', stance: 'bullish',
						tickers: ['BTC'], coverage: 2,
						articles: [{ title: 'a', link: 'https://x.com/1', source: 'CoinDesk', pub_date: 'd' }],
					},
				],
			}),
		);
		const out = structured(await buildCryptoNewsDigestTool().handler({ hours: 24 }));
		expect(out.ok).toBe(true);
		expect(out.engine).toBe('llm');
		expect(out.narratives[0].articles[0].link).toBe('https://x.com/1');
		expect(String(fetchMock.mock.calls[0][0])).toContain('/api/news/digest');
	});

	it('crypto_news_archive search forwards filters and surfaces coverage honesty', async () => {
		fetchMock.mockResolvedValue(
			res(200, {
				articles: [{ ...ARTICLE, market_context: { btc_price: 64000 } }],
				total_scanned_matches: 41, has_more: true,
				scanned: { months: ['2026-07'], complete: false, months_remaining: 100 },
				hint: 'add start_date to reach older articles',
			}),
		);
		const out = structured(
			await buildCryptoNewsArchiveTool().handler({ ticker: 'BTC', sentiment: 'positive', limit: 10 }),
		);
		expect(out.ok).toBe(true);
		expect(out.scanned.complete).toBe(false);
		expect(out.hint).toContain('start_date');
		expect(out.articles[0].market_context.btc_price).toBe(64000);
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain('ticker=BTC');
		expect(url).toContain('sentiment=positive');
	});

	it('crypto_news_archive stats and trending modes hit their query flags', async () => {
		fetchMock.mockResolvedValue(res(200, { stats: { total_articles: 662547 } }));
		const stats = structured(await buildCryptoNewsArchiveTool().handler({ mode: 'stats' }));
		expect(stats.stats.total_articles).toBe(662547);
		expect(String(fetchMock.mock.calls[0][0])).toContain('stats=true');

		fetchMock.mockResolvedValue(res(200, { trending: [{ ticker: 'BTC', count: 900 }] }));
		const trending = structured(await buildCryptoNewsArchiveTool().handler({ mode: 'trending' }));
		expect(trending.trending[0].ticker).toBe('BTC');
		expect(String(fetchMock.mock.calls[1][0])).toContain('trending=true');
	});
});

describe('server registration', () => {
	it('the news trio is part of the built tool surface', async () => {
		const { buildTools } = await import('../mcp-server/src/index.js');
		const names = (await buildTools()).map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining(['crypto_news', 'crypto_news_digest', 'crypto_news_archive']),
		);
	});
});
