// Unit tests for GET /api/users/:username/creations, the profile "Creations"
// tab's aggregation endpoint (user-value campaign, work order 01; retired, see
// git history), which
// merges the three anonymous-by-design creation tables that only carry a
// user_id when the creator happened to be signed in: forge_creations (models),
// dioramas (worlds), and material_restyles (restyles).
//
// Mocks: sql (the username lookup), rate-limit, and the three stores. All
// offline, no DATABASE_URL or Redis needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : [])),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true, limit: 60, remaining: 0, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const listCreationsByUser = vi.fn(async () => []);
vi.mock('../../api/_lib/forge-store.js', () => ({ listCreationsByUser: (...a) => listCreationsByUser(...a) }));

const listDioramasByUser = vi.fn(async () => []);
vi.mock('../../api/_lib/diorama-store.js', () => ({ listDioramasByUser: (...a) => listDioramasByUser(...a) }));

const listRestylesByUser = vi.fn(async () => []);
vi.mock('../../api/_lib/material-restyle-store.js', () => ({ listRestylesByUser: (...a) => listRestylesByUser(...a) }));

const { default: handler } = await import('../../api/users/[username]/creations.js');

const USER_ID = '00000000-0000-0000-0000-0000000000c1';

function makeReq(username, query = {}) {
	const qs = new URLSearchParams(query).toString();
	return {
		method: 'GET',
		query: { username },
		headers: {},
		url: `/api/users/${username}/creations${qs ? `?${qs}` : ''}`,
	};
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
async function call(username, query) {
	const res = makeRes();
	await handler(makeReq(username, query), res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

const MODEL = {
	id: 'm1', type: 'model', prompt: 'a brass desk lamp', glbUrl: 'https://cdn/m1.glb',
	category: 'item', isRemix: false, createdAt: '2026-07-12T12:00:00Z',
};
const WORLD = {
	id: 'w1', type: 'world', title: 'Neon alley', prompt: 'a neon alley', mood: 'night',
	thumbnailGlb: 'https://cdn/w1.glb', createdAt: '2026-07-12T11:00:00Z',
};
const RESTYLE = {
	id: 'r1', type: 'restyle', action: 'restyle', label: null, glbUrl: 'https://cdn/r1.glb',
	sourceUrl: 'https://cdn/src.glb', prompt: 'weathered bronze', category: 'AI restyle',
	createdAt: '2026-07-12T10:00:00Z',
};

beforeEach(() => {
	sqlQueue.length = 0;
	rlState.success = true;
	listCreationsByUser.mockReset().mockResolvedValue([]);
	listDioramasByUser.mockReset().mockResolvedValue([]);
	listRestylesByUser.mockReset().mockResolvedValue([]);
});

describe('GET /api/users/:username/creations: validation', () => {
	it('rejects a username that cannot exist without touching the database', async () => {
		const { res, body } = await call('a');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(listCreationsByUser).not.toHaveBeenCalled();
	});

	it('404s for an unknown user', async () => {
		sqlQueue.push([]); // user lookup: no row
		const { res, body } = await call('ghost');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('is public, so no session is required', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		const { res } = await call('alice');
		expect(res.statusCode).toBe(200);
	});
});

describe('GET /api/users/:username/creations: merging', () => {
	it('merges models, worlds and restyles into one newest-first page', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		listCreationsByUser.mockResolvedValue([MODEL]);
		listDioramasByUser.mockResolvedValue([WORLD]);
		listRestylesByUser.mockResolvedValue([RESTYLE]);

		const { res, body } = await call('alice');
		expect(res.statusCode).toBe(200);
		expect(body.items.map((i) => i.type)).toEqual(['model', 'world', 'restyle']);

		const times = body.items.map((i) => new Date(i.createdAt).getTime());
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it('shapes each type with a working viewer link', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		listCreationsByUser.mockResolvedValue([MODEL]);
		listDioramasByUser.mockResolvedValue([WORLD]);
		listRestylesByUser.mockResolvedValue([RESTYLE]);

		const { body } = await call('alice');
		const byType = Object.fromEntries(body.items.map((i) => [i.type, i]));

		expect(byType.model.viewerUrl).toBe(`https://three.ws/viewer?src=${encodeURIComponent('https://cdn/m1.glb')}`);
		expect(byType.model.title).toBe('a brass desk lamp');
		expect(byType.world.viewerUrl).toBe('https://three.ws/diorama?id=w1');
		expect(byType.world.category).toBe('night');
		expect(byType.restyle.viewerUrl).toBe(`https://three.ws/viewer?src=${encodeURIComponent('https://cdn/r1.glb')}`);
		expect(byType.restyle.title).toBe('weathered bronze');
		expect(byType.restyle.category).toBe('AI restyle');
	});

	it('titles an unprompted colorway fan-out rather than rendering an empty card', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		listRestylesByUser.mockResolvedValue([
			{ ...RESTYLE, id: 'r2', action: 'variants', prompt: null, category: 'colorway variant' },
		]);

		const { body } = await call('alice');
		expect(body.items[0].title).toBe('Colorway variant');
	});

	it('honours ?type= by querying only that one source', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		listRestylesByUser.mockResolvedValue([RESTYLE]);

		const { body } = await call('alice', { type: 'restyle' });
		expect(body.items.map((i) => i.type)).toEqual(['restyle']);
		expect(listCreationsByUser).not.toHaveBeenCalled();
		expect(listDioramasByUser).not.toHaveBeenCalled();
	});
});

describe('GET /api/users/:username/creations: pagination', () => {
	it('over-fetches each source so a merged page is never short', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		await call('alice', { limit: '10' });
		for (const fn of [listCreationsByUser, listDioramasByUser, listRestylesByUser]) {
			expect(fn).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, limit: 11 }));
		}
	});

	it('clamps limit to the documented 1..48 range', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		await call('alice', { limit: '500' });
		expect(listCreationsByUser).toHaveBeenCalledWith(expect.objectContaining({ limit: 49 }));
	});

	it('returns the oldest item on a full page as the next cursor, null otherwise', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		listCreationsByUser.mockResolvedValue([MODEL, { ...MODEL, id: 'm2', createdAt: '2026-07-12T09:00:00Z' }]);

		const full = await call('alice', { limit: '2' });
		expect(full.body.items).toHaveLength(2);
		expect(full.body.next).toBe('2026-07-12T09:00:00Z');

		sqlQueue.push([{ id: USER_ID }]);
		listCreationsByUser.mockResolvedValue([MODEL]);
		const partial = await call('alice', { limit: '2' });
		expect(partial.body.next).toBeNull();
	});

	it('passes the before cursor through to every source, canonicalized', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		// The handler parses the cursor and re-serializes it, so what reaches the
		// stores is always full-precision ISO 8601 regardless of how the caller
		// wrote it. Asserting the caller's spelling would pass only by accident.
		const before = '2026-07-12T00:00:00Z';
		await call('alice', { before });
		for (const fn of [listCreationsByUser, listDioramasByUser, listRestylesByUser]) {
			expect(fn).toHaveBeenCalledWith(
				expect.objectContaining({ before: new Date(before).toISOString() }),
			);
		}
	});

	it('serves a designed empty result, not a 404, for a creator with nothing yet', async () => {
		sqlQueue.push([{ id: USER_ID }]);
		const { res, body } = await call('alice');
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ items: [], next: null });
		expect(res.getHeader('cache-control')).toContain('s-maxage=60');
	});
});
