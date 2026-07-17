// api/_lib/solana/connection.js — solanaRpcEndpoints() failover list.
//
// Regression guard for the production log storm where every cron tick hit
// `[solana-rpc] https://rpc.ankr.com 403 — cooling 30m, failing over`: Ankr
// sunset keyless access, so the hardcoded keyless `rpc.ankr.com/solana` entry
// was a guaranteed 403 + cooldown log on every run. The fix gates Ankr behind
// ANKR_API_KEY (authenticated form only) and adds PublicNode as a keyless,
// un-throttled fallback so failover never depends on the aggressively
// rate-limited public mainnet-beta endpoint alone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	solanaRpcEndpoints,
	shouldRotate,
	makeRotatingFetch,
	classifyRpcBody,
} from '../../api/_lib/solana/connection.js';

const KEYS = [
	'HELIUS_API_KEY',
	'ALCHEMY_API_KEY',
	'ANKR_API_KEY',
	'DRPC_API_KEY',
	'SOLANA_RPC_URL',
	'SOLANA_RPC_FALLBACK_URLS',
	'SOLANA_RPC_LAST_RESORT_URLS',
];

describe('solanaRpcEndpoints', () => {
	let saved;
	beforeEach(() => {
		saved = {};
		for (const k of KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('never includes a keyless Ankr endpoint (Ankr 403s every keyless call)', () => {
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps).not.toContain('https://rpc.ankr.com/solana');
		expect(eps.some((u) => u.startsWith('https://rpc.ankr.com/') && !/\/solana\/.+/.test(u))).toBe(false);
	});

	it('includes PublicNode, Leo RPC, and the public endpoint as keyless fallbacks', () => {
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps).toContain('https://solana-rpc.publicnode.com');
		expect(eps).toContain('https://solana.leorpc.com/?api_key=FREE');
		expect(eps).toContain('https://api.mainnet-beta.solana.com');
	});

	it('keeps five working keyless lanes even with every API key absent', () => {
		// Helius/Alchemy/dRPC/Ankr all unset (the "paid plan lapsed" state): the
		// chain must still resolve a usable node, never collapse to one throttled lane.
		// Five independent public nodes were each verified answering live mainnet RPC,
		// so a request only errors if all five are down at once. (solana.therpc.io was
		// pruned 2026-07-17 after going fully unreachable; MagicBlock took its slot.)
		const eps = solanaRpcEndpoints('mainnet');
		const keyless = [
			'https://solana-rpc.publicnode.com',
			'https://solana.leorpc.com/?api_key=FREE',
			'https://api.tatum.io/v3/blockchain/node/solana-mainnet',
			'https://rpc.magicblock.app/mainnet',
			'https://api.mainnet-beta.solana.com',
		];
		for (const u of keyless) expect(eps).toContain(u);
	});

	it('keeps the public mainnet-beta endpoint last (most rate-limited)', () => {
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps[eps.length - 1]).toBe('https://api.mainnet-beta.solana.com');
	});

	it('adds Ankr only in its authenticated form when ANKR_API_KEY is set', () => {
		process.env.ANKR_API_KEY = 'k_test_123';
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps).toContain('https://rpc.ankr.com/solana/k_test_123');
		expect(eps).not.toContain('https://rpc.ankr.com/solana');
	});

	it('pins an explicit url first and dedups it', () => {
		const eps = solanaRpcEndpoints('mainnet', 'https://my.rpc/solana');
		expect(eps[0]).toBe('https://my.rpc/solana');
		expect(eps.filter((u) => u === 'https://my.rpc/solana')).toHaveLength(1);
	});

	it('keeps the devnet list on the devnet cluster (no mainnet bleed)', () => {
		const eps = solanaRpcEndpoints('devnet');
		expect(eps).toContain('https://api.devnet.solana.com');
		expect(eps).not.toContain('https://api.mainnet-beta.solana.com');
	});

	it('adds dRPC only in its authenticated form when DRPC_API_KEY is set', () => {
		process.env.DRPC_API_KEY = 'dk_test_456';
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps).toContain('https://lb.drpc.org/ogrpc?network=solana&dkey=dk_test_456');
	});

	it('includes operator SOLANA_RPC_FALLBACK_URLS before the public endpoints', () => {
		process.env.SOLANA_RPC_FALLBACK_URLS =
			'https://free-a.example/sol , https://free-b.example/sol';
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps).toContain('https://free-a.example/sol');
		expect(eps).toContain('https://free-b.example/sol');
		// Operator fallbacks rank ahead of the most-throttled public endpoint.
		expect(eps.indexOf('https://free-a.example/sol')).toBeLessThan(
			eps.indexOf('https://api.mainnet-beta.solana.com'),
		);
		// And the public mainnet-beta endpoint is still last.
		expect(eps[eps.length - 1]).toBe('https://api.mainnet-beta.solana.com');
	});

	it('places SOLANA_RPC_LAST_RESORT_URLS after EVERY free endpoint (paid quota preserved)', () => {
		// The paid metered reserve (e.g. the Quicknode credit-funded endpoint) must
		// only serve when the whole free chain is down — so it sits dead last, even
		// behind the most-throttled public mainnet-beta endpoint.
		process.env.HELIUS_API_KEY = 'h_test';
		process.env.SOLANA_RPC_FALLBACK_URLS = 'https://free-a.example/sol';
		process.env.SOLANA_RPC_LAST_RESORT_URLS =
			'https://paid.quiknode.example/abc , https://paid-2.example/sol';
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps[eps.length - 2]).toBe('https://paid.quiknode.example/abc');
		expect(eps[eps.length - 1]).toBe('https://paid-2.example/sol');
		expect(eps.indexOf('https://api.mainnet-beta.solana.com')).toBeLessThan(
			eps.indexOf('https://paid.quiknode.example/abc'),
		);
		expect(eps.indexOf('https://free-a.example/sol')).toBeLessThan(
			eps.indexOf('https://paid.quiknode.example/abc'),
		);
	});

	it('never leaks SOLANA_RPC_LAST_RESORT_URLS into the devnet list (no cluster bleed)', () => {
		process.env.SOLANA_RPC_LAST_RESORT_URLS = 'https://paid.quiknode.example/abc';
		const eps = solanaRpcEndpoints('devnet');
		expect(eps).not.toContain('https://paid.quiknode.example/abc');
	});
});

// Regression guard for the production club-cover outage: a misconfigured primary
// SOLANA_RPC_URL answered JSON-RPC POSTs with HTTP 404, and shouldRotate() did
// not treat 404 as rotate-worthy — so the 404 was returned to web3.js instead of
// failing over to the healthy PublicNode lane, taking every `getMint`/checkout
// `prepare` call (and thus the whole Solana payment flow) down with a 500.
describe('shouldRotate', () => {
	it('rotates off a dead/misrouted endpoint URL (404/408/410)', () => {
		expect(shouldRotate(404)).toBe(true); // wrong/expired RPC URL path
		expect(shouldRotate(408)).toBe(true); // request timeout
		expect(shouldRotate(410)).toBe(true); // endpoint gone
	});

	it('still rotates on auth, rate-limit, and provider-down statuses', () => {
		for (const s of [401, 403, 429, 500, 502, 503]) {
			expect(shouldRotate(s)).toBe(true);
		}
	});

	it('does not rotate a healthy response or a genuine request error', () => {
		// 200 is healthy; a live RPC returns method-not-found as 200 + JSON-RPC
		// error, never an HTTP 404. 400/422 are real request errors, identical on
		// every provider, so they surface to the caller rather than burning the list.
		for (const s of [200, 400, 422]) {
			expect(shouldRotate(s)).toBe(false);
		}
	});
});

// Regression guard for the recurring StructError storm: a provider answered a
// JSON-RPC POST with HTTP 200 but an empty or HTML body, which web3.js then ran
// through its superstruct result schema and threw
// `StructError: Expected the value to satisfy a union of … but received:` to the
// caller WITHOUT rotating (a parse error carries no rotate-worthy HTTP status).
// makeRotatingFetch now detects the poison body and fails over to the next lane.
describe('makeRotatingFetch poison-body failover', () => {
	const json = '{"jsonrpc":"2.0","result":{"value":1},"id":1}';
	let realFetch;
	beforeEach(() => {
		realFetch = global.fetch;
	});
	afterEach(() => {
		global.fetch = realFetch;
		vi.restoreAllMocks();
	});

	function mockResponses(map) {
		global.fetch = vi.fn(async (url) => {
			const r = map[url];
			if (!r) throw new Error(`unexpected fetch ${url}`);
			return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
		});
	}

	it('fails over a 200-but-empty body to the next endpoint and returns its JSON', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const a = 'https://poison-empty.example/sol';
		const b = 'https://healthy.example/sol';
		mockResponses({ [a]: { body: '' }, [b]: { body: json } });
		const fetchImpl = makeRotatingFetch([a, b]);
		const resp = await fetchImpl(a, { method: 'POST', body: '{}' });
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe(json);
	});

	it('fails over a 200-but-HTML body (provider interstitial) to the next endpoint', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const a = 'https://poison-html.example/sol';
		const b = 'https://healthy.example/sol';
		mockResponses({ [a]: { body: '<!DOCTYPE html><html>503</html>' }, [b]: { body: json } });
		const fetchImpl = makeRotatingFetch([a, b]);
		const resp = await fetchImpl(a, { method: 'POST', body: '{}' });
		expect(await resp.text()).toBe(json);
	});

	it('passes a valid JSON-RPC error body straight through (does not rotate)', async () => {
		const errBody = '{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":1}';
		const a = 'https://rpc.example/sol';
		const fetchImpl = makeRotatingFetch([a, 'https://unused.example/sol']);
		global.fetch = vi.fn(async (url) => {
			if (url !== a) throw new Error('should not have rotated');
			return new Response(errBody, { status: 200, headers: { 'content-type': 'application/json' } });
		});
		const resp = await fetchImpl(a, { method: 'POST', body: '{}' });
		expect(await resp.text()).toBe(errBody);
	});

	it('fails over a 200 envelope missing both result and error (the StructError shape)', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		// `{jsonrpc,id}` with no result/error — what web3.js choked on with the
		// empty-`received:` StructError that 500'd the club-cover prepare step.
		const a = 'https://poison-noresult.example/sol';
		const b = 'https://healthy.example/sol';
		mockResponses({ [a]: { body: '{"jsonrpc":"2.0","id":1}' }, [b]: { body: json } });
		const resp = await makeRotatingFetch([a, b])(a, { method: 'POST', body: '{}' });
		expect(await resp.text()).toBe(json);
	});

	it('fails over a 200 + provider quota error (exhausted paid plan) to the next lane', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		// How an exhausted Helius plan answers: HTTP 200, JSON-RPC error -32429.
		const quota = '{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}';
		const a = 'https://exhausted.example/sol';
		const b = 'https://healthy.example/sol';
		mockResponses({ [a]: { body: quota }, [b]: { body: json } });
		const resp = await makeRotatingFetch([a, b])(a, { method: 'POST', body: '{}' });
		expect(await resp.text()).toBe(json);
	});

	it('fails over a truncated JSON body to the next lane', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const a = 'https://truncated.example/sol';
		const b = 'https://healthy.example/sol';
		mockResponses({ [a]: { body: '{"jsonrpc":"2.0","result":{"val' }, [b]: { body: json } });
		const resp = await makeRotatingFetch([a, b])(a, { method: 'POST', body: '{}' });
		expect(await resp.text()).toBe(json);
	});
});

// classifyRpcBody is the single source of truth for "is this 200 body usable?".
// It turns the recurring StructError (web3.js choking on a malformed 200) into a
// rotate signal instead of a thrown error reaching the caller.
describe('classifyRpcBody', () => {
	it('accepts a normal JSON-RPC success (result present, even when null)', () => {
		expect(classifyRpcBody('{"jsonrpc":"2.0","result":{"value":null},"id":1}')).toBeNull();
		expect(classifyRpcBody('{"jsonrpc":"2.0","result":null,"id":1}')).toBeNull();
		// Tatum omits the jsonrpc/id echo but carries `result` — still usable.
		expect(classifyRpcBody('{"result":{"context":{"slot":1},"value":null}}')).toBeNull();
	});

	it('accepts a deterministic JSON-RPC request error (must surface, not rotate)', () => {
		expect(classifyRpcBody('{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"},"id":1}')).toBeNull();
		expect(classifyRpcBody('{"jsonrpc":"2.0","error":{"code":-32002,"message":"Transaction simulation failed"},"id":1}')).toBeNull();
	});

	it('flags empty, HTML, and truncated bodies', () => {
		expect(classifyRpcBody('')?.reason).toBe('empty body');
		expect(classifyRpcBody('   ')?.reason).toBe('empty body');
		expect(classifyRpcBody('<!DOCTYPE html><html>502</html>')?.reason).toBe('HTML body');
		expect(classifyRpcBody('{"jsonrpc":"2.0","result":{')?.reason).toBe('unparseable body');
	});

	it('flags a 200 envelope missing both result and error', () => {
		expect(classifyRpcBody('{"jsonrpc":"2.0","id":1}')?.reason).toBe('missing result/error');
	});

	it('flags provider capacity/quota/auth errors for failover', () => {
		// Quota → status 429 so the cooldown picks the long quota park.
		const quota = classifyRpcBody('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}');
		expect(quota?.status).toBe(429);
		for (const [code, msg] of [
			[-32029, 'Too Many Requests'],
			[-32052, 'API key is not allowed'],
			[0, 'rate limit exceeded'],
			[0, 'forbidden'],
		]) {
			expect(classifyRpcBody(`{"jsonrpc":"2.0","error":{"code":${code},"message":"${msg}"},"id":1}`)).not.toBeNull();
		}
	});

	it('validates every element of a JSON-RPC batch', () => {
		const goodBatch = '[{"jsonrpc":"2.0","result":1,"id":1},{"jsonrpc":"2.0","result":2,"id":2}]';
		expect(classifyRpcBody(goodBatch)).toBeNull();
		const badBatch = '[{"jsonrpc":"2.0","result":1,"id":1},{"jsonrpc":"2.0","id":2}]';
		expect(classifyRpcBody(badBatch)?.reason).toBe('missing result/error');
	});
});
