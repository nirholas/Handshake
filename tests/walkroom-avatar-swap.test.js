// Mid-session avatar swap, server side. The `avatar` message has been wired in
// WalkRoom all along but until the in-world switcher (/play HUD Avatar button)
// no client used it mid-session; these tests pin the contract the switcher now
// depends on: an allow-listed URL updates the Player schema field peers
// re-render from, junk (bare ids, blob: URLs, foreign hosts) is dropped
// without touching the player, and the per-second rate budget holds so a
// malicious client can't turn the swap into a broadcast amplifier. The full
// WalkRoom needs the Colyseus runtime, so the handler runs against a minimal
// stand-in (Object.create skips the Room constructor), same as the tag tests.

import { describe, it, expect, beforeEach } from 'vitest';
import { WalkRoom } from '../multiplayer/src/rooms/WalkRoom.js';

function makeRoom() {
	const room = Object.create(WalkRoom.prototype);
	room.state = { players: new Map() };
	room._actionCounters = new Map();
	return room;
}

function seat(room, id) {
	const player = { avatar: 'https://three.ws/avatars/original.glb', agent: '' };
	room.state.players.set(id, player);
	return player;
}

const client = (sessionId) => ({ sessionId });

describe('WalkRoom mid-session avatar swap', () => {
	let room;
	beforeEach(() => { room = makeRoom(); });

	it('updates the schema avatar for an allow-listed URL so peers re-render it', () => {
		const p = seat(room, 'a');
		room._handleAvatar(client('a'), { avatar: 'https://three.ws/m/knight.glb' });
		expect(p.avatar).toBe('https://three.ws/m/knight.glb');

		room._actionCounters.clear();
		room._handleAvatar(client('a'), { avatar: '/avatars/default.glb' });
		expect(p.avatar).toBe('/avatars/default.glb');
	});

	it('drops values the clients could never load: bare ids, blob: URLs, foreign hosts', () => {
		const p = seat(room, 'a');
		for (const bad of ['av_12345', 'blob:https://three.ws/xyz', 'https://evil.example/model.glb']) {
			room._actionCounters.clear();
			room._handleAvatar(client('a'), { avatar: bad });
			expect(p.avatar).toBe('https://three.ws/avatars/original.glb');
		}
	});

	it('ignores a swap from a session with no seated player', () => {
		expect(() => room._handleAvatar(client('ghost'), { avatar: '/avatars/default.glb' })).not.toThrow();
	});

	it('enforces the per-second rate budget so swaps cannot amplify broadcasts', () => {
		const p = seat(room, 'a');
		room._handleAvatar(client('a'), { avatar: '/avatars/one.glb' });
		room._handleAvatar(client('a'), { avatar: '/avatars/two.glb' });
		room._handleAvatar(client('a'), { avatar: '/avatars/three.glb' });
		// Budget is 2/s (ACTION_RATES.avatar): the third swap in the window is dropped.
		expect(p.avatar).toBe('/avatars/two.glb');
	});

	it('carries the optional agent label through, truncated to the wire cap', () => {
		const p = seat(room, 'a');
		room._handleAvatar(client('a'), { avatar: '/avatars/default.glb', agent: 'x'.repeat(200) });
		expect(p.agent.length).toBeLessThanOrEqual(64);
	});
});
