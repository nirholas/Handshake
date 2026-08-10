/**
 * CoinCommunities session survival across the 1h access-token expiry.
 *
 * Regression target: `cc_at` (the access-token cookie) and the JWT inside it
 * share a 1h lifetime, so an hour after sign-in the browser has dropped it and
 * only the 30-day `cc_rt` refresh cookie is still sent. Every user-scoped
 * surface read the session with `userAuthHeaders(req)`, which sees no `cc_at`
 * and reports "not signed in", and `withAuthRefresh` bailed on the same check
 * before it ever reached the refresh token. Net effect: the 30-day refresh
 * token was never once used and every session silently died at 1h, locking the
 * Town composer and the wallet-link flow behind a sign-in the user had already
 * completed.
 *
 * These tests pin the fixed behavior: a request carrying only `cc_rt` mints a
 * fresh access token, re-runs the call, and persists the new cookies; a request
 * carrying nothing is still treated as signed out; and a dead refresh token
 * clears the stale cookies instead of looping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })),
		authIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })),
		authedReadIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })),
	},
	clientIp: () => '127.0.0.1',
}));

// The upstream SDK, driven per-test. cc() is the only door to it, so stubbing
// the module's client here exercises the real session logic in
// api/_lib/coin-communities.js rather than a re-implementation of it.
const sdk = {
	refreshToken: vi.fn(),
	postMessage: vi.fn(),
	walletChallenge: vi.fn(),
	linkWallet: vi.fn(),
	getWallets: vi.fn(),
	unlinkWallet: vi.fn(),
};
vi.mock('@coin-communities/sdk/node', () => ({
	configureApi: vi.fn(),
	api: sdk,
}));

process.env.CC_API_KEY = 'test-key';

const { withAuthRefresh, hasUserSession, userAuthHeaders } = await import(
	'../api/_lib/coin-communities.js'
);
const { default: messagesHandler } = await import('../api/community/messages.js');
const { default: challengeHandler } = await import('../api/community/wallet/challenge.js');
const { default: linkHandler } = await import('../api/community/wallet/link.js');
const { default: unlinkHandler } = await import('../api/community/wallet/unlink.js');

const TOKEN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function makeReq({ method = 'POST', url = '/api/community/messages', cookie = '', body } = {}) {
	return {
		method,
		url,
		headers: {
			origin: 'https://three.ws',
			'content-type': 'application/json',
			...(cookie ? { cookie } : {}),
		},
		rawBody: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
		socket: { remoteAddress: '127.0.0.1' },
	};
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => {
		r._h[k.toLowerCase()] = v;
	};
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.removeHeader = (k) => {
		delete r._h[k.toLowerCase()];
	};
	r.end = (b) => {
		r._b = b;
	};
	r.json = () => JSON.parse(r._b);
	return r;
}

const ok = (data) => ({ data, error: null });
const fail = (statusCode, message) => ({ data: null, error: { statusCode, message } });

beforeEach(() => {
	rl.ok = true;
	for (const fn of Object.values(sdk)) fn.mockReset();
});

describe('hasUserSession', () => {
	it('sees an hours-old session that has only the refresh cookie left', () => {
		const req = makeReq({ cookie: 'cc_rt=refresh-token' });
		// The old gate: no access cookie, so this is null and the user reads as a
		// stranger. The new gate must still recognize them.
		expect(userAuthHeaders(req)).toBeNull();
		expect(hasUserSession(req)).toBe(true);
	});

	it('is false when no session cookie is present at all', () => {
		expect(hasUserSession(makeReq())).toBe(false);
	});
});

describe('withAuthRefresh with an expired access-token cookie', () => {
	it('refreshes from cc_rt, retries the call, and persists the new cookies', async () => {
		sdk.refreshToken.mockResolvedValue(ok({ accessToken: 'fresh-at', refreshToken: 'fresh-rt' }));
		const call = vi.fn(async (h) => ok({ seen: h.Authorization }));

		const res = makeRes();
		const result = await withAuthRefresh(makeReq({ cookie: 'cc_rt=old-rt' }), res, call);

		expect(sdk.refreshToken).toHaveBeenCalledWith({ body: { refreshToken: 'old-rt' } });
		expect(result.headers).toEqual({ Authorization: 'Bearer fresh-at' });
		expect(result.data.seen).toBe('Bearer fresh-at');
		const cookies = res.getHeader('set-cookie');
		expect(cookies.some((c) => c.startsWith('cc_at=fresh-at;'))).toBe(true);
		expect(cookies.some((c) => c.startsWith('cc_rt=fresh-rt;'))).toBe(true);
	});

	it('reports no session and clears cookies when the refresh token is dead', async () => {
		sdk.refreshToken.mockResolvedValue(fail(401, 'refresh token expired'));
		const call = vi.fn();

		const res = makeRes();
		const result = await withAuthRefresh(makeReq({ cookie: 'cc_rt=dead' }), res, call);

		expect(result.headers).toBeNull();
		expect(call).not.toHaveBeenCalled();
		expect(res.getHeader('set-cookie').every((c) => c.includes('Max-Age=0'))).toBe(true);
	});

	it('never calls refresh when there is no session at all', async () => {
		const res = makeRes();
		const result = await withAuthRefresh(makeReq(), res, vi.fn());
		expect(result.headers).toBeNull();
		expect(sdk.refreshToken).not.toHaveBeenCalled();
		expect(res.getHeader('set-cookie')).toBeUndefined();
	});

	it('still refreshes on an upstream 401 when the access cookie is present', async () => {
		sdk.refreshToken.mockResolvedValue(ok({ accessToken: 'fresh-at', refreshToken: 'fresh-rt' }));
		const call = vi
			.fn()
			.mockResolvedValueOnce(fail(401, 'jwt expired'))
			.mockResolvedValueOnce(ok({ retried: true }));

		const result = await withAuthRefresh(
			makeReq({ cookie: 'cc_at=stale; cc_rt=good' }),
			makeRes(),
			call,
		);

		expect(call).toHaveBeenCalledTimes(2);
		expect(result.data).toEqual({ retried: true });
		expect(result.headers).toEqual({ Authorization: 'Bearer fresh-at' });
	});
});

describe('POST /api/community/messages with a refresh-only session', () => {
	const body = { content: 'gm from the holders world', walletAddress: TOKEN, chainId: 'solana' };

	it('posts as the user after refreshing, instead of locking the composer', async () => {
		sdk.refreshToken.mockResolvedValue(ok({ accessToken: 'fresh-at', refreshToken: 'fresh-rt' }));
		sdk.postMessage.mockResolvedValue(
			ok({ message: { id: 'm1', tokenAddress: TOKEN, content: body.content, createdAt: 'now' } }),
		);

		const res = makeRes();
		await messagesHandler(
			makeReq({ url: `/api/community/messages?token=${TOKEN}`, cookie: 'cc_rt=old-rt', body }),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(res.json().data.message.id).toBe('m1');
		expect(sdk.postMessage).toHaveBeenCalledTimes(1);
		expect(sdk.postMessage.mock.calls[0][0].headers).toEqual({ Authorization: 'Bearer fresh-at' });
	});

	it('answers 401 auth_required (not posting_locked) when the refresh fails', async () => {
		sdk.refreshToken.mockResolvedValue(fail(401, 'refresh token expired'));

		const res = makeRes();
		await messagesHandler(
			makeReq({ url: `/api/community/messages?token=${TOKEN}`, cookie: 'cc_rt=dead', body }),
			res,
		);

		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('auth_required');
		expect(sdk.postMessage).not.toHaveBeenCalled();
	});
});

describe('POST /api/community/wallet/challenge with a refresh-only session', () => {
	it('issues the challenge on the refreshed token', async () => {
		sdk.refreshToken.mockResolvedValue(ok({ accessToken: 'fresh-at', refreshToken: 'fresh-rt' }));
		sdk.walletChallenge.mockResolvedValue(ok({ message: 'sign this', nonce: 'n1' }));

		const res = makeRes();
		await challengeHandler(
			makeReq({
				url: '/api/community/wallet/challenge',
				cookie: 'cc_rt=old-rt',
				body: { address: TOKEN },
			}),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ message: 'sign this', nonce: 'n1' });
	});

	it('rejects a request with no session before touching the upstream', async () => {
		const res = makeRes();
		await challengeHandler(
			makeReq({ url: '/api/community/wallet/challenge', body: { address: TOKEN } }),
			res,
		);

		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('unauthorized');
		expect(sdk.walletChallenge).not.toHaveBeenCalled();
	});
});

describe('POST /api/community/wallet/unlink', () => {
	it('removes every linked svm wallet and reports the count', async () => {
		sdk.getWallets.mockResolvedValue(
			ok({
				wallets: [
					{ id: 'w1', chainType: 'svm', address: 'A' },
					{ id: 'w2', chainType: 'svm', address: 'B' },
					{ id: 'w3', chainType: 'evm', address: '0xabc' },
				],
			}),
		);
		sdk.unlinkWallet.mockResolvedValue(ok({}));

		const res = makeRes();
		await unlinkHandler(makeReq({ url: '/api/community/wallet/unlink', cookie: 'cc_at=at' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ unlinked: 2 });
		expect(sdk.unlinkWallet).toHaveBeenCalledTimes(2);
	});

	it('treats an already-gone wallet (404) as unlinked', async () => {
		sdk.getWallets.mockResolvedValue(
			ok({ wallets: [{ id: 'w1', chainType: 'svm', address: 'A' }] }),
		);
		sdk.unlinkWallet.mockResolvedValue(fail(404, 'not found'));

		const res = makeRes();
		await unlinkHandler(makeReq({ url: '/api/community/wallet/unlink', cookie: 'cc_at=at' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ unlinked: 1 });
	});

	it('surfaces a real upstream unlink failure as 502', async () => {
		sdk.getWallets.mockResolvedValue(
			ok({ wallets: [{ id: 'w1', chainType: 'svm', address: 'A' }] }),
		);
		sdk.unlinkWallet.mockResolvedValue(fail(500, 'upstream exploded'));

		const res = makeRes();
		await unlinkHandler(makeReq({ url: '/api/community/wallet/unlink', cookie: 'cc_at=at' }), res);

		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe('unlink_failed');
	});
});

describe('POST /api/community/wallet/link', () => {
	it('links the wallet on a refreshed session and echoes the stored address', async () => {
		sdk.refreshToken.mockResolvedValue(ok({ accessToken: 'fresh-at', refreshToken: 'fresh-rt' }));
		sdk.linkWallet.mockResolvedValue(ok({ wallet: { address: TOKEN } }));

		const res = makeRes();
		await linkHandler(
			makeReq({
				url: '/api/community/wallet/link',
				cookie: 'cc_rt=old-rt',
				body: { address: TOKEN, signature: 'sig' },
			}),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ address: TOKEN });
		expect(sdk.linkWallet.mock.calls[0][0].headers).toEqual({ Authorization: 'Bearer fresh-at' });
	});

	it('passes an upstream 409 (already linked) through instead of flattening it to 502', async () => {
		sdk.linkWallet.mockResolvedValue(fail(409, 'wallet already linked'));

		const res = makeRes();
		await linkHandler(
			makeReq({
				url: '/api/community/wallet/link',
				cookie: 'cc_at=at',
				body: { address: TOKEN, signature: 'sig' },
			}),
			res,
		);

		expect(res.statusCode).toBe(409);
		expect(res.json().error).toBe('link_failed');
	});
});
