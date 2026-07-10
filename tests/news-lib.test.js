// Coverage for api/_lib/news.js — the native crypto-news aggregation engine.
// Exercises feed parsing (RSS 2.0 + Atom), normalization, ticker extraction,
// lexicon sentiment, dedupe, and the serve-stale-on-error source cache. All
// network I/O is mocked; the parsing runs on realistic fixture XML.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { parseFeed, lexiconSentiment, extractTickers, articleId, stripHtml, getNews, findArticle } =
	await import('../api/_lib/news.js');

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>CoinDesk</title>
<item>
	<title>Bitcoin Surges Past $120K as ETF Inflows Hit Record High</title>
	<link>https://www.coindesk.com/markets/2026/07/09/btc-surge</link>
	<description><![CDATA[<p>Bitcoin rallied to a new all-time high &amp; analysts cite $4B in weekly ETF inflows.</p>]]></description>
	<content:encoded><![CDATA[<p>Bitcoin rallied to a new all-time high on Thursday.</p><p>Spot ETF products absorbed roughly four billion dollars over the week, the strongest stretch since launch, according to exchange data.</p><p>Ethereum and Solana followed with smaller gains.</p>]]></content:encoded>
	<pubDate>Thu, 09 Jul 2026 14:00:00 GMT</pubDate>
	<dc:creator>Jane Doe</dc:creator>
	<media:content url="https://img.example.com/btc.jpg" />
</item>
<item>
	<title>Exchange Hacked: $40M Stolen in Hot Wallet Exploit</title>
	<link>https://www.coindesk.com/business/2026/07/09/hack</link>
	<description>Attackers drained the exchange hot wallet overnight.</description>
	<pubDate>Thu, 09 Jul 2026 10:00:00 GMT</pubDate>
</item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>Base</title>
	<entry>
		<title>Scaling update: throughput doubled</title>
		<link rel="alternate" href="https://base.mirror.xyz/scaling-update"/>
		<summary>The network upgrade doubled gas throughput.</summary>
		<published>2026-07-08T09:00:00Z</published>
		<author><name>Base Team</name></author>
	</entry>
</feed>`;

describe('parseFeed', () => {
	it('parses RSS 2.0 items into normalized articles', () => {
		const articles = parseFeed(RSS_FIXTURE, 'coindesk');
		expect(articles).toHaveLength(2);
		const a = articles[0];
		expect(a.title).toBe('Bitcoin Surges Past $120K as ETF Inflows Hit Record High');
		expect(a.link).toBe('https://www.coindesk.com/markets/2026/07/09/btc-surge');
		expect(a.source).toBe('CoinDesk');
		expect(a.source_key).toBe('coindesk');
		expect(a.category).toBe('general');
		expect(a.image).toBe('https://img.example.com/btc.jpg');
		expect(a.author).toBe('Jane Doe');
		expect(a.pub_date).toBe('2026-07-09T14:00:00.000Z');
		expect(a.description).toContain('Bitcoin rallied');
		expect(a.description).not.toContain('<p>');
		expect(a.id).toMatch(/^[0-9a-f]{16}$/);
	});

	it('captures the full content:encoded body for the reader fallback', () => {
		const [a] = parseFeed(RSS_FIXTURE, 'coindesk');
		expect(a.content_text).toContain('four billion dollars');
		expect(a.content_text.length).toBeGreaterThan((a.description || '').length);
	});

	it('parses Atom entries including rel=alternate links', () => {
		const articles = parseFeed(ATOM_FIXTURE, 'base_blog');
		expect(articles).toHaveLength(1);
		expect(articles[0].link).toBe('https://base.mirror.xyz/scaling-update');
		expect(articles[0].title).toBe('Scaling update: throughput doubled');
		expect(articles[0].pub_date).toBe('2026-07-08T09:00:00.000Z');
	});

	it('drops items with no link or title', () => {
		const xml = `<rss><channel><item><title>only title</title></item></channel></rss>`;
		expect(parseFeed(xml, 'coindesk')).toHaveLength(0);
	});
});

describe('enrichment', () => {
	it('detects tickers from $SYMBOL and known names', () => {
		expect(extractTickers('Bitcoin and $PEPE rally while Solana dips')).toEqual(
			expect.arrayContaining(['BTC', 'PEPE', 'SOL']),
		);
	});

	it('scores clearly positive and negative headlines apart', () => {
		const pos = lexiconSentiment('Bitcoin surges to all-time high after ETF approval');
		const neg = lexiconSentiment('Exchange hacked, funds stolen in $40M exploit');
		expect(pos.label).toMatch(/positive/);
		expect(neg.label).toMatch(/negative/);
		expect(lexiconSentiment('Weekly newsletter roundup').label).toBe('neutral');
	});

	it('articleId is a stable 16-hex hash of the link', () => {
		expect(articleId('https://x.com/a')).toBe(articleId('https://x.com/a'));
		expect(articleId('https://x.com/a')).not.toBe(articleId('https://x.com/b'));
		expect(articleId('https://x.com/a')).toMatch(/^[0-9a-f]{16}$/);
	});

	it('stripHtml flattens tags and entities', () => {
		expect(stripHtml('<p>A &amp; B&nbsp;&mdash; C</p>')).toBe('A & B — C');
	});
});

describe('getNews aggregation', () => {
	const originalFetch = global.fetch;
	beforeEach(() => {
		global.fetch = vi.fn(async () => ({
			ok: true,
			text: async () => RSS_FIXTURE,
		}));
	});
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('aggregates a single source, filters by q, strips content_text from payloads', async () => {
		const res = await getNews({ source: 'coindesk', q: 'etf', limit: 10 });
		expect(res.articles.length).toBe(1);
		expect(res.articles[0].title).toContain('ETF');
		expect(res.articles[0]).not.toHaveProperty('content_text');
		expect(res.sources_total).toBe(1);
		expect(res.sources_ok).toBe(1);
	});

	it('returns empty for an unknown source key instead of fanning out', async () => {
		const res = await getNews({ source: 'not-a-source' });
		expect(res.articles).toEqual([]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('serves the last-good copy when a source starts failing', async () => {
		await getNews({ source: 'coindesk' }); // primes the cache (fresh fetch above)
		global.fetch = vi.fn(async () => ({ ok: false, status: 503, text: async () => '' }));
		// force refetch by advancing time past the 5-minute TTL
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 6 * 60_000);
		const res = await getNews({ source: 'coindesk' });
		expect(res.articles.length).toBeGreaterThan(0); // stale copy, not a blank page
		expect(res.sources_ok).toBe(0);
		vi.useRealTimers();
	});

	it('findArticle locates a cached article with its content_text intact', async () => {
		const link = 'https://www.coindesk.com/markets/2026/07/09/btc-surge';
		const hit = await findArticle({ link });
		expect(hit).toBeTruthy();
		expect(hit.content_text).toContain('four billion dollars');
	});
});
