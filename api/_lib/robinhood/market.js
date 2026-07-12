// Robinhood Chain market-data engine.
//
// The one place that turns on-chain reads + public data providers into the
// normalized shapes the /api/v1/robinhood/* handlers serve. Everything here is
// cached with a short TTL (cacheWrap) so a burst of board views collapses to
// one multicall sweep — the stocks board never fans out 95 RPC calls per
// request (CLAUDE.md perf rule).
//
// Correctness invariants (the two mistakes generic trackers make — verified
// against the Wave-1 SDK's stocks.ts):
//   1. Chainlink Robinhood feeds are ALREADY multiplier-adjusted. The feed
//      answer is the price per TOKEN; never re-apply uiMultiplier to it.
//   2. Share-equivalent units = balance × uiMultiplier ÷ 1e18. Raw token
//      balances understate positions after splits/reinvested dividends.

import { formatUnits } from 'viem';
import { cacheWrap } from '../cache.js';
import { hoodClient, explorerLinks, MAINNET_EXPLORER } from './chain.js';
import { addressesFor, NOXA, ODYSSEY_FACTORIES, V3_FEE_TIERS, USDG_DECIMALS } from './addresses.js';
import {
	erc20Abi,
	stockTokenAbi,
	aggregatorV3Abi,
	uniswapV3FactoryAbi,
	uniswapV3PoolAbi,
	noxaTokenLaunchedEvent,
	odysseyTokenCreatedEvent,
} from './abis.js';
import { listStockTokens, getStockToken, registryMeta } from './registry.js';

// Stock feeds update 24/5 (market hours); a Saturday read of a Friday-close
// answer is normal, not stale. 72h tolerates the weekend gap.
const MAX_FEED_AGE_SECONDS = 3 * 24 * 60 * 60;
const ONE_E18 = 10n ** 18n;

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Uniswap v3 pool price ────────────────────────────────────────────────────
// Human price of token0 denominated in token1 from a v3 slot0 sqrtPriceX96.
function poolPriceToken0InToken1(sqrtPriceX96, dec0, dec1) {
	const sqrt = Number(sqrtPriceX96) / 2 ** 96;
	const raw = sqrt * sqrt; // token1/token0 in base units
	return raw * 10 ** (dec0 - dec1);
}

/**
 * Discover the deepest USDG pool for each Stock Token and read its mid price,
 * in one multicall sweep. Returns Map<tokenAddressLower, { priceUsd, pool, fee,
 * liquidity }>. USDG is the chain's 6-decimal dollar stablecoin, so a USDG pool
 * gives a direct USD quote with no second oracle hop. Tokens with no USDG pool
 * simply get no DEX price (premium shown only where it can be computed
 * honestly).
 */
async function dexUsdgPrices(client, tokens, network) {
	const { usdg, uniswapV3Factory } = addressesFor(network);
	// Round 1: getPool(token, usdg, fee) for every token × fee tier.
	const poolCalls = [];
	for (const t of tokens) {
		for (const fee of V3_FEE_TIERS) {
			poolCalls.push({ address: uniswapV3Factory, abi: uniswapV3FactoryAbi, functionName: 'getPool', args: [t.address, usdg, fee] });
		}
	}
	const poolRes = await client.multicall({ contracts: poolCalls, allowFailure: true });

	const ZERO = '0x0000000000000000000000000000000000000000';
	const candidates = []; // { token, pool, fee }
	poolRes.forEach((r, i) => {
		if (!r || r.status !== 'success') return;
		const pool = r.result;
		if (!pool || pool === ZERO) return;
		const tokenIdx = Math.floor(i / V3_FEE_TIERS.length);
		const fee = V3_FEE_TIERS[i % V3_FEE_TIERS.length];
		candidates.push({ token: tokens[tokenIdx], pool, fee });
	});
	if (candidates.length === 0) return new Map();

	// Round 2: slot0 + token0 + liquidity for each candidate pool.
	const detailCalls = candidates.flatMap((c) => [
		{ address: c.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' },
		{ address: c.pool, abi: uniswapV3PoolAbi, functionName: 'token0' },
		{ address: c.pool, abi: uniswapV3PoolAbi, functionName: 'liquidity' },
	]);
	const detailRes = await client.multicall({ contracts: detailCalls, allowFailure: true });

	const best = new Map(); // tokenLower -> { priceUsd, pool, fee, liquidity }
	candidates.forEach((c, i) => {
		const slot0 = detailRes[i * 3];
		const token0 = detailRes[i * 3 + 1];
		const liq = detailRes[i * 3 + 2];
		if (!slot0 || slot0.status !== 'success' || !token0 || token0.status !== 'success') return;
		const sqrtPriceX96 = slot0.result[0];
		if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return;
		const stockIsToken0 = String(token0.result).toLowerCase() === c.token.address.toLowerCase();
		const dec0 = stockIsToken0 ? c.token.decimals : USDG_DECIMALS;
		const dec1 = stockIsToken0 ? USDG_DECIMALS : c.token.decimals;
		const p = poolPriceToken0InToken1(sqrtPriceX96, dec0, dec1); // token1 per token0
		const usdgPerStock = stockIsToken0 ? p : p === 0 ? 0 : 1 / p;
		if (!Number.isFinite(usdgPerStock) || usdgPerStock <= 0) return;
		const liquidity = liq && liq.status === 'success' ? liq.result : 0n;
		const key = c.token.address.toLowerCase();
		const prev = best.get(key);
		// Prefer the pool with the most in-range liquidity.
		if (!prev || liquidity > prev._liq) {
			best.set(key, { priceUsd: usdgPerStock, pool: c.pool, fee: c.fee, _liq: liquidity });
		}
	});
	return best;
}

// ── Stocks board snapshot ────────────────────────────────────────────────────
async function buildStocksSnapshot(network) {
	const client = hoodClient(network);
	const tokens = listStockTokens();
	const feedTokens = tokens.filter((t) => t.feed);

	// One multicall: uiMultiplier + pause flags for all, latestRoundData for the
	// feed-bearing ones.
	const baseCalls = tokens.flatMap((t) => [
		{ address: t.address, abi: stockTokenAbi, functionName: 'uiMultiplier' },
		{ address: t.address, abi: stockTokenAbi, functionName: 'tokenPaused' },
	]);
	const feedCalls = feedTokens.map((t) => ({ address: t.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' }));

	const [baseRes, feedRes, dexPrices] = await Promise.all([
		client.multicall({ contracts: baseCalls, allowFailure: true }),
		feedCalls.length ? client.multicall({ contracts: feedCalls, allowFailure: true }) : Promise.resolve([]),
		dexUsdgPrices(client, feedTokens, network).catch(() => new Map()),
	]);

	const quoteByFeedIdx = new Map();
	feedTokens.forEach((t, i) => {
		const r = feedRes[i];
		if (!r || r.status !== 'success') return;
		const [roundId, answer, , updatedAt] = r.result;
		if (answer <= 0n || updatedAt === 0n) return;
		const dec = t.feedDecimals ?? 8;
		const age = Math.max(0, nowSec() - Number(updatedAt));
		quoteByFeedIdx.set(t.symbol, {
			priceUsd: Number(formatUnits(answer, dec)),
			roundId: roundId.toString(),
			updatedAt: Number(updatedAt),
			ageSeconds: age,
			stale: age > MAX_FEED_AGE_SECONDS,
		});
	});

	const links = explorerLinks(network);
	const rows = tokens.map((t, i) => {
		const uiMultiplier = baseRes[i * 2]?.status === 'success' ? baseRes[i * 2].result : ONE_E18;
		const paused = baseRes[i * 2 + 1]?.status === 'success' ? Boolean(baseRes[i * 2 + 1].result) : false;
		const quote = t.feed ? quoteByFeedIdx.get(t.symbol) || null : null;
		const dex = dexPrices.get(t.address.toLowerCase()) || null;
		const chainlinkPrice = quote && !quote.stale ? quote.priceUsd : null;
		const dexPrice = dex ? dex.priceUsd : null;
		const premium =
			chainlinkPrice && dexPrice && chainlinkPrice > 0 ? (dexPrice - chainlinkPrice) / chainlinkPrice : null;
		return {
			symbol: t.symbol,
			name: t.name,
			address: t.address,
			decimals: t.decimals,
			feed: t.feed,
			uiMultiplier: uiMultiplier.toString(),
			uiMultiplierFloat: Number(formatUnits(uiMultiplier, 18)),
			paused,
			chainlinkPrice,
			feedRoundId: quote?.roundId ?? null,
			feedUpdatedAt: quote?.updatedAt ?? null,
			feedAgeSeconds: quote?.ageSeconds ?? null,
			feedStale: quote?.stale ?? null,
			dexPrice,
			dexPool: dex?.pool ?? null,
			dexFeeTier: dex?.fee ?? null,
			premium, // fraction: (dex - chainlink) / chainlink
			explorer: { token: links.token(t.address), feed: t.feed ? links.address(t.feed) : null },
		};
	});

	// Priced first (by |premium| then price), then feed-only, then unpriced.
	rows.sort((a, b) => {
		const ap = a.chainlinkPrice ?? -1;
		const bp = b.chainlinkPrice ?? -1;
		if ((bp >= 0) !== (ap >= 0)) return bp >= 0 ? 1 : -1;
		return bp - ap;
	});

	const meta = registryMeta();
	return {
		asOf: new Date().toISOString(),
		network,
		source: 'onchain:chainlink+uniswap-v3',
		chainId: network === 'testnet' ? 46630 : 4663,
		count: rows.length,
		pricedCount: rows.filter((r) => r.chainlinkPrice != null).length,
		dexPricedCount: rows.filter((r) => r.dexPrice != null).length,
		registry: meta,
		stocks: rows,
	};
}

export function stocksSnapshot(network = 'mainnet') {
	return cacheWrap(`rh:stocks:${network}`, 45, () => buildStocksSnapshot(network));
}

// ── Single Stock Token detail ────────────────────────────────────────────────
async function buildStockDetail(symbol, network) {
	const token = getStockToken(symbol);
	if (!token) return null;
	// Reuse the board snapshot (cached) for the priced row, then add the
	// per-token corporate-action reads the board omits.
	const [snap, extra] = await Promise.all([
		stocksSnapshot(network),
		hoodClient(network)
			.multicall({
				contracts: [
					{ address: token.address, abi: stockTokenAbi, functionName: 'totalSupply' },
					{ address: token.address, abi: stockTokenAbi, functionName: 'newUIMultiplier' },
					{ address: token.address, abi: stockTokenAbi, functionName: 'effectiveAt' },
					{ address: token.address, abi: stockTokenAbi, functionName: 'oraclePaused' },
				],
				allowFailure: true,
			})
			.catch(() => []),
	]);
	const row = snap.stocks.find((r) => r.symbol === token.symbol) || null;
	const val = (i) => (extra[i]?.status === 'success' ? extra[i].result : null);
	const totalSupply = val(0);
	const newMultiplier = val(1);
	const effectiveAt = val(2);
	const oraclePaused = val(3);
	return {
		asOf: new Date().toISOString(),
		network,
		source: 'onchain:chainlink+uniswap-v3',
		...row,
		symbol: token.symbol,
		name: token.name,
		address: token.address,
		totalSupply: totalSupply != null ? totalSupply.toString() : null,
		totalSupplyFloat: totalSupply != null ? Number(formatUnits(totalSupply, token.decimals)) : null,
		pendingMultiplier: newMultiplier != null && newMultiplier > 0n ? newMultiplier.toString() : null,
		pendingMultiplierEffectiveAt: effectiveAt != null && effectiveAt > 0n ? Number(effectiveAt) : null,
		oraclePaused: oraclePaused != null ? Boolean(oraclePaused) : null,
		legal:
			'Tokenized debt security (issuer: Robinhood Assets (Jersey) Ltd). May not be offered, ' +
			'sold, or delivered to US persons (additional limits: Canada, UK, Switzerland).',
	};
}

export function stockDetail(symbol, network = 'mainnet') {
	return cacheWrap(`rh:stock:${network}:${String(symbol).toUpperCase()}`, 30, () => buildStockDetail(symbol, network));
}

// ── Chain stats (DefiLlama TVL series + live block/gas) ──────────────────────
async function fetchJson(url, opts = {}) {
	const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000), ...opts });
	if (!res.ok) {
		const e = new Error(`upstream ${url} → ${res.status}`);
		e.status = res.status;
		throw e;
	}
	return res.json();
}

async function buildChainStats(network) {
	const client = hoodClient(network);
	const [chainMeta, tvlSeries, live] = await Promise.all([
		// Only mainnet is indexed by DefiLlama; testnet skips the TVL legs.
		network === 'testnet'
			? Promise.resolve(null)
			: fetchJson('https://api.llama.fi/v2/chains').then((all) =>
					Array.isArray(all) ? all.find((c) => c.name === 'Robinhood Chain') || null : null,
				).catch(() => null),
		network === 'testnet'
			? Promise.resolve([])
			: fetchJson('https://api.llama.fi/v2/historicalChainTvl/robinhood-chain')
					.then((s) => (Array.isArray(s) ? s.slice(-90).map((p) => ({ date: p.date, tvl: p.tvl })) : []))
					.catch(() => []),
		Promise.all([client.getBlockNumber(), client.getGasPrice()])
			.then(([blockNumber, gasPrice]) => ({
				blockNumber: blockNumber.toString(),
				gasPriceWei: gasPrice.toString(),
				gasPriceGwei: Number(formatUnits(gasPrice, 9)),
			}))
			.catch(() => null),
	]);

	const tvlNow = tvlSeries.length ? tvlSeries[tvlSeries.length - 1].tvl : chainMeta?.tvl ?? null;
	const tvlPrev = tvlSeries.length > 1 ? tvlSeries[tvlSeries.length - 2].tvl : null;
	return {
		asOf: new Date().toISOString(),
		network,
		source: network === 'testnet' ? 'onchain' : 'defillama+onchain',
		chainId: network === 'testnet' ? 46630 : 4663,
		name: 'Robinhood Chain',
		explorer: network === 'testnet' ? undefined : MAINNET_EXPLORER,
		tvlUsd: tvlNow,
		tvlChange1d: tvlNow != null && tvlPrev ? (tvlNow - tvlPrev) / tvlPrev : null,
		tvlSeries,
		block: live,
		stockTokenCount: registryMeta().tokenCount,
		feedCount: registryMeta().feedCount,
	};
}

export function chainStats(network = 'mainnet') {
	return cacheWrap(`rh:chain:${network}`, 60, () => buildChainStats(network));
}

// ── Memecoin screener (CoinGecko categories + GeckoTerminal pools) ───────────
function normalizeCoinRow(c) {
	return {
		id: c.id,
		symbol: c.symbol,
		name: c.name,
		image: c.image ?? null,
		priceUsd: c.current_price ?? null,
		marketCapUsd: c.market_cap ?? null,
		marketCapRank: c.market_cap_rank ?? null,
		fdvUsd: c.fully_diluted_valuation ?? null,
		volume24hUsd: c.total_volume ?? null,
		change24h: c.price_change_percentage_24h ?? null,
		change7d: c.price_change_percentage_7d_in_currency ?? null,
		sparkline: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price : null,
		high24h: c.high_24h ?? null,
		low24h: c.low_24h ?? null,
		ath: c.ath ?? null,
		athChange: c.ath_change_percentage ?? null,
		lastUpdated: c.last_updated ?? null,
	};
}

async function buildCoinsScreener() {
	const [meme, stocksEco, gtNew] = await Promise.all([
		fetchJson(
			'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=robinhood-chain-meme' +
				'&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=7d',
		).catch(() => []),
		fetchJson(
			'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=robinhood-chain-stocks-ecosystem' +
				'&order=market_cap_desc&per_page=50&page=1&sparkline=true&price_change_percentage=7d',
		).catch(() => []),
		// GeckoTerminal new pools surface fresh launches CoinGecko hasn't indexed
		// yet (best-effort — public GT is aggressively rate-limited).
		fetchJson('https://api.geckoterminal.com/api/v2/networks/robinhood/new_pools?page=1')
			.then((d) => (Array.isArray(d?.data) ? d.data : []))
			.catch(() => []),
	]);

	const memeRows = (Array.isArray(meme) ? meme : []).map(normalizeCoinRow);
	const ecoRows = (Array.isArray(stocksEco) ? stocksEco : []).map(normalizeCoinRow);
	const trending = [...memeRows].sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0)).slice(0, 20);
	const gainers = [...memeRows].filter((r) => r.change24h != null).sort((a, b) => b.change24h - a.change24h).slice(0, 10);

	const newPools = gtNew.slice(0, 20).map((p) => {
		const a = p.attributes || {};
		return {
			pool: a.address ?? null,
			name: a.name ?? null,
			priceUsd: a.base_token_price_usd != null ? Number(a.base_token_price_usd) : null,
			fdvUsd: a.fdv_usd != null ? Number(a.fdv_usd) : null,
			volume24hUsd: a.volume_usd?.h24 != null ? Number(a.volume_usd.h24) : null,
			createdAt: a.pool_created_at ?? null,
			base: p.relationships?.base_token?.data?.id ?? null,
		};
	});

	return {
		asOf: new Date().toISOString(),
		network: 'mainnet',
		source: 'coingecko+geckoterminal',
		meme: memeRows,
		stocksEcosystem: ecoRows,
		trending,
		gainers,
		newPools,
		counts: { meme: memeRows.length, stocksEcosystem: ecoRows.length, newPools: newPools.length },
	};
}

export function coinsScreener() {
	return cacheWrap('rh:coins', 60, buildCoinsScreener);
}

// ── Coin detail (CoinGecko contract lookup + GeckoTerminal pool) ─────────────
async function buildCoinDetail(address) {
	const addr = String(address).toLowerCase();
	const [cg, gt] = await Promise.all([
		fetchJson(
			`https://api.coingecko.com/api/v3/coins/robinhood/contract/${addr}`,
		).catch(() => null),
		fetchJson(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${addr}/pools?page=1`)
			.then((d) => (Array.isArray(d?.data) ? d.data : []))
			.catch(() => []),
	]);

	const md = cg?.market_data || {};
	const usd = (o) => (o && typeof o === 'object' ? o.usd : null);
	const links = explorerLinks('mainnet');
	const pools = gt.slice(0, 10).map((p) => {
		const a = p.attributes || {};
		return {
			pool: a.address ?? null,
			name: a.name ?? null,
			dex: p.relationships?.dex?.data?.id ?? null,
			priceUsd: a.base_token_price_usd != null ? Number(a.base_token_price_usd) : null,
			volume24hUsd: a.volume_usd?.h24 != null ? Number(a.volume_usd.h24) : null,
			reserveUsd: a.reserve_in_usd != null ? Number(a.reserve_in_usd) : null,
			change24h: a.price_change_percentage?.h24 != null ? Number(a.price_change_percentage.h24) : null,
			createdAt: a.pool_created_at ?? null,
		};
	});
	const topPool = pools.slice().sort((a, b) => (b.reserveUsd || 0) - (a.reserveUsd || 0))[0] || null;

	return {
		asOf: new Date().toISOString(),
		network: 'mainnet',
		source: 'coingecko+geckoterminal',
		address,
		id: cg?.id ?? null,
		symbol: cg?.symbol ?? null,
		name: cg?.name ?? null,
		image: cg?.image?.large ?? cg?.image?.small ?? null,
		description: typeof cg?.description?.en === 'string' ? cg.description.en.slice(0, 800) : null,
		priceUsd: usd(md.current_price) ?? topPool?.priceUsd ?? null,
		marketCapUsd: usd(md.market_cap) ?? null,
		fdvUsd: usd(md.fully_diluted_valuation) ?? null,
		volume24hUsd: usd(md.total_volume) ?? topPool?.volume24hUsd ?? null,
		change24h: md.price_change_percentage_24h ?? topPool?.change24h ?? null,
		change7d: md.price_change_percentage_7d ?? null,
		high24h: usd(md.high_24h) ?? null,
		low24h: usd(md.low_24h) ?? null,
		ath: usd(md.ath) ?? null,
		athChange: usd(md.ath_change_percentage) ?? null,
		circulatingSupply: md.circulating_supply ?? null,
		totalSupply: md.total_supply ?? null,
		topPool,
		pools,
		explorer: { token: links.token(address), address: links.address(address) },
	};
}

export function coinDetail(address) {
	return cacheWrap(`rh:coin:${String(address).toLowerCase()}`, 45, () => buildCoinDetail(address));
}

// ── Recent launchpad activity (NOXA + The Odyssey via eth_getLogs) ───────────
async function buildLaunches(network) {
	if (network === 'testnet') {
		return { asOf: new Date().toISOString(), network, source: 'onchain:logs', launches: [], note: 'launchpads are mainnet-only' };
	}
	const client = hoodClient(network);
	const latest = await client.getBlockNumber();
	// ~100ms blocks → 120k blocks ≈ the last few hours. Chunked for public-RPC
	// limits (launches are infrequent, so a wider window keeps the board useful).
	const lookback = 120_000n;
	const chunk = 10_000n;
	const fromBlock = latest > lookback ? latest - lookback : 0n;
	const links = explorerLinks(network);
	const launches = [];

	for (let start = fromBlock; start <= latest; start += chunk) {
		const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
		const [noxaLogs, odysseyLogs] = await Promise.all([
			client
				.getLogs({ address: NOXA.launchFactory, event: noxaTokenLaunchedEvent, fromBlock: start, toBlock: end })
				.catch(() => []),
			client
				.getLogs({ address: ODYSSEY_FACTORIES, event: odysseyTokenCreatedEvent, fromBlock: start, toBlock: end })
				.catch(() => []),
		]);
		for (const log of noxaLogs) {
			launches.push({
				launchpad: 'noxa',
				token: log.args.token,
				creator: log.args.deployer,
				pool: log.args.pool ?? null,
				status: 'listed', // NOXA lists instantly (no bonding curve)
				blockNumber: Number(log.blockNumber),
				txHash: log.transactionHash,
				explorer: { token: links.token(log.args.token), tx: links.tx(log.transactionHash) },
			});
		}
		for (const log of odysseyLogs) {
			launches.push({
				launchpad: 'odyssey',
				token: log.args.token,
				creator: log.args.creator,
				pool: null,
				status: 'bonding', // on the curve until PoolMigrated
				blockNumber: Number(log.blockNumber),
				txHash: log.transactionHash,
				explorer: { token: links.token(log.args.token), tx: links.tx(log.transactionHash) },
			});
		}
	}
	launches.sort((a, b) => b.blockNumber - a.blockNumber);
	return {
		asOf: new Date().toISOString(),
		network,
		source: 'onchain:logs',
		latestBlock: Number(latest),
		lookbackBlocks: Number(lookback),
		count: launches.length,
		launches: launches.slice(0, 100),
	};
}

export function recentLaunches(network = 'mainnet') {
	return cacheWrap(`rh:launches:${network}`, 30, () => buildLaunches(network));
}
