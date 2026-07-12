// Unit tests for the merge/render logic of GET /api/users/me/feed —
// specifically the scope=all (platform-wide, no-auth) path added by
// prompts/user-value/02-activity-feed.md, and the model/world/follow event
// kinds layered onto the pre-existing avatar/agent/coin feed
// (see tests/api/users-follow.test.js for the follow-graph-specific contract
// this file deliberately leaves alone).
//
// Mocks: sql (raw avatar/agent/coin/follow queries), forge-store's
// listRecentCreations, diorama-store's listDioramas. All offline — no
// DATABASE_URL or Redis needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

// api/_lib/db.js's real `sql` composes nested `sql\`\`` fragments (used here for
// conditional `${before ? sql\`and x < ${before}\` : sql\`\`}` WHERE clauses)
// into the parent query rather than executing them standalone. This mock must
// do the same — an empty fragment call (`sql\`\`` with no interpolations) is a
// building block, not a query, and must NOT consume a slot off sqlQueue.
const sqlQueue = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			const isEmptyFragment = Array.isArray(strings) && strings.length === 1 && strings[0] === '' && values.length === 0;
			if (isEmptyFragment) return { __fragment: true };
			return (async () => (sqlQueue.length ? sqlQueue.shift() : []))();
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
});

describe('GET /api/users/me/feed?scope=all', () => {
	it('requires no session', async () => {
		sqlQueue.push([]); // avatars
		sqlQueue.push([]); // agents
		sqlQueue.push([]); // coins
		sqlQueue.push([]); // follows
		const { res } = await call({ scope: 'all' });
		expect(res.statusCode).toBe(200);
	});

	it('merges avatar/agent/coin/model/world/follow rows into one reverse-chronological feed', async () => {
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

		const { res, body } = await call({ scope: 'all', limit: '10' });
		expect(res.statusCode).toBe(200);
		expect(body.scope).toBe('all');

		// m1 13:00 > coin (launched_at 12:00) > follow 11:00 > avatar 10:00 >
		// agent 08:00 > m2 07:00 > world 06:00.
		const kinds = body.items.map((it) => it.kind);
		expect(kinds).toEqual(['model', 'coin', 'follow', 'avatar', 'agent', 'model', 'world']);

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
