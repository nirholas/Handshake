// Contract tests for the wallet-first /play gate credentials.
//
// The nonce + play pass are HMAC-signed on the Vercel side (api/_lib/play-pass.js)
// and verified on the standalone game server (multiplayer/src/play-pass.js).
// These two must stay byte-compatible, and each token must reject tampering,
// expiry, and cross-use. The signature/balance flow lives in api/play/verify.js;
// here we lock down the sealing layer it depends on.

import { describe, it, expect, beforeAll } from 'vitest';

let api, mp;

beforeAll(async () => {
	process.env.NODE_ENV = 'development';
	delete process.env.HOLDER_PASS_SECRET; // both sides fall back to the same dev secret
	process.env.PLAY_GATE_MINT = 'So11111111111111111111111111111111111111112';
	process.env.PLAY_GATE_MIN = '1';
	api = await import('../api/_lib/play-pass.js');
	mp = await import('../multiplayer/src/play-pass.js');
});

describe('nonce', () => {
	it('issues a nonce that verifies', () => {
		const { nonce, exp } = api.issueNonce();
		expect(typeof nonce).toBe('string');
		expect(api.verifyNonce(nonce)).toBeTruthy();
		expect(exp).toBeGreaterThan(Date.now() / 1000);
	});

	it('rejects a tampered or garbage nonce', () => {
		const { nonce } = api.issueNonce();
		expect(api.verifyNonce(nonce + 'x')).toBeNull();
		expect(api.verifyNonce('garbage')).toBeNull();
		expect(api.verifyNonce(null)).toBeNull();
	});

	it('is namespaced apart from a play pass', () => {
		const { nonce } = api.issueNonce();
		// A nonce must never validate as a pass, nor a pass as a nonce.
		expect(mp.verifyPlayPass(nonce)).toBeNull();
	});
});

describe('play pass cross-process contract', () => {
	const mint = 'So11111111111111111111111111111111111111112';
	const wallet = '4Nd1mYbQ2YpTof3pT7nYwE2qS9p9z3v8WqHk5xQ2abcd';

	it('signs on the API side and verifies on the game server', () => {
		const token = api.signPlayPass({ wallet, mint, balance: 5 });
		const v = mp.verifyPlayPass(token);
		expect(v).toBeTruthy();
		expect(v.wallet).toBe(wallet);
		expect(v.mint).toBe(mint);
		expect(v.balance).toBe(5);
		expect(v.tier).toBe('play');
		expect(v.minBalance).toBe(1);
	});

	it('rejects a tampered pass', () => {
		const token = api.signPlayPass({ wallet, mint, balance: 5 });
		expect(mp.verifyPlayPass(token.slice(0, -2) + 'zz')).toBeNull();
		// flip a payload byte
		const [body, sig] = token.split('.');
		const flipped = body.slice(0, -1) + (body.slice(-1) === 'A' ? 'B' : 'A') + '.' + sig;
		expect(mp.verifyPlayPass(flipped)).toBeNull();
	});

	it('is not accepted as a nonce', () => {
		const token = api.signPlayPass({ wallet, mint, balance: 5 });
		expect(api.verifyNonce(token)).toBeNull();
	});

	it('rounds the balance to 6dp', () => {
		const token = api.signPlayPass({ wallet, mint, balance: 1.23456789 });
		expect(mp.verifyPlayPass(token).balance).toBe(1.234568);
	});

	it('fails closed on a negative balance (verifier rejects)', () => {
		// verify.js never produces a negative balance, but if a tampered/forged pass
		// carried one the game server must refuse it rather than admit the player.
		const bad = api.signPlayPass({ wallet, mint, balance: -3 });
		expect(mp.verifyPlayPass(bad)).toBeNull();
	});
});

describe('gate config', () => {
	it('reads the mint + min from env', () => {
		expect(api.PLAY_GATE_MINT).toBe('So11111111111111111111111111111111111111112');
		expect(api.PLAY_GATE_MIN).toBe(1);
	});
});
