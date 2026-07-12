/**
 * GET /api/premium/status — authorization gate (security fix H1).
 *
 * The keys / resources / purchase-history payload is private, account-scoped
 * data. Because wallet addresses are public, the handler must only return it to
 * a caller who proves control of the wallet with a fresh ed25519 signature
 * (SIWS-class), mirroring /api/x402/my-receipts. Unauthenticated callers get
 * only the boolean pass state.
 *
 * `passStatus` and the rate limiter are mocked; the SIWS signature verification
 * runs for real against a genuine ed25519 keypair.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { premiumStatusIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const FULL_STATUS = {
	active: true,
	pass: { id: 'pass-1', plan: 'premium', started_at: '2026-07-01', expires_at: '2026-08-01', asset: 'THREE' },
	resources: ['news-archive'],
	keys: [{ id: 'sub-1', name: 'default', key_prefix: 'x402_live_ABCDEF', rate_limit_per_minute: 120, expires_at: '2026-08-01', status: 'active', usage: { granted: 42, denied: 3, last_seen: null } }],
	history: [{ id: 'pass-1', plan: 'premium', asset: 'THREE', amount_atomics: '3995000000', usd_price: 7.99, tx_signature: 'sig', started_at: '2026-07-01', expires_at: '2026-08-01', created_at: '2026-07-01' }],
};
vi.mock('../api/_lib/premium.js', () => ({
	passStatus: vi.fn(async () => structuredClone(FULL_STATUS)),
}));

const { default: handler } = await import('../api/premium/status.js');

// ── ed25519 wallet + signer ──────────────────────────────────────────────────
const seed = new Uint8Array(32).fill(7);
const pub = ed25519.getPublicKey(seed);
const WALLET = bs58.encode(pub);

function sign(message) {
	const sig = ed25519.sign(new TextEncoder().encode(message), seed);
	return Buffer.from(sig).toString('base64');
}
function ownershipMessage(wallet, issuedAt) {
	return `three.ws premium status\nWallet: ${wallet}\nIssued At: ${issuedAt}`;
}

function makeReq(url) {
	return { method: 'GET', url, headers: { origin: 'https://three.ws' }, socket: { remoteAddress: '127.0.0.1' } };
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call(qs = '') {
	const req = makeReq(`/api/premium/status${qs}`);
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	vi.clearAllMocks();
});

describe('GET /api/premium/status — public path (no ownership proof)', () => {
	it('returns only pass state, never keys/resources/history', async () => {
		const r = await call(`?wallet=${WALLET}`);
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.active).toBe(true);
		expect(body.pass).toMatchObject({ id: 'pass-1' });
		expect(body.keys).toEqual([]);
		expect(body.resources).toEqual([]);
		expect(body.history).toEqual([]);
	});

	it('an attacker signing with a DIFFERENT key gets the stripped payload', async () => {
		const otherSeed = new Uint8Array(32).fill(9);
		const issuedAt = new Date().toISOString();
		// Sign the victim wallet's message with the attacker's key — must not verify.
		const forged = Buffer.from(ed25519.sign(new TextEncoder().encode(ownershipMessage(WALLET, issuedAt)), otherSeed)).toString('base64');
		const r = await call(`?wallet=${WALLET}&issuedAt=${encodeURIComponent(issuedAt)}&signature=${encodeURIComponent(forged)}`);
		expect(r._s).toBe(200);
		expect(r.json().keys).toEqual([]);
	});

	it('a stale (expired) signature gets the stripped payload', async () => {
		const issuedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min old
		const signature = sign(ownershipMessage(WALLET, issuedAt));
		const r = await call(`?wallet=${WALLET}&issuedAt=${encodeURIComponent(issuedAt)}&signature=${encodeURIComponent(signature)}`);
		expect(r._s).toBe(200);
		expect(r.json().keys).toEqual([]);
	});
});

describe('GET /api/premium/status — authenticated path (valid ownership proof)', () => {
	it('returns the full payload including keys and history', async () => {
		const issuedAt = new Date().toISOString();
		const signature = sign(ownershipMessage(WALLET, issuedAt));
		const r = await call(`?wallet=${WALLET}&issuedAt=${encodeURIComponent(issuedAt)}&signature=${encodeURIComponent(signature)}`);
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.keys).toHaveLength(1);
		expect(body.keys[0].key_prefix).toBe('x402_live_ABCDEF');
		expect(body.history).toHaveLength(1);
		expect(body.resources).toEqual(['news-archive']);
	});
});

describe('GET /api/premium/status — rate limiting', () => {
	it('429 when the limiter declines', async () => {
		rl.ok = false;
		const r = await call(`?wallet=${WALLET}`);
		expect(r._s).toBe(429);
	});
});
