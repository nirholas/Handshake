// Cover for the X post archive: every case here was written against a defect
// measured in the first real @trythreews scrape (data/x-archive/, 359 posts,
// 2026-08-14), not an imagined one.

import { describe, it, expect } from 'vitest';
import {
	analyze,
	authorOf,
	engagementRate,
	engagements,
	isMetricsSuspect,
	lengthBucketOf,
	median,
	mergeScrapes,
	normalizeScrape,
	parseCount,
	percentile,
	topicsOf,
} from '../scripts/x-archive-lib.mjs';

const post = (over = {}) => ({
	tweetId: over.tweetId || '1',
	handle: 'trythreews',
	authorHandle: 'trythreews',
	isOwn: true,
	url: 'https://x.com/trythreews/status/1',
	text: 'a post',
	postedAt: '2026-06-01T12:00:00.000Z',
	isRetweet: false,
	isReply: false,
	isPinned: false,
	hasImage: false,
	hasVideo: false,
	hasCard: false,
	hashtags: [],
	mentions: [],
	urls: [],
	likes: 10,
	retweets: 2,
	replies: 1,
	views: 1000,
	viewsLabel: '1K',
	viewsExact: false,
	metricsSource: 'scrape',
	measuredAt: '2026-08-14T05:00:00.000Z',
	...over,
});

describe('parseCount', () => {
	it('reads X abbreviations and records whether the number is exact', () => {
		expect(parseCount('236')).toEqual({ value: 236, exact: true, label: '236' });
		expect(parseCount('6.3K')).toEqual({ value: 6300, exact: false, label: '6.3K' });
		expect(parseCount('18K')).toEqual({ value: 18000, exact: false, label: '18K' });
		expect(parseCount('1.2M')).toEqual({ value: 1200000, exact: false, label: '1.2M' });
		expect(parseCount('1,204')).toEqual({ value: 1204, exact: true, label: '1,204' });
	});

	it('returns null rather than 0 for an unmeasured counter', () => {
		// 0 is a real engagement value. Collapsing "not measured" into it would
		// silently score an unscraped post as a failure.
		expect(parseCount('').value).toBeNull();
		expect(parseCount(null).value).toBeNull();
		expect(parseCount(undefined).value).toBeNull();
		expect(parseCount('n/a').value).toBeNull();
	});
});

describe('authorOf', () => {
	it('reads the author from the permalink, not from the scrape flags', () => {
		// 145 of the 359 posts in the first archive are reposts of other
		// accounts, and every one arrived with type.isRetweet === false.
		expect(authorOf({ url: 'https://x.com/Pumpfun/status/2054619494480285818' }, 'trythreews')).toBe('pumpfun');
		expect(authorOf({ url: 'https://x.com/trythreews/status/2087646652056432688' }, 'trythreews')).toBe('trythreews');
		expect(authorOf({ url: 'https://twitter.com/nichxbt/status/1' }, 'trythreews')).toBe('nichxbt');
	});

	it('falls back to the archived handle when there is no permalink', () => {
		expect(authorOf({}, 'trythreews')).toBe('trythreews');
	});
});

describe('isMetricsSuspect', () => {
	it('rejects a scraped zero that reach contradicts', () => {
		expect(isMetricsSuspect(post({ likes: 0, retweets: 0, replies: 16, views: 6800 }))).toBe(true);
		expect(isMetricsSuspect(post({ likes: 0, retweets: 17, replies: 3, views: 1200 }))).toBe(true);
		expect(isMetricsSuspect(post({ likes: null }))).toBe(true);
	});

	it('accepts a plausible zero on a low-reach post', () => {
		expect(isMetricsSuspect(post({ likes: 0, retweets: 0, replies: 0, views: 120 }))).toBe(false);
	});

	it('trusts a zero that came from the X API', () => {
		const fromApi = post({ likes: 0, retweets: 0, replies: 5, views: 9000, metricsSource: 'x-api-v2' });
		expect(isMetricsSuspect(fromApi)).toBe(false);
	});
});

describe('normalizeScrape', () => {
	const scrape = {
		profile: 'trythreews',
		scrapedAt: '2026-08-14T05:52:33.134Z',
		tweets: [
			{
				id: '2087646652056432688',
				url: 'https://x.com/trythreews/status/2087646652056432688',
				text: 'three.ws is now verified',
				timestamp: '2026-08-12T21:05:23.000Z',
				metrics: { replies: '16', retweets: '63', likes: '187', views: '6.3K' },
				media: { hasImage: true, hasVideo: false, hasCard: false },
				type: { isRetweet: false, isReply: false, isPinned: false },
				extracted: { hashtags: [], mentions: ['@fomo'], urls: [] },
				scrapedAt: '2026-08-14T05:51:43.032Z',
			},
			{
				id: '2054619494480285818',
				url: 'https://x.com/Pumpfun/status/2054619494480285818',
				text: 'someone else wrote this',
				timestamp: '2026-05-13T00:00:00.000Z',
				metrics: { replies: '501', retweets: '273', likes: '1,700', views: '1.2M' },
				media: {},
				type: { isRetweet: false, isReply: false, isPinned: false },
				extracted: {},
				scrapedAt: '2026-08-14T05:51:43.032Z',
			},
		],
	};

	it('normalizes counters, authorship and media', () => {
		const out = normalizeScrape(scrape);
		expect(out.handle).toBe('trythreews');
		expect(out.metricsSource).toBe('scrape');
		expect(out.posts).toHaveLength(2);

		const [own, repost] = out.posts;
		expect(own.likes).toBe(187);
		expect(own.views).toBe(6300);
		expect(own.viewsExact).toBe(false);
		expect(own.isOwn).toBe(true);
		expect(own.mentions).toEqual(['@fomo']);

		expect(repost.isOwn).toBe(false);
		expect(repost.authorHandle).toBe('pumpfun');
		// The scrape claimed this was not a retweet. The permalink says otherwise.
		expect(repost.isRetweet).toBe(true);
	});

	it('marks a refresher file as exact', () => {
		const out = normalizeScrape({ ...scrape, source: 'x-api-v2' });
		expect(out.metricsSource).toBe('x-api-v2');
		expect(out.posts[0].metricsSource).toBe('x-api-v2');
	});

	it('drops a post the scraper saw twice while scrolling', () => {
		const dup = { ...scrape, tweets: [...scrape.tweets, scrape.tweets[0]] };
		expect(normalizeScrape(dup).posts).toHaveLength(2);
	});

	it('refuses a file it cannot attribute or date', () => {
		expect(() => normalizeScrape({ ...scrape, profile: '' })).toThrow(/handle/);
		expect(() => normalizeScrape({ ...scrape, scrapedAt: 'nonsense' })).toThrow(/scrapedAt/);
		expect(() => normalizeScrape({ profile: 'x', scrapedAt: scrape.scrapedAt })).toThrow(/tweets/);
	});
});

describe('mergeScrapes', () => {
	it('lets the newest measurement win and keeps the older one as history', () => {
		const at = (iso, likes) => ({
			handle: 'trythreews',
			scrapedAt: iso,
			posts: [{ ...post({ likes, measuredAt: iso }) }],
		});
		const { posts, history } = mergeScrapes([at('2026-08-14T00:00:00.000Z', 187), at('2026-08-01T00:00:00.000Z', 40)]);
		expect(posts).toHaveLength(1);
		expect(posts[0].likes).toBe(187);
		expect(history.get('1').map((h) => h.likes)).toEqual([40, 187]);
	});
});

describe('statistics', () => {
	it('computes median and percentiles over a mixed list', () => {
		expect(median([1, 2, 3])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([])).toBeNull();
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
	});

	it('counts engagements without views and leaves the rate null when reach is unknown', () => {
		expect(engagements(post({ likes: 10, retweets: 2, replies: 1 }))).toBe(13);
		expect(engagementRate(post({ likes: 10, retweets: 2, replies: 1, views: 1000 }))).toBeCloseTo(1.3);
		expect(engagementRate(post({ views: null }))).toBeNull();
	});
});

describe('classification', () => {
	it('buckets by length', () => {
		expect(lengthBucketOf(post({ text: 'short' }))).toBe('xs');
		expect(lengthBucketOf(post({ text: 'x'.repeat(200) }))).toBe('m');
		expect(lengthBucketOf(post({ text: 'x'.repeat(600) }))).toBe('xl');
	});

	it('tags subjects, and falls back to other', () => {
		expect(topicsOf(post({ text: 'x402 payments settle in USDC' }))).toContain('payments');
		expect(topicsOf(post({ text: 'gm' }))).toEqual(['other']);
	});
});

describe('analyze', () => {
	const corpus = [
		...Array.from({ length: 6 }, (_, i) => post({ tweetId: `img${i}`, hasImage: true, likes: 40, retweets: 5, replies: 5 })),
		...Array.from({ length: 6 }, (_, i) => post({ tweetId: `txt${i}`, likes: 4, retweets: 1, replies: 0 })),
		post({ tweetId: 'repost', isOwn: false, authorHandle: 'pumpfun', isRetweet: true, likes: 5000 }),
		post({ tweetId: 'broken', likes: 0, retweets: 0, replies: 9, views: 20000 }),
	];

	it('excludes reposts and unbelievable counters from every measurement', () => {
		const report = analyze(corpus, { handle: 'trythreews' });
		expect(report.generatedFrom.analyzed).toBe(12);
		expect(report.generatedFrom.retweetsExcluded).toBe(1);
		expect(report.generatedFrom.suspectExcluded).toBe(1);
		// The 5000-like repost belongs to another account and must not inflate us.
		expect(report.totals.likes).toBe(6 * 40 + 6 * 4);
		expect(report.amplified.byAuthor[0]).toEqual({ author: 'pumpfun', count: 1 });
	});

	it('reports lift against the corpus median, both ways', () => {
		const report = analyze(corpus, { handle: 'trythreews' });
		const image = report.formats.find((f) => f.key === 'image');
		expect(image.significant).toBe(true);
		expect(image.with.count).toBe(6);
		expect(image.with.lift).toBeGreaterThan(1);
		expect(image.without.lift).toBeLessThan(1);
	});

	it('leaves a dimension unmarked when one side is too small to compare', () => {
		const report = analyze([...corpus, post({ tweetId: 'vid', hasVideo: true, likes: 90 })], { handle: 'trythreews' });
		expect(report.formats.find((f) => f.key === 'video').significant).toBe(false);
	});
});
