// Unit tests for GET /api/search — the cross-entity discovery endpoint
// (prompts/user-value/05-discovery-search.md). Mocks the five source
// functions in api/_lib/cross-search.js (each already unit-testable on its
// own via the stores it wraps) and asserts the endpoint's own job: fan-out
// wiring, type filtering, ranking/merge, and degrade-cleanly-without-a-db.
// All offline — no DATABASE_URL or Redis needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = { configured: true };
vi.mock('../../api/_lib/env.js', () => ({
	databaseConfigured: () => dbState.configured,
	env: {},
}));

const storeState = { forge: true, diorama: true };
vi.mock('../../api/_lib/forge-store.js', () => ({
	forgeStoreEnabled: () => storeState.forge,
}));
vi.mock('../../api/_lib/diorama-store.js', () => ({
	dioramaStoreEnabled: () => storeState.diorama,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const mocks = {
	searchAvatars: vi.fn(async () => []),
	searchAgents: vi.fn(async () => []),
	searchModels: vi.fn(async () => []),
	searchWorlds: vi.fn(async () => []),
	searchCoins: vi.fn(async () => []),
	attachFollowerCounts: vi.fn(async (items) => items),
	rankItems: vi.fn((items) => items),
};
vi.mock('../../api/_lib/cross-search.js', () => mocks);

const { default: searchHandler } = await import('../../api/search.js');

function makeReq(query = {}) {
	return { method: 'GET', headers: {}, url: `/api/search?${new URLSearchParams(query)}` };
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(query) {
	const req = makeReq(query);
	const res = makeRes();
	await searchHandler(req, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

function item(type, id, extra = {}) {
	return { type, id, title: `${type} ${id}`, description: '', image: null, glbUrl: null, assetUrl: `/${type}/${id}`, creator: null, remix: null, createdAt: new Date().toISOString(), signals: {}, ...extra };
}

beforeEach(() => {
	dbState.configured = true;
	storeState.forge = true;
	storeState.diorama = true;
	rlState.success = true;
	for (const key of ['searchAvatars', 'searchAgents', 'searchModels', 'searchWorlds', 'searchCoins']) {
		mocks[key].mockReset().mockResolvedValue([]);
	}
	mocks.attachFollowerCounts.mockReset().mockImplementation(async (items) => items);
	mocks.rankItems.mockReset().mockImplementation((items) => items);
});

describe('GET /api/search', () => {
	it('spans at least two creation types for a single query', async () => {
		mocks.searchAvatars.mockResolvedValue([item('avatar', 'a1')]);
		mocks.searchModels.mockResolvedValue([item('model', 'm1', { remix: { endpoint: '/api/x402/remix-asset', sourceCreationId: 'm1', priceUsd: 0.25 } })]);

		const { res, body } = await call({ q: 'dragon' });

		expect(res.statusCode).toBe(200);
		expect(body.enabled).toBe(true);
		const types = new Set(body.items.map((i) => i.type));
		expect(types.has('avatar')).toBe(true);
		expect(types.has('model')).toBe(true);
		expect(body.items).toHaveLength(2);
	});

	it('every result carries an assetUrl and a remixable model carries a working remix action', async () => {
		mocks.searchModels.mockResolvedValue([
			item('model', 'm1', {
				assetUrl: 'https://three.ws/viewer?src=x',
				creator: { label: '@maker', url: '/u/maker' },
				remix: { endpoint: '/api/x402/remix-asset', sourceCreationId: 'm1', priceUsd: 0.25, royaltyPercent: 5, royaltyPayable: true },
			}),
		]);

		const { body } = await call({ q: 'sneaker', type: 'model' });

		expect(body.items).toHaveLength(1);
		const [m] = body.items;
		expect(m.assetUrl).toBeTruthy();
		expect(m.creator.url).toBe('/u/maker');
		expect(m.remix.endpoint).toBe('/api/x402/remix-asset');
		expect(m.remix.sourceCreationId).toBe('m1');
	});

	it('scopes to one type when type= is set and skips the others', async () => {
		mocks.searchAvatars.mockResolvedValue([item('avatar', 'a1')]);

		await call({ q: 'x', type: 'avatar' });

		expect(mocks.searchAvatars).toHaveBeenCalled();
		expect(mocks.searchAgents).not.toHaveBeenCalled();
		expect(mocks.searchModels).not.toHaveBeenCalled();
		expect(mocks.searchWorlds).not.toHaveBeenCalled();
		expect(mocks.searchCoins).not.toHaveBeenCalled();
	});

	it('never queries coins without a search term (no "browse all coins" concept here)', async () => {
		await call({ type: 'coin' });
		expect(mocks.searchCoins).not.toHaveBeenCalled();
	});

	it('skips models/worlds when their stores are unconfigured, without erroring', async () => {
		storeState.forge = false;
		storeState.diorama = false;
		mocks.searchAvatars.mockResolvedValue([item('avatar', 'a1')]);

		const { res, body } = await call({ q: 'x' });

		expect(res.statusCode).toBe(200);
		expect(mocks.searchModels).not.toHaveBeenCalled();
		expect(mocks.searchWorlds).not.toHaveBeenCalled();
		expect(body.items.some((i) => i.type === 'avatar')).toBe(true);
	});

	it('degrades to an empty, non-throwing result when no database is configured', async () => {
		dbState.configured = false;

		const { res, body } = await call({ q: 'x' });

		expect(res.statusCode).toBe(200);
		expect(body.enabled).toBe(false);
		expect(body.items).toEqual([]);
		expect(mocks.searchAvatars).not.toHaveBeenCalled();
	});

	it('an empty query returns no items without erroring (client renders the idle/browse state)', async () => {
		const { res, body } = await call({});
		expect(res.statusCode).toBe(200);
		expect(body.items).toEqual([]);
	});

	it('trims whitespace and caps q length before it reaches any query', async () => {
		await call({ q: '  dragon  ' + 'x'.repeat(100) });
		const [args] = mocks.searchAvatars.mock.calls;
		expect(args[0].q.startsWith('dragon')).toBe(true);
		expect(args[0].q.length).toBeLessThanOrEqual(80);
	});

	it('rate limits like other public discovery endpoints', async () => {
		rlState.success = false;
		const { res } = await call({ q: 'x' });
		expect(res.statusCode).toBe(429);
	});
});
