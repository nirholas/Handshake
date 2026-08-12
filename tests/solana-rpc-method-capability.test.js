import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	makeRotatingFetch,
	isEndpointCooling,
	isMethodDemoted,
	isMethodRefusal,
	rpcMethodsFromBody,
	rpcMethodDemotions,
	classifyRpcBody,
	throwDisposition,
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

	// The dangerous direction of "never bench on a refusal". `Your IP or provider is
	// blocked from this endpoint` is emitted per-method by MagicBlock (which serves
	// six other shapes perfectly) AND caller-wide by a node that has genuinely banned
	// our egress. The wording is identical, so only BREADTH separates them: a lane
	// that refuses one or two shapes is refusing a call, a lane that refuses
	// everything is refusing us and must leave the rotation properly.
	it('benches a lane that refuses call shape after call shape, that is a caller ban, not a policy block', async () => {
		const banned = 'https://cap-i1.test/';
		const healthy = 'https://cap-i2.test/';
		global.fetch = vi.fn(async (url) => (url === banned ? resp(MAGICBLOCK_IP_BLOCK) : resp(OK)));
		const rf = makeRotatingFetch([banned, healthy]);

		// Three distinct shapes refused is still inside the legitimate range: Tatum's
		// free tier gates exactly three while serving two more we want to keep.
		for (const m of ['getBalance', 'getTokenAccountsByOwner', 'getProgramAccounts']) {
			await rf(null, rpc(m));
		}
		expect(isEndpointCooling(banned)).toBe(false);

		// The fourth tips it: no real policy block is this wide.
		await rf(null, rpc('getAccountInfo'));
		expect(isEndpointCooling(banned)).toBe(true);
	});

	it('leaves a lane serving when only one shape is refused, however alarming the wording', async () => {
		const magicblock = 'https://cap-j1.test/';
		const healthy = 'https://cap-j2.test/';
		global.fetch = vi.fn(async (url, init) =>
			url === magicblock && JSON.parse(init.body).method === 'getProgramAccounts'
				? resp(MAGICBLOCK_IP_BLOCK)
				: resp(OK),
		);
		const rf = makeRotatingFetch([magicblock, healthy]);

		// The real MagicBlock profile: refuse getProgramAccounts, serve everything
		// else. Hammer it with the other shapes and it must stay the primary.
		await rf(null, rpc('getProgramAccounts'));
		for (const m of ['getBalance', 'getLatestBlockhash', 'getSignatureStatuses', 'getAccountInfo', 'simulateTransaction']) {
			await rf(null, rpc(m));
		}
		expect(isEndpointCooling(magicblock)).toBe(false);
		expect(isMethodDemoted(magicblock, 'getProgramAccounts')).toBe(true);
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

// Leo RPC answers EVERY getTokenLargestAccounts with the JSON-RPC spec's -32603
// "Internal error" while serving getAccountInfo and getMultipleAccounts normally
// (measured live 2026-08-12). Unclassified, -32603 was not a failover signal at
// all: the error envelope was handed back as though it were the chain's answer,
// so /api/crypto/holders returned 503 and /api/crypto/security reported
// riskLevel "unknown" on live mints while lanes that DO serve the method sat
// untried further down the chain.
const LEO_INTERNAL_ERROR = {
	jsonrpc: '2.0',
	id: 1,
	error: { code: -32603, message: 'Internal JSON-RPC error.' },
};

describe('classifyRpcBody: a node internal error is a per-shape failover, not an answer', () => {
	it('fails a -32603 envelope over and demotes the shape rather than the lane', () => {
		const bad = classifyRpcBody(JSON.stringify(LEO_INTERNAL_ERROR));
		expect(bad).toBeTruthy();
		expect(bad.methodBlock).toBe(true);
		expect(bad.reason).toBe('node internal error');
	});

	// The line that separates -32603 from the deterministic family next to it: a
	// method that does not exist gives the same answer on every lane, so rotating
	// on it would just retry a guaranteed failure down the whole chain.
	it('leaves the deterministic -32601/-32602 family alone', () => {
		expect(classifyRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }))).toBeNull();
		expect(classifyRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }))).toBeNull();
	});

	it('rotates a -32603 lane onto one that serves the shape, without cooling it', async () => {
		const faulting = 'https://cap-k1.test/';
		const serving = 'https://cap-k2.test/';
		global.fetch = vi.fn(async (url, init) =>
			url === faulting && JSON.parse(init.body).method === 'getTokenLargestAccounts'
				? resp(LEO_INTERNAL_ERROR)
				: resp(OK),
		);
		const rf = makeRotatingFetch([faulting, serving]);

		const r = await rf(null, rpc('getTokenLargestAccounts', ['MintPlaceholder1111111111111111111111111111']));
		await expect(r.json()).resolves.toEqual(OK);
		expect(isMethodDemoted(faulting, 'getTokenLargestAccounts')).toBe(true);
		expect(isEndpointCooling(faulting)).toBe(false);

		// The lane is still the primary for everything it does serve.
		await rf(null, rpc('getAccountInfo'));
		expect(global.fetch.mock.calls.at(-1)[0]).toBe(faulting);
	});
});

// PublicNode accepts a getTokenLargestAccounts and then never answers it: no
// response at 35 s, while getAccountInfo comes back in milliseconds. Charging
// that hang to the LANE parked the free chain's primary for every method, on one
// shape it silently refuses. throwDisposition is the policy, split out so the
// three events that reach the same catch can be pinned without waiting on a real
// 10 s attempt bound.
describe('throwDisposition: what a thrown attempt charges the lane', () => {
	it('charges nothing when the CALLER aborted, whatever else is true', () => {
		expect(throwDisposition({ callerAborted: true, attemptTimedOut: true, hasMethods: true })).toBe('ignore');
		expect(throwDisposition({ callerAborted: true, attemptTimedOut: false, hasMethods: false })).toBe('ignore');
	});

	it('demotes the call shape when the lane hung past the attempt bound', () => {
		expect(throwDisposition({ callerAborted: false, attemptTimedOut: true, hasMethods: true })).toBe('demote-method');
	});

	// No readable call shape means no shape to demote; fall back to the brief lane
	// cooldown rather than guessing which method to strike off.
	it('cools the lane for a transport failure, or a hang whose shape we cannot read', () => {
		expect(throwDisposition({ callerAborted: false, attemptTimedOut: false, hasMethods: true })).toBe('cool-lane');
		expect(throwDisposition({ callerAborted: false, attemptTimedOut: true, hasMethods: false })).toBe('cool-lane');
	});
});
