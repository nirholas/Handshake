// Keyless EVM swap-QUOTE chain: ParaSwap, then KyberSwap, then LI.FI.
//
// Read-only price discovery ONLY. This module never builds transaction
// calldata, never signs, and never sends anything on-chain: every rung calls a
// public, keyless quote endpoint and returns numbers. The LI.FI quote endpoint
// requires a `fromAddress` even for a price read, so a burn address is passed
// as a placeholder; the tx payload LI.FI attaches to its response is discarded
// on purpose.
//
// Chain order and why: ParaSwap's /prices endpoint is the most permissive
// keyless rung (no per-request address requirement, decimals resolved
// server-side), KyberSwap's aggregator routes endpoint is a fast second with
// per-chain hosts under one API shape, and LI.FI (li.quest/v1/quote, the same
// keyless host api/x402/cross-chain.js already probes for bridge health) is the
// broadest but the most tightly rate-limited without a key, so it goes last.
// First success wins; each rung fails soft on its own timeout
// (AbortSignal.timeout, the pattern the cross-chain probes use) and the next
// rung is tried. Only when every rung has failed does the chain throw, carrying
// the per-provider attempt log for the caller's error message.
//
// Chains covered: Ethereum, Base, Polygon, Arbitrum, Optimism, BSC. Each
// provider addresses chains differently (ParaSwap and LI.FI take the numeric
// chain id, KyberSwap takes a per-chain host path segment), so `resolveChain`
// maps one caller-facing name (plus common aliases and the raw chain id) to
// every per-provider identifier.
//
// Native-coin quotes work through the providers' shared sentinel address
// (0xeeee...eeee), which is a syntactically valid EVM address and passes
// straight through.

const PARASWAP_BASE = 'https://api.paraswap.io';
const KYBER_BASE = 'https://aggregator-api.kyberswap.com';
const LIFI_BASE = 'https://li.quest';

// Per-rung budget. A rung that cannot answer in this window is treated as down
// and the chain moves on; three rungs stay comfortably inside a 30s request.
export const PROVIDER_TIMEOUT_MS = 7000;

// LI.FI's quote endpoint validates fromAddress but a pure price read has no
// caller wallet; the canonical burn address satisfies the validator without
// implying any account. No transaction is ever built from this quote.
const LIFI_QUOTE_ADDRESS = '0x000000000000000000000000000000000000dEaD';

// One row per supported chain: caller-facing key, accepted aliases, numeric
// chain id (ParaSwap `network`, LI.FI `fromChain`/`toChain`), and KyberSwap's
// host path segment.
const CHAINS = {
	ethereum: { chainId: 1, kyber: 'ethereum', aliases: ['eth', 'mainnet'] },
	base: { chainId: 8453, kyber: 'base', aliases: [] },
	polygon: { chainId: 137, kyber: 'polygon', aliases: ['matic'] },
	arbitrum: { chainId: 42161, kyber: 'arbitrum', aliases: ['arb'] },
	optimism: { chainId: 10, kyber: 'optimism', aliases: ['op'] },
	bsc: { chainId: 56, kyber: 'bsc', aliases: ['bnb', 'binance'] },
};

/** Caller-facing chain keys, for validation messages. */
export const SUPPORTED_CHAINS = Object.keys(CHAINS);

/**
 * Map a chain name (key, alias, or numeric chain id as number/string) to its
 * per-provider identifiers. Returns null for anything unsupported.
 * @param {string|number} input
 * @returns {{ key: string, chainId: number, kyber: string } | null}
 */
export function resolveChain(input) {
	const raw = String(input ?? '').trim().toLowerCase();
	if (!raw) return null;
	for (const [key, def] of Object.entries(CHAINS)) {
		if (raw === key || def.aliases.includes(raw) || raw === String(def.chainId)) {
			return { key, chainId: def.chainId, kyber: def.kyber };
		}
	}
	return null;
}

/** Trim an upstream error body to something safe for an attempt log. */
function snippet(text) {
	return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Finite positive number or null; upstream USD fields arrive as strings. */
function num(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * Human price (buy tokens per 1 sell token) when both decimals are known.
 * Number precision is fine here: this is a display/comparison figure, the
 * exact raw buyAmount string stays authoritative.
 */
function humanPrice(sellAmount, buyAmount, sellDecimals, buyDecimals) {
	if (!Number.isInteger(sellDecimals) || !Number.isInteger(buyDecimals)) return null;
	const sell = Number(sellAmount) / 10 ** sellDecimals;
	const buy = Number(buyAmount) / 10 ** buyDecimals;
	if (!Number.isFinite(sell) || sell <= 0 || !Number.isFinite(buy) || buy < 0) return null;
	return buy / sell;
}

async function fetchJson(url, timeoutMs, providerName) {
	const res = await fetch(url, {
		headers: { Accept: 'application/json', 'User-Agent': 'three-ws/1.0 (+https://three.ws)' },
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {
		data = null;
	}
	if (!res.ok) {
		const detail = snippet(data?.error || data?.message || text) || 'no error body';
		throw new Error(`${providerName} ${res.status}: ${detail}`);
	}
	if (data === null) throw new Error(`${providerName} returned a non-JSON body`);
	return data;
}

// ---------------------------------------------------------------------------
// Rung 1: ParaSwap /prices (keyless, decimals resolved server-side).
// ---------------------------------------------------------------------------
async function quoteParaswap({ chain, sellToken, buyToken, amount, timeoutMs }) {
	const url = new URL('/prices', PARASWAP_BASE);
	url.searchParams.set('srcToken', sellToken);
	url.searchParams.set('destToken', buyToken);
	url.searchParams.set('amount', amount);
	url.searchParams.set('side', 'SELL');
	url.searchParams.set('network', String(chain.chainId));

	const data = await fetchJson(url, timeoutMs, 'paraswap');
	const route = data?.priceRoute;
	if (data?.error) throw new Error(`paraswap: ${snippet(data.error)}`);
	if (!route?.destAmount) throw new Error('paraswap: no priceRoute in response');

	const sellDecimals = Number.isInteger(route.srcDecimals) ? route.srcDecimals : null;
	const buyDecimals = Number.isInteger(route.destDecimals) ? route.destDecimals : null;
	return {
		provider: 'paraswap',
		chain: chain.key,
		chainId: chain.chainId,
		sellToken,
		buyToken,
		sellAmount: String(route.srcAmount ?? amount),
		buyAmount: String(route.destAmount),
		price: humanPrice(route.srcAmount ?? amount, route.destAmount, sellDecimals, buyDecimals),
		estimatedGas: route.gasCost != null ? String(route.gasCost) : null,
		gasUsd: num(route.gasCostUSD),
		sellAmountUsd: num(route.srcUSD),
		buyAmountUsd: num(route.destUSD),
		venue: route.bestRoute?.[0]?.swaps?.[0]?.swapExchanges?.[0]?.exchange ?? null,
	};
}

// ---------------------------------------------------------------------------
// Rung 2: KyberSwap Aggregator routes (keyless, per-chain host segment).
// ---------------------------------------------------------------------------
async function quoteKyberswap({ chain, sellToken, buyToken, amount, timeoutMs }) {
	const url = new URL(`/${chain.kyber}/api/v1/routes`, KYBER_BASE);
	url.searchParams.set('tokenIn', sellToken);
	url.searchParams.set('tokenOut', buyToken);
	url.searchParams.set('amountIn', amount);

	const data = await fetchJson(url, timeoutMs, 'kyberswap');
	// Kyber wraps everything in { code, message, data }; code 0 is success.
	if (data?.code !== 0) throw new Error(`kyberswap: ${snippet(data?.message) || `code ${data?.code}`}`);
	const summary = data?.data?.routeSummary;
	if (!summary?.amountOut) throw new Error('kyberswap: no routeSummary in response');

	return {
		provider: 'kyberswap',
		chain: chain.key,
		chainId: chain.chainId,
		sellToken,
		buyToken,
		sellAmount: String(summary.amountIn ?? amount),
		buyAmount: String(summary.amountOut),
		// Kyber's summary carries no token decimals, so no human price; the USD
		// legs below give callers the same comparison signal.
		price: null,
		estimatedGas: summary.gas != null ? String(summary.gas) : null,
		gasUsd: num(summary.gasUsd),
		sellAmountUsd: num(summary.amountInUsd),
		buyAmountUsd: num(summary.amountOutUsd),
		venue: summary.route?.[0]?.[0]?.exchange ?? null,
	};
}

// ---------------------------------------------------------------------------
// Rung 3: LI.FI /v1/quote (keyless with rate limits; same-chain = swap quote).
// ---------------------------------------------------------------------------
async function quoteLifi({ chain, sellToken, buyToken, amount, timeoutMs }) {
	const url = new URL('/v1/quote', LIFI_BASE);
	url.searchParams.set('fromChain', String(chain.chainId));
	url.searchParams.set('toChain', String(chain.chainId));
	url.searchParams.set('fromToken', sellToken);
	url.searchParams.set('toToken', buyToken);
	url.searchParams.set('fromAmount', amount);
	url.searchParams.set('fromAddress', LIFI_QUOTE_ADDRESS);

	const data = await fetchJson(url, timeoutMs, 'lifi');
	const estimate = data?.estimate;
	if (!estimate?.toAmount) throw new Error('lifi: no estimate in response');

	const sellDecimals = data?.action?.fromToken?.decimals;
	const buyDecimals = data?.action?.toToken?.decimals;
	const gasCosts = Array.isArray(estimate.gasCosts) ? estimate.gasCosts : [];
	const gasUnits = gasCosts.length ? gasCosts.reduce((sum, g) => sum + (num(g?.estimate) ?? 0), 0) : null;
	const gasUsd = gasCosts.length ? gasCosts.reduce((sum, g) => sum + (num(g?.amountUSD) ?? 0), 0) : null;
	return {
		provider: 'lifi',
		chain: chain.key,
		chainId: chain.chainId,
		sellToken,
		buyToken,
		sellAmount: String(estimate.fromAmount ?? amount),
		buyAmount: String(estimate.toAmount),
		price: humanPrice(
			estimate.fromAmount ?? amount,
			estimate.toAmount,
			Number.isInteger(sellDecimals) ? sellDecimals : null,
			Number.isInteger(buyDecimals) ? buyDecimals : null,
		),
		estimatedGas: gasUnits != null && gasUnits > 0 ? String(gasUnits) : null,
		gasUsd,
		sellAmountUsd: num(estimate.fromAmountUSD),
		buyAmountUsd: num(estimate.toAmountUSD),
		venue: data?.tool ?? null,
	};
}

// The chain, in priority order. Exported so tests and docs can assert the
// order instead of restating it.
export const QUOTE_PROVIDERS = [
	{ name: 'paraswap', quote: quoteParaswap },
	{ name: 'kyberswap', quote: quoteKyberswap },
	{ name: 'lifi', quote: quoteLifi },
];

/**
 * Fetch the best available swap quote by walking the provider chain.
 * First rung that answers wins; every failure (transport error, timeout,
 * non-2xx, no-route body) fails soft into the next rung.
 *
 * @param {object} params
 * @param {{ key: string, chainId: number, kyber: string }} params.chain  From resolveChain().
 * @param {string} params.sellToken  0x token address (0xeeee... for the native coin).
 * @param {string} params.buyToken   0x token address.
 * @param {string} params.amount     Sell amount in RAW base units (integer string).
 * @param {number} [params.timeoutMs]  Per-rung budget, default PROVIDER_TIMEOUT_MS.
 * @returns {Promise<{ quote: object, provider: string, attempts: Array<{provider: string, ok: boolean, latencyMs: number, error?: string}> }>}
 * @throws {Error & { attempts: Array }} when every rung failed.
 */
export async function getSwapQuote({ chain, sellToken, buyToken, amount, timeoutMs = PROVIDER_TIMEOUT_MS }) {
	const attempts = [];
	for (const rung of QUOTE_PROVIDERS) {
		const t0 = Date.now();
		try {
			const quote = await rung.quote({ chain, sellToken, buyToken, amount, timeoutMs });
			attempts.push({ provider: rung.name, ok: true, latencyMs: Date.now() - t0 });
			return { quote, provider: rung.name, attempts };
		} catch (err) {
			attempts.push({
				provider: rung.name,
				ok: false,
				latencyMs: Date.now() - t0,
				error: snippet(err?.message ?? err),
			});
		}
	}
	const summary = attempts.map((a) => `${a.provider}: ${a.error}`).join('; ');
	throw Object.assign(new Error(`every quote provider failed (${summary})`), { attempts });
}
