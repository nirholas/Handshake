// Keyless EVM swap-quote chain (api/_lib/evm/swap-quotes.js) and its endpoint
// (GET /api/v1/evm/swap-quote).
//
// Every rung of the quote chain must be REACHABLE, proven by failing the rungs
// above it at the TRANSPORT level (a thrown fetch: ECONNRESET or an abort),
// the way a provider actually dies. A chain tested only with parsed error
// bodies looks healthy while the real failure mode walks straight past it;
// tests/api/llm-free-chain-reachability.test.js documents the incident that
// made this the house style for fallback chains.
//
// Fixtures are trimmed captures of REAL responses from the three live
// endpoints (curl-verified 2026-08-05, WETH -> USDC on Base):
//   ParaSwap  GET api.paraswap.io/prices            -> { priceRoute }
//   KyberSwap GET aggregator-api.kyberswap.com/base/api/v1/routes
//                                                   -> { code: 0, data: { routeSummary } }
//   LI.FI     GET li.quest/v1/quote                 -> { estimate, action, tool }
// No test opens a real socket: global fetch is stubbed per-host.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ONE_WETH = '1000000000000000000';

const HOSTS = {
	paraswap: 'api.paraswap.io',
	kyberswap: 'aggregator-api.kyberswap.com',
	lifi: 'li.quest',
};

// ── Real-shape fixtures (trimmed live captures) ─────────────────────────────

const PARASWAP_BODY = {
	priceRoute: {
		blockNumber: 49592462,
		network: 8453,
		srcToken: WETH_BASE.toLowerCase(),
		srcDecimals: 18,
		srcAmount: ONE_WETH,
		destToken: USDC_BASE.toLowerCase(),
		destDecimals: 6,
		destAmount: '1912283226',
		bestRoute: [
			{ percent: 100, swaps: [{ swapExchanges: [{ exchange: 'CurveV1StableNg', percent: 100 }] }] },
		],
		gasCostUSD: '0.003527',
		gasCost: '302300',
		side: 'SELL',
		srcUSD: '1908.0400000000',
		destUSD: '1911.5297864090',
	},
};

const KYBER_BODY = {
	code: 0,
	message: 'successfully',
	data: {
		routeSummary: {
			tokenIn: WETH_BASE.toLowerCase(),
			amountIn: ONE_WETH,
			amountInUsd: '1908.8696524460145',
			tokenOut: USDC_BASE.toLowerCase(),
			amountOut: '1906692387',
			amountOutUsd: '1909.011824429036',
			gas: '2615965',
			gasUsd: '0.029961217202165626',
			route: [[{ exchange: 'uniswap-v4-fairflow', poolType: 'uniswap-v4' }]],
		},
	},
};

const LIFI_BODY = {
	type: 'lifi',
	tool: 'fly',
	action: {
		fromToken: { address: WETH_BASE, chainId: 8453, symbol: 'WETH', decimals: 18 },
		toToken: { address: USDC_BASE, chainId: 8453, symbol: 'USDC', decimals: 6 },
		fromChainId: 8453,
		toChainId: 8453,
	},
	estimate: {
		tool: 'fly',
		fromAmount: ONE_WETH,
		toAmount: '1907503064',
		toAmountMin: '1897965549',
		fromAmountUSD: '1908.09',
		toAmountUSD: '1900.79',
		gasCosts: [{ type: 'SEND', estimate: '375000', amountUSD: '0.011' }],
	},
};

// How a provider dies for real: the socket drops, or the attempt is aborted.
function transportFailure(kind) {
	if (kind === 'abort') return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
	return Object.assign(new Error('fetch failed: ECONNRESET'), { cause: { code: 'ECONNRESET' } });
}

const jsonResp = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	text: async () => JSON.stringify(body),
});

// Per-host behavior for the stubbed fetch. Each entry is either a function
// returning a response object or an Error instance to throw (transport death).
let hostPlan = {};
let fetchLog = [];

function stubFetch() {
	vi.stubGlobal('fetch', async (input) => {
		const url = new URL(String(input));
		fetchLog.push(url);
		const plan = hostPlan[url.host];
		if (!plan) throw new Error(`unexpected fetch to ${url.host} in test`);
		const step = typeof plan === 'function' ? plan(url) : plan;
		if (step instanceof Error) throw step;
		return step;
	});
}

// Switchable quotas, mirroring the v1-resolve test harness.
let apiV1Ok = true;
let quoteIpOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () =>
			apiV1Ok
				? { success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }
				: { success: false, limit: 120, remaining: 0, reset: Date.now() + 60_000 },
		apiIp: async () =>
			quoteIpOk
				? { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 }
				: { success: false, limit: 30, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.9',
}));

beforeEach(() => {
	apiV1Ok = true;
	quoteIpOk = true;
	hostPlan = {};
	fetchLog = [];
	stubFetch();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function lib() {
	return import('../../api/_lib/evm/swap-quotes.js');
}

const baseParams = async () => {
	const { resolveChain } = await lib();
	return {
		chain: resolveChain('base'),
		sellToken: WETH_BASE,
		buyToken: USDC_BASE,
		amount: ONE_WETH,
		timeoutMs: 1000,
	};
};

// ── Chain identity ──────────────────────────────────────────────────────────
describe('swap-quotes chain map', () => {
	it('lists the rungs in the documented order: paraswap, kyberswap, lifi', async () => {
		const { QUOTE_PROVIDERS } = await lib();
		expect(QUOTE_PROVIDERS.map((p) => p.name)).toEqual(['paraswap', 'kyberswap', 'lifi']);
	});

	it('covers the six required chains and maps names, aliases, and ids per provider', async () => {
		const { resolveChain, SUPPORTED_CHAINS } = await lib();
		expect(SUPPORTED_CHAINS).toEqual(['ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'bsc']);
		expect(resolveChain('ethereum')).toEqual({ key: 'ethereum', chainId: 1, kyber: 'ethereum' });
		expect(resolveChain('eth')).toEqual({ key: 'ethereum', chainId: 1, kyber: 'ethereum' });
		expect(resolveChain('BASE')).toEqual({ key: 'base', chainId: 8453, kyber: 'base' });
		expect(resolveChain('matic')).toEqual({ key: 'polygon', chainId: 137, kyber: 'polygon' });
		expect(resolveChain('arb')).toEqual({ key: 'arbitrum', chainId: 42161, kyber: 'arbitrum' });
		expect(resolveChain('op')).toEqual({ key: 'optimism', chainId: 10, kyber: 'optimism' });
		expect(resolveChain('bnb')).toEqual({ key: 'bsc', chainId: 56, kyber: 'bsc' });
		expect(resolveChain(8453)).toEqual({ key: 'base', chainId: 8453, kyber: 'base' });
		expect(resolveChain('56')).toEqual({ key: 'bsc', chainId: 56, kyber: 'bsc' });
		expect(resolveChain('solana')).toBeNull();
		expect(resolveChain('')).toBeNull();
	});
});

// ── Rung 1 wins ─────────────────────────────────────────────────────────────
describe('getSwapQuote: first success wins', () => {
	it('returns a normalized ParaSwap quote and never touches the rungs below', async () => {
		hostPlan[HOSTS.paraswap] = () => jsonResp(PARASWAP_BODY);
		const { getSwapQuote } = await lib();
		const { quote, provider, attempts } = await getSwapQuote(await baseParams());

		expect(provider).toBe('paraswap');
		expect(attempts).toEqual([{ provider: 'paraswap', ok: true, latencyMs: expect.any(Number) }]);
		expect(fetchLog).toHaveLength(1);
		expect(fetchLog[0].host).toBe(HOSTS.paraswap);
		expect(fetchLog[0].pathname).toBe('/prices');
		expect(fetchLog[0].searchParams.get('network')).toBe('8453');
		expect(fetchLog[0].searchParams.get('side')).toBe('SELL');
		expect(fetchLog[0].searchParams.get('amount')).toBe(ONE_WETH);

		expect(quote).toEqual({
			provider: 'paraswap',
			chain: 'base',
			chainId: 8453,
			sellToken: WETH_BASE,
			buyToken: USDC_BASE,
			sellAmount: ONE_WETH,
			buyAmount: '1912283226',
			price: 1912.283226,
			estimatedGas: '302300',
			gasUsd: 0.003527,
			sellAmountUsd: 1908.04,
			buyAmountUsd: 1911.529786409,
			venue: 'CurveV1StableNg',
		});
	});
});

// ── Transport-level failover, rung by rung ──────────────────────────────────
describe('getSwapQuote: every rung is reachable through a transport-level failure', () => {
	it('falls to KyberSwap when ParaSwap dies at the socket, on the per-chain host segment', async () => {
		hostPlan[HOSTS.paraswap] = transportFailure('econnreset');
		hostPlan[HOSTS.kyberswap] = () => jsonResp(KYBER_BODY);
		const { getSwapQuote } = await lib();
		const { quote, provider, attempts } = await getSwapQuote(await baseParams());

		expect(provider).toBe('kyberswap');
		expect(attempts.map((a) => [a.provider, a.ok])).toEqual([
			['paraswap', false],
			['kyberswap', true],
		]);
		expect(attempts[0].error).toMatch(/ECONNRESET/);
		const kyberUrl = fetchLog.find((u) => u.host === HOSTS.kyberswap);
		expect(kyberUrl.pathname).toBe('/base/api/v1/routes');
		expect(kyberUrl.searchParams.get('amountIn')).toBe(ONE_WETH);

		expect(quote).toEqual({
			provider: 'kyberswap',
			chain: 'base',
			chainId: 8453,
			sellToken: WETH_BASE,
			buyToken: USDC_BASE,
			sellAmount: ONE_WETH,
			buyAmount: '1906692387',
			price: null,
			estimatedGas: '2615965',
			gasUsd: 0.029961217202165626,
			sellAmountUsd: 1908.8696524460145,
			buyAmountUsd: 1909.011824429036,
			venue: 'uniswap-v4-fairflow',
		});
	});

	it('falls to LI.FI when ParaSwap and KyberSwap both die (reset + abort)', async () => {
		hostPlan[HOSTS.paraswap] = transportFailure('econnreset');
		hostPlan[HOSTS.kyberswap] = transportFailure('abort');
		hostPlan[HOSTS.lifi] = () => jsonResp(LIFI_BODY);
		const { getSwapQuote } = await lib();
		const { quote, provider, attempts } = await getSwapQuote(await baseParams());

		expect(provider).toBe('lifi');
		expect(attempts.map((a) => [a.provider, a.ok])).toEqual([
			['paraswap', false],
			['kyberswap', false],
			['lifi', true],
		]);
		const lifiUrl = fetchLog.find((u) => u.host === HOSTS.lifi);
		expect(lifiUrl.pathname).toBe('/v1/quote');
		expect(lifiUrl.searchParams.get('fromChain')).toBe('8453');
		expect(lifiUrl.searchParams.get('toChain')).toBe('8453');
		// The quote read supplies the burn placeholder, never a user wallet.
		expect(lifiUrl.searchParams.get('fromAddress')).toBe('0x000000000000000000000000000000000000dEaD');

		expect(quote).toEqual({
			provider: 'lifi',
			chain: 'base',
			chainId: 8453,
			sellToken: WETH_BASE,
			buyToken: USDC_BASE,
			sellAmount: ONE_WETH,
			buyAmount: '1907503064',
			price: 1907.503064,
			estimatedGas: '375000',
			gasUsd: 0.011,
			sellAmountUsd: 1908.09,
			buyAmountUsd: 1900.79,
			venue: 'fly',
		});
	});

	it('fails soft past a ParaSwap HTTP error and a KyberSwap non-zero code body', async () => {
		hostPlan[HOSTS.paraswap] = () => jsonResp({ error: 'No routes found with enough liquidity' }, 404);
		hostPlan[HOSTS.kyberswap] = () => jsonResp({ code: 4005, message: 'route not found' });
		hostPlan[HOSTS.lifi] = () => jsonResp(LIFI_BODY);
		const { getSwapQuote } = await lib();
		const { provider, attempts } = await getSwapQuote(await baseParams());

		expect(provider).toBe('lifi');
		expect(attempts[0].error).toMatch(/paraswap 404/);
		expect(attempts[1].error).toMatch(/route not found/);
	});

	it('throws with the full attempt log when every rung is down', async () => {
		hostPlan[HOSTS.paraswap] = transportFailure('econnreset');
		hostPlan[HOSTS.kyberswap] = transportFailure('econnreset');
		hostPlan[HOSTS.lifi] = transportFailure('abort');
		const { getSwapQuote } = await lib();

		const err = await getSwapQuote(await baseParams()).then(
			() => null,
			(e) => e,
		);
		expect(err).toBeTruthy();
		expect(err.message).toMatch(/every quote provider failed/);
		expect(err.attempts.map((a) => a.provider)).toEqual(['paraswap', 'kyberswap', 'lifi']);
		expect(err.attempts.every((a) => a.ok === false)).toBe(true);
	});
});

// ── The endpoint ────────────────────────────────────────────────────────────

function makeReq({ url, host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host };
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

async function dispatch(req, res) {
	const mod = await import('../../api/v1/evm/swap-quote.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

const quoteUrl = (over = {}) => {
	const q = new URLSearchParams({
		chain: 'base',
		sellToken: WETH_BASE,
		buyToken: USDC_BASE,
		amount: ONE_WETH,
		...over,
	});
	for (const [k, v] of [...q]) if (v === '') q.delete(k);
	return `/api/v1/evm/swap-quote?${q}`;
};

describe('GET /api/v1/evm/swap-quote', () => {
	it('serves the normalized best quote, names the provider, and caches briefly', async () => {
		hostPlan[HOSTS.paraswap] = () => jsonResp(PARASWAP_BODY);
		const { res, body } = await dispatch(makeReq({ url: quoteUrl() }), makeRes());

		expect(res.statusCode).toBe(200);
		expect(body.data.provider).toBe('paraswap');
		expect(body.data.quote.buyAmount).toBe('1912283226');
		expect(body.data.quote.price).toBe(1912.283226);
		expect(body.data.attempts).toHaveLength(1);
		expect(res.getHeader('cache-control')).toMatch(/max-age=10/);
	});

	it('accepts a numeric chain id and quotes through the failover rung', async () => {
		hostPlan[HOSTS.paraswap] = transportFailure('econnreset');
		hostPlan[HOSTS.kyberswap] = () => jsonResp(KYBER_BODY);
		const { res, body } = await dispatch(makeReq({ url: quoteUrl({ chain: '8453' }) }), makeRes());

		expect(res.statusCode).toBe(200);
		expect(body.data.provider).toBe('kyberswap');
		expect(body.data.attempts.map((a) => a.ok)).toEqual([false, true]);
	});

	it('rejects an unsupported chain with 400 naming the supported set', async () => {
		const { res, body } = await dispatch(makeReq({ url: quoteUrl({ chain: 'solana' }) }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toMatch(/ethereum, base, polygon, arbitrum, optimism, bsc/);
	});

	it('rejects a malformed token address with 400', async () => {
		const { res, body } = await dispatch(makeReq({ url: quoteUrl({ sellToken: 'weth' }) }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toMatch(/sellToken/);
	});

	it('rejects identical sell and buy tokens with 400', async () => {
		const url = quoteUrl({ buyToken: WETH_BASE.toLowerCase() });
		const { res, body } = await dispatch(makeReq({ url }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error_description).toMatch(/must differ/);
	});

	it('rejects a non-integer or zero amount with 400', async () => {
		for (const amount of ['1.5', '0', '-3', 'abc', '']) {
			const { res, body } = await dispatch(makeReq({ url: quoteUrl({ amount }) }), makeRes());
			expect(res.statusCode).toBe(400);
			expect(body.error).toBe('validation_error');
			expect(body.error_description).toMatch(/RAW base units/);
		}
	});

	it('returns 502 quote_unavailable (never 500) naming each rung when all providers fail', async () => {
		hostPlan[HOSTS.paraswap] = transportFailure('econnreset');
		hostPlan[HOSTS.kyberswap] = transportFailure('abort');
		hostPlan[HOSTS.lifi] = transportFailure('econnreset');
		const { res, body } = await dispatch(makeReq({ url: quoteUrl() }), makeRes());

		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('quote_unavailable');
		expect(body.error_description).toMatch(/paraswap/);
		expect(body.error_description).toMatch(/kyberswap/);
		expect(body.error_description).toMatch(/lifi/);
	});

	it('returns 429 when the per-IP quote quota is exhausted, before any upstream call', async () => {
		quoteIpOk = false;
		const { res, body } = await dispatch(makeReq({ url: quoteUrl() }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(fetchLog).toHaveLength(0);
	});
});
