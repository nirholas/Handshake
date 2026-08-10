/**
 * GET/POST /api/community/world-gate endpoint tests.
 *
 * The world gate (R24) is the one place a coin creator changes who may enter
 * their Holders world, so the endpoint's job is to be exact about identity: a
 * read is public and always states the requirement, a write only lands when the
 * caller's linked Solana wallet IS the coin's on-chain creator, and every way
 * that check can fail has its own coded answer the gate UI routes on.
 *
 * Storage is the real world-gate lib over the in-memory KV fallback (no
 * UPSTASH_* in the test env), so the read-after-write assertions exercise the
 * actual persistence path rather than a stand-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

// Session state the handler sees: `wallets` are the caller's linked SVM
// addresses, `signedIn` is the cookie-level "is there a session at all" answer.
const session = { signedIn: false, wallets: [], walletError: null };
const ccConfigured = { value: true };
vi.mock('../api/_lib/coin-communities.js', async () => {
	const actual = await vi.importActual('../api/_lib/coin-communities.js');
	return {
		...actual,
		cc: vi.fn(() => {
			if (!ccConfigured.value) throw new actual.UnconfiguredError();
			return {
				getWallets: async () =>
					session.walletError
						? { data: null, error: session.walletError }
						: {
								data: {
									wallets: session.wallets.map((address) => ({ address, chainType: 'svm' })),
								},
								error: null,
							},
			};
		}),
		hasUserSession: vi.fn(() => session.signedIn),
		withAuthRefresh: vi.fn(async (req, res, call) => {
			if (!session.signedIn) return { data: null, error: null, headers: null };
			const headers = { Authorization: 'Bearer test-session' };
			const result = await call(headers);
			return { ...result, headers };
		}),
	};
});

const { readWorldGate, writeWorldGate } = await import('../api/_lib/world-gate.js');
const { default: handler } = await import('../api/community/world-gate.js');

// Synthetic base58 addresses of the right shape: no real mainnet mint or wallet.
const MINT = 'THREEsynthetic1111111111111111111111111pump';
const CREATOR = 'THREEcreator11111111111111111111111111wallet';
const OTHER = 'THREEother111111111111111111111111111wallet';
const EVM_MINT = '0x1234567890abcdef1234567890abcdef12345678';

// The pump.fun creator lookup, the handler's one outbound HTTP call.
const pump = { creator: CREATOR, status: 200 };
let fetchSpy;

function makeReq(httpMethod, { token = MINT, body } = {}) {
	const req = {
		method: httpMethod,
		url: `/api/community/world-gate${token === null ? '' : `?token=${encodeURIComponent(token)}`}`,
		headers: { origin: 'https://three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
	if (body !== undefined) {
		req.headers['content-type'] = 'application/json';
		req.body = body;
	}
	return req;
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	r.json = () => JSON.parse(r._b);
	return r;
}
async function call(httpMethod, opts) {
	const res = makeRes();
	await handler(makeReq(httpMethod, opts), res);
	return res;
}

beforeEach(async () => {
	rl.ok = true;
	ccConfigured.value = true;
	session.signedIn = false;
	session.wallets = [];
	session.walletError = null;
	pump.creator = CREATOR;
	pump.status = 200;
	await writeWorldGate(MINT, { minTokens: 0 });
	fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({
		ok: pump.status === 200 && String(url).includes(`/coins/${MINT}`),
		status: pump.status,
		json: async () => ({ creator: pump.creator }),
	}));
});
afterEach(() => {
	fetchSpy.mockRestore();
	vi.clearAllMocks();
});

describe('GET world-gate', () => {
	it('reads an ungated world publicly, never cached', async () => {
		const res = await call('GET');
		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ mint: MINT, gated: false, minTokens: 0, canEdit: false });
		expect(res._h['cache-control']).toBe('no-store');
	});

	it('reports a stored threshold', async () => {
		await writeWorldGate(MINT, { minTokens: 250_000 }, CREATOR);
		const { data } = (await call('GET')).json();
		expect(data).toMatchObject({ gated: true, minTokens: 250_000 });
	});

	it('rejects a malformed token', async () => {
		const res = await call('GET', { token: 'not-a-mint' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
	});

	it('rejects a missing token', async () => {
		const res = await call('GET', { token: null });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
	});

	it('grants canEdit to the creator', async () => {
		session.signedIn = true;
		session.wallets = [CREATOR];
		expect((await call('GET')).json().data.canEdit).toBe(true);
	});

	it('withholds canEdit from a signed-in non-creator', async () => {
		session.signedIn = true;
		session.wallets = [OTHER];
		expect((await call('GET')).json().data.canEdit).toBe(false);
	});

	it('still serves the requirement when the creator lookup fails', async () => {
		session.signedIn = true;
		session.wallets = [CREATOR];
		pump.status = 502;
		await writeWorldGate(MINT, { minTokens: 42 }, CREATOR);
		const { data } = (await call('GET')).json();
		expect(data).toMatchObject({ gated: true, minTokens: 42, canEdit: false });
	});

	it('skips the upstream lookups entirely when signed out', async () => {
		await call('GET');
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('POST world-gate', () => {
	it('writes a creator-set threshold and persists it', async () => {
		session.signedIn = true;
		session.wallets = [CREATOR];
		const res = await call('POST', { body: { minTokens: 5000 } });
		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ mint: MINT, gated: true, minTokens: 5000 });
		expect(await readWorldGate(MINT)).toMatchObject({ minTokens: 5000, setBy: CREATOR });
	});

	it('clears the gate on minTokens 0', async () => {
		session.signedIn = true;
		session.wallets = [CREATOR];
		await writeWorldGate(MINT, { minTokens: 5000 }, CREATOR);
		const res = await call('POST', { body: { minTokens: 0 } });
		expect(res.json().data).toEqual({ mint: MINT, gated: false, minTokens: 0 });
		expect(await readWorldGate(MINT)).toBeNull();
	});

	it('recognizes a creator wallet linked after the first few', async () => {
		session.signedIn = true;
		session.wallets = [
			'THREEw1111111111111111111111111111111wallet',
			'THREEw2111111111111111111111111111111wallet',
			'THREEw3111111111111111111111111111111wallet',
			'THREEw4111111111111111111111111111111wallet',
			'THREEw5111111111111111111111111111111wallet',
			CREATOR,
		];
		const res = await call('POST', { body: { minTokens: 10 } });
		expect(res.statusCode).toBe(200);
		expect(res.json().data.minTokens).toBe(10);
	});

	it('401s without a session', async () => {
		const res = await call('POST', { body: { minTokens: 1 } });
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('auth_required');
	});

	it('403s a signed-in user with no linked Solana wallet', async () => {
		session.signedIn = true;
		session.wallets = [];
		const res = await call('POST', { body: { minTokens: 1 } });
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toBe('wallet_required');
	});

	it('403s a non-creator and leaves the gate untouched', async () => {
		session.signedIn = true;
		session.wallets = [OTHER];
		const res = await call('POST', { body: { minTokens: 1 } });
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toBe('not_creator');
		expect(await readWorldGate(MINT)).toBeNull();
	});

	it('502s when the creator cannot be resolved', async () => {
		session.signedIn = true;
		session.wallets = [CREATOR];
		pump.status = 502;
		const res = await call('POST', { body: { minTokens: 1 } });
		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe('creator_unresolved');
	});

	it('502s when the wallet read fails upstream', async () => {
		session.signedIn = true;
		session.walletError = { message: 'wallets upstream down' };
		const res = await call('POST', { body: { minTokens: 1 } });
		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe('upstream_error');
	});

	it('rejects a non-Solana world with a coded, non-retryable answer', async () => {
		session.signedIn = true;
		session.wallets = [CREATOR];
		const res = await call('POST', { token: EVM_MINT, body: { minTokens: 1 } });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('solana_only');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects a body that is not JSON', async () => {
		session.signedIn = true;
		session.wallets = [CREATOR];
		const res = await call('POST', { body: 'plain text' });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
	});

	it('503s when CoinCommunities is unconfigured', async () => {
		ccConfigured.value = false;
		const res = await call('POST', { body: { minTokens: 1 } });
		expect(res.statusCode).toBe(503);
		expect(res.json().error).toBe('cc_unconfigured');
	});
});

describe('transport', () => {
	it('405s an unsupported method', async () => {
		const res = await call('DELETE');
		expect(res.statusCode).toBe(405);
		expect(res.json().error).toBe('method_not_allowed');
	});

	it('429s when rate limited', async () => {
		rl.ok = false;
		const res = await call('GET');
		expect(res.statusCode).toBe(429);
		expect(res.json().error).toBe('rate_limited');
	});

	it('answers a preflight with the credentialed CORS contract', async () => {
		const res = makeRes();
		await handler(makeReq('OPTIONS'), res);
		expect(res.statusCode).toBe(204);
		expect(res._h['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
		expect(res._h['access-control-allow-credentials']).toBe('true');
	});
});
