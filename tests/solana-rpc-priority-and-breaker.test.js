import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
	solanaRpcEndpoints,
	markEndpointCooldown,
	isEndpointCooling,
	hydrateEndpointCooldowns,
	rpcLaneHealth,
	classifyRpcBody,
} from '../api/_lib/solana/connection.js';
import { cacheGet, cacheSet, cacheDel } from '../api/_lib/cache.js';

// Two production defects this file locks down, both found in the 2026-07-28
// triage sweep:
//
//  1. PRIORITY INVERSION. ~35 call sites spell their default as
//     `process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'`.
//     Because an explicit url is pinned at priority 1, unsetting SOLANA_RPC_URL
//     made the single most-throttled endpoint in the chain outrank Helius and
//     every paid lane at once.
//  2. PER-INSTANCE-ONLY BREAKER. The quota verdict lived in a process Map that
//     dies with each Cloud Run cold start, so every fresh instance re-burned a
//     request against a provider already over its cap — actively harmful on a
//     DAILY cap, where the wasted probes are what keep the account pinned.

const PUBLIC_MAINNET = 'https://api.mainnet-beta.solana.com';
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';
const COOLDOWN_CACHE_KEY = 'rpccool:v1';

const ENV_KEYS = [
	'SOLANA_RPC_URL',
	'SOLANA_RPC_URL_DEVNET',
	'QUICKNODE_RPC_URL',
	'QUICKNODE_RPC_URL_DEVNET',
	'HELIUS_API_KEY',
	'ALCHEMY_API_KEY',
	'ANKR_API_KEY',
	'DRPC_API_KEY',
	'SOLANA_RPC_FALLBACK_URLS',
	'SOLANA_RPC_FALLBACKS',
	'SOLANA_RPC_LAST_RESORT_URLS',
];

let saved;

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('endpoint priority — the public cluster default never outranks a real lane', () => {
	it('does not pin the public mainnet URL at priority 1', () => {
		process.env.HELIUS_API_KEY = 'k';
		const list = solanaRpcEndpoints('mainnet', PUBLIC_MAINNET);
		expect(list[0]).toBe('https://mainnet.helius-rpc.com/?api-key=k');
		expect(list[0]).not.toBe(PUBLIC_MAINNET);
	});

	it('keeps the public endpoint in the chain at its natural position, never drops it', () => {
		process.env.HELIUS_API_KEY = 'k';
		const list = solanaRpcEndpoints('mainnet', PUBLIC_MAINNET);
		expect(list).toContain(PUBLIC_MAINNET);
		expect(list.indexOf(PUBLIC_MAINNET)).toBeGreaterThan(0);
	});

	it('applies the same rule on devnet', () => {
		process.env.HELIUS_API_KEY = 'k';
		const list = solanaRpcEndpoints('devnet', PUBLIC_DEVNET);
		expect(list[0]).toBe('https://devnet.helius-rpc.com/?api-key=k');
		expect(list).toContain(PUBLIC_DEVNET);
	});

	it('still pins a genuinely explicit endpoint first', () => {
		process.env.HELIUS_API_KEY = 'k';
		const list = solanaRpcEndpoints('mainnet', 'https://my.private.rpc/x');
		expect(list[0]).toBe('https://my.private.rpc/x');
	});

	it('keeps a metered last-resort reserve dead last, behind every free lane', () => {
		process.env.HELIUS_API_KEY = 'k';
		process.env.SOLANA_RPC_LAST_RESORT_URLS = 'https://paid.quiknode.pro/abc';
		const list = solanaRpcEndpoints('mainnet', PUBLIC_MAINNET);
		expect(list[list.length - 1]).toBe('https://paid.quiknode.pro/abc');
		expect(list.indexOf('https://paid.quiknode.pro/abc')).toBeGreaterThan(
			list.indexOf(PUBLIC_MAINNET),
		);
	});

	it('regression: a reserve also named as the primary is NOT preserved as a reserve', () => {
		// The exact production misconfiguration. The same QuickNode URL sat in
		// SOLANA_RPC_URL, QUICKNODE_RPC_URL and SOLANA_RPC_LAST_RESORT_URLS; dedupe
		// keeps the FIRST occurrence, so the "insurance rung" absorbed 100% of
		// traffic and burned its daily cap. Naming it as primary must win the pin
		// (config says so), which is precisely why the config must not name it.
		const qn = 'https://paid.quiknode.pro/abc';
		process.env.HELIUS_API_KEY = 'k';
		process.env.SOLANA_RPC_URL = qn;
		process.env.SOLANA_RPC_LAST_RESORT_URLS = qn;
		const list = solanaRpcEndpoints('mainnet');
		expect(list[0]).toBe(qn);
		expect(list.filter((u) => u === qn)).toHaveLength(1);
		expect(list[list.length - 1]).not.toBe(qn);
	});
});

describe('endpoint breaker — quota verdicts are shared fleet-wide', () => {
	const url = 'https://quota-dead.example/rpc';

	afterEach(async () => {
		await cacheDel(COOLDOWN_CACHE_KEY).catch(() => {});
	});

	it('publishes a quota park so sibling instances can inherit it', async () => {
		markEndpointCooldown(url, 429, 'daily request limit reached - upgrade your account');
		// Publication is fire-and-forget; give the microtask queue a turn.
		await new Promise((r) => setTimeout(r, 25));
		const shared = await cacheGet(COOLDOWN_CACHE_KEY);
		expect(shared).toBeTruthy();
		expect(Number(shared[url])).toBeGreaterThan(Date.now());
	});

	it('picks the long quota window for a daily-cap signal, not the short 429 window', async () => {
		const ms = markEndpointCooldown(url, 429, 'daily request limit reached');
		expect(ms).toBeGreaterThanOrEqual(6 * 3_600_000);
	});

	it.each([
		['Alchemy monthly cap', 'Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.'],
		['Helius plan cap', 'max usage reached'],
		['QuickNode daily cap', 'daily request limit reached - upgrade your account'],
	])('parks %s for the quota window, never the 10m transient one', (_label, message) => {
		// Every paid provider words exhaustion differently. Asserting only "is
		// cooling" hid the Alchemy case: it matched no quota phrase, took the 10m
		// transient window, and re-entered rotation as the primary every 10 minutes.
		const ms = markEndpointCooldown(`https://${_label.replace(/\W+/g, '-')}.example/rpc`, 429, message);
		expect(ms).toBeGreaterThanOrEqual(6 * 3_600_000);
	});

	it('classifies an exhausted-plan JSON-RPC body as a capacity error so the rotation fails over', () => {
		// Alchemy reports its monthly cap as JSON-RPC code 429; QuickNode/Helius use
		// negative codes. All three must rotate rather than surface to the caller.
		for (const err of [
			{ code: 429, message: 'Monthly capacity limit exceeded.' },
			{ code: -32429, message: 'max usage reached' },
			{ code: -32003, message: 'daily request limit reached' },
		]) {
			const verdict = classifyRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 1, error: err }));
			expect(verdict, `code ${err.code} must rotate`).toBeTruthy();
		}
		// A deterministic method error must NOT rotate: every lane would fail it.
		expect(
			classifyRpcBody(
				JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }),
			),
		).toBeNull();
	});

	it.each([
		// Measured on the live free lanes 2026-07-30. The first is the dangerous one:
		// HTTP 200, so nothing rotates on status, and code -32010 is not a capacity
		// code, so it reached $THREE holder-gating callers as a hard error.
		['PublicNode getProgramAccounts (200)', { code: -32010, message: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA excluded from account secondary indexes; this RPC method unavailable for key' }],
		['PublicNode getTokenAccountsByOwner', { code: -32602, message: 'Request blocked. Details: blocked parameter: params.1.programId' }],
		['MagicBlock IP block', { code: 403, message: 'Your IP or provider is blocked from this endpoint' }],
	])('rotates past a provider POLICY block: %s', (_label, error) => {
		expect(classifyRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 1, error }))).toBeTruthy();
	});

	it('keeps a healthy lane after a 403 that refuses one call shape, not the key', () => {
		// PublicNode answers HTTP 403 to getTokenAccountsByOwner filtered by programId
		// while serving every other method. Sized as an auth failure it parked the node
		// for 30m, so the token/USDC balance readers evicted their own primary on
		// routine traffic and the rotation cascaded onto the exhausted paid lanes.
		const blocked = markEndpointCooldown(
			'https://policy-403.example/rpc',
			403,
			'{"code":-32602,"message":"Request blocked. Details: blocked parameter: params.1.programId"}',
		);
		expect(blocked).toBeLessThan(10 * 60_000);

		// A real credential failure must still park the endpoint for the auth window.
		const badKey = markEndpointCooldown(
			'https://bad-key.example/rpc',
			403,
			'{"error":"invalid api key"}',
		);
		expect(badKey).toBeGreaterThanOrEqual(30 * 60_000);
	});

	it('still refuses to rotate on a genuine invalid-params error', () => {
		// -32602 is shared between "you sent bad params" (deterministic, every lane
		// fails it) and PublicNode's policy block above. Only the phrasing separates
		// them, so the genuine case must stay non-rotating.
		expect(
			classifyRpcBody(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					error: { code: -32602, message: 'Invalid param: WrongSize' },
				}),
			),
		).toBeNull();
	});

	it('hydrate() adopts a sibling verdict for an endpoint this instance never tried', async () => {
		const unseen = 'https://never-tried-here.example/rpc';
		expect(isEndpointCooling(unseen)).toBe(false);
		await cacheSet(COOLDOWN_CACHE_KEY, { [unseen]: Date.now() + 3_600_000 }, 3600);
		// Force the interval guard open so this call actually reads through.
		await hydrateEndpointCooldowns(Date.now() + 10 * 60_000);
		expect(isEndpointCooling(unseen)).toBe(true);
	});

	it('never lets a stale shared entry resurrect an expired cooldown', async () => {
		const expired = 'https://already-recovered.example/rpc';
		await cacheSet(COOLDOWN_CACHE_KEY, { [expired]: Date.now() - 1000 }, 3600);
		await hydrateEndpointCooldowns(Date.now() + 20 * 60_000);
		expect(isEndpointCooling(expired)).toBe(false);
	});

	it('reports the whole paid tier going dark, the blind spot that hid three exhausted plans', () => {
		// The 2026-07-29 production state: Helius plan (-32429 max usage reached),
		// QuickNode daily cap (-32003) and Alchemy monthly cap (429) all exhausted
		// at once, with only the Helius sensor watching — and it read per-instance
		// memory, so a fresh instance still reported "premium RPC healthy".
		process.env.HELIUS_API_KEY = 'hk';
		process.env.ALCHEMY_API_KEY = 'ak';
		process.env.SOLANA_RPC_LAST_RESORT_URLS = 'https://paid.quiknode.pro/abc';

		const before = rpcLaneHealth();
		expect(before.paidTotal).toBe(3);
		expect(before.allPaidCooling).toBe(false);

		markEndpointCooldown('https://mainnet.helius-rpc.com/?api-key=hk', 429, 'max usage reached');
		markEndpointCooldown('https://solana-mainnet.g.alchemy.com/v2/ak', 429, 'Monthly capacity limit exceeded');
		markEndpointCooldown('https://paid.quiknode.pro/abc', 429, 'daily request limit reached');

		const after = rpcLaneHealth();
		expect(after.allPaidCooling).toBe(true);
		expect(after.paidCooling).toBe(after.paidTotal);
		// Free lanes must still be serving — degraded, never down.
		expect(after.total - after.cooling).toBeGreaterThan(0);
	});

	it('does not call a keyless deployment degraded — no paid lanes is a valid choice', () => {
		const h = rpcLaneHealth();
		expect(h.paidTotal).toBe(0);
		expect(h.allPaidCooling).toBe(false);
	});

	it('does not count a free node pinned as SOLANA_RPC_URL as paid capacity', () => {
		// Repointing SOLANA_RPC_URL at a keyless node is the standard mitigation
		// during a quota outage (applied 2026-07-30, when the Alchemy monthly cap,
		// the Helius plan and the QuickNode daily cap were all exhausted at once).
		// Judging "paid" by env-var provenance made that mitigation hide the very
		// outage it was mitigating: the free node counted as a healthy premium lane,
		// so allPaidCooling read false while every real paid lane was dark.
		process.env.HELIUS_API_KEY = 'hk';
		process.env.ALCHEMY_API_KEY = 'ak';
		process.env.SOLANA_RPC_URL = 'https://solana-rpc.publicnode.com';

		const health = rpcLaneHealth();
		expect(health.paidTotal).toBe(2);
		expect(health.lanes.find((l) => l.url.includes('publicnode')).paid).toBe(false);

		markEndpointCooldown('https://mainnet.helius-rpc.com/?api-key=hk', 429, 'max usage reached');
		markEndpointCooldown(
			'https://solana-mainnet.g.alchemy.com/v2/ak',
			429,
			'Monthly capacity limit exceeded',
		);

		const after = rpcLaneHealth();
		expect(after.allPaidCooling).toBe(true);
		// The pinned free lane is still serving, which is the point of the mitigation.
		expect(after.lanes.find((l) => l.url.includes('publicnode')).cooling).toBe(false);
	});

	it('masks credentials in every lane it reports', () => {
		process.env.HELIUS_API_KEY = 'super-secret-key';
		const h = rpcLaneHealth();
		expect(JSON.stringify(h.lanes)).not.toContain('super-secret-key');
	});

	it('a transient network blip stays local — it must not park the endpoint fleet-wide', async () => {
		await cacheDel(COOLDOWN_CACHE_KEY).catch(() => {});
		const blip = 'https://blippy.example/rpc';
		// 503 → SERVER_COOLDOWN_MS (2m), below the publish threshold.
		markEndpointCooldown(blip, 503, '');
		await new Promise((r) => setTimeout(r, 25));
		const shared = await cacheGet(COOLDOWN_CACHE_KEY);
		expect(shared?.[blip]).toBeUndefined();
	});
});
