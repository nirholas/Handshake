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
	Keypair: { generate: () => ({ publicKey: { toBase58: () => 'mocked' }, secretKey: new Uint8Array(64) }) },
	Connection: class {},
	PublicKey: class {
		constructor(s) { this._s = s; }
		toBase58() { return String(this._s); }
		toString() { return String(this._s); }
		toBuffer() { return Buffer.alloc(32); }
	},
}));
vi.mock('../../src/solana/sns.js', () => ({
	resolveSnsName: vi.fn(async () => null),
	reverseLookupAddress: vi.fn(async () => null),
}));
vi.mock('../../src/pump/vanity-keygen.js', () => ({
	generateVanityKey: vi.fn(async () => ({ publicKey: 'mocked', secretKey: 'mocked' })),
}));

vi.setConfig({ testTimeout: 15_000, hookTimeout: 60_000 });

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

// Mock the upstream pumpfun-claims-bot client.
vi.mock('../../api/_lib/pumpfun-mcp.js', () => ({
	pumpfunBotEnabled: vi.fn(() => false),
	pumpfunMcp: { creatorIntel: vi.fn(), recentClaims: vi.fn(), graduations: vi.fn() },
}));

// ── helpers ────────────────────────────────────────────────────────────────
function makeReq(body) {
	const stream = body
		? Readable.from([Buffer.from(JSON.stringify(body))])
		: Readable.from([]);
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
beforeAll(async () => {
	const mod = await import('../../api/pump-fun-mcp.js');
	handlerRef = mod.default;
}, 60_000);

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
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('initialize', () => {
	it('returns server info and protocol version', async () => {
		const { res, json } = await call({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(res.statusCode).toBe(200);
		expect(json.result.protocolVersion).toBeDefined();
		expect(json.result.serverInfo.name).toBe('three.ws-pumpfun-mcp');
	});
});

describe('tools/list', () => {
	it('returns all 22 declared tools with schemas', async () => {
		const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(Array.isArray(json.result.tools)).toBe(true);
		expect(json.result.tools).toHaveLength(22);
		const names = json.result.tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				'getBondingCurve',
				'getCreatorProfile',
				'getGraduatedTokens',
				'getKingOfTheHill',
				'getNewTokens',
				'getTokenDetails',
				'getTokenHolders',
				'getTokenTrades',
				'getTrendingTokens',
				'kol_leaderboard',
				'kol_radar',
				'pumpfun_first_claims',
				'pumpfun_list_claims',
				'pumpfun_quote_swap',
				'pumpfun_vanity_mint',
				'pumpfun_watch_claims',
				'pumpfun_watch_whales',
				'searchTokens',
				'sns_resolve',
				'sns_reverseLookup',
				'social_cashtag_sentiment',
				'social_x_post_impact',
			].sort(),
		);
		for (const t of json.result.tools) expect(t.inputSchema.type).toBe('object');
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
			params: { name: 'getTrendingTokens', arguments: { limit: 5 } },
		});
		expect(json.error.code).toBe(-32004);
		expect(json.error.message).toMatch(/indexer/i);
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
