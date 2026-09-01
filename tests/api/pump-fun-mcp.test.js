// Tests for /api/pump-fun-mcp — the in-house JSON-RPC route serving the
// pump-fun skill. SDKs and Solana RPC are mocked; the test focuses on the
// route's contract: JSON-RPC envelope, tool dispatch, on-chain reads, and
// the indexer-not-configured error path (no fabricated payloads).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// Cold-import of /api/pump-fun-mcp transitively pulls @solana/web3.js (via
// src/solana/sns.js and src/pump/vanity-keygen.js), which on a fresh
// Codespace under contention can exceed 2 minutes. None of these tests
// actually call SNS or vanity-keygen, so we mock both upstream modules with
// the minimum surface the handler touches at *call time* — the routes that
// would invoke them aren't exercised here.
vi.mock('@solana/web3.js', () => ({
	Keypair: {
		generate: () => ({
			publicKey: { toBase58: () => 'mocked' },
			secretKey: new Uint8Array(64),
		}),
	},
	Connection: class {},
	PublicKey: class {
		constructor(s) {
			this._s = s;
		}
		toBase58() {
			return String(this._s);
		}
		toString() {
			return String(this._s);
		}
		toBuffer() {
			return Buffer.alloc(32);
		}
	},
}));
vi.mock('../../src/solana/sns.js', () => ({
	resolveSnsName: vi.fn(async () => null),
	reverseLookupAddress: vi.fn(async () => null),
}));
vi.mock('../../src/pump/vanity-keygen.js', () => ({
	generateVanityKey: vi.fn(async () => ({ publicKey: 'mocked', secretKey: 'mocked' })),
}));

// hookTimeout matches the global 120s calibration in vitest.config.js: the
// beforeAll cold-imports api/pump-fun-mcp.js, which pulls the heavy Solana SDK
// graph and has been measured past 60s under full-suite fork contention.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 120_000 });

// Mock rate-limit + clientIp so the route never blocks on Upstash.
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// Mock the pump.js SDK adapter — we exercise the route, not Solana.
const sdkMock = {
	fetchBuyState: vi.fn(),
	fetchBondingCurve: vi.fn(),
	fetchGlobal: vi.fn(),
};
const connectionMock = {
	getAccountInfo: vi.fn(),
	getTokenLargestAccounts: vi.fn(),
};
vi.mock('../../api/_lib/pump.js', () => ({
	getPumpSdk: vi.fn(async () => ({ sdk: sdkMock, BN: function () {}, web3: {} })),
	getConnection: vi.fn(() => connectionMock),
	solanaPubkey: vi.fn((s) => {
		if (!s || s === 'bad') return null;
		return { toString: () => s, toBuffer: () => Buffer.alloc(32) };
	}),
}));

// Mock the upstream pumpfun-claims-bot client. pumpfunBotEnabled defaults to
// false (no indexer); individual tests toggle it to exercise the configured
// path — the route calls it fresh per request, so toggling between calls works.
vi.mock('../../api/_lib/pumpfun-mcp.js', () => ({
	pumpfunBotEnabled: vi.fn(() => false),
	pumpfunMcp: { creatorIntel: vi.fn(), recentClaims: vi.fn(), graduations: vi.fn() },
}));
import { pumpfunBotEnabled } from '../../api/_lib/pumpfun-mcp.js';

// The live pump.fun feed rung under get_trending_tokens / get_new_tokens. Each
// test sets what the feed answers; `data: null` means every rung is down.
vi.mock('../../api/_lib/pump-trending.js', () => ({
	getTrendingSlim: vi.fn(async () => ({ data: null, stale: false })),
	getNewSlim: vi.fn(async () => ({ data: null, stale: false })),
}));
import { getTrendingSlim, getNewSlim } from '../../api/_lib/pump-trending.js';

// ── helpers ────────────────────────────────────────────────────────────────
function makeReq(body) {
	const stream = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	stream.method = 'POST';
	stream.url = '/api/pump-fun-mcp';
	stream.headers = { host: 'localhost', 'content-type': 'application/json' };
	return stream;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}
let handlerRef;
// No explicit hook timeout: this cold-imports api/pump-fun-mcp.js, which pulls the
// heavy Solana SDK graph. Under full-suite fork contention that import has been
// measured well past 60s, so we inherit the global 120s hookTimeout (calibrated in
// vitest.config.js to clear the worst-case cold import) rather than capping at 60s.
beforeAll(async () => {
	const mod = await import('../../api/pump-fun-mcp.js');
	handlerRef = mod.default;
});

async function call(rpc) {
	const res = makeRes();
	await handlerRef(makeReq(rpc), res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	sdkMock.fetchBuyState.mockReset();
	sdkMock.fetchBondingCurve.mockReset();
	connectionMock.getAccountInfo.mockReset();
	connectionMock.getTokenLargestAccounts.mockReset();
	// Default to the unconfigured-indexer state; tests that exercise the
	// configured path opt in explicitly. Reset here so a toggle can't leak across
	// tests (the route reads pumpfunBotEnabled() fresh on every request).
	pumpfunBotEnabled.mockReturnValue(false);
});

// ── Tests ──────────────────────────────────────────────────────────────────

// The four discovery tools that require the external indexer (PUMPFUN_BOT_URL).
// get_trending_tokens and get_new_tokens are NOT here: they fall through to the
// live pump.fun feed and stay advertised without the indexer.
const INDEXER_TOOL_NAMES = [
	'search_tokens',
	'get_graduated_tokens',
	'get_king_of_the_hill',
	'get_creator_profile',
];
const LIVE_FEED_TOOL_NAMES = ['get_trending_tokens', 'get_new_tokens'];

describe('initialize', () => {
	it('returns server info, protocol version, and indexerEnabled flag', async () => {
		pumpfunBotEnabled.mockReturnValue(false);
		const { res, json } = await call({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(res.statusCode).toBe(200);
		expect(json.result.protocolVersion).toBeDefined();
		expect(json.result.serverInfo.name).toBe('three.ws-pumpfun-mcp');
		// indexerEnabled tracks PUMPFUN_BOT_URL presence — false when unconfigured.
		expect(json.result.serverInfo.indexerEnabled).toBe(false);
	});

	it('reports indexerEnabled true when the bot is configured', async () => {
		pumpfunBotEnabled.mockReturnValue(true);
		const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(json.result.serverInfo.indexerEnabled).toBe(true);
	});
});

describe('tools/list', () => {
	it('excludes the four indexer-only tools (keeps pumpfun_bot_status and the live-feed tools) when unconfigured', async () => {
		pumpfunBotEnabled.mockReturnValue(false);
		const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(Array.isArray(json.result.tools)).toBe(true);
		const names = json.result.tools.map((t) => t.name);
		// None of the indexer-only discovery tools are advertised…
		for (const n of INDEXER_TOOL_NAMES) expect(names).not.toContain(n);
		// …but the always-on metadata tool and the live-feed discovery tools are.
		expect(names).toContain('pumpfun_bot_status');
		for (const n of LIVE_FEED_TOOL_NAMES) expect(names).toContain(n);
		// 25 total declared − 4 indexer-only tools = 21 advertised.
		expect(json.result.tools).toHaveLength(21);
		for (const t of json.result.tools) expect(t.inputSchema.type).toBe('object');
	});

	it('advertises all 25 tools (incl. indexer tools) when the bot is configured', async () => {
		pumpfunBotEnabled.mockReturnValue(true);
		const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(json.result.tools).toHaveLength(25);
		const names = json.result.tools.map((t) => t.name);
		for (const n of INDEXER_TOOL_NAMES) expect(names).toContain(n);
		expect(names).toContain('pumpfun_bot_status');
	});
});

describe('tools/call getBondingCurve', () => {
	it('returns curve data from on-chain fetchBuyState', async () => {
		sdkMock.fetchBuyState.mockResolvedValueOnce({
			bondingCurve: {
				realSolReserves: { toString: () => '50000000000' }, // 50 SOL
				realTokenReserves: { toString: () => '500000000' },
				virtualSolReserves: { toString: () => '30000000000' },
				virtualTokenReserves: { toString: () => '1073000000' },
				complete: false,
			},
		});
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'getBondingCurve', arguments: { mint: 'Mint1', network: 'mainnet' } },
		});
		expect(json.error).toBeUndefined();
		const data = json.result.structuredContent;
		expect(data.complete).toBe(false);
		expect(data.solReserves).toBe('50.0000');
		expect(data.graduationPercent).toBeGreaterThan(0);
		expect(data.graduationPercent).toBeLessThan(100);
	});

	it('returns rpc error -32602 on invalid mint', async () => {
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'getBondingCurve', arguments: { mint: 'bad' } },
		});
		expect(json.error.code).toBe(-32602);
	});
});

describe('tools/call getTokenHolders', () => {
	it('returns concentration analysis from getTokenLargestAccounts', async () => {
		connectionMock.getTokenLargestAccounts.mockResolvedValueOnce({
			value: [
				{ address: { toString: () => 'A' }, amount: '5000000', uiAmount: 50 },
				{ address: { toString: () => 'B' }, amount: '3000000', uiAmount: 30 },
				{ address: { toString: () => 'C' }, amount: '2000000', uiAmount: 20 },
			],
		});
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'getTokenHolders', arguments: { mint: 'M', limit: 3 } },
		});
		const data = json.result.structuredContent;
		expect(data.count).toBe(3);
		expect(data.topHolderPercent).toBeCloseTo(50);
		expect(data.holders[0].percent).toBeCloseTo(50);
	});
});

describe('tools/call indexer-required tools', () => {
	it('returns -32004 when PUMPFUN_BOT_URL is not configured', async () => {
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'searchTokens', arguments: { query: 'three', limit: 5 } },
		});
		expect(json.error.code).toBe(-32004);
		expect(json.error.message).toMatch(/indexer/i);
	});
});

describe('tools/call live-feed discovery tools', () => {
	const row = (mint, i) => ({
		mint,
		symbol: `S${i}`,
		name: `Coin ${i}`,
		logo: null,
		price_usd: null,
		usd_market_cap: 1000 * (i + 1),
		rank: i + 1,
	});

	it('getTrendingTokens answers from the live pump.fun feed without the indexer', async () => {
		pumpfunBotEnabled.mockReturnValue(false);
		getTrendingSlim.mockResolvedValueOnce({
			data: ['THREEsynthetic1111111111111111111111111111', 'THREEsynthetic2222222222222222222222222222'].map(row),
			stale: false,
		});
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'getTrendingTokens', arguments: { limit: 5 } },
		});
		expect(json.error).toBeUndefined();
		expect(getTrendingSlim).toHaveBeenCalledWith(5);
		const data = json.result.structuredContent;
		expect(data.source).toBe('pump.fun');
		expect(data.stale).toBe(false);
		expect(data.tokens.map((t) => t.mint)).toEqual([
			'THREEsynthetic1111111111111111111111111111',
			'THREEsynthetic2222222222222222222222222222',
		]);
	});

	it('get_new_tokens clamps the limit and flags a stale feed', async () => {
		pumpfunBotEnabled.mockReturnValue(false);
		getNewSlim.mockResolvedValueOnce({ data: [row('THREEsynthetic3333333333333333333333333333', 0)], stale: true });
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'get_new_tokens', arguments: { limit: 500 } },
		});
		expect(getNewSlim).toHaveBeenCalledWith(50);
		expect(json.result.structuredContent.stale).toBe(true);
		expect(json.result.structuredContent.tokens).toHaveLength(1);
	});

	it('returns -32004 only when every live rung is down', async () => {
		pumpfunBotEnabled.mockReturnValue(false);
		getNewSlim.mockResolvedValueOnce({ data: null, stale: false });
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'getNewTokens', arguments: { limit: 5 } },
		});
		expect(json.error.code).toBe(-32004);
		expect(json.error.message).toMatch(/pump\.fun/i);
	});
});

describe('tools/call pumpfun_bot_status', () => {
	it('reports unconfigured + unhealthy with a message when the bot is unset', async () => {
		pumpfunBotEnabled.mockReturnValue(false);
		const { res, json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'pumpfun_bot_status', arguments: {} },
		});
		// Always available — never gated, never an error envelope.
		expect(res.statusCode).toBe(200);
		expect(json.error).toBeUndefined();
		const data = json.result.structuredContent;
		expect(data.configured).toBe(false);
		expect(data.healthy).toBe(false);
		expect(data.message).toMatch(/PUMPFUN_BOT_URL/);
	});

	it('stays listed even when indexer tools are filtered out', async () => {
		pumpfunBotEnabled.mockReturnValue(false);
		const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(json.result.tools.map((t) => t.name)).toContain('pumpfun_bot_status');
	});
});

describe('auth gate on expensive/sensitive tools', () => {
	it('pumpfun_vanity_mint without a bearer or X-PAYMENT is rejected (does NOT return a secret key)', async () => {
		const { res, json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'pumpfun_vanity_mint', arguments: { suffix: 'aa' } },
		});
		// Bare callers (no MCP protocol headers) get a proper 402 Payment
		// Required carrying the x402 envelope (JSON-RPC code -32402).
		expect(res.statusCode).toBe(402);
		expect(json.error).toBeDefined();
		expect(json.error.code).toBe(-32402);
		// Critically: no secret key (or any result) is produced for an anon caller.
		expect(json.result).toBeUndefined();
	});

	it('pumpfun_watch_whales without auth is rejected', async () => {
		const { res, json } = await call({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'pumpfun_watch_whales', arguments: { mint: 'M' } },
		});
		expect(res.statusCode).toBe(402);
		expect(json.error.code).toBe(-32402);
	});

	it('pumpfun_watch_claims without auth is rejected', async () => {
		const { res, json } = await call({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'pumpfun_watch_claims', arguments: { creator: 'C' } },
		});
		expect(res.statusCode).toBe(402);
		expect(json.error.code).toBe(-32402);
	});

	it('free read-only tools stay open (no auth needed)', async () => {
		// getTokenHolders is a cheap on-chain read — must not be gated.
		connectionMock.getTokenLargestAccounts.mockResolvedValueOnce({
			value: [{ address: { toString: () => 'A' }, amount: '1', uiAmount: 1 }],
		});
		const { res, json } = await call({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'getTokenHolders', arguments: { mint: 'M', limit: 1 } },
		});
		expect(res.statusCode).toBe(200);
		expect(json.error).toBeUndefined();
		expect(json.result.structuredContent.count).toBe(1);
	});
});

describe('unknown methods/tools', () => {
	it('returns -32601 for unknown method', async () => {
		const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'tools/eat' });
		expect(json.error.code).toBe(-32601);
	});

	it('returns -32601 for unknown tool', async () => {
		const { json } = await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'mintInfiniteUSDC', arguments: {} },
		});
		expect(json.error.code).toBe(-32601);
	});
});
