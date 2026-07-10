// @vitest-environment jsdom
//
// /play friends presence + social relay (W09).
//
// `/play` joins the same authoritative WalkRoom that `/walk` does, but for a long
// time it never carried a presence ticket into the join and never forwarded the
// server's `social` push. The consequence was silent and user-visible: a player
// standing in a coin world showed as **Offline** to every friend, and a DM sent
// to them was dropped on the floor rather than delivered to their open socket.
//
// These tests pin both halves of the contract at the seam that regressed:
//   1. the resolved presence ticket rides the join options (and is omitted, not
//      sent as null/undefined, when the player is anonymous or the mint fails);
//   2. a `social` room message is re-emitted on CommunityNet's own event bus so
//      the FriendsClient can route DMs and friend-graph events.
//
// The colyseus transport is mocked at the two module seams CommunityNet uses, so
// this exercises the real CommunityNet code path without a live server.

import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.self = globalThis;

// A minimal stand-in for a joined Colyseus room: records the handlers registered
// against each message type so a test can push a server message through them.
function makeFakeRoom() {
	const handlers = new Map();
	return {
		sessionId: 'sess-1',
		// Only the scalar fields connect() reads directly. The mocked
		// getStateCallbacks returns undefined for every collection, which sends the
		// `if ($players)` guards down the same skip path an older server schema does.
		state: { persistent: false, worldTime: 0, coin: '', coinName: '', coinSymbol: '', coinImage: '' },
		onMessage(type, cb) { handlers.set(type, cb); },
		onLeave() {},
		onError() {},
		leave() {},
		removeAllListeners() {},
		// test helper — deliver a message as the server would
		__emit(type, payload) { handlers.get(type)?.(payload); },
		__handlers: handlers,
	};
}

let lastJoinOptions = null;
let fakeRoom = null;

vi.mock('colyseus.js', () => ({
	Client: class { constructor(url) { this.url = url; } },
	// `$(room.state)` → undefined means every collection guard skips, which is the
	// same shape CommunityNet already tolerates against an older server schema.
	getStateCallbacks: () => () => undefined,
}));

vi.mock('../src/shared/colyseus-connect.js', () => ({
	CONNECT_TIMEOUT_MS: 15_000,
	joinRoomWithTimeout: vi.fn(async (_client, _roomName, options) => {
		lastJoinOptions = options;
		return fakeRoom;
	}),
}));

const { CommunityNet } = await import('../src/game/community-net.js');

const COIN = { mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', name: 'THREE', symbol: 'THREE', image: '' };

function newNet(opts = {}) {
	return new CommunityNet({ url: 'ws://test.invalid', coin: COIN, name: 'tester', ...opts });
}

beforeEach(() => {
	lastJoinOptions = null;
	fakeRoom = makeFakeRoom();
});

describe('CommunityNet presence ticket (W09)', () => {
	it('carries the resolved presence ticket into the join options', async () => {
		const net = newNet({ getPresence: async () => 'signed.presence.token' });
		await net.connect();
		expect(lastJoinOptions.presence).toBe('signed.presence.token');
		net.destroy();
	});

	it('omits `presence` entirely when the player is anonymous', async () => {
		// getPresenceTicket() resolves null for a signed-out player. Sending an
		// explicit `presence: null` would make the server verify (and reject) a
		// ticket that was never minted — the key must be absent.
		const net = newNet({ getPresence: async () => null });
		await net.connect();
		expect('presence' in lastJoinOptions).toBe(false);
		net.destroy();
	});

	it('joins the world anyway when the ticket mint throws', async () => {
		// A failing /api/friends/presence-ticket must never block play: the player
		// enters the world, simply invisible to the social graph until reconnect.
		const net = newNet({ getPresence: async () => { throw new Error('502'); } });
		await net.connect();
		expect(lastJoinOptions).not.toBeNull();
		expect('presence' in lastJoinOptions).toBe(false);
		expect(net.status).toBe('online');
		net.destroy();
	});

	it('omits `presence` when no supplier is configured at all', async () => {
		const net = newNet();
		await net.connect();
		expect('presence' in lastJoinOptions).toBe(false);
		net.destroy();
	});
});

describe('CommunityNet social relay (W09)', () => {
	it('registers a `social` room handler and re-emits it on the event bus', async () => {
		const net = newNet({ getPresence: async () => 'tok' });
		await net.connect();

		const seen = [];
		net.on('social', (msg) => seen.push(msg));

		expect(fakeRoom.__handlers.has('social')).toBe(true);
		const dm = { type: 'dm', message: { id: 'm1', from: 'u2', body: 'gm' } };
		fakeRoom.__emit('social', dm);

		expect(seen).toEqual([dm]);
		net.destroy();
	});

	it('forwards friend-graph events, not just DMs', async () => {
		const net = newNet();
		await net.connect();
		const seen = [];
		net.on('social', (msg) => seen.push(msg));
		fakeRoom.__emit('social', { type: 'friend_request', from: 'u9' });
		fakeRoom.__emit('social', { type: 'friend_accept', from: 'u9' });
		expect(seen.map((m) => m.type)).toEqual(['friend_request', 'friend_accept']);
		net.destroy();
	});

	it('exposes `social` as a known event (on() rejects unknown names)', () => {
		const net = newNet();
		expect(() => net.on('social', () => {})).not.toThrow();
		expect(() => net.on('definitely-not-an-event', () => {})).toThrow(/unknown event/);
		net.destroy();
	});
});
