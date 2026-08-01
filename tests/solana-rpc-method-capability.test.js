import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	makeRotatingFetch,
	isEndpointCooling,
	isMethodDemoted,
	isMethodRefusal,
	rpcMethodsFromBody,
	rpcMethodDemotions,
	classifyRpcBody,
} from '../api/_lib/solana/connection.js';

// Lanes are not interchangeable, and the router used to pretend they were.
//
// Every free Solana lane answers getBalance, getLatestBlockhash and
// getSignatureStatuses. They diverge on exactly the calls that carry the product:
// PublicNode refuses a programId-filtered getTokenAccountsByOwner (the shape
// behind $THREE holder gating and every USDC balance) while serving everything
// else perfectly, and MagicBlock IP-blocks getProgramAccounts while serving the
// token filters. Measured live 2026-07-30 and again 2026-08-01 with
// scripts/probe-rpc-lanes.mjs.
//
// Treating those refusals as LANE faults produced the defect this file locks
// down: a healthy free primary was benched by its own routine traffic, for 30
// minutes, on the auth path, because a 403 body was never read, and the rotation
// cascaded down onto the paid lanes the free chain exists to protect. The fix is
// per-method capability: a refusal demotes (lane, method) and nothing else.
//
// Every test uses its own hostnames because the cooldown and demotion maps are
// process-wide by design (that is what makes one lane's verdict apply to every
// caller in the instance).

const resp = (body, status = 200, headers = { 'content-type': 'application/json' }) =>
	new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

const OK = { jsonrpc: '2.0', id: 1, result: { ok: true } };
const rpc = (method, params = []) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

// The exact wire shapes, verbatim from the live lanes.
const PUBLICNODE_403_BODY = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	error: { code: -32602, message: 'Request blocked. Details: blocked parameter: params.1.programId' },
});
const PUBLICNODE_PROGRAM_ACCOUNTS = {
	jsonrpc: '2.0',
	id: 1,
	error: {
		code: -32010,
		message:
			'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA excluded from account secondary indexes; this RPC method unavailable for key',
	},
};
const MAGICBLOCK_IP_BLOCK = {
	jsonrpc: '2.0',
	id: 1,
	error: { code: 403, message: 'Your IP or provider is blocked from this endpoint' },
};
const TATUM_TIER_GATE = {
	jsonrpc: '2.0',
	id: 1,
	error: { code: -16401, message: "Method 'getBalance' is available for paid plans only. To access this feature, please upgrade your subscription" },
};
const REAL_AUTH_FAILURE = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	error: { code: -32052, message: 'invalid api key' },
});

describe('rpcMethodsFromBody', () => {
	it('reads the method out of a single JSON-RPC call', () => {
		expect(rpcMethodsFromBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance' }))).toEqual(['getBalance']);
	});

	it('reads every distinct method out of a batch', () => {
		const batch = JSON.stringify([
			{ jsonrpc: '2.0', id: 1, method: 'getBalance' },
			{ jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner' },
			{ jsonrpc: '2.0', id: 3, method: 'getBalance' },
		]);
		expect(rpcMethodsFromBody(batch)).toEqual(['getBalance', 'getTokenAccountsByOwner']);
	});

	// An unreadable body must make capability checks a no-op rather than a guess:
	// silently skipping a healthy lane because we could not parse our own request
	// would be a worse failure than the one this whole layer prevents.
	it('returns nothing for a body it cannot read, so no lane is skipped on a guess', () => {
		expect(rpcMethodsFromBody('not json')).toEqual([]);
		expect(rpcMethodsFromBody('')).toEqual([]);
		expect(rpcMethodsFromBody(undefined)).toEqual([]);
		expect(rpcMethodsFromBody(JSON.stringify([]))).toEqual([]);
		expect(rpcMethodsFromBody(JSON.stringify({ jsonrpc: '2.0', id: 1 }))).toEqual([]);
	});
});

describe('isMethodRefusal: the one matcher both the router and the probe use', () => {
	it.each([
		['PublicNode programId filter', 'Request blocked. Details: blocked parameter: params.1.programId'],
		['PublicNode getProgramAccounts', 'Tokenkeg… excluded from account secondary indexes; this RPC method unavailable for key'],
		['MagicBlock IP block', 'Your IP or provider is blocked from this endpoint'],
		['Tatum tier gate', "Method 'getBalance' is available for paid plans only"],
		['operator-disabled method', 'method getProgramAccounts is not available'],
	])('classifies %s as a method refusal', (_label, message) => {
		expect(isMethodRefusal(message)).toBe(true);
	});

	// The dangerous false positive. PublicNode's policy block and a genuine
	// invalid-params error share the code -32602; only the wording separates them.
	// A genuine client error is deterministic, so demoting on it would silently
	// strike lanes off for a bug in our own request.
	it.each([
		['genuine invalid params', 'Invalid param: WrongSize'],
		['quota exhaustion', 'max usage reached'],
		['daily cap', 'daily request limit reached - upgrade your account'],
		['bad credential', 'invalid api key'],
		['empty', ''],
	])('does NOT classify %s as a method refusal', (_label, message) => {
		expect(isMethodRefusal(message)).toBe(false);
	});
});

describe('classifyRpcBody flags a 200-status method refusal separately from capacity', () => {
	it('marks PublicNode getProgramAccounts as a method block', () => {
		const out = classifyRpcBody(JSON.stringify(PUBLICNODE_PROGRAM_ACCOUNTS));
		expect(out?.methodBlock).toBe(true);
	});

	it('marks a MagicBlock IP block as a method block', () => {
		expect(classifyRpcBody(JSON.stringify(MAGICBLOCK_IP_BLOCK))?.methodBlock).toBe(true);
	});

	it('marks a Tatum tier gate as a method block', () => {
		expect(classifyRpcBody(JSON.stringify(TATUM_TIER_GATE))?.methodBlock).toBe(true);
	});

	it('does NOT mark a real quota exhaustion as a method block, that one benches the lane', () => {
		const quota = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32429, message: 'max usage reached' } });
		const out = classifyRpcBody(quota);
		expect(out?.status).toBe(429);
		expect(out?.methodBlock).toBe(false);
	});
});

describe('makeRotatingFetch: a method refusal demotes the method, never the lane', () => {
	let origFetch;
	beforeEach(() => {
		origFetch = global.fetch;
	});
	afterEach(() => {
		global.fetch = origFetch;
		vi.restoreAllMocks();
	});

	// THE regression. PublicNode answers a programId-filtered getTokenAccountsByOwner
	// with HTTP 403 + `blocked parameter`. The rotating fetch only read the response
	// body on a 429, so on a 403 the classifier saw an empty string, could not
	// recognise the refusal, and fell through to the auth branch, parking a healthy
	// free primary for 30 minutes on traffic it generates constantly.
	it('a `blocked parameter` 403 does not trigger the auth path or cool the lane', async () => {
		const blocked = 'https://cap-a1.test/';
		const healthy = 'https://cap-a2.test/';
		global.fetch = vi.fn(async (url) =>
			url === blocked ? resp(PUBLICNODE_403_BODY, 403) : resp(OK),
		);

		const out = await makeRotatingFetch([blocked, healthy])(null, rpc('getTokenAccountsByOwner'));

		expect((await out.json()).result).toEqual({ ok: true });
		// The lane is NOT benched: no cooldown of any length, auth or otherwise.
		expect(isEndpointCooling(blocked)).toBe(false);
		// Only the one call shape is demoted.
		expect(isMethodDemoted(blocked, 'getTokenAccountsByOwner')).toBe(true);
		expect(isMethodDemoted(blocked, 'getBalance')).toBe(false);
	});

	it('keeps serving every other call shape from the lane that refused one', async () => {
		const blocked = 'https://cap-b1.test/';
		const healthy = 'https://cap-b2.test/';
		const seen = [];
		global.fetch = vi.fn(async (url, init) => {
			seen.push([url, JSON.parse(init.body).method]);
			const method = JSON.parse(init.body).method;
			if (url === blocked && method === 'getTokenAccountsByOwner') return resp(PUBLICNODE_403_BODY, 403);
			return resp(OK);
		});
		const rf = makeRotatingFetch([blocked, healthy]);

		await rf(null, rpc('getTokenAccountsByOwner'));
		seen.length = 0;
		await rf(null, rpc('getBalance'));

		// getBalance still lands on the refusing lane, first try, no failover.
		expect(seen).toEqual([[blocked, 'getBalance']]);
	});

	it('skips the demoted lane entirely on the next request for the same shape', async () => {
		const blocked = 'https://cap-c1.test/';
		const healthy = 'https://cap-c2.test/';
		global.fetch = vi.fn(async (url) => (url === blocked ? resp(PUBLICNODE_403_BODY, 403) : resp(OK)));
		const rf = makeRotatingFetch([blocked, healthy]);

		await rf(null, rpc('getTokenAccountsByOwner'));
		global.fetch.mockClear();
		await rf(null, rpc('getTokenAccountsByOwner'));

		// One call, straight to the healthy lane, the refusal is not re-paid.
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(global.fetch.mock.calls[0][0]).toBe(healthy);
	});

	it('demotes on a 200-status policy block too, where no HTTP status would rotate', async () => {
		const blocked = 'https://cap-d1.test/';
		const healthy = 'https://cap-d2.test/';
		global.fetch = vi.fn(async (url) => (url === blocked ? resp(PUBLICNODE_PROGRAM_ACCOUNTS) : resp(OK)));

		const out = await makeRotatingFetch([blocked, healthy])(null, rpc('getProgramAccounts'));

		expect((await out.json()).result).toEqual({ ok: true });
		expect(isEndpointCooling(blocked)).toBe(false);
		expect(isMethodDemoted(blocked, 'getProgramAccounts')).toBe(true);
	});

	// The other half of the split: a credential really being rejected must still
	// bench the whole lane, or the auth path would be dead code.
	it('a genuine 403 with no refusal wording still cools the lane', async () => {
		const badKey = 'https://cap-e1.test/';
		const healthy = 'https://cap-e2.test/';
		global.fetch = vi.fn(async (url) => (url === badKey ? resp(REAL_AUTH_FAILURE, 403) : resp(OK)));

		await makeRotatingFetch([badKey, healthy])(null, rpc('getBalance'));

		expect(isEndpointCooling(badKey)).toBe(true);
		expect(isMethodDemoted(badKey, 'getBalance')).toBe(false);
	});

	// A batch is atomic to the caller: one refused member breaks the whole reply,
	// so the lane must be skipped for the batch even though it serves the rest.
	it('skips a lane demoted for ANY method carried by a batch', async () => {
		const blocked = 'https://cap-f1.test/';
		const healthy = 'https://cap-f2.test/';
		global.fetch = vi.fn(async (url) => (url === blocked ? resp(PUBLICNODE_403_BODY, 403) : resp(OK)));
		const rf = makeRotatingFetch([blocked, healthy]);

		await rf(null, rpc('getTokenAccountsByOwner'));
		global.fetch.mockClear();
		const batch = {
			method: 'POST',
			body: JSON.stringify([
				{ jsonrpc: '2.0', id: 1, method: 'getBalance' },
				{ jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner' },
			]),
		};
		await rf(null, batch);

		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(global.fetch.mock.calls[0][0]).toBe(healthy);
	});

	// Bookkeeping must never be able to strand a request. If every lane has refused
	// this shape at some point, the widest pass still gives it one honest attempt.
	it('still attempts the call when every lane is demoted for that shape', async () => {
		const a = 'https://cap-g1.test/';
		const b = 'https://cap-g2.test/';
		let refuse = true;
		global.fetch = vi.fn(async () => (refuse ? resp(PUBLICNODE_403_BODY, 403) : resp(OK)));
		const rf = makeRotatingFetch([a, b]);

		await expect(rf(null, rpc('getTokenAccountsByOwner'))).rejects.toThrow();
		expect(isMethodDemoted(a, 'getTokenAccountsByOwner')).toBe(true);
		expect(isMethodDemoted(b, 'getTokenAccountsByOwner')).toBe(true);

		refuse = false;
		const out = await rf(null, rpc('getTokenAccountsByOwner'));
		expect((await out.json()).result).toEqual({ ok: true });
	});

	it('reports live demotions for the ops surface and reaps expired ones', async () => {
		const blocked = 'https://cap-h1.test/';
		const healthy = 'https://cap-h2.test/';
		global.fetch = vi.fn(async (url) => (url === blocked ? resp(PUBLICNODE_403_BODY, 403) : resp(OK)));
		await makeRotatingFetch([blocked, healthy])(null, rpc('getTokenAccountsByOwner'));

		const live = rpcMethodDemotions().filter((d) => d.url === blocked);
		expect(live).toHaveLength(1);
		expect(live[0].method).toBe('getTokenAccountsByOwner');
		expect(live[0].remainingMs).toBeGreaterThan(0);

		// Read far enough in the future and the entry is gone, not merely hidden.
		const later = rpcMethodDemotions(Date.now() + 60 * 60_000).filter((d) => d.url === blocked);
		expect(later).toHaveLength(0);
		expect(isMethodDemoted(blocked, 'getTokenAccountsByOwner')).toBe(false);
	});
});
