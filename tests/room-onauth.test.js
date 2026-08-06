// Room admission (onAuth): pins the Colyseus 0.16 contract that broke holder
// worlds in production.
//
// Colyseus 0.16 has two distinct onAuth shapes:
//   static onAuth(token, options, context)  : token = HTTP bearer token
//   onAuth(client, options, context)        : instance method, real client
//
// WalkRoom and ClashRoom used to declare `static onAuth(client, options)`,
// which meant the first argument was actually the bearer token (undefined for
// colyseus.js clients). Every path that assigned client.userData: the whole
// holder tier and the platform play gate: threw a TypeError on join. These
// tests pin (a) that both rooms declare the INSTANCE form and no static
// override, and (b) the gate behaviour itself: valid pass admits and binds the
// verified wallet to client.userData, missing/mismatched pass refuses with the
// tagged error the client gates route on.
//
// The pass is minted by the real API signer (api/_lib/holder-pass.js) and
// verified by the real multiplayer verifier: both fall back to the same dev
// secret when HOLDER_PASS_SECRET is unset, which is exactly the production
// wire contract ("byte-for-byte compatible").

import { describe, it, expect } from 'vitest';
import { WalkRoom } from '../multiplayer/src/rooms/WalkRoom.js';
import { ClashRoom } from '../multiplayer/src/rooms/ClashRoom.js';
import { signHolderPass } from '../api/_lib/holder-pass.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WALLET = 'So11111111111111111111111111111111111111112';

// onAuth never reads `this`, so bind a bare object: no need to boot a full
// Colyseus room (schema, clock, presence) just to exercise admission.
const walkAuth = (client, options) => WalkRoom.prototype.onAuth.call({}, client, options);
const clashAuth = (client, options) => ClashRoom.prototype.onAuth.call({}, client, options);

describe('onAuth declaration shape', () => {
	it('WalkRoom declares instance onAuth and no static override', () => {
		expect(Object.prototype.hasOwnProperty.call(WalkRoom.prototype, 'onAuth')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(WalkRoom, 'onAuth')).toBe(false);
	});
	it('ClashRoom declares instance onAuth and no static override', () => {
		expect(Object.prototype.hasOwnProperty.call(ClashRoom.prototype, 'onAuth')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(ClashRoom, 'onAuth')).toBe(false);
	});
});

describe('WalkRoom.onAuth: holder tier', () => {
	it('admits the open General world without any pass', () => {
		const client = {};
		expect(walkAuth(client, { tier: '' })).toBe(true);
		expect(client.userData).toBeUndefined();
	});

	it('admits a holder join with a valid pass and binds the verified wallet', () => {
		const client = {};
		const holderPass = signHolderPass({ mint: MINT, wallet: WALLET, usd: 25 });
		expect(walkAuth(client, { tier: 'holders', coin: MINT, holderPass })).toBe(true);
		expect(client.userData.holderWallet).toBe(WALLET);
		expect(client.userData.holderUsd).toBe(25);
	});

	it('refuses a holder join with no pass', () => {
		expect(() => walkAuth({}, { tier: 'holders', coin: MINT })).toThrow(/holder_pass_required/);
	});

	it('refuses a pass minted for a different coin', () => {
		const holderPass = signHolderPass({ mint: 'OtherMint1111111111111111111111111111111111', wallet: WALLET, usd: 25 });
		expect(() => walkAuth({}, { tier: 'holders', coin: MINT, holderPass })).toThrow(/holder_pass_mismatch/);
	});

	it('refuses a tampered pass', () => {
		const holderPass = signHolderPass({ mint: MINT, wallet: WALLET, usd: 25 });
		expect(() => walkAuth({}, { tier: 'holders', coin: MINT, holderPass: holderPass.slice(0, -2) + 'xx' }))
			.toThrow(/holder_pass_required/);
	});
});

describe('ClashRoom.onAuth: faction gate', () => {
	it('admits a fighter holding the coin they fight for', () => {
		const client = {};
		const holderPass = signHolderPass({ mint: MINT, wallet: WALLET, usd: 25 });
		expect(clashAuth(client, { coin: MINT, holderPass })).toBe(true);
		expect(client.userData.account).toBe(WALLET);
		expect(client.userData.faction).toBe(MINT);
	});

	it('refuses a fighter without a pass for their declared faction', () => {
		expect(() => clashAuth({}, { coin: MINT })).toThrow(/holder_pass_required/);
	});
});
