// Coverage for the Reddit community listings in the news pipeline: the
// reddit_* registry entries (api/_lib/news-sources.js) and the keyless-JSON
// adapters plus the Atom-mirror fallback in api/_lib/news.js.
//
// No live network here, matching the house style for news coverage (liveness
// is scripts/news-sources-probe.mjs's concern; see tests/news-sources.test.js).
// The fixtures are real-shaped against Reddit's keyless listing schema, and
// the Atom fixture mirrors a capture from the live r/solana hot.rss taken
// 2026-08-06. That capture session is also why the fallback exists at all: the
// JSON endpoint answered a constant 403 to datacenter egress (every UA, every
// host variant) while the Atom mirror of the same listing answered 200 to the
// aggregator's bot UA, which is exactly the split these tests exercise.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getNews } = await import('../../api/_lib/news.js');
const { NEWS_SOURCES } = await import('../../api/_lib/news-sources.js');

const NOW_S = Math.floor(Date.now() / 1000);

// A keyless hot.json listing, shaped exactly like Reddit's (kind/data/children
// envelope, t3 posts with score / stickied / over_18 / permalink /
// created_utc). The lead post is a real r/solana front-page item from the
// 2026-08-06 capture.
const LISTING_FIXTURE = {
	kind: 'Listing',
	data: {
		after: 't3_after',
		children: [
			{
				kind: 't3',
				data: {
					title: 'Read this before posting (rules and resources)',
					permalink: '/r/solana/comments/aaa111/read_this_before_posting/',
					score: 950,
					stickied: true,
					over_18: false,
					author: 'solana-mods',
					selftext: 'Subreddit rules.',
					created_utc: NOW_S - 86400 * 30,
				},
			},
			{
				kind: 't3',
				data: {
					title: 'Solana Proposals Enter Preliminary Vote to Raise Fee Burn and Speed Inflation Decline',
					permalink: '/r/solana/comments/1vegh2l/solana_proposals_enter_preliminary_vote_to_raise/',
					score: 812,
					stickied: false,
					over_18: false,
					author: 'ansi09',
					selftext: '',
					url: 'https://governance.example.com/proposal',
					thumbnail: 'default',
					preview: {
						images: [
							{
								source: {
									url: 'https://preview.redd.it/6dzf9dsekchh1.png?width=1400&height=530&auto=webp&s=97d8c185204126e7752ff957c7dc3fe573d3aa15',
									width: 1400,
									height: 530,
								},
							},
						],
					},
					created_utc: NOW_S - 3600,
				},
			},
			{
				kind: 't3',
				data: {
					title: 'How do validators handle the new fee burn split?',
					permalink: '/r/solana/comments/bbb222/how_do_validators_handle_the_new_fee_burn_split/',
					score: 57,
					stickied: false,
					over_18: false,
					author: 'validator-curious',
					selftext:
						'Trying to understand how the burn interacts with priority fees on Solana. If the proposal passes, does the validator share of priority fees change too, or only the base fee burn? Links to the actual SIMD text welcome.',
					thumbnail: 'self',
					created_utc: NOW_S - 7200,
				},
			},
			{
				kind: 't3',
				data: {
					title: 'my wallet screenshot',
					permalink: '/r/solana/comments/ccc333/my_wallet_screenshot/',
					score: 2,
					stickied: false,
					over_18: false,
					author: 'shillbot9000',
					selftext: '',
					created_utc: NOW_S - 600,
				},
			},
			{
				kind: 't3',
				data: {
					title: 'Daily Discussion - August 6, 2026 (GMT+0)',
					permalink: '/r/solana/comments/ddd444/daily_discussion/',
					score: 410,
					stickied: false,
					over_18: false,
					author: 'AutoModerator',
					selftext: 'Talk about anything.',
					created_utc: NOW_S - 1800,
				},
			},
			{
				kind: 't3',
				data: {
					title: 'NSFW chart art',
					permalink: '/r/solana/comments/eee555/nsfw_chart_art/',
					score: 90,
					stickied: false,
					over_18: true,
					author: 'degen',
					selftext: '',
					created_utc: NOW_S - 900,
				},
			},
		],
	},
};

// The same listing as Reddit's Atom mirror serves it (hot.rss): single
// link-with-href entries, html content wrapped in the "submitted by /u/x
// [link] [comments]" boilerplate. Structure mirrors the live 2026-08-06
// r/solana capture.
const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
	<category term="solana" label="r/solana"/>
	<updated>2026-08-06T00:03:01+00:00</updated>
	<id>/r/solana/hot.rss?limit=40</id>
	<title>Solana</title>
	<entry>
		<author><name>/u/ansi09</name><uri>https://www.reddit.com/user/ansi09</uri></author>
		<category term="solana" label="r/solana"/>
		<content type="html">&lt;div class="md"&gt;&lt;p&gt;Preliminary vote is live on the governance portal.&lt;/p&gt;&lt;/div&gt; submitted by &lt;a href="https://www.reddit.com/user/ansi09"&gt; /u/ansi09 &lt;/a&gt; [link] [comments]</content>
		<id>t3_1vegh2l</id>
		<link href="https://www.reddit.com/r/solana/comments/1vegh2l/solana_proposals_enter_preliminary_vote_to_raise/" />
		<updated>2026-08-05T21:03:33+00:00</updated>
		<published>2026-08-05T21:03:33+00:00</published>
		<title>Solana Proposals Enter Preliminary Vote to Raise Fee Burn and Speed Inflation Decline</title>
	</entry>
	<entry>
		<author><name>/u/AutoModerator</name><uri>https://www.reddit.com/user/AutoModerator</uri></author>
		<category term="solana" label="r/solana"/>
		<content type="html">Talk about anything. submitted by &lt;a href="https://www.reddit.com/user/AutoModerator"&gt; /u/AutoModerator &lt;/a&gt; [link] [comments]</content>
		<id>t3_ddd444</id>
		<link href="https://www.reddit.com/r/solana/comments/ddd444/daily_discussion/" />
		<updated>2026-08-05T22:00:00+00:00</updated>
		<published>2026-08-05T22:00:00+00:00</published>
		<title>Daily Discussion - August 6, 2026 (GMT+0)</title>
	</entry>
</feed>`;

describe('reddit registry entries', () => {
	const redditKeys = Object.keys(NEWS_SOURCES).filter((k) => k.startsWith('reddit_'));

	it('registers the six subreddit listings as keyless JSON sources', () => {
		expect([...redditKeys].sort()).toEqual(
			['reddit_solana', 'reddit_cryptocurrency', 'reddit_cryptomarkets', 'reddit_defi', 'reddit_bitcoin', 'reddit_ethereum'].sort(),
		);
		for (const key of redditKeys) {
			const src = NEWS_SOURCES[key];
			expect(src.kind, key).toBe('json');
			const url = new URL(src.url);
			expect(url.hostname, key).toBe('www.reddit.com');
			expect(url.pathname, key).toMatch(/^\/r\/[A-Za-z]+\/hot\.json$/);
			// raw_json=1 keeps preview URLs unescaped; no OAuth params anywhere
			expect(url.searchParams.get('raw_json'), key).toBe('1');
			expect(src.url, key).not.toMatch(/oauth|token|key=/i);
		}
	});

	it('maps each subreddit to its home category', () => {
		expect(NEWS_SOURCES.reddit_solana.category).toBe('solana');
		expect(NEWS_SOURCES.reddit_cryptocurrency.category).toBe('general');
		expect(NEWS_SOURCES.reddit_cryptomarkets.category).toBe('trading');
		expect(NEWS_SOURCES.reddit_defi.category).toBe('defi');
		expect(NEWS_SOURCES.reddit_bitcoin.category).toBe('bitcoin');
		expect(NEWS_SOURCES.reddit_ethereum.category).toBe('ethereum');
	});

	it('lists reddit_solana first, honouring the chain priority (refresh follows registry order)', () => {
		expect(redditKeys[0]).toBe('reddit_solana');
	});

	it('declares the Atom mirror of the SAME subreddit listing as the fallback', () => {
		for (const key of redditKeys) {
			const src = NEWS_SOURCES[key];
			const sub = src.url.match(/\/r\/([^/]+)\/hot\.json/)[1];
			const fb = new URL(src.fallback_url);
			expect(fb.hostname, key).toBe('www.reddit.com');
			expect(fb.pathname, key).toBe(`/r/${sub}/hot.rss`);
		}
	});
});

describe('reddit JSON adapter (hot.json)', () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('normalizes posts into the article shape and drops stickied, low-score, megathread, and NSFW noise', async () => {
		global.fetch = vi.fn(async () => ({ ok: true, json: async () => LISTING_FIXTURE }));
		const res = await getNews({ source: 'reddit_solana', limit: 20 });

		expect(res.sources_ok).toBe(1);
		const titles = res.articles.map((a) => a.title);
		expect(titles).toContain('Solana Proposals Enter Preliminary Vote to Raise Fee Burn and Speed Inflation Decline');
		expect(titles).toContain('How do validators handle the new fee burn split?');
		// stickied, score < 5, Daily Discussion megathread, over_18: all filtered
		expect(titles).not.toContain('Read this before posting (rules and resources)');
		expect(titles).not.toContain('my wallet screenshot');
		expect(titles.join(' ')).not.toMatch(/Daily Discussion/);
		expect(titles).not.toContain('NSFW chart art');

		const lead = res.articles.find((a) => a.title.startsWith('Solana Proposals'));
		expect(lead.link).toBe(
			'https://www.reddit.com/r/solana/comments/1vegh2l/solana_proposals_enter_preliminary_vote_to_raise/',
		);
		expect(lead.id).toMatch(/^[0-9a-f]{16}$/);
		expect(lead.source).toBe('r/solana');
		expect(lead.source_key).toBe('reddit_solana');
		expect(lead.category).toBe('solana');
		expect(lead.author).toBe('u/ansi09');
		expect(lead.score).toBe(812);
		expect(lead.pub_date).toBe(new Date((NOW_S - 3600) * 1000).toISOString());
		expect(lead.image).toBe(
			'https://preview.redd.it/6dzf9dsekchh1.png?width=1400&height=530&auto=webp&s=97d8c185204126e7752ff957c7dc3fe573d3aa15',
		);
		expect(lead.tickers).toContain('SOL');
		expect(lead.sentiment).toHaveProperty('label');

		const selfPost = res.articles.find((a) => a.title.startsWith('How do validators'));
		expect(selfPost.description).toContain('priority fees');
		expect(selfPost.score).toBe(57);
		// the 'self' thumbnail placeholder is not an image
		expect(selfPost.image).toBeNull();
	});
});

describe('reddit Atom-mirror fallback (hot.rss)', () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('serves the listing from the Atom mirror when the JSON rung answers 403', async () => {
		const urls = [];
		global.fetch = vi.fn(async (url) => {
			urls.push(String(url));
			if (String(url).includes('hot.json')) return { ok: false, status: 403 };
			return { ok: true, text: async () => ATOM_FIXTURE.replace(/\/r\/solana\//g, '/r/ethereum/') };
		});
		const res = await getNews({ source: 'reddit_ethereum', limit: 20 });

		expect(urls[0]).toBe(NEWS_SOURCES.reddit_ethereum.url);
		expect(urls[1]).toBe(NEWS_SOURCES.reddit_ethereum.fallback_url);
		expect(res.sources_ok).toBe(1);
		const titles = res.articles.map((a) => a.title);
		expect(titles).toContain('Solana Proposals Enter Preliminary Vote to Raise Fee Burn and Speed Inflation Decline');
		// the Atom mirror carries no stickied/score metadata, so the megathread
		// gate re-applies from the title
		expect(titles.join(' ')).not.toMatch(/Daily Discussion/);

		const a = res.articles[0];
		expect(a.link).toBe('https://www.reddit.com/r/ethereum/comments/1vegh2l/solana_proposals_enter_preliminary_vote_to_raise/');
		expect(a.author).toBe('/u/ansi09');
		expect(a.pub_date).toBe('2026-08-05T21:03:33.000Z');
		// Reddit's "submitted by /u/x [link] [comments]" wrapper is boilerplate,
		// not post text
		expect(a.description).toContain('Preliminary vote is live');
		expect(a.description).not.toMatch(/submitted by/i);
		expect(a.description).not.toMatch(/\[comments\]/);
	});

	it('degrades to an empty (not thrown) round when both rungs fail, keeping backoff soft on a transient 429', async () => {
		global.fetch = vi.fn(async (url) =>
			String(url).includes('hot.json') ? { ok: false, status: 403 } : { ok: false, status: 429 },
		);
		const res = await getNews({ source: 'reddit_defi', limit: 20 });
		expect(res.articles).toEqual([]);
		expect(res.sources_ok).toBe(0);
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});
});
