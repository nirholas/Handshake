import { describe, it, expect, vi } from 'vitest';

// Mock the thin glue deps so we test the endpoint's COMPOSITION logic (narratives
// + launch feed shaping), not the network/DB beneath it.
vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	rateLimited: (res) => { res._rateLimited = true; },
	json: (res, status, body) => { res._json = { status, body }; return res; },
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));
vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheSet: vi.fn(async () => {}),
}));
vi.mock('../api/_lib/launcher-trends.js', () => ({
	PROVIDER_IDS: ['coin_intel', 'trending', 'knowyourmeme', 'googletrends', 'x', 'hackernews', 'reddit', 'wikipedia'],
	rankNarratives: vi.fn(async () => ({
		terms: [
			{ term: 'drooling cat', score: 9.1, sources: ['knowyourmeme', 'reddit'], kind: 'meme' },
			{ term: 'train dog', score: 4.2, sources: ['x'], kind: 'meme' },
		],
		top: { term: 'drooling cat', score: 9.1, sources: ['knowyourmeme', 'reddit'], kind: 'meme' },
		providers: ['knowyourmeme', 'reddit', 'x'],
	})),
}));
vi.mock('../api/_lib/db.js', () => ({
	sql: () => Promise.resolve([
		{ name: 'Drool Lord', symbol: 'DROOL', mint: 'MINT111', kind: 'trend', trigger_source: 'knowyourmeme', trigger_detail: { top_narrative: 'drooling cat' }, created_at: '2026-06-27T00:00:00Z' },
	]),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

import handler from '../api/launcher/trends.js';
import { rankNarratives } from '../api/_lib/launcher-trends.js';
import { cacheGet, cacheSet } from '../api/_lib/cache.js';

function fakeRes() { return { setHeader() {}, end() {}, statusCode: 200 }; }

describe('GET /api/launcher/trends', () => {
	it('returns ranked narratives + the autonomous launch feed', async () => {
		const res = fakeRes();
		await handler({ method: 'GET', url: '/api/launcher/trends?network=mainnet&limit=10', headers: {} }, res);

		expect(res._json.status).toBe(200);
		const b = res._json.body;
		expect(b.network).toBe('mainnet');
		expect(b.narratives.count).toBe(2);
		expect(b.narratives.top.term).toBe('drooling cat');
		expect(b.narratives.terms[0]).toMatchObject({ term: 'drooling cat', momentum: 2 });
		expect(b.narratives.providers).toContain('knowyourmeme');
		// launch feed maps trigger_detail.top_narrative → rode
		expect(b.launches[0]).toMatchObject({ symbol: 'DROOL', mint: 'MINT111', rode: 'drooling cat' });
	});

	it('honours launches=0 (narratives only)', async () => {
		const res = fakeRes();
		await handler({ method: 'GET', url: '/api/launcher/trends?launches=0', headers: {} }, res);
		expect(res._json.body.launches).toEqual([]);
		expect(res._json.body.narratives.count).toBe(2);
	});

	it('validates ?sources, drops unknown ids, and forwards a sorted filter', async () => {
		rankNarratives.mockClear();
		const res = fakeRes();
		await handler({ method: 'GET', url: '/api/launcher/trends?sources=knowyourmeme,bogus,googletrends', headers: {} }, res);
		expect(rankNarratives).toHaveBeenCalledWith(
			expect.objectContaining({ sources: ['googletrends', 'knowyourmeme'] }),
		);
	});

	it('omits the sources filter entirely when none are valid (uses defaults)', async () => {
		rankNarratives.mockClear();
		const res = fakeRes();
		await handler({ method: 'GET', url: '/api/launcher/trends?sources=bogus', headers: {} }, res);
		expect(rankNarratives).toHaveBeenCalledWith(
			expect.objectContaining({ sources: undefined }),
		);
	});

	// A provider sweep that fails must degrade to "no narratives right now", and it
	// must NOT be cached: a frozen empty ranking would be served to every polling
	// agent for a full minute as if it were the real state of the world.
	it('degrades to an empty ranking when every provider fails, and never caches it', async () => {
		rankNarratives.mockRejectedValueOnce(new Error('all providers down'));
		cacheSet.mockClear();
		const res = fakeRes();
		await handler({ method: 'GET', url: '/api/launcher/trends?launches=0', headers: {} }, res);
		expect(res._json.status).toBe(200);
		expect(res._json.body.narratives).toMatchObject({ count: 0, top: null, terms: [] });
		expect(cacheSet).not.toHaveBeenCalled();
	});

	it('serves a cache hit without re-ranking the providers', async () => {
		cacheGet.mockResolvedValueOnce({ network: 'mainnet', cached: true });
		rankNarratives.mockClear();
		const res = fakeRes();
		await handler({ method: 'GET', url: '/api/launcher/trends', headers: {} }, res);
		expect(res._json.body).toEqual({ network: 'mainnet', cached: true });
		expect(rankNarratives).not.toHaveBeenCalled();
	});
});
