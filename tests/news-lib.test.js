// Coverage for api/_lib/news.js — the native crypto-news aggregation engine.
// Exercises feed parsing (RSS 2.0 + Atom), normalization, ticker extraction,
// lexicon sentiment, dedupe, and the serve-stale-on-error source cache. All
// network I/O is mocked; the parsing runs on realistic fixture XML.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
	parseFeed, lexiconSentiment, extractTickers, articleId, stripHtml, getNews, findArticle,
	stripFeedBoilerplate, truncateWords, cleanImageUrl, metaContent, extractOgImage,
} = await import('../api/_lib/news.js');
const { isFeaturedSource, NEWS_SOURCES } = await import('../api/_lib/news-sources.js');

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

	it('stripFeedBoilerplate removes WordPress syndication tails', () => {
		expect(
			stripFeedBoilerplate('Real reporting here. The post Some Headline appeared first on CoinDesk.'),
		).toBe('Real reporting here.');
		expect(stripFeedBoilerplate('Body text. Continue reading on our site')).toBe('Body text.');
		expect(stripFeedBoilerplate('Trailing elision […]')).toBe('Trailing elision');
		expect(stripFeedBoilerplate('Clean sentence.')).toBe('Clean sentence.');
	});

	it('truncateWords never cuts mid-word and marks the elision', () => {
		const source = 'the quick brown fox jumps over the lazy dog';
		const out = truncateWords(source, 20);
		expect(out.endsWith('…')).toBe(true);
		// every emitted word must be a complete word from the source
		const words = out.slice(0, -1).trim().split(' ');
		expect(source.split(' ').slice(0, words.length)).toEqual(words);
		expect(truncateWords('short', 20)).toBe('short');
		expect(truncateWords('', 20)).toBeNull();
		// a single word longer than the cap still truncates rather than overflowing
		expect(truncateWords('supercalifragilistic', 10).length).toBeLessThanOrEqual(11);
	});
});

describe('image hygiene', () => {
	it('cleanImageUrl keeps real https URLs and upgrades http / protocol-relative', () => {
		expect(cleanImageUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
		expect(cleanImageUrl('http://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
		expect(cleanImageUrl('//cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
	});

	it('cleanImageUrl rejects data: URIs, relative paths, and tracking pixels', () => {
		expect(cleanImageUrl('data:image/svg+xml,%3Csvg%3E')).toBeNull(); // ZeroHedge ships this
		expect(cleanImageUrl('/images/local.png')).toBeNull();
		expect(cleanImageUrl('ftp://example.com/a.jpg')).toBeNull();
		expect(cleanImageUrl('https://stats.example.com/1x1.gif')).toBeNull();
		expect(cleanImageUrl('https://example.com/spacer.gif')).toBeNull();
		expect(cleanImageUrl('https://feeds.feedburner.com/~r/site/~4/abc')).toBeNull();
		expect(cleanImageUrl('')).toBeNull();
		expect(cleanImageUrl(null)).toBeNull();
	});

	it('parseFeed falls through junk media:content to a real enclosure image', () => {
		const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
			<channel><item>
				<title>Story with a junk media slot</title>
				<link>https://example.com/story</link>
				<media:content url="data:image/svg+xml,%3Csvg%3E"/>
				<enclosure url="https://cdn.example.com/real.jpg" type="image/jpeg"/>
			</item></channel></rss>`;
		const [a] = parseFeed(xml, 'coindesk');
		expect(a.image).toBe('https://cdn.example.com/real.jpg');
	});

	it('extractOgImage reads og:image / twitter:image in either attribute order', () => {
		expect(
			extractOgImage('<head><meta property="og:image" content="https://pub.example.com/og.jpg"/></head>'),
		).toBe('https://pub.example.com/og.jpg');
		expect(
			extractOgImage('<head><meta content="https://pub.example.com/tw.jpg" name="twitter:image"/></head>'),
		).toBe('https://pub.example.com/tw.jpg');
		// secure_url wins over the plain og:image
		expect(
			extractOgImage(
				'<head><meta property="og:image" content="http://pub.example.com/a.jpg"/><meta property="og:image:secure_url" content="https://pub.example.com/b.jpg"/></head>',
			),
		).toBe('https://pub.example.com/b.jpg');
		// a data:-URI og:image is junk, not a preview
		expect(extractOgImage('<meta property="og:image" content="data:image/png;base64,xx"/>')).toBeNull();
		expect(extractOgImage('<head><title>no meta</title></head>')).toBeNull();
	});

	it('metaContent returns null when the tag is absent', () => {
		expect(metaContent('<head></head>', ['og:image'])).toBeNull();
	});
});

describe('featured sources', () => {
	it('admits tier1/tier2 and high-credibility outlets, refuses the long tail', () => {
		expect(isFeaturedSource('coindesk')).toBe(true); // tier2, 0.95
		expect(isFeaturedSource('theblock')).toBe(true); // tier2, 0.93
		expect(isFeaturedSource('bbc_business')).toBe(true); // tier1
		expect(isFeaturedSource('watcherguru')).toBe(false); // tier3, 0.68
		expect(isFeaturedSource('not-a-source')).toBe(false);
		// the bar yields a real set — enough for a Featured tab, far below the registry
		const featured = Object.keys(NEWS_SOURCES).filter(isFeaturedSource);
		expect(featured.length).toBeGreaterThanOrEqual(8);
		expect(featured.length).toBeLessThan(Object.keys(NEWS_SOURCES).length / 4);
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
