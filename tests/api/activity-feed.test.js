// Unit tests for the merge/render logic of GET /api/users/me/feed, covering
// both the scope=all (platform-wide, no-auth) path and the scope=following
// (personal, auth-required) path added by the user-value campaign, work order 02
// (activity feed; retired, see git history),
// across every event kind the endpoint emits: avatar, agent, coin, model,
// world, restyle, follow (see tests/api/users-follow.test.js for the
// follow-graph-specific contract this file deliberately leaves alone).
//
// Mocks: sql (raw avatar/agent/coin/restyle/follow queries), forge-store's
// listRecentCreations, diorama-store's listDioramas, material-restyle-store's
// listRecentRestyles. All offline, no DATABASE_URL or Redis needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

// api/_lib/db.js's real `sql` composes nested `sql\`\`` fragments (used here for
// conditional `${before ? sql\`and x < ${before}\` : sql\`\`}` WHERE clauses)
// into the parent query rather than executing them standalone. This mock must
// do the same: a fragment is a building block, not a query, and must NOT
// consume a slot off sqlQueue. Two shapes exist in the handler: the empty
// fragment (`sql\`\``) and the cursor fragment (`sql\`and x.created_at < ${before}\``),
// so both are recognised; anything else is a real query.
const sqlQueue = [];
function isFragment(strings, values) {
	if (!Array.isArray(strings)) return false;
	if (strings.length === 1 && strings[0] === '' && values.length === 0) return true;
	return /^\s*and\s/i.test(strings[0] || '');
}
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			if (isFragment(strings, values)) return { __fragment: true };
			// A queued function is called at query time: the only way to stage a
			// rejection (a missing table) without leaving a rejected promise
			// sitting unhandled in the queue.
			return (async () => {
				const next = sqlQueue.length ? sqlQueue.shift() : [];
				return typeof next === 'function' ? next() : next;
			})();
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (k) => (k ? `https://r2.example/${k}` : null),
	thumbnailUrl: (k) => (k ? `https://r2.example/thumb/${k}` : null),
}));

const listRecentCreations = vi.fn(async () => []);
vi.mock('../../api/_lib/forge-store.js', () => ({ listRecentCreations: (...a) => listRecentCreations(...a) }));

const listDioramas = vi.fn(async () => []);
vi.mock('../../api/_lib/diorama-store.js', () => ({ listDioramas: (...a) => listDioramas(...a) }));

const listRecentRestyles = vi.fn(async () => []);
vi.mock('../../api/_lib/material-restyle-store.js', () => ({ listRecentRestyles: (...a) => listRecentRestyles(...a) }));

const { default: meFeedHandler } = await import('../../api/users/me/feed.js');

function makeReq(query = {}) {
	return { method: 'GET', query, headers: {}, url: `/api/users/me/feed?${new URLSearchParams(query)}` };
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
	await meFeedHandler(req, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

beforeEach(() => {
	sqlQueue.length = 0;
	authState.session = null;
	rlState.success = true;
	listRecentCreations.mockReset().mockResolvedValue([]);
	listDioramas.mockReset().mockResolvedValue([]);
	listRecentRestyles.mockReset().mockResolvedValue([]);
});

const VIEWER = { id: '00000000-0000-0000-0000-000000000001', username: 'viewer' };

describe('GET /api/users/me/feed?scope=all', () => {
	it('requires no session', async () => {
		sqlQueue.push([]); // avatars
		sqlQueue.push([]); // agents
		sqlQueue.push([]); // coins
		sqlQueue.push([]); // follows
		const { res } = await call({ scope: 'all' });
		expect(res.statusCode).toBe(200);
	});

	it('merges avatar/agent/coin/model/world/restyle/follow rows into one reverse-chronological feed', async () => {
		sqlQueue.push([
			{ id: 'av1', name: 'Cool Avatar', thumbnail_key: 'thumb1', created_at: '2026-07-12T10:00:00Z', username: 'alice', display_name: 'Alice', avatar_url: null },
		]);
		sqlQueue.push([
			{ id: 'ag1', name: 'Helper Bot', description: 'helps', profile_image_url: null, avatar_url: null, created_at: '2026-07-12T08:00:00Z', username: 'bob', display_name: 'Bob', actor_avatar: null },
		]);
		sqlQueue.push([
			{ agent_id: 'ag2', agent_name: 'Coin Bot', profile_image_url: null, avatar_url: null, token: { mint: 'MintAddr123', name: 'CoinName', symbol: 'CN', launched_at: '2026-07-12T12:00:00Z' }, created_at: '2026-07-12T09:00:00Z', username: 'carol', display_name: 'Carol', actor_avatar: null },
		]);
		sqlQueue.push([
			{ created_at: '2026-07-12T11:00:00Z', follower_username: 'dave', follower_display: 'Dave', follower_avatar: null, target_username: 'erin', target_display: 'Erin', target_avatar: null },
		]);
		listRecentCreations.mockResolvedValue([
			{ id: 'm1', type: 'model', prompt: 'a red robot', glbUrl: 'https://cdn/x.glb', previewImageUrl: null, category: 'other', isRemix: false, createdAt: '2026-07-12T13:00:00Z', username: null, displayName: null, avatarUrl: null },
			{ id: 'm2', type: 'model', prompt: 'remixed sword', glbUrl: 'https://cdn/y.glb', previewImageUrl: null, category: 'item', isRemix: true, createdAt: '2026-07-12T07:00:00Z', username: 'frank', displayName: 'Frank', avatarUrl: null },
		]);
		listDioramas.mockResolvedValue([
			{ id: 'w1', title: 'A cozy world', prompt: 'p', mood: 'cozy', ground: 'grass', palette: null, author: null, creatorUsername: 'gwen', creatorDisplayName: 'Gwen', creatorAvatarUrl: null, thumbnailGlb: 'https://cdn/w.glb', objectCount: 3, views: 0, featured: false, createdAt: '2026-07-12T06:00:00Z' },
		]);
		listRecentRestyles.mockResolvedValue([
			{ id: 'r1', type: 'restyle', action: 'restyle', label: null, glbUrl: 'https://cdn/r1.glb', prompt: 'brushed copper', category: 'AI restyle', createdAt: '2026-07-12T09:00:00Z', username: 'hana', displayName: 'Hana', avatarUrl: null },
		]);

		const { res, body } = await call({ scope: 'all', limit: '10' });
		expect(res.statusCode).toBe(200);
		expect(body.scope).toBe('all');

		// m1 13:00 > coin (launched_at 12:00) > follow 11:00 > avatar 10:00 >
		// restyle 09:00 > agent 08:00 > m2 07:00 > world 06:00.
		const kinds = body.items.map((it) => it.kind);
		expect(kinds).toEqual(['model', 'coin', 'follow', 'avatar', 'restyle', 'agent', 'model', 'world']);

		// Newest-first ordering across all merged kinds.
		const times = body.items.map((it) => new Date(it.created_at).getTime());
		expect(times).toEqual([...times].sort((a, b) => b - a));

		// A model made while signed out carries no attributable actor.
		const anon = body.items.find((it) => it.id === 'm1');
		expect(anon.actor.username).toBeNull();

		// A remixed model is flagged so the client can render "remixed" not "forged".
		const remix = body.items.find((it) => it.id === 'm2');
		expect(remix.isRemix).toBe(true);

		// A world links to the diorama viewer and carries real creator attribution.
		const world = body.items.find((it) => it.kind === 'world');
		expect(world.href).toBe('https://three.ws/diorama?id=w1');
		expect(world.actor.username).toBe('gwen');

		// A follow event carries both actor (follower) and target (followee).
		const follow = body.items.find((it) => it.kind === 'follow');
		expect(follow.actor.username).toBe('dave');
		expect(follow.target.username).toBe('erin');
		expect(follow.href).toBe('/u/erin');

		// A coin launch resolves mint/name/symbol from the agent's token metadata.
		const coin = body.items.find((it) => it.kind === 'coin');
		expect(coin.id).toBe('MintAddr123');
		expect(coin.subtitle).toBe('$CN');

		// A Material Studio restyle links to the GLB viewer, carries the creator,
		// and renders the kind glyph rather than a broken <img> (result is a GLB).
		const restyle = body.items.find((it) => it.kind === 'restyle');
		expect(restyle.id).toBe('r1');
		expect(restyle.title).toBe('brushed copper');
		expect(restyle.subtitle).toBe('AI restyle');
		expect(restyle.href).toBe(`https://three.ws/viewer?src=${encodeURIComponent('https://cdn/r1.glb')}`);
		expect(restyle.image).toBeNull();
		expect(restyle.isVariant).toBe(false);
		expect(restyle.actor.username).toBe('hana');
	});

	it('flags a seeded colorway fan-out as a variant and titles an unprompted restyle', async () => {
		sqlQueue.push([]); // avatars
		sqlQueue.push([]); // agents
		sqlQueue.push([]); // coins
		sqlQueue.push([]); // follows
		listRecentRestyles.mockResolvedValue([
			{ id: 'r2', type: 'restyle', action: 'variants', label: null, glbUrl: 'https://cdn/r2.glb', prompt: null, category: 'colorway variant', createdAt: '2026-07-12T05:00:00Z', username: null, displayName: null, avatarUrl: null },
		]);

		const { body } = await call({ scope: 'all' });
		const [restyle] = body.items;
		expect(restyle.kind).toBe('restyle');
		expect(restyle.isVariant).toBe(true);
		expect(restyle.title).toBe('Colorway variant');
		// Anonymous restyle: no profile link is invented for it.
		expect(restyle.actor.username).toBeNull();
	});

	it('passes the before cursor down to every creation source and echoes the next cursor', async () => {
		sqlQueue.push([]); // avatars
		sqlQueue.push([]); // agents
		sqlQueue.push([]); // coins
		sqlQueue.push([]); // follows
		listRecentCreations.mockResolvedValue([
			{ id: 'm9', type: 'model', prompt: 'older robot', glbUrl: 'https://cdn/m9.glb', previewImageUrl: null, category: 'other', isRemix: false, createdAt: '2026-07-11T10:00:00Z', username: 'ivy', displayName: 'Ivy', avatarUrl: null },
		]);
		listRecentRestyles.mockResolvedValue([
			{ id: 'r9', type: 'restyle', action: 'restyle', label: null, glbUrl: 'https://cdn/r9.glb', prompt: 'matte black', category: 'AI restyle', createdAt: '2026-07-11T09:00:00Z', username: 'ivy', displayName: 'Ivy', avatarUrl: null },
		]);

		const before = '2026-07-12T00:00:00Z';
		const { body } = await call({ scope: 'all', limit: '2', before });

		for (const fn of [listRecentCreations, listDioramas, listRecentRestyles]) {
			expect(fn).toHaveBeenCalledWith(expect.objectContaining({ before }));
		}
		// A full page hands back the oldest item's timestamp as the next cursor.
		expect(body.items.map((it) => it.kind)).toEqual(['model', 'restyle']);
		expect(body.next).toBe('2026-07-11T09:00:00Z');
	});

	it('returns a well-formed empty feed when nothing has happened, never 500s', async () => {
		sqlQueue.push([]); // avatars
		sqlQueue.push([]); // agents
		sqlQueue.push([]); // coins
		sqlQueue.push([]); // follows
		const { res, body } = await call({ scope: 'all' });
		expect(res.statusCode).toBe(200);
		expect(body.items).toEqual([]);
		expect(body.next).toBeNull();
	});
});

// scope=following runs its own follow-joined query per kind (the stores are
// bypassed entirely, since every source has to be constrained by the follow edge),
// so the kind coverage has to be asserted separately from scope=all. Queue
// order matches the handler: following_count, then avatars, agents, coins,
// models, worlds, restyles, follows.
describe('GET /api/users/me/feed?scope=following', () => {
	function queueFollowingScope({ avatars = [], agents = [], coins = [], models = [], worlds = [], restyles = [], follows = [], followingCount = 3 } = {}) {
		sqlQueue.push([{ following_count: followingCount }]);
		sqlQueue.push(avatars);
		sqlQueue.push(agents);
		sqlQueue.push(coins);
		sqlQueue.push(models);
		sqlQueue.push(worlds);
		sqlQueue.push(restyles);
		sqlQueue.push(follows);
	}

	it('emits model, world and restyle events from the people the viewer follows', async () => {
		authState.session = VIEWER;
		queueFollowingScope({
			models: [
				{ id: 'm1', prompt: 'a brass lamp', glb_url: 'https://cdn/m1.glb', preview_image_url: 'https://cdn/m1.png', model_category: 'item', parent_creation_id: null, created_at: '2026-07-12T12:00:00Z', username: 'alice', display_name: 'Alice', avatar_url: null },
			],
			worlds: [
				{ id: 'w1', title: 'Neon alley', mood: 'night', created_at: '2026-07-12T11:00:00Z', objects: [{ glbUrl: 'https://cdn/w1.glb' }], username: 'bob', display_name: 'Bob', avatar_url: null },
			],
			restyles: [
				{ id: 'r1', action: 'restyle', label: null, instruction: 'weathered bronze', preset: null, result_url: 'https://cdn/r1.glb', created_at: '2026-07-12T10:00:00Z', username: 'carol', display_name: 'Carol', avatar_url: 'avatars/carol.png' },
				{ id: 'r2', action: 'variants', label: null, instruction: null, preset: 'pastel', result_url: 'https://cdn/r2.glb', created_at: '2026-07-12T09:00:00Z', username: 'carol', display_name: 'Carol', avatar_url: null },
			],
		});

		const { res, body } = await call({ scope: 'following', limit: '10' });
		expect(res.statusCode).toBe(200);
		expect(body.scope).toBe('following');
		expect(body.following_count).toBe(3);
		expect(body.items.map((it) => it.kind)).toEqual(['model', 'world', 'restyle', 'restyle']);

		const [, , restyle, variant] = body.items;
		expect(restyle.id).toBe('r1');
		expect(restyle.title).toBe('weathered bronze');
		expect(restyle.subtitle).toBe('AI restyle');
		expect(restyle.isVariant).toBe(false);
		expect(restyle.href).toBe(`https://three.ws/viewer?src=${encodeURIComponent('https://cdn/r1.glb')}`);
		// A relative avatar key is resolved through the R2 public URL helper.
		expect(restyle.actor.avatar_url).toBe('https://r2.example/avatars/carol.png');

		// preset stands in for the title when there is no free-text instruction.
		expect(variant.title).toBe('pastel');
		expect(variant.subtitle).toBe('colorway variant');
		expect(variant.isVariant).toBe(true);

		// Private feed: never cached at the edge.
		expect(res.getHeader('cache-control')).toBe('private, no-store');
	});

	it('pages with the before cursor and reports the next one from the oldest item', async () => {
		authState.session = VIEWER;
		queueFollowingScope({
			models: [
				{ id: 'm2', prompt: 'older model', glb_url: 'https://cdn/m2.glb', preview_image_url: null, model_category: 'other', parent_creation_id: 'm1', created_at: '2026-07-11T12:00:00Z', username: 'alice', display_name: 'Alice', avatar_url: null },
			],
			restyles: [
				{ id: 'r3', action: 'restyle', label: null, instruction: 'chrome', preset: null, result_url: 'https://cdn/r3.glb', created_at: '2026-07-11T11:00:00Z', username: 'carol', display_name: 'Carol', avatar_url: null },
			],
		});

		const { body } = await call({ scope: 'following', limit: '2', before: '2026-07-12T00:00:00Z' });
		expect(body.items.map((it) => it.id)).toEqual(['m2', 'r3']);
		expect(body.items[0].isRemix).toBe(true);
		expect(body.next).toBe('2026-07-11T11:00:00Z');
	});

	it('degrades to the other kinds when the material_restyles table is missing', async () => {
		authState.session = VIEWER;
		// The restyle query is fail-soft: simulate the pre-migration deployment by
		// letting it reject, and assert the rest of the feed still renders.
		sqlQueue.push([{ following_count: 1 }]);
		sqlQueue.push([]); // avatars
		sqlQueue.push([]); // agents
		sqlQueue.push([]); // coins
		sqlQueue.push([
			{ id: 'm3', prompt: 'still here', glb_url: 'https://cdn/m3.glb', preview_image_url: null, model_category: 'other', parent_creation_id: null, created_at: '2026-07-12T12:00:00Z', username: 'alice', display_name: 'Alice', avatar_url: null },
		]);
		sqlQueue.push([]); // worlds
		sqlQueue.push(() => Promise.reject(new Error('relation "material_restyles" does not exist')));
		sqlQueue.push([]); // follows

		const { res, body } = await call({ scope: 'following' });
		expect(res.statusCode).toBe(200);
		expect(body.items.map((it) => it.kind)).toEqual(['model']);
	});
});
