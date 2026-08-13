// Handler tests for the four public /api/intel read endpoints:
//   GET /api/intel/heatmap        (live token field behind the 3D heatmap)
//   GET /api/intel/yields         (DeFiLlama yield pools)
//   GET /api/intel/smart-money    (coin + wallet reputation reads)
//   GET /api/intel/wallet/:addr   (one wallet's reputation card)
//
// Each endpoint gets its success path and one failure path. The upstreams
// (pump.fun, Dexscreener, DeFiLlama, the reputation graph) are the seams the
// handlers own, so those are stubbed here; the handler logic itself, including
// the anchor pinning, the flow pulse, address validation, and the 502/400
// boundaries, runs for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true })),
		mcpIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));

const getYieldPoolsMock = vi.fn();
vi.mock('../api/_lib/market-data.js', () => ({ getYieldPools: (...a) => getYieldPoolsMock(...a) }));

const getSmartMoneyForMintMock = vi.fn();
const getWalletReputationMock = vi.fn();
vi.mock('../api/_lib/smart-money.js', () => ({
	getSmartMoneyForMint: (...a) => getSmartMoneyForMintMock(...a),
	getWalletReputation: (...a) => getWalletReputationMock(...a),
}));

const { default: heatmapHandler, _resetHeatmapCache } = await import('../api/intel/heatmap.js');
const { default: yieldsHandler } = await import('../api/intel/yields.js');
const { default: smartMoneyHandler } = await import('../api/intel/smart-money.js');
const { default: walletHandler } = await import('../api/intel/wallet/[address].js');

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const OTHER_MINT = 'THREEsynthetic1111111111111111111111111111';
const WALLET = 'THREEsyntheticWa11et1111111111111111111111';

function mkReq({ method = 'GET', url = '/', headers = {} } = {}) {
	return { method, url, headers: { host: 'three.ws', ...headers }, socket: {}, on() {}, destroy() {} };
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

// One Dexscreener pair as the live API shapes it (only the fields the handler reads).
const pair = (mint, over = {}) => ({
	baseToken: { address: mint, symbol: 'sym', name: 'name' },
	priceUsd: '0.0016',
	priceChange: { h24: -4.03 },
	volume: { h24: 79088.64 },
	txns: { h24: { buys: 700, sells: 300 } },
	marketCap: 1625310,
	info: { imageUrl: 'https://cdn.example/img.png' },
	...over,
});

// Routes the handler's three upstream calls (pump trending, Dexscreener batch,
// pump coin metadata) off one table so a case can fail exactly one of them.
function stubUpstreams({ trending = [OTHER_MINT], pairs = null, meta = { symbol: 'three', name: 'three.ws' }, dexStatus = 200 } = {}) {
	const dexPairs = pairs ?? [pair(THREE_MINT), pair(OTHER_MINT)];
	vi.stubGlobal('fetch', vi.fn(async (input) => {
		const url = String(input);
		if (url.includes('/coins?') || /\/coins\?/.test(url)) {
			return new Response(JSON.stringify(trending.map((mint) => ({ mint }))), { status: 200 });
		}
		if (url.includes('/latest/dex/tokens/')) {
			if (dexStatus !== 200) return new Response('upstream down', { status: dexStatus });
			return new Response(JSON.stringify({ pairs: dexPairs }), { status: 200 });
		}
		if (url.includes('/coins/')) {
			return new Response(JSON.stringify(meta ?? { error: 'not found' }), { status: 200 });
		}
		return new Response('not found', { status: 404 });
	}));
}

beforeEach(() => {
	vi.unstubAllGlobals();
	_resetHeatmapCache();
	getYieldPoolsMock.mockReset();
	getSmartMoneyForMintMock.mockReset();
	getWalletReputationMock.mockReset();
});

describe('GET /api/intel/heatmap', () => {
	it('pins $THREE first, flags it featured, and folds in its 24h order flow', async () => {
		stubUpstreams();
		const res = mkRes();
		await heatmapHandler(mkReq({ url: '/api/intel/heatmap?limit=5' }), res);

		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.ok).toBe(true);
		expect(body.anchor).toBe(THREE_MINT);
		expect(body.tokens[0].id).toBe(THREE_MINT);
		expect(body.tokens[0].featured).toBe(true);
		// 700 buys / 300 sells => 70% buys, score +0.4.
		expect(body.tokens[0].flow).toEqual({ buys24h: 700, sells24h: 300, buyPct: 70, score: 0.4 });
		// The flow pulse is an anchor-only enrichment.
		expect(body.tokens[1].featured).toBe(false);
		expect(body.tokens[1].flow).toBeUndefined();
	});

	it('keeps the field alive with no anchor trade history (flow omitted, tile still served)', async () => {
		stubUpstreams({ pairs: [pair(THREE_MINT, { txns: { h24: { buys: 0, sells: 0 } } }), pair(OTHER_MINT)] });
		const res = mkRes();
		await heatmapHandler(mkReq({ url: '/api/intel/heatmap?limit=5' }), res);

		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.tokens[0].id).toBe(THREE_MINT);
		expect(body.tokens[0].flow).toBeUndefined();
	});

	it('502s with a JSON error when every market upstream is down', async () => {
		stubUpstreams({ trending: [], pairs: [], dexStatus: 503, meta: null });
		const res = mkRes();
		await heatmapHandler(mkReq({ url: '/api/intel/heatmap' }), res);

		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('upstream_error');
	});

	it('rejects a non-GET method', async () => {
		stubUpstreams();
		const res = mkRes();
		await heatmapHandler(mkReq({ method: 'POST', url: '/api/intel/heatmap' }), res);
		expect(res.statusCode).toBe(405);
	});
});

describe('GET /api/intel/yields', () => {
	it('returns live pools and strips the upstream ilRisk field', async () => {
		getYieldPoolsMock.mockResolvedValue([
			{ pool: 'p1', project: 'lido', chain: 'Ethereum', symbol: 'STETH', tvlUsd: 1e9, apy: 2.1, apyBase: 2.1, apyReward: 0, stablecoin: false, ilRisk: 'no' },
		]);
		const res = mkRes();
		await yieldsHandler(mkReq({ url: '/api/intel/yields?chain=Ethereum&stablecoin=false&limit=1' }), res);

		expect(res.statusCode).toBe(200);
		expect(getYieldPoolsMock).toHaveBeenCalledWith({ chain: 'Ethereum', project: undefined, stablecoin: false, limit: 1 });
		const body = parse(res);
		expect(body.pools).toHaveLength(1);
		expect(body.pools[0].project).toBe('lido');
		expect(body.pools[0]).not.toHaveProperty('ilRisk');
	});

	it('clamps a junk limit to the default and an oversized one to the max', async () => {
		getYieldPoolsMock.mockResolvedValue([]);
		await yieldsHandler(mkReq({ url: '/api/intel/yields?limit=abc' }), mkRes());
		expect(getYieldPoolsMock.mock.calls[0][0].limit).toBe(25);

		await yieldsHandler(mkReq({ url: '/api/intel/yields?limit=99999' }), mkRes());
		expect(getYieldPoolsMock.mock.calls[1][0].limit).toBe(100);
	});

	it('502s with a JSON error when DeFiLlama is unreachable', async () => {
		getYieldPoolsMock.mockRejectedValue(new Error('llama down'));
		const res = mkRes();
		await yieldsHandler(mkReq({ url: '/api/intel/yields' }), res);

		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('upstream_error');
	});
});

describe('GET /api/intel/smart-money', () => {
	it('serves a coin read for a valid mint', async () => {
		getSmartMoneyForMintMock.mockResolvedValue({ mint: THREE_MINT, network: 'mainnet', smart_money_score: 42, computed: true });
		const res = mkRes();
		await smartMoneyHandler(mkReq({ url: `/api/intel/smart-money?mint=${THREE_MINT}` }), res);

		expect(res.statusCode).toBe(200);
		expect(getSmartMoneyForMintMock).toHaveBeenCalledWith(THREE_MINT, 'mainnet');
		expect(parse(res).smart_money_score).toBe(42);
	});

	it('serves a wallet read and honours the devnet network param', async () => {
		getWalletReputationMock.mockResolvedValue({ address: WALLET, network: 'devnet', computed: false });
		const res = mkRes();
		await smartMoneyHandler(mkReq({ url: `/api/intel/smart-money?wallet=${WALLET}&network=devnet` }), res);

		expect(res.statusCode).toBe(200);
		expect(getWalletReputationMock).toHaveBeenCalledWith(WALLET, 'devnet');
	});

	it('400s when neither mint nor wallet is supplied', async () => {
		const res = mkRes();
		await smartMoneyHandler(mkReq({ url: '/api/intel/smart-money' }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('bad_request');
	});

	it('400s on a non-base58 address instead of querying the graph with junk', async () => {
		const bad = mkRes();
		await smartMoneyHandler(mkReq({ url: '/api/intel/smart-money?wallet=%3Cscript%3E' }), bad);
		expect(bad.statusCode).toBe(400);

		const badMint = mkRes();
		await smartMoneyHandler(mkReq({ url: '/api/intel/smart-money?mint=not-a-mint' }), badMint);
		expect(badMint.statusCode).toBe(400);

		expect(getWalletReputationMock).not.toHaveBeenCalled();
		expect(getSmartMoneyForMintMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/intel/wallet/:address', () => {
	it('reads the address from the path when no query param is injected', async () => {
		getWalletReputationMock.mockResolvedValue({ address: WALLET, network: 'mainnet', computed: false });
		const res = mkRes();
		await walletHandler(mkReq({ url: `/api/intel/wallet/${WALLET}` }), res);

		expect(res.statusCode).toBe(200);
		expect(getWalletReputationMock).toHaveBeenCalledWith(WALLET, 'mainnet');
		expect(parse(res).computed).toBe(false);
	});

	it('prefers the injected address query param (the routed shape)', async () => {
		getWalletReputationMock.mockResolvedValue({ address: WALLET, network: 'mainnet', computed: true });
		const res = mkRes();
		await walletHandler(mkReq({ url: `/api/intel/wallet/[address]?address=${WALLET}` }), res);

		expect(res.statusCode).toBe(200);
		expect(getWalletReputationMock).toHaveBeenCalledWith(WALLET, 'mainnet');
	});

	it('400s on a malformed address', async () => {
		const res = mkRes();
		await walletHandler(mkReq({ url: '/api/intel/wallet/xyz' }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('bad_request');
		expect(getWalletReputationMock).not.toHaveBeenCalled();
	});
});
