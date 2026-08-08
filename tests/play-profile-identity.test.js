// @vitest-environment jsdom
//
// Verified three.ws identity in the world servers (W10).
//
// A signed-in player's platform profile now rides the multiplayer stack end to
// end: the presence ticket carries the username + display name (signed, so a
// client can never wear a handle it doesn't own), WalkRoom publishes the
// verified username on the Player schema, and the shared avatar inspector
// renders the real profile card, follow, friend/DM, creations, for any peer
// whose ticket verified. These tests pin the three seams that make that
// trustworthy:
//   1. the multiplayer ticket verifier: profile fields round-trip, legacy
//      tickets (no u/dn) still verify, tampering and expiry still fail;
//   2. the Player schema: `username` exists, defaults empty, and stays the
//      LAST field (append-only binary protocol, reordering breaks live
//      clients against older servers);
//   3. the inspector profile card: renders real profile data, wires follow
//      and message actions, and stays completely absent for guests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 1. ticket verifier ───────────────────────────────────────────────────────

process.env.MULTIPLAYER_SHARED_SECRET = 'test-shared-secret';
const { verifyPresenceTicket } = await import('../multiplayer/src/presence-token.js');

function mintTicket(payload, secret = 'test-shared-secret') {
	const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
	const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
	return `${body}.${sig}`;
}

describe('presence ticket carries the verified profile (W10)', () => {
	const exp = Math.floor(Date.now() / 1000) + 600;

	it('round-trips uid + username + display name', () => {
		const t = mintTicket({ uid: 'u-123', exp, u: 'nick', dn: 'Nick Builder', crew: 'ABC', crewName: 'Alpha' });
		expect(verifyPresenceTicket(t)).toEqual({
			uid: 'u-123',
			username: 'nick',
			displayName: 'Nick Builder',
			crew: 'ABC',
			crewName: 'Alpha',
		});
	});

	it('still verifies a legacy ticket without profile fields', () => {
		const t = mintTicket({ uid: 'u-123', exp });
		const out = verifyPresenceTicket(t);
		expect(out.uid).toBe('u-123');
		expect(out.username).toBe('');
		expect(out.displayName).toBe('');
	});

	it('rejects a tampered payload', () => {
		const t = mintTicket({ uid: 'u-123', exp, u: 'nick' });
		const [, sig] = t.split('.');
		const forged = Buffer.from(JSON.stringify({ uid: 'u-123', exp, u: 'someone-else' }), 'utf8').toString('base64url');
		expect(verifyPresenceTicket(`${forged}.${sig}`)).toBeNull();
	});

	it('rejects a wrong secret and an expired ticket', () => {
		expect(verifyPresenceTicket(mintTicket({ uid: 'u-1', exp, u: 'nick' }, 'other-secret'))).toBeNull();
		expect(verifyPresenceTicket(mintTicket({ uid: 'u-1', exp: Math.floor(Date.now() / 1000) - 5, u: 'nick' }))).toBeNull();
	});

	it('coerces non-string profile fields to empty strings', () => {
		const t = mintTicket({ uid: 'u-1', exp, u: { evil: true }, dn: 42 });
		const out = verifyPresenceTicket(t);
		expect(out.username).toBe('');
		expect(out.displayName).toBe('');
	});
});

// ── 2. Player schema ─────────────────────────────────────────────────────────

describe('Player schema username field (W10)', () => {
	it('exists and defaults to empty (guests stay anonymous)', async () => {
		const { Player } = await import('../multiplayer/src/schemas.js');
		const p = new Player();
		expect(p.username).toBe('');
	});

	it('is declared after every pre-existing field (append-only wire protocol)', () => {
		const src = readFileSync(path.join(__dirname, '../multiplayer/src/schemas.js'), 'utf8');
		const defBlock = src.slice(src.indexOf('defineTypes(Player'), src.indexOf('export class Block'));
		const usernameAt = defBlock.indexOf("username: 'string'");
		expect(usernameAt).toBeGreaterThan(-1);
		// Every other Player field must be declared before it, inserting a field
		// mid-schema shifts the positional indices and desyncs live clients.
		for (const field of ['id:', 'name:', 'account:', 'cosmetics:', 'it:', 'itSince:']) {
			const at = defBlock.indexOf(field);
			expect(at).toBeGreaterThan(-1);
			expect(at).toBeLessThan(usernameAt);
		}
	});
});

// ── 3. inspector profile card ────────────────────────────────────────────────

const apiFetchMock = vi.fn();
const fakeFriends = {
	loaded: true,
	loadError: null,
	friends: [],
	incoming: [],
	outgoing: [],
	friend(id) { return this.friends.find((f) => f.id === id) || null; },
	refresh: vi.fn(async () => {}),
	sendRequest: vi.fn(async () => {}),
	accept: vi.fn(async () => {}),
};

vi.mock('../src/api.js', () => ({ apiFetch: (...args) => apiFetchMock(...args) }));
vi.mock('../src/friends.js', () => ({ friendsClient: () => fakeFriends }));
vi.mock('../src/shared/agent-reputation.js', () => ({
	reputationPanelEl: () => document.createElement('div'),
	ensureReputationStyles: () => {},
}));

const { openAvatarInspector, closeAvatarInspector } = await import('../src/shared/avatar-inspector.js');

const PROFILE_FIXTURE = {
	user: {
		id: 'u-1',
		username: 'nick',
		display_name: 'Nick',
		bio: 'I build tiny worlds.',
		avatar_url: '',
		location: 'Lisbon',
		created_at: '2026-01-05T00:00:00Z',
	},
	stats: { creations: 2, coins: 1 },
	creations: [
		{ id: 'c1', type: 'model', title: 'Bronze sword', viewerUrl: 'https://three.ws/viewer?src=sword', createdAt: '2026-02-01T00:00:00Z' },
		{ id: 'c2', type: 'world', title: 'Cliff village', viewerUrl: 'https://three.ws/diorama?id=c2', createdAt: '2026-03-01T00:00:00Z' },
	],
};

function routeApi({ following = false, followPost } = {}) {
	apiFetchMock.mockImplementation(async (pathname, init = {}) => {
		const method = (init.method || 'GET').toUpperCase();
		if (pathname === '/api/users/nick' && method === 'GET') {
			return { ok: true, status: 200, json: async () => PROFILE_FIXTURE };
		}
		if (pathname === '/api/users/nick/follow' && method === 'GET') {
			return { ok: true, status: 200, json: async () => ({ following, followed_by: false, followers_count: 3, following_count: 2 }) };
		}
		if (pathname === '/api/users/nick/follow' && (method === 'POST' || method === 'DELETE')) {
			if (followPost) return followPost(method);
			return { ok: true, status: 200, json: async () => ({ following: method === 'POST', followed_by: false, followers_count: method === 'POST' ? 4 : 3, following_count: 2 }) };
		}
		// Anything else (agents, balances), a clean 404 keeps those sections quiet.
		return { ok: false, status: 404, json: async () => ({}) };
	});
}

async function settle() {
	// The card paints across a few chained microtasks + fetch mocks.
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('avatar inspector profile card (W10)', () => {
	beforeEach(() => {
		closeAvatarInspector();
		document.body.innerHTML = '';
		apiFetchMock.mockReset();
		fakeFriends.friends = [];
		fakeFriends.incoming = [];
		fakeFriends.outgoing = [];
		fakeFriends.loadError = null;
		fakeFriends.sendRequest.mockClear();
	});

	it('renders the verified profile: handle, bio, counts, creations, view-profile link', async () => {
		routeApi();
		openAvatarInspector({ kind: 'peer', name: 'nick-in-game', world: 'play', username: 'nick' });
		await settle();

		const root = document.querySelector('.avi-root');
		expect(root).toBeTruthy();
		expect(root.querySelector('.avi-subname')?.textContent).toBe('@nick');
		const profile = root.querySelector('[data-avi="profile"]');
		expect(profile).toBeTruthy();
		expect(profile.textContent).toContain('I build tiny worlds.');
		expect(profile.textContent).toContain('followers');
		const rows = [...profile.querySelectorAll('.avi-creation')];
		expect(rows.map((r) => r.getAttribute('href'))).toEqual([
			'https://three.ws/viewer?src=sword',
			'https://three.ws/diorama?id=c2',
		]);
		const viewProfile = [...root.querySelectorAll('.avi-foot a')].find((a) => a.getAttribute('href') === '/u/nick');
		expect(viewProfile).toBeTruthy();
	});

	it('shows no profile section at all for a guest without a verified username', async () => {
		routeApi();
		openAvatarInspector({ kind: 'peer', name: 'guest-ab12', world: 'play' });
		await settle();
		expect(document.querySelector('[data-avi="profile"]')).toBeNull();
		expect(apiFetchMock).not.toHaveBeenCalledWith('/api/users/guest-ab12', expect.anything());
	});

	it('follow button posts the edge and flips to Following', async () => {
		routeApi();
		openAvatarInspector({ kind: 'peer', name: 'nick', username: 'nick' });
		await settle();

		const row = document.querySelector('.avi-profile-actions');
		const followBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Follow');
		expect(followBtn).toBeTruthy();
		followBtn.click();
		await settle();

		expect(apiFetchMock).toHaveBeenCalledWith('/api/users/nick/follow', expect.objectContaining({ method: 'POST' }));
		expect([...row.querySelectorAll('button')].some((b) => b.textContent === 'Following')).toBe(true);
	});

	it('offers Message for an existing friend and routes through onOpenDM', async () => {
		routeApi();
		fakeFriends.friends = [{ id: 'u-1', name: 'Nick' }];
		const onOpenDM = vi.fn();
		openAvatarInspector({ kind: 'peer', name: 'nick', username: 'nick' }, { onOpenDM });
		await settle();

		const msgBtn = [...document.querySelectorAll('.avi-profile-actions button')].find((b) => b.textContent === 'Message');
		expect(msgBtn).toBeTruthy();
		msgBtn.click();
		expect(onOpenDM).toHaveBeenCalledWith('u-1');
		// The panel closes so the DM surface takes the stage.
		expect(document.querySelector('.avi-root.avi-in')).toBeNull();
	});

	it('offers Add friend for a stranger and sends the request', async () => {
		routeApi();
		openAvatarInspector({ kind: 'peer', name: 'nick', username: 'nick' });
		await settle();

		const addBtn = [...document.querySelectorAll('.avi-profile-actions button')].find((b) => b.textContent === 'Add friend');
		expect(addBtn).toBeTruthy();
		addBtn.click();
		await settle();
		expect(fakeFriends.sendRequest).toHaveBeenCalledWith('u-1');
	});

	it('leaves no verified profile section behind when switching to a guest', async () => {
		// Switching subjects overlaps two panels for the exit transition (220ms).
		// Once it finishes, exactly one panel may remain, and a guest's panel must
		// carry no profile section, otherwise the previous player's identity is
		// still on screen over an anonymous avatar.
		routeApi();
		openAvatarInspector({ kind: 'peer', name: 'Nick', username: 'nirholas' });
		await settle();
		expect(document.querySelectorAll('.avi-root').length).toBe(1);

		openAvatarInspector({ kind: 'peer', name: 'guest-ab12' });
		await new Promise((r) => setTimeout(r, 300)); // outlast the 220ms exit
		await settle();

		expect(document.querySelectorAll('.avi-root').length).toBe(1);
		expect(document.querySelector('[data-avi="profile"]')).toBeNull();
	});

	it('hides the friends verb (but keeps follow) for an anonymous viewer', async () => {
		routeApi();
		fakeFriends.loadError = 'signin';
		openAvatarInspector({ kind: 'peer', name: 'nick', username: 'nick' });
		await settle();

		const buttons = [...document.querySelectorAll('.avi-profile-actions button')];
		expect(buttons.map((b) => b.textContent)).toEqual(['Follow']);
	});
});
