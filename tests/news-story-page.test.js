// Coverage for the story permalink pipeline — api/_lib/news-story.js
// (adjacent-month fallback) and api/news/story-page.js (canonical 301 when
// the requested month differs from the article's real month, slug-powered
// 404). Regression for the dead-permalink class of bug: a story whose month
// drifted by one across a boundary must resolve, not 404.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({ wrap: (fn) => fn }));
vi.mock('../api/_lib/env.js', () => ({ env: {} }));

const ARTICLE = {
	id: 'abcdefabcdefabcd',
	title: 'Regulated crypto exchanges gain ground',
	link: 'https://publisher.example/story',
	description: 'Oversight tightens and regulated venues win share.',
	source: 'The Block',
	source_key: 'theblock',
	category: 'general',
	pub_date: '2025-03-30T23:50:00.000Z', // canonical month: 2025-03
	tickers: ['BTC'],
	sentiment: { score: 0.2, label: 'positive', confidence: 0.6 },
};

const findArticle = vi.fn(async () => null);
const loadMonth = vi.fn(async () => []);
vi.mock('../api/_lib/news.js', () => ({ findArticle: (...a) => findArticle(...a) }));
vi.mock('../api/_lib/news-archive-store.js', () => ({ loadMonth: (...a) => loadMonth(...a) }));

const { resolveStory } = await import('../api/_lib/news-story.js');
const { default: handler } = await import('../api/news/story-page.js');

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
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res);
}

beforeEach(() => {
	findArticle.mockReset().mockResolvedValue(null);
	loadMonth.mockReset().mockResolvedValue([]);
});

describe('resolveStory', () => {
	it('finds an article in its exact archive month', async () => {
		loadMonth.mockImplementation(async (m) => (m === '2025-03' ? [ARTICLE] : []));
		const hit = await resolveStory('2025-03', ARTICLE.id);
		expect(hit).toMatchObject({ origin: 'archive', article: { id: ARTICLE.id } });
	});

	it('falls back to an adjacent month when the requested one misses', async () => {
		loadMonth.mockImplementation(async (m) => (m === '2025-03' ? [ARTICLE] : []));
		const hit = await resolveStory('2025-02', ARTICLE.id);
		expect(hit).toMatchObject({ origin: 'archive', article: { id: ARTICLE.id } });
		const asked = loadMonth.mock.calls.map((c) => c[0]);
		expect(asked).toContain('2025-02');
		expect(asked).toContain('2025-03');
	});

	it('returns null when the story is nowhere', async () => {
		expect(await resolveStory('2025-02', 'deadbeefdeadbeef')).toBeNull();
	});

	it('rejects malformed keys without any lookup', async () => {
		expect(await resolveStory('2025-13', ARTICLE.id)).toBeNull();
		expect(await resolveStory('2025-03', 'not-an-id')).toBeNull();
		expect(loadMonth).not.toHaveBeenCalled();
	});
});

describe('GET /api/news/story-page', () => {
	it('serves the story at its canonical month', async () => {
		loadMonth.mockImplementation(async (m) => (m === '2025-03' ? [ARTICLE] : []));
		const res = await call(`/api/news/story-page?month=2025-03&id=${ARTICLE.id}`);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Regulated crypto exchanges gain ground');
		expect(res.body).toContain(`/markets/news/2025-03/${ARTICLE.id}`);
	});

	it('301s a month-drifted URL to the canonical permalink', async () => {
		loadMonth.mockImplementation(async (m) => (m === '2025-03' ? [ARTICLE] : []));
		const res = await call(`/api/news/story-page?month=2025-02&id=${ARTICLE.id}`);
		expect(res.statusCode).toBe(301);
		expect(res.headers.location).toMatch(new RegExp(`^/markets/news/2025-03/${ARTICLE.id}`));
	});

	it('301s when the live record’s month differs from the requested one', async () => {
		const nowMonth = new Date().toISOString().slice(0, 7);
		const prev = (() => {
			const d = new Date(`${nowMonth}-01T00:00:00Z`);
			d.setUTCMonth(d.getUTCMonth() - 1);
			return d.toISOString().slice(0, 7);
		})();
		const liveArticle = { ...ARTICLE, pub_date: `${prev}-28T12:00:00.000Z` };
		findArticle.mockResolvedValue(liveArticle);
		const res = await call(`/api/news/story-page?month=${nowMonth}&id=${ARTICLE.id}`);
		expect(res.statusCode).toBe(301);
		expect(res.headers.location).toMatch(new RegExp(`^/markets/news/${prev}/${ARTICLE.id}`));
	});

	it('404 turns the URL slug into a prefilled archive search', async () => {
		const res = await call(
			'/api/news/story-page?month=2025-02&id=deadbeefdeadbeef&slug=regulated-crypto-exchanges-gain-ground',
		);
		expect(res.statusCode).toBe(404);
		expect(res.body).toContain('/markets/archive?q=regulated%20crypto%20exchanges%20gain%20ground');
		expect(res.body).toContain('Search the archive for');
	});
});
