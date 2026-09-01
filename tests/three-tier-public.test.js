// HTTP-level tests for the public $THREE tier surface added in api/three/[action].js:
//   GET  /api/three/tier?wallet=<addr>   — account-less tier read for a connected wallet
//   POST /api/three/tier-pass            — signature-proven tier pass (no account)
//
// Balance/price reads are mocked so the tier resolves deterministically; signatures
// are produced with real ed25519 keypairs so the verify path runs end-to-end.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58mod from 'bs58';

const bs58 = bs58mod.default || bs58mod;

// $THREE held-USD comes from getBalances(); mock it so we control the tier.
const getBalances = vi.fn();
const getTokenPriceUsd = vi.fn();
vi.mock('../api/_lib/balances.js', () => ({ getBalances: (...a) => getBalances(...a) }));
vi.mock('../api/_lib/token/price.js', () => ({ getTokenPriceUsd: (...a) => getTokenPriceUsd(...a) }));

let handler, TOKEN_MINT, verifyTierPass;

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		_ended: false,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this._ended = true; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq({ method = 'GET', url = '/', body = null } = {}) {
	const chunks = body != null ? [Buffer.from(JSON.stringify(body))] : [];
	const r = Readable.from(chunks);
	r.method = method;
	r.url = url;
	r.headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
	return r;
}

function newKeypair() {
	const sk = ed25519.utils.randomSecretKey();
	const pk = ed25519.getPublicKey(sk);
	return { sk, pk, address: bs58.encode(pk) };
}

// MUST stay byte-identical to the client builder (src/three/holder.js) and the
// server validator (checkTierPassMessage in api/three/[action].js).
function buildTierPassMessage(wallet, issuedAt = new Date().toISOString()) {
	return [
		'three.ws — verify wallet to unlock $THREE holder perks.',
		'',
		`Wallet: ${wallet}`,
		`Issued At: ${issuedAt}`,
		'',
		'Signing is free and does not move funds.',
	].join('\n');
}

function sign(sk, message) {
	return bs58.encode(ed25519.sign(new TextEncoder().encode(message), sk));
}

beforeAll(async () => {
	process.env.NODE_ENV = 'development';
	process.env.HOLDER_PASS_SECRET = 'three-tier-public-test-secret';
	const mod = await import('../api/three/[action].js');
	handler = mod.default;
	({ TOKEN_MINT } = await import('../api/_lib/token/config.js'));
	({ verifyTierPass } = await import('../api/_lib/three-tier.js'));
});

describe('GET /api/three/tier (no session, no wallet)', () => {
	it('answers the public ladder at the Member floor instead of a 401, so /three renders for every visitor', async () => {
		const res = mockRes();
		await handler(mockReq({ url: '/api/three/tier' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.json.signed_in).toBe(false);
		expect(res.json.wallet_linked).toBe(false);
		expect(res.json.source).toBe('public');
		expect(res.json.tier.id).toBe('member');
		expect(res.json.held_usd).toBe(0);
		expect(res.json.next).toMatchObject({ id: 'bronze', min_usd: 25, usd_to_go: 25 });
		expect(res.json.ladder.map((t) => t.id)).toEqual(['member', 'bronze', 'silver', 'gold', 'genesis']);
	});
});

describe('GET /api/three/tier?wallet=', () => {
	it('resolves Member for a zero-balance wallet, no account needed', async () => {
		getBalances.mockResolvedValue({ tokens: [] });
		const { address } = newKeypair();
		const res = mockRes();
		await handler(mockReq({ url: `/api/three/tier?wallet=${address}` }), res);
		expect(res.statusCode).toBe(200);
		expect(res.json.tier.id).toBe('member');
		expect(res.json.source).toBe('wallet');
		expect(res.json.wallet).toBe(address);
		expect(Array.isArray(res.json.ladder)).toBe(true);
	});

	it('resolves the right tier from held USD', async () => {
		getBalances.mockResolvedValue({ tokens: [{ mint: TOKEN_MINT, amount: 5000, usd: 600, price: 0.12 }] });
		const { address } = newKeypair();
		const res = mockRes();
		await handler(mockReq({ url: `/api/three/tier?wallet=${address}` }), res);
		expect(res.statusCode).toBe(200);
		expect(res.json.tier.id).toBe('gold');
		expect(res.json.held_usd).toBe(600);
	});

	it('rejects a malformed wallet with 400', async () => {
		const res = mockRes();
		await handler(mockReq({ url: '/api/three/tier?wallet=not-a-wallet' }), res);
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_wallet');
	});
});

describe('POST /api/three/tier-pass (signature path)', () => {
	it('mints a verifiable, wallet-bound pass for a valid signature', async () => {
		getBalances.mockResolvedValue({ tokens: [{ mint: TOKEN_MINT, amount: 5000, usd: 600, price: 0.12 }] });
		const { sk, address } = newKeypair();
		const message = buildTierPassMessage(address);
		const res = mockRes();
		await handler(mockReq({ method: 'POST', url: '/api/three/tier-pass', body: { wallet: address, message, signature: sign(sk, message) } }), res);
		expect(res.statusCode).toBe(201);
		expect(typeof res.json.pass).toBe('string');
		const payload = verifyTierPass(res.json.pass);
		expect(payload).toBeTruthy();
		expect(payload.wallet).toBe(address);
		expect(payload.tierId).toBe('gold');
		expect(payload.level).toBe(3);
	});

	it('rejects a signature that does not match the wallet', async () => {
		getBalances.mockResolvedValue({ tokens: [] });
		const { address } = newKeypair();
		const other = newKeypair();
		const message = buildTierPassMessage(address);
		const res = mockRes();
		await handler(mockReq({ method: 'POST', url: '/api/three/tier-pass', body: { wallet: address, message, signature: sign(other.sk, message) } }), res);
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('bad_signature');
	});

	it('rejects a stale message (issued too long ago)', async () => {
		const { sk, address } = newKeypair();
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		const message = buildTierPassMessage(address, stale);
		const res = mockRes();
		await handler(mockReq({ method: 'POST', url: '/api/three/tier-pass', body: { wallet: address, message, signature: sign(sk, message) } }), res);
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('stale_message');
	});

	it('rejects a message not bound to the wallet', async () => {
		const { sk, address } = newKeypair();
		const other = newKeypair();
		// Signed correctly for `address`, but the message names a different wallet.
		const message = buildTierPassMessage(other.address);
		const res = mockRes();
		await handler(mockReq({ method: 'POST', url: '/api/three/tier-pass', body: { wallet: address, message, signature: sign(sk, message) } }), res);
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('wallet_mismatch');
	});
});
