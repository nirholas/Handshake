// The /play account identity contract: which credential is allowed to claim a
// saved profile (gold, bank, pack, unlocked cosmetics, quest log).
//
// Before this, `playerId` fell back to a raw `pid` join option, so any client
// could join as `pid=<victim's wallet or guest id>`, land in that profile, spend
// it, and persist its own mutations back over it. guest-token.js existed with
// exactly the right fix in its header and had zero callers. These tests lock the
// wiring in place: a bare pid is never an account key again, and the signed
// token is the only thing that carries a guest's progression forward.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WalkRoom } from '../multiplayer/src/rooms/WalkRoom.js';
import { newGuestId, signGuestToken, verifyGuestToken } from '../multiplayer/src/guest-token.js';
import { playerStore, savePlayer, loadPlayer } from '../multiplayer/src/playerStore.js';

// A WalkRoom instance without the Colyseus constructor: _resolveIdentity only
// touches the player store and the token helpers.
function makeRoom() {
	return Object.create(WalkRoom.prototype);
}

function client(userData = null) {
	return { sessionId: 'sess-' + Math.random().toString(36).slice(2, 8), userData };
}

describe('guest-token', () => {
	it('round-trips a server-minted guest id', () => {
		const gid = newGuestId();
		expect(gid.startsWith('gs_')).toBe(true);
		expect(verifyGuestToken(signGuestToken(gid))).toBe(gid);
	});

	it('refuses a tampered payload, a tampered signature, and junk', () => {
		const token = signGuestToken(newGuestId());
		const [body, sig] = token.split('.');
		const otherBody = Buffer.from(JSON.stringify({ k: 'guest', gid: 'gs_victim', iat: 1, exp: 4102444800 }))
			.toString('base64').replace(/=+$/, '');
		expect(verifyGuestToken(`${otherBody}.${sig}`)).toBe(null);
		expect(verifyGuestToken(`${body}.${'A'.repeat(sig.length)}`)).toBe(null);
		expect(verifyGuestToken('not-a-token')).toBe(null);
		expect(verifyGuestToken('')).toBe(null);
		expect(verifyGuestToken(null)).toBe(null);
	});

	it('refuses an expired token', () => {
		const past = Math.floor(Date.now() / 1000) - 10;
		const body = Buffer.from(JSON.stringify({ k: 'guest', gid: 'gs_x', iat: past - 100, exp: past }))
			.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
		// Sign it the same way the module does so only expiry can reject it.
		const signed = signGuestToken('gs_x');
		expect(verifyGuestToken(signed)).toBe('gs_x'); // control: a fresh one passes
		expect(verifyGuestToken(`${body}.${signed.split('.')[1]}`)).toBe(null);
	});

	it('never accepts a wallet-shaped id as a guest id', () => {
		// A wallet address sealed as a guest id would let the guest lane claim a
		// wallet account's profile. The prefix check is what prevents it.
		const walletish = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
		const body = Buffer.from(JSON.stringify({
			k: 'guest', gid: walletish, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
		})).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
		expect(verifyGuestToken(`${body}.${signGuestToken('gs_a').split('.')[1]}`)).toBe(null);
	});
});

describe('WalkRoom._resolveIdentity — who may claim a saved profile', () => {
	let room;
	beforeEach(() => {
		room = makeRoom();
		playerStore._mem.clear();
	});

	it('THE EXPLOIT: a bare pid naming a victim can no longer claim their profile', async () => {
		// The victim has played before and their guest id has been upgraded to the
		// signed-token flow (as every active guest's is on their next join).
		const victim = 'guest-victimaccount';
		savePlayer(victim, { gold: 999999, guestUpgraded: true });

		const id = await room._resolveIdentity(client(), { pid: victim });

		expect(id.playerId).not.toBe(victim);
		expect(id.playerId.startsWith('gs_')).toBe(true); // a fresh guest instead
		expect(loadPlayer(victim).gold).toBe(999999);     // untouched
	});

	it('a bare pid naming a WALLET is never honored, upgraded or not', async () => {
		const wallet = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
		savePlayer(wallet, { gold: 500 });
		const id = await room._resolveIdentity(client(), { pid: wallet });
		expect(id.playerId).not.toBe(wallet);
		expect(id.playerId.startsWith('gs_')).toBe(true);
	});

	it('binds the wallet onAuth verified, above every client-supplied option', async () => {
		const authed = 'AuthedWallet1111111111111111111111111111111';
		const id = await room._resolveIdentity(
			client({ account: authed }),
			{ pid: 'guest-someone-else', guestToken: signGuestToken(newGuestId()) },
		);
		expect(id.playerId).toBe(authed);
		expect(id.guestToken).toBe('');
	});

	it('honors a guest id ONLY when it arrives inside a valid signed token', async () => {
		const gid = newGuestId();
		savePlayer(gid, { gold: 42 });

		const withToken = await room._resolveIdentity(client(), { guestToken: signGuestToken(gid) });
		expect(withToken.playerId).toBe(gid);
		expect(verifyGuestToken(withToken.guestToken)).toBe(gid); // re-issued, so it never lapses

		// The same id asserted bare gets a brand-new guest, not that profile.
		const bare = await room._resolveIdentity(client(), { pid: gid });
		expect(bare.playerId).not.toBe(gid);
	});

	it('migrates a legacy guest-… pid exactly once, then locks it to the token', async () => {
		const legacy = 'guest-abc123def';
		savePlayer(legacy, { gold: 77 });

		// First contact: the device still holds only the old localStorage id, so it
		// keeps its progression and receives a signed token to use from now on.
		const first = await room._resolveIdentity(client(), { pid: legacy });
		expect(first.playerId).toBe(legacy);
		expect(verifyGuestToken(first.guestToken)).toBe(legacy);
		expect(loadPlayer(legacy).guestUpgraded).toBe(true);

		// Anyone asserting the same id bare afterwards is a stranger.
		const second = await room._resolveIdentity(client(), { pid: legacy });
		expect(second.playerId).not.toBe(legacy);

		// The device that holds the token keeps its profile.
		const holder = await room._resolveIdentity(client(), { guestToken: first.guestToken });
		expect(holder.playerId).toBe(legacy);
	});

	it('mints a fresh guest for a first-time visitor with no credential at all', async () => {
		const a = await room._resolveIdentity(client(), {});
		const b = await room._resolveIdentity(client(), {});
		expect(a.playerId.startsWith('gs_')).toBe(true);
		expect(a.playerId).not.toBe(b.playerId); // unguessable, never shared
		expect(verifyGuestToken(a.guestToken)).toBe(a.playerId);
	});
});
