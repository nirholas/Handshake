// GET /api/crypto/portfolio - free, keyless portfolio overview for any wallet.
//
// The /portfolio page's data source, and part of the free crypto-data endpoint
// family (same conventions as api/crypto/wallet.js). One call returns what a
// portfolio view needs beyond raw balances: stable/major/other classification,
// top-asset allocation with palette slots, per-row portfolio share, per-token
// 24h price change, and an honest aggregate 24h move with its coverage stated.
//
// Chains: Solana first (fully keyless: Helius DAS when a key is present, public
// RPC walk otherwise, Jupiter Lite + pump.fun curve prices), Ethereum via the
// same getBalances() EVM path (needs ALCHEMY_API_KEY, degrades to 503).
//
// 24h changes: the EVM path already carries CoinGecko 24h changes per token.
// Solana balances carry none, so this handler enriches the top holdings from
// DexScreener's batch endpoint (30 mints per call, keyless) and SOL itself from
// the multi-provider sol-price failover. Tokens beyond the enrichment cap keep
// change24h null and the aggregate reports its actual coverage; nothing is
// extrapolated.

import { cors, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getBalances, heliusHealth } from '../_lib/balances.js';
import { isValidAddressForChain } from '../_lib/splits.js';
import { solChange24hPct } from '../_lib/sol-price.js';
import { cacheWrap } from '../_lib/cache.js';
import { fetchUpstreamJson, lastGood } from '../_lib/upstream-fetch.js';
import { buildOverview } from '../_lib/portfolio-overview.js';

const CHAIN_ALIASES = {
	solana: 'solana',
	sol: 'solana',
	ethereum: 'evm',
	eth: 'evm',
	evm: 'evm',
	mainnet: 'evm',
};

// DexScreener batches up to 30 token addresses per request. Two batches cover
// the top 60 holdings by value; beyond that is dust whose 24h move cannot
// meaningfully shift the aggregate, and coveragePct reports the gap honestly.
const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens/';
const CHANGE_BATCH = 30;
const CHANGE_BATCHES_MAX = 2;

const OVERVIEW_TTL_S = 60;

// Wrapped SOL tracks native SOL; pricing it off its own (thinner) pairs would
// let the two report different moves for the same asset.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function fetchSolanaChanges(tokens) {
	const changes = new Map();

	const [solPct, batchResults] = await Promise.all([
		solChange24hPct().catch(() => null),
		fetchDexScreenerChanges(tokens),
	]);
	if (Number.isFinite(solPct)) {
		changes.set('native', solPct);
		changes.set(WSOL_MINT, solPct);
	}
	for (const [mint, pct] of batchResults) {
		if (!changes.has(mint)) changes.set(mint, pct);
	}
	return changes;
}

async function fetchDexScreenerChanges(tokens) {
	const mints = tokens
		.filter((t) => t.mint && t.mint !== WSOL_MINT && Number(t.usd) > 0)
		.sort((a, b) => (b.usd || 0) - (a.usd || 0))
		.slice(0, CHANGE_BATCH * CHANGE_BATCHES_MAX)
		.map((t) => t.mint);
	if (!mints.length) return new Map();

	const batches = [];
	for (let i = 0; i < mints.length; i += CHANGE_BATCH) {
		batches.push(mints.slice(i, i + CHANGE_BATCH));
	}
	// Each batch retries and keeps its own last-known-good pair list. Before
	// this, allSettled swallowed a failure into an empty array and every holding
	// in that batch silently rendered a blank 24h change, indistinguishable from
	// a token that genuinely has none. A short-lived remembered answer keeps the
	// column populated through a throttle, and `staleBatches` records when it did.
	let staleBatches = 0;
	const settled = await Promise.allSettled(batches.map(async (batch, i) => {
		const { value: data, stale } = await lastGood(
			`portfolio-change:${batch.join(',')}`,
			() => fetchUpstreamJson(
				`${DEXSCREENER_TOKENS}${batch.map(encodeURIComponent).join(',')}`,
				{ headers: { Accept: 'application/json' } },
				{ name: `dexscreener:portfolio:${i}`, timeoutMs: 6_000, attempts: 2 },
			),
			{ maxAgeMs: 10 * 60_000 },
		);
		if (stale) staleBatches++;
		return Array.isArray(data?.pairs) ? data.pairs : [];
	}));

	// A mint can be either side of many pairs; keep the change from its
	// deepest-liquidity pair, the same pick rule as api/_lib/token-market.js.
	const best = new Map();
	const wanted = new Set(mints);
	for (const res of settled) {
		if (res.status !== 'fulfilled') continue;
		for (const p of res.value) {
			const liq = p?.liquidity?.usd ?? 0;
			for (const side of [p?.baseToken, p?.quoteToken]) {
				const addr = side?.address;
				if (!addr || !wanted.has(addr)) continue;
				const prev = best.get(addr);
				if (!prev || liq > prev.liq) {
					const pct = Number(p?.priceChange?.h24);
					best.set(addr, { liq, pct: Number.isFinite(pct) ? pct : null });
				}
			}
		}
	}
	const changes = new Map();
	for (const [mint, { pct }] of best) {
		if (pct != null) changes.set(mint, pct);
	}
	return changes;
}

function sourcesFor(chain) {
	if (chain === 'solana') {
		const h = heliusHealth();
		const balanceSource = h.configured && h.available ? 'helius-das' : 'solana-rpc';
		return [balanceSource, 'jupiter-lite', 'dexscreener'];
	}
	return ['alchemy', 'coingecko'];
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const [ipRl, globalRl] = await Promise.all([limits.cryptoDataIp(ip), limits.cryptoDataGlobal()]);
	if (!ipRl.success || !globalRl.success) {
		return error(res, 429, 'rate_limited', 'too many requests - slow down and retry shortly', {
			retryAfter: 60,
		});
	}

	const url = new URL(req.url, 'http://x');
	const address = (url.searchParams.get('address') || '').trim();
	const rawChain = (url.searchParams.get('chain') || 'solana').trim().toLowerCase();

	if (!address) {
		return error(res, 400, 'missing_address', 'pass ?address=<wallet> (a Solana or EVM address)', {
			example: '/api/crypto/portfolio?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=solana',
		});
	}
	const chain = CHAIN_ALIASES[rawChain];
	if (!chain) {
		return error(res, 400, 'unsupported_chain', `chain "${rawChain}" is not supported`, {
			supported: ['solana', 'ethereum'],
		});
	}
	if (!isValidAddressForChain(address, chain)) {
		return error(res, 400, 'invalid_address', `not a valid ${chain === 'solana' ? 'Solana' : 'EVM'} address`, {
			example: '/api/crypto/portfolio?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=solana',
		});
	}

	let body;
	try {
		body = await cacheWrap(`pfovw:${chain}:${address}`, OVERVIEW_TTL_S, async () => {
			const balances = await getBalances({ chain, address });
			const changes = chain === 'solana'
				? await fetchSolanaChanges(balances.tokens || [])
				: null;
			const overview = buildOverview(balances, changes);
			return {
				address,
				chain: chain === 'solana' ? 'solana' : 'ethereum',
				...overview,
				...(balances.stale ? { stale: true } : {}),
				ts: new Date().toISOString(),
				sources: sourcesFor(chain),
			};
		});
	} catch (err) {
		if (err?.code === 'not_configured') {
			return error(res, 503, 'not_configured', 'this chain requires a provider key that is not set on this deployment - Solana works keyless', {
				chain: rawChain,
			});
		}
		res.setHeader('retry-after', '15');
		return error(res, 503, 'upstream_unavailable', 'wallet data source is temporarily unavailable - retry shortly', {
			retryAfter: 15,
		});
	}

	res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(JSON.stringify(body));
});
