// Unit tests for POST /api/play/refresh, the silent mid-session renewal of a
// wallet's /play credential.
//
// Refresh is the one endpoint that mints a play pass without a wallet signature,
// so the properties worth pinning down are the ones that keep that safe:
//
//   1. Only a pass WE signed, still unexpired, and issued for THIS gate's token
//      can be renewed. A forged, expired, or foreign-mint pass falls back to a
//      full sign-in (401) rather than being trusted.
//   2. The wallet is never taken from the request body. It comes out of the
//      sealed pass, so a caller cannot renew into a different wallet.
//   3. The balance floor is re-read on-chain every renewal, so a wallet that
//      offloaded its tokens loses the pass instead of riding it.
//   4. The `expiresAt` on the wire matches the lifetime actually sealed into the
//      pass. The browser schedules its next renewal off that value, so a drift
//      between the two shows up as silent mid-session kicks.
//
// balances.js is stubbed because the chain read is not this handler's logic and is
// already exercised against real RPC in tests/play-gate.test.js. Everything else
// here (pass signing, HMAC verification, expiry) runs the real module.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

process.env.NODE_ENV = 'development';
process.env.HOLDER_PASS_SECRET = 'play-refresh-test-secret';
process.env.PLAY_GATE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
process.env.PLAY_GATE_MIN = '1';

const balanceState = { result: null, error: null };
vi.mock('../../api/_lib/balances.js', () => ({
	getBalances: vi.fn(async () => {
		if (balanceState.error) throw balanceState.error;
		return balanceState.result;
	}),
}));

const rlState = { success: true, limit: 60, remaining: 59, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const handler = (await import('../../api/play/refresh.js')).default;
const { signPlayPass, verifyPlayPass, PASS_TTL_S } = await import('../../api/_lib/play-pass.js');
const { getBalances } = await import('../../api/_lib/balances.js');

const MINT = process.env.PLAY_GATE_MINT;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WALLET = 'THREEsynthetic1111111111111111111111111111';

function mockRes() {
	const r = {
		statusCode: 200, _headers: {}, _body: '',
		setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this._headers[String(k).toLowerCase()]; },
		writeHead(status, headers) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
			return this;
		},
		end(b) { this._body = b || ''; return this; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
	return r;
}

function mockReq({ method = 'POST', body = null, origin = 'https://three.ws' } = {}) {
	const chunks = body != null ? [Buffer.from(JSON.stringify(body))] : [];
	const r = Readable.from(chunks);
	r.method = method;
	r.url = '/api/play/refresh';
	r.headers = { origin, host: 'three.ws', 'content-type': 'application/json' };
	r.socket = { remoteAddress: '127.0.0.1' };
	return r;
}

async function post(body) {
	const res = mockRes();
	await handler(mockReq({ body }), res);
	return res;
}

/** A solana balance payload holding `amount` of the gate token. */
function holding(amount) {
	return {
		chain: 'solana',
		address: WALLET,
		native: { symbol: 'SOL', amount: 0.5, decimals: 9 },
		tokens: [{ mint: MINT, symbol: 'three', amount, decimals: 6 }],
	};
}

beforeEach(() => {
	rlState.success = true;
	balanceState.error = null;
	balanceState.result = holding(25);
	vi.mocked(getBalances).mockClear();
});

describe('POST /api/play/refresh: what may be renewed', () => {
	it('renews a valid pass and re-reads the wallet it sealed, not one from the body', async () => {
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass, wallet: 'someOtherWalletEntirely' });
		expect(res.statusCode).toBe(200);
		const d = res.json.data;
		expect(d.ok).toBe(true);
		expect(d.wallet).toBe(WALLET);
		expect(getBalances).toHaveBeenCalledWith({ chain: 'solana', address: WALLET });
	});

	it('issues a genuinely new pass rather than echoing the old one back', async () => {
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 3 });
		const res = await post({ playPass: pass });
		const fresh = res.json.data.playPass;
		expect(typeof fresh).toBe('string');
		const opened = verifyPlayPass(fresh);
		expect(opened).toBeTruthy();
		expect(opened.wallet).toBe(WALLET);
		expect(opened.mint).toBe(MINT);
		// The renewed pass carries the balance just read on-chain, not the stale one
		// the presented pass was sealed with.
		expect(opened.balance).toBe(25);
	});

	it('advertises exactly the lifetime it sealed into the pass', async () => {
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass });
		const d = res.json.data;
		const sealedExp = verifyPlayPass(d.playPass).exp * 1000;
		const advertised = new Date(d.expiresAt).getTime();
		// One source of truth for the TTL: the wire value and the sealed expiry must
		// agree to within the clock tick between signing and serialising.
		expect(Math.abs(advertised - sealedExp)).toBeLessThan(2000);
		expect(Math.round((advertised - Date.now()) / 1000)).toBeCloseTo(PASS_TTL_S, -1);
	});

	it('refuses a forged pass so the client falls back to a full sign-in', async () => {
		const res = await post({ playPass: 'eyJrIjoicGxheS1wYXNzIn0.deadbeefdeadbeefdeadbeef' });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('pass_invalid');
		expect(getBalances).not.toHaveBeenCalled();
	});

	it('refuses a pass whose signature was tampered with', async () => {
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const [body] = pass.split('.');
		const res = await post({ playPass: `${body}.${'A'.repeat(43)}` });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('pass_invalid');
	});

	it('refuses a pass minted for a different gate token', async () => {
		const pass = signPlayPass({ wallet: WALLET, mint: SOL_MINT, balance: 999 });
		const res = await post({ playPass: pass });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('pass_invalid');
		expect(getBalances).not.toHaveBeenCalled();
	});

	it('refuses an expired pass', async () => {
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now - (PASS_TTL_S + 60) * 1000);
		const stale = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		vi.mocked(Date.now).mockRestore();
		const res = await post({ playPass: stale });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('pass_invalid');
	});
});

describe('POST /api/play/refresh: the balance floor', () => {
	it('refuses renewal when the wallet has dropped below the floor', async () => {
		balanceState.result = holding(0.25);
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass });
		// A 200 with an honest refusal, not an error: the client renders "top up",
		// it does not retry a failed request.
		expect(res.statusCode).toBe(200);
		const d = res.json.data;
		expect(d.ok).toBe(false);
		expect(d.reason).toBe('balance_too_low');
		expect(d.balance).toBe(0.25);
		expect(d.minBalance).toBe(1);
		expect(d.playPass).toBeUndefined();
		expect(d.acquireUrl).toContain(MINT);
	});

	it('treats a wallet that holds none of the token as zero, not as an error', async () => {
		balanceState.result = { chain: 'solana', address: WALLET, native: { symbol: 'SOL', amount: 2 }, tokens: [] };
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass });
		expect(res.json.data).toMatchObject({ ok: false, reason: 'balance_too_low', balance: 0 });
	});

	it('surfaces an RPC outage as a 502 rather than renewing on a missing read', async () => {
		balanceState.error = new Error('rpc unreachable');
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass });
		expect(res.statusCode).toBe(502);
		expect(res.json.error).toBe('balance_unavailable');
	});

	it('passes a 503 from the balance layer through unchanged', async () => {
		balanceState.error = Object.assign(new Error('all providers in cooldown'), { status: 503 });
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass });
		expect(res.statusCode).toBe(503);
		expect(res.json.error).toBe('balance_unavailable');
	});
});

describe('POST /api/play/refresh: HTTP posture', () => {
	it('rejects a body with no pass', async () => {
		const res = await post({});
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
	});

	it('rejects a pass too short to be one we issued', async () => {
		const res = await post({ playPass: 'short' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
	});

	it('rejects a non-POST request', async () => {
		const res = mockRes();
		await handler(mockReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('never lets a credential response be cached', async () => {
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass });
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('answers a credentialed preflight without doing any work', async () => {
		const res = mockRes();
		await handler(mockReq({ method: 'OPTIONS' }), res);
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-credentials')).toBe('true');
		expect(getBalances).not.toHaveBeenCalled();
	});

	it('refuses a rate-limited caller before verifying anything', async () => {
		rlState.success = false;
		const pass = signPlayPass({ wallet: WALLET, mint: MINT, balance: 25 });
		const res = await post({ playPass: pass });
		expect(res.statusCode).toBe(429);
		expect(getBalances).not.toHaveBeenCalled();
	});
});

describe('POST /api/play/refresh: with no game token pinned', () => {
	it('tells the client the gate is off instead of minting a pass', async () => {
		// PLAY_GATE_MINT is read once at module load, so an unpinned gate needs a
		// fresh module graph rather than a mutated env var.
		vi.resetModules();
		const saved = process.env.PLAY_GATE_MINT;
		delete process.env.PLAY_GATE_MINT;
		delete process.env.THREE_MINT;
		try {
			const gateless = (await import('../../api/play/refresh.js')).default;
			const res = mockRes();
			await gateless(mockReq({ body: { playPass: 'a'.repeat(40) } }), res);
			expect(res.statusCode).toBe(400);
			expect(res.json.error).toBe('gate_disabled');
		} finally {
			process.env.PLAY_GATE_MINT = saved;
			vi.resetModules();
		}
	});
});
