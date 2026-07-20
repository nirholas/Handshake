// Coverage for api/_lib/news-rights.js — the publisher-rights boundary.
//
// Two invariants are load-bearing here and both carry legal weight:
//   1. A withdrawn story is unreachable by every route (id, source key, link
//      host) and its permalink answers 410, not 404 or 200.
//   2. No publisher's full body is ever emitted. excerptParagraphs() is the
//      only thing standing between the extraction ladder and the response, so
//      its bounds are asserted directly rather than through a caller.
//
// This file exists because of a real DMCA notice (The Merkle, LLC / NullTX,
// 2026-07-19). If a test here starts failing, the site is republishing
// copyrighted text again — fix the code, do not relax the test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({ wrap: (fn) => fn }));
vi.mock('../api/_lib/env.js', () => ({ env: {} }));

const findArticle = vi.fn(async () => null);
const loadMonth = vi.fn(async () => []);
vi.mock('../api/_lib/news.js', () => ({ findArticle: (...a) => findArticle(...a) }));
vi.mock('../api/_lib/news-archive-store.js', () => ({ loadMonth: (...a) => loadMonth(...a) }));

const { suppression, isSuppressed, excerptParagraphs, excerptText, EXCERPT_MAX_CHARS, EXCERPT_MAX_PARAGRAPHS, TAKEDOWN_IDS } =
	await import('../api/_lib/news-rights.js');
const { NEWS_SOURCES } = await import('../api/_lib/news-sources.js');
const { default: storyPage } = await import('../api/news/story-page.js');

// One of the ids named in the notice.
const TAKEN_DOWN_ID = '4bc5221ecb8d937f';

function call(url) {
	const res = {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			this.body = chunk || '';
		},
	};
	return storyPage({ method: 'GET', url, headers: {} }, res).then(() => res);
}

beforeEach(() => {
	findArticle.mockReset().mockResolvedValue(null);
	loadMonth.mockReset().mockResolvedValue([]);
});

describe('suppression', () => {
	it('catches a taken-down story by id', () => {
		expect(suppression({ id: TAKEN_DOWN_ID })).toMatchObject({ reason: 'takedown' });
	});

	it('is case-insensitive on the id', () => {
		expect(isSuppressed({ id: TAKEN_DOWN_ID.toUpperCase() })).toBe(true);
	});

	it('catches a withdrawn publisher by source key', () => {
		expect(suppression({ id: 'aaaaaaaaaaaaaaaa', source_key: 'nulltx' })).toMatchObject({
			reason: 'restricted_publisher',
		});
	});

	it('catches a withdrawn publisher by link host, with or without www', () => {
		expect(isSuppressed({ link: 'https://nulltx.com/some-story/' })).toBe(true);
		expect(isSuppressed({ link: 'https://www.nulltx.com/some-story/' })).toBe(true);
	});

	it('does not catch a lookalike host', () => {
		expect(isSuppressed({ link: 'https://nulltx.com.evil.example/x' })).toBe(false);
		expect(isSuppressed({ link: 'https://notnulltx.com/x' })).toBe(false);
	});

	it('leaves ordinary articles alone', () => {
		expect(isSuppressed({ id: 'abcdefabcdefabcd', source_key: 'theblock', link: 'https://theblock.co/x' })).toBe(false);
	});

	it('tolerates junk input rather than throwing', () => {
		expect(isSuppressed(null)).toBe(false);
		expect(isSuppressed({})).toBe(false);
		expect(isSuppressed({ link: 'not a url' })).toBe(false);
	});

	it('holds every id named in the notice', () => {
		expect(TAKEDOWN_IDS.size).toBe(24);
		for (const id of TAKEDOWN_IDS) expect(id, `${id} must be a 16-hex story id`).toMatch(/^[a-f0-9]{16}$/);
	});
});

describe('the withdrawn publisher is out of the ingest registry', () => {
	it('no longer lists nulltx', () => {
		expect(NEWS_SOURCES.nulltx).toBeUndefined();
	});

	it('lists no feed pointing at the withdrawn host', () => {
		for (const [key, src] of Object.entries(NEWS_SOURCES)) {
			expect(new URL(src.url).hostname, `${key} must not poll a withdrawn publisher`).not.toMatch(/(^|\.)nulltx\.com$/);
		}
	});
});

describe('excerptParagraphs — the standing limit for every publisher', () => {
	const body = [
		'Bitcoin climbed above ninety thousand dollars on Tuesday as spot ETF inflows accelerated for a fourth straight session.',
		'Analysts pointed to a thinning order book on the major venues, which amplifies moves in both directions.',
		'A third paragraph that must never be served.',
		'A fourth paragraph that must never be served either.',
	];

	it('never exceeds the paragraph cap', () => {
		expect(excerptParagraphs(body).paragraphs.length).toBeLessThanOrEqual(EXCERPT_MAX_PARAGRAPHS);
	});

	it('never exceeds the character budget', () => {
		const joined = excerptParagraphs(body).paragraphs.join('');
		// The single-paragraph overrun path appends an ellipsis; allow for it.
		expect(joined.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
	});

	it('reports truncation so the reader can link out', () => {
		expect(excerptParagraphs(body).truncated).toBe(true);
	});

	it('drops the withheld paragraphs entirely, not just visually', () => {
		const out = excerptParagraphs(body).paragraphs.join(' ');
		expect(out).not.toContain('must never be served');
	});

	it('cuts a single oversized paragraph at a boundary, never mid-word', () => {
		const long = ['word '.repeat(400).trim()];
		const { paragraphs, truncated } = excerptParagraphs(long);
		expect(truncated).toBe(true);
		expect(paragraphs[0].length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
		expect(paragraphs[0]).toMatch(/…$/);
		expect(paragraphs[0]).not.toMatch(/wor…$/); // no mid-word cut
	});

	it('passes through a genuinely short body without claiming truncation', () => {
		const short = ['A two sentence wire brief. That is the whole item.'];
		const { paragraphs, truncated } = excerptParagraphs(short);
		expect(paragraphs).toEqual(short);
		expect(truncated).toBe(false);
	});

	it('handles an empty or dirty body', () => {
		expect(excerptParagraphs([])).toEqual({ paragraphs: [], truncated: false });
		expect(excerptParagraphs(null)).toEqual({ paragraphs: [], truncated: false });
		expect(excerptParagraphs(['', '   ']).paragraphs).toEqual([]);
	});
});

describe('excerptText — the description field carries whole articles too', () => {
	it('leaves a genuine one-line summary untouched', () => {
		const d = 'Oversight tightens and regulated venues win share.';
		expect(excerptText(d)).toBe(d);
	});

	it('caps a content:encoded description that is really the full body', () => {
		const fullBody = 'Sentence about the market. '.repeat(200);
		const out = excerptText(fullBody);
		expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
		expect(out.length).toBeLessThan(fullBody.length);
	});

	it('is empty-safe', () => {
		expect(excerptText('')).toBe('');
		expect(excerptText(null)).toBe('');
		expect(excerptText(undefined)).toBe('');
	});
});

describe('GET /api/news/story-page for a withdrawn story', () => {
	it('answers 410 Gone, not 404 or 200', async () => {
		const res = await call(`/api/news/story-page?month=2026-06&id=${TAKEN_DOWN_ID}`);
		expect(res.statusCode).toBe(410);
	});

	it('is marked noindex so it leaves the search index', async () => {
		const res = await call(`/api/news/story-page?month=2026-06&id=${TAKEN_DOWN_ID}`);
		expect(res.headers['x-robots-tag']).toContain('noindex');
		expect(res.body).toMatch(/name=["']robots["'][^>]*content=["']noindex/);
	});

	it('410s without touching the archive at all', async () => {
		await call(`/api/news/story-page?month=2026-06&id=${TAKEN_DOWN_ID}`);
		expect(loadMonth).not.toHaveBeenCalled();
		expect(findArticle).not.toHaveBeenCalled();
	});

	it('410s under any month, since the id alone is disqualifying', async () => {
		const res = await call(`/api/news/story-page?month=2026-07&id=${TAKEN_DOWN_ID}`);
		expect(res.statusCode).toBe(410);
	});

	it('410s every id named in the notice', async () => {
		for (const id of TAKEDOWN_IDS) {
			const res = await call(`/api/news/story-page?month=2026-07&id=${id}`);
			expect(res.statusCode, `${id} must be gone`).toBe(410);
		}
	});

	it('explains the removal instead of showing a generic dead end', async () => {
		const res = await call(`/api/news/story-page?month=2026-06&id=${TAKEN_DOWN_ID}`);
		expect(res.body).toContain('removed');
		expect(res.body).not.toContain('Story not found');
	});

	it('does not embed a full-body description anywhere in the served HTML', async () => {
		// A content:encoded publisher: the whole article arrives in `description`.
		const TAIL = 'THIS_IS_THE_END_OF_THE_ARTICLE_BODY';
		const fullBody = `The lede sentence of the story. ${'Filler body sentence. '.repeat(200)} ${TAIL}`;
		const article = {
			id: 'dddddddddddddddd',
			title: 'A publisher that ships full text in RSS',
			link: 'https://thedefiant.io/some-story',
			description: fullBody,
			source: 'The Defiant',
			source_key: 'thedefiant',
			category: 'general',
			pub_date: '2026-05-02T10:00:00.000Z',
			tickers: [],
		};
		loadMonth.mockImplementation(async (m) => (m === '2026-05' ? [article] : []));
		const res = await call(`/api/news/story-page?month=2026-05&id=${article.id}`);
		expect(res.statusCode).toBe(200);
		// Rendered lead, JSON seed, and meta tags must all be bounded.
		expect(res.body).not.toContain(TAIL);
		expect(res.body).toContain('A publisher that ships full text in RSS');
	});

	it('410s a story from a withdrawn publisher that is not named in the notice', async () => {
		const other = {
			id: 'cccccccccccccccc',
			title: 'Some other NullTX story',
			link: 'https://nulltx.com/another/',
			source: 'NullTX',
			source_key: 'nulltx',
			pub_date: '2026-05-02T10:00:00.000Z',
		};
		loadMonth.mockImplementation(async (m) => (m === '2026-05' ? [other] : []));
		const res = await call(`/api/news/story-page?month=2026-05&id=${other.id}`);
		expect(res.statusCode).toBe(410);
		expect(res.body).not.toContain('Some other NullTX story');
	});
});
