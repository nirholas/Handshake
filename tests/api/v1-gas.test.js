// GET /api/v1/gas + api/_lib/gas-oracles.js: keyless-first EVM gas oracle chain.
//
// The oracle chain tries Blocknative → Owlracle → Etherscan V2 (mainnet only),
// skipping rungs that do not serve the requested chain, each rung failing soft
// on its own timeout. These tests exercise the REAL provider mappers against
// captured live response shapes (Owlracle and Etherscan bodies captured from
// the real APIs on 2026-08-05; Blocknative per its documented blockprices
// contract) with fetch stubbed at the boundary (no test opens a socket), plus
// the endpoint contract: envelope, defaults, discovery, 400/429/503 paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// ── Captured / documented provider fixtures ─────────────────────────────────

// Blocknative blockprices: documented response shape (docs.blocknative.com),
// values in line with the live mainnet capture window below.
const BLOCKNATIVE_MAINNET = {
	system: 'ethereum',
	network: 'main',
	unit: 'gwei',
	maxPrice: 2,
	currentBlockNumber: 25692165,
	msSinceLastBlock: 4000,
	blockPrices: [
		{
			blockNumber: 25692166,
			estimatedTransactionCount: 120,
			baseFeePerGas: 0.104899732,
			estimatedPrices: [
				{ confidence: 99, price: 0.34, maxPriorityFeePerGas: 0.228996727, maxFeePerGas: 0.371189757 },
				{ confidence: 95, price: 0.14, maxPriorityFeePerGas: 0.0105, maxFeePerGas: 0.142193 },
				{ confidence: 90, price: 0.13, maxPriorityFeePerGas: 0.008663652, maxFeePerGas: 0.131942596 },
				{ confidence: 80, price: 0.12, maxPriorityFeePerGas: 0.006105707, maxFeePerGas: 0.117328939 },
				{ confidence: 70, price: 0.11, maxPriorityFeePerGas: 0.005870803, maxFeePerGas: 0.110770535 },
			],
		},
	],
};

// Owlracle /v4/base/gas: captured live 2026-08-05. speeds ascend by
// acceptance: slow → standard → fast → instant.
const OWLRACLE_BASE = {
	timestamp: '2026-08-05T23:59:00.913Z',
	avgTime: 2,
	avgTx: 130.31,
	avgGas: 177672.5452001389,
	speeds: [
		{ acceptance: 0.37, maxFeePerGas: 0.005500004, maxPriorityFeePerGas: 0.000500004, baseFee: 0.005, estimatedFee: 0.0018631094217399296 },
		{ acceptance: 0.62, maxFeePerGas: 0.005500011, maxPriorityFeePerGas: 0.000500011, baseFee: 0.005, estimatedFee: 0.0018631117929683782 },
		{ acceptance: 0.955, maxFeePerGas: 0.00575, maxPriorityFeePerGas: 0.00075, baseFee: 0.005, estimatedFee: 0.0019477947970591649 },
		{ acceptance: 1, maxFeePerGas: 0.006, maxPriorityFeePerGas: 0.000981067, baseFee: 0.005018933, estimatedFee: 0.002032481527366085 },
	],
};

// Etherscan V2 gastracker gasoracle: captured live 2026-08-05 (chainid=1).
const ETHERSCAN_MAINNET = {
	status: '1',
	message: 'OK',
	result: {
		LastBlock: '25692166',
		SafeGasPrice: '0.11201434',
		ProposeGasPrice: '0.112059969',
		FastGasPrice: '0.123265965',
		suggestBaseFee: '0.111877452',
		gasUsedRatio: '0.68,0.18,0.75,0.35,0.20',
	},
};

const jsonResponse = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
});

// Route a stubbed fetch by provider host. Records every call for assertions.
function providerFetch(routes) {
	const calls = [];
	const impl = async (url, opts = {}) => {
		calls.push({ url: String(url), opts });
		for (const [needle, responder] of Object.entries(routes)) {
			if (String(url).includes(needle)) return responder(String(url), opts);
		}
		throw new Error(`unrouted fetch: ${url}`);
	};
	impl.calls = calls;
	return impl;
}

const refused = () => Promise.reject(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));

beforeEach(() => {
	// The vitest setup loader pulls .env into process.env; pin every provider
	// key to a known state so URL/header assertions are deterministic.
	vi.stubEnv('BLOCKNATIVE_API_KEY', '');
	vi.stubEnv('OWLRACLE_API_KEY', '');
	vi.stubEnv('ETHERSCAN_API_KEY', '');
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ── Chain resolution + registry ─────────────────────────────────────────────

describe('gas-oracles: chain resolution', () => {
	it('resolves names, aliases, numeric chainIds, and eip155 prefixes', async () => {
		const { resolveGasChain } = await import('../../api/_lib/gas-oracles.js');
		expect(resolveGasChain('ethereum')).toBe('ethereum');
		expect(resolveGasChain('eth')).toBe('ethereum');
		expect(resolveGasChain(' ETH ')).toBe('ethereum');
		expect(resolveGasChain('1')).toBe('ethereum');
		expect(resolveGasChain('8453')).toBe('base');
		expect(resolveGasChain('eip155:137')).toBe('polygon');
		expect(resolveGasChain('bnb')).toBe('bsc');
		expect(resolveGasChain('matic')).toBe('polygon');
		expect(resolveGasChain('op')).toBe('optimism');
		expect(resolveGasChain(42161)).toBe('arbitrum');
		expect(resolveGasChain('dogecoin')).toBe(null);
		expect(resolveGasChain('')).toBe(null);
		expect(resolveGasChain(undefined)).toBe(null);
	});

	it('declares chain-appropriate rungs: Etherscan mainnet-only, Owlracle everywhere', async () => {
		const { listGasChains } = await import('../../api/_lib/gas-oracles.js');
		const chains = listGasChains();
		const byName = Object.fromEntries(chains.map((c) => [c.chain, c]));

		expect(byName.ethereum.sources).toEqual(['blocknative', 'owlracle', 'etherscan']);
		expect(byName.base.sources).toEqual(['blocknative', 'owlracle']);
		expect(byName.fantom.sources).toEqual(['owlracle']);
		// The Etherscan gastracker rung serves Ethereum mainnet only.
		const withEtherscan = chains.filter((c) => c.sources.includes('etherscan'));
		expect(withEtherscan.map((c) => c.chain)).toEqual(['ethereum']);
		// Every chain keeps at least one keyless rung.
		for (const c of chains) expect(c.sources.length).toBeGreaterThan(0);
	});
});

// ── Provider mappers (real parsers, captured shapes) ────────────────────────

describe('gas-oracles: Blocknative rung', () => {
	it('maps blockprices to normalized tiers (fast=highest confidence, safe=lowest)', async () => {
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({
			'api.blocknative.com': () => jsonResponse(BLOCKNATIVE_MAINNET),
		});
		const est = await getGasEstimate('ethereum', { fetchImpl });

		expect(est.source).toBe('blocknative');
		expect(est.chain).toBe('ethereum');
		expect(est.chainId).toBe(1);
		expect(est.unit).toBe('gwei');
		expect(est.baseFee).toBe(0.1049);
		expect(est.tiers.fast).toEqual({ maxFeePerGas: 0.3712, maxPriorityFeePerGas: 0.229 });
		expect(est.tiers.standard).toEqual({ maxFeePerGas: 0.1319, maxPriorityFeePerGas: 0.0087 });
		expect(est.tiers.safe).toEqual({ maxFeePerGas: 0.1108, maxPriorityFeePerGas: 0.0059 });
		expect(typeof est.ts).toBe('number');

		// Keyless call: chainid in the query, NO Authorization header.
		const call = fetchImpl.calls[0];
		expect(call.url).toContain('gasprices/blockprices?chainid=1');
		expect(call.opts.headers.authorization).toBeUndefined();
	});

	it('sends BLOCKNATIVE_API_KEY as a raw Authorization header when configured', async () => {
		vi.stubEnv('BLOCKNATIVE_API_KEY', 'bn-test-key');
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({
			'api.blocknative.com': () => jsonResponse(BLOCKNATIVE_MAINNET),
		});
		await getGasEstimate('base', { fetchImpl });
		expect(fetchImpl.calls[0].url).toContain('chainid=8453');
		expect(fetchImpl.calls[0].opts.headers.authorization).toBe('bn-test-key');
	});
});

describe('gas-oracles: Owlracle rung', () => {
	it('falls through to Owlracle when Blocknative is unreachable, skipping the instant tier', async () => {
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({
			'api.blocknative.com': refused,
			'api.owlracle.info': () => jsonResponse(OWLRACLE_BASE),
		});
		const est = await getGasEstimate('base', { fetchImpl });

		expect(est.source).toBe('owlracle');
		expect(est.chain).toBe('base');
		expect(est.chainId).toBe(8453);
		expect(est.baseFee).toBe(0.005);
		expect(est.tiers.safe).toEqual({ maxFeePerGas: 0.0055, maxPriorityFeePerGas: 0.0005 });
		expect(est.tiers.standard).toEqual({ maxFeePerGas: 0.0055, maxPriorityFeePerGas: 0.0005 });
		expect(est.tiers.fast).toEqual({ maxFeePerGas: 0.0058, maxPriorityFeePerGas: 0.0008 });

		// Keyless guest path: /v4/<network>/gas with no apikey param.
		const owl = fetchImpl.calls.find((c) => c.url.includes('owlracle'));
		expect(owl.url).toContain('/v4/base/gas');
		expect(owl.url).not.toContain('apikey');
	});

	it('appends OWLRACLE_API_KEY as the documented apikey query param when configured', async () => {
		vi.stubEnv('OWLRACLE_API_KEY', 'owl-test-key');
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({
			'api.blocknative.com': refused,
			'api.owlracle.info': () => jsonResponse(OWLRACLE_BASE),
		});
		await getGasEstimate('bsc', { fetchImpl });
		const owl = fetchImpl.calls.find((c) => c.url.includes('owlracle'));
		expect(owl.url).toContain('/v4/bsc/gas?apikey=owl-test-key');
	});
});

describe('gas-oracles: Etherscan rung (mainnet final)', () => {
	it('recovers per-tier priority fees from the legacy total prices', async () => {
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({
			'api.blocknative.com': refused,
			'api.owlracle.info': () => jsonResponse({ error: { status: 403 } }, 403),
			'api.etherscan.io': () => jsonResponse(ETHERSCAN_MAINNET),
		});
		const est = await getGasEstimate('ethereum', { fetchImpl });

		expect(est.source).toBe('etherscan');
		expect(est.baseFee).toBe(0.1119);
		// SafeGasPrice etc. are TOTAL gas prices; priority = total - suggestBaseFee.
		expect(est.tiers.safe).toEqual({ maxFeePerGas: 0.112, maxPriorityFeePerGas: 0.0001 });
		expect(est.tiers.standard).toEqual({ maxFeePerGas: 0.1121, maxPriorityFeePerGas: 0.0002 });
		expect(est.tiers.fast).toEqual({ maxFeePerGas: 0.1233, maxPriorityFeePerGas: 0.0114 });

		// The chain was walked in order: Blocknative, then Owlracle, then Etherscan.
		expect(fetchImpl.calls.map((c) => new URL(c.url).hostname)).toEqual([
			'api.blocknative.com',
			'api.owlracle.info',
			'api.etherscan.io',
		]);
		// Keyless: no apikey param when ETHERSCAN_API_KEY is unset.
		expect(fetchImpl.calls[2].url).toContain('chainid=1&module=gastracker&action=gasoracle');
		expect(fetchImpl.calls[2].url).not.toContain('apikey');
	});

	it('uses ETHERSCAN_API_KEY via the shared env helper when configured', async () => {
		vi.stubEnv('ETHERSCAN_API_KEY', 'etherscan-test-key');
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({
			'api.blocknative.com': refused,
			'api.owlracle.info': refused,
			'api.etherscan.io': () => jsonResponse(ETHERSCAN_MAINNET),
		});
		await getGasEstimate('ethereum', { fetchImpl });
		expect(fetchImpl.calls[2].url).toContain('apikey=etherscan-test-key');
	});

	it('treats an Etherscan status:"0" body as a rung failure, surfacing its reason', async () => {
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({
			'api.blocknative.com': refused,
			'api.owlracle.info': refused,
			'api.etherscan.io': () =>
				jsonResponse({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached' }),
		});
		await expect(getGasEstimate('ethereum', { fetchImpl })).rejects.toMatchObject({
			code: 'gas_sources_unavailable',
			attempts: [
				{ source: 'blocknative', error: 'fetch failed' },
				{ source: 'owlracle', error: 'fetch failed' },
				{ source: 'etherscan', error: 'Max calls per sec rate limit reached' },
			],
		});
	});
});

describe('gas-oracles: chain-appropriate rung skipping + failure contract', () => {
	it('only calls Owlracle for a chain Blocknative/Etherscan do not serve', async () => {
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({ 'api.owlracle.info': refused });
		await expect(getGasEstimate('fantom', { fetchImpl })).rejects.toMatchObject({
			code: 'gas_sources_unavailable',
			attempts: [{ source: 'owlracle', error: 'fetch failed' }],
		});
		expect(fetchImpl.calls).toHaveLength(1);
		expect(fetchImpl.calls[0].url).toContain('/v4/ftm/gas');
	});

	it('rejects an unknown chain with unsupported_chain before any fetch', async () => {
		const { getGasEstimate } = await import('../../api/_lib/gas-oracles.js');
		const fetchImpl = providerFetch({});
		await expect(getGasEstimate('solana', { fetchImpl })).rejects.toMatchObject({
			code: 'unsupported_chain',
		});
		expect(fetchImpl.calls).toHaveLength(0);
	});
});

// ── Endpoint: GET /api/v1/gas ───────────────────────────────────────────────

// Gateway rate limit (shared /api/v1 budget): flip `quotaOk` per test.
let quotaOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () =>
			quotaOk
				? { success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }
				: { success: false, limit: 120, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.9',
}));

// Pass-through cache so each test hits the oracle chain deterministically
// (the real cacheWrap would pin the first test's answer for 10s).
vi.mock('../../api/_lib/cache.js', () => ({
	cacheWrap: (_key, _ttl, fn) => fn(),
}));

function makeReq(url) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host: 'three.ws' };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function dispatch(url) {
	const req = makeReq(url);
	const res = makeRes();
	const mod = await import('../../api/v1/gas.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

describe('GET /api/v1/gas', () => {
	beforeEach(() => {
		quotaOk = true;
	});

	it('returns normalized tiers for ?chain=base in the { data } envelope, edge-cacheable', async () => {
		vi.stubGlobal('fetch', providerFetch({
			'api.blocknative.com': refused,
			'api.owlracle.info': () => jsonResponse(OWLRACLE_BASE),
		}));
		const { res, body } = await dispatch('/api/v1/gas?chain=base');
		expect(res.statusCode).toBe(200);
		expect(body.data.chain).toBe('base');
		expect(body.data.chainId).toBe(8453);
		expect(body.data.source).toBe('owlracle');
		expect(body.data.tiers.fast.maxFeePerGas).toBe(0.0058);
		expect(res.getHeader('cache-control')).toMatch(/max-age=10/);
	});

	it('defaults to Ethereum mainnet when no chain is passed', async () => {
		vi.stubGlobal('fetch', providerFetch({
			'api.blocknative.com': () => jsonResponse(BLOCKNATIVE_MAINNET),
		}));
		const { res, body } = await dispatch('/api/v1/gas');
		expect(res.statusCode).toBe(200);
		expect(body.data.chain).toBe('ethereum');
		expect(body.data.source).toBe('blocknative');
	});

	it('lists supported chains and their sources with ?chains=1', async () => {
		vi.stubGlobal('fetch', providerFetch({}));
		const { res, body } = await dispatch('/api/v1/gas?chains=1');
		expect(res.statusCode).toBe(200);
		const eth = body.data.chains.find((c) => c.chain === 'ethereum');
		expect(eth.sources).toEqual(['blocknative', 'owlracle', 'etherscan']);
		expect(body.data.chains.length).toBeGreaterThanOrEqual(10);
	});

	it('rejects an unknown chain with 400 naming the supported set', async () => {
		vi.stubGlobal('fetch', providerFetch({}));
		const { res, body } = await dispatch('/api/v1/gas?chain=solana');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('unsupported_chain');
		expect(body.error_description).toContain('ethereum');
		expect(body.error_description).toContain('base');
	});

	it('returns 503 sources_unavailable (never 500) when every rung fails', async () => {
		vi.stubGlobal('fetch', providerFetch({
			'api.blocknative.com': refused,
			'api.owlracle.info': refused,
			'api.etherscan.io': refused,
		}));
		const { res, body } = await dispatch('/api/v1/gas?chain=eth');
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('sources_unavailable');
		expect(body.error_description).toContain('blocknative');
		expect(body.error_description).toContain('owlracle');
		expect(body.error_description).toContain('etherscan');
	});

	it('returns 429 when the shared /api/v1 budget is exhausted', async () => {
		quotaOk = false;
		vi.stubGlobal('fetch', providerFetch({}));
		const { res, body } = await dispatch('/api/v1/gas?chain=base');
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBeTruthy();
	});
});
