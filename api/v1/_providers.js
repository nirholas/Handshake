// Upstream provider registry for the three.ws aggregator (/api/v1/x/*).
//
// This is the single source of truth for every THIRD-PARTY API three.ws
// bundles and re-offers as one API. Adding a new upstream — or a new endpoint
// on an existing one — is a descriptor here; no new route file, no new
// plumbing. The catch-all route (api/v1/x/[...slug].js) resolves a request
// against this registry and the aggregator engine (api/_lib/aggregator.js)
// runs it through one auth / rate-limit / metering / billing path.
//
// Provider descriptor:
//   id          url-safe slug (first path segment under /api/v1/x)
//   name        human label
//   category    grouping for discovery
//   base        upstream base URL (no trailing slash)
//   requiresKey true when the upstream needs an API key to function at all
//   envVar      env var holding three.ws's platform key for this upstream
//   byokHeader  request header a caller uses to supply THEIR OWN upstream key
//   applyKey    (headers, url, key) => void — places a key where the upstream wants it
//   endpoints   array of endpoint descriptors:
//     id        url-safe slug (second path segment)
//     method    'GET' | 'POST' — the CALLER-facing verb the aggregator front
//               door requires (api/v1/x/[...slug].js rejects any other verb).
//     upstreamMethod  optional; only set when the upstream verb differs from
//               `method` — e.g. a caller-side GET that drives a POST-only
//               JSON-RPC upstream (see the `solana` provider below). Handled
//               in api/_lib/aggregator.js (`executeUpstream`): when set to
//               'POST', the endpoint's `body()` builder receives the
//               caller's query params (a GET has no caller body to forward).
//     path      string, or (query) => string for path params
//     query     (query) => object of upstream query params (GET)
//     body      (body) => object forwarded as the upstream JSON body (POST,
//               or as the caller's query params when `upstreamMethod` lifts
//               a caller-side GET to an upstream POST)
//     transform (data) => normalized response (default: passthrough)
//     free      optional { perMin, perDay } — unauthenticated per-IP quota
//               served before the x402 402 challenge kicks in
//     priceAtomics  x402 price in USDC atomics (6 decimals; "1000" = $0.001)
//     scope     three.ws OAuth scope required for the plan-billing path
//     summary   one line for discovery
//     params    documented inputs for discovery

import { env } from '../_lib/env.js';

function required(value, name) {
	const v = value == null ? '' : String(value).trim();
	if (!v) {
		const err = new Error(`query param "${name}" is required`);
		err.status = 400;
		err.code = 'missing_param';
		throw err;
	}
	return v;
}

// ── DexScreener helpers ──────────────────────────────────────────────────────

// Cap a comma-separated address list at `cap` entries (DexScreener's own
// /latest/dex/tokens/ limit is 30) — trims whitespace, drops empties.
function capAddressList(csv, cap = 30) {
	return csv
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, cap)
		.join(',');
}

// DexScreener pairs are large (~30 fields incl. boosts/presale/social info);
// slim to the fields an agent actually reasons over. Shared by token/search/pair.
function slimDexPair(p) {
	if (!p || typeof p !== 'object') return null;
	return {
		chainId: p.chainId ?? null,
		dexId: p.dexId ?? null,
		pairAddress: p.pairAddress ?? null,
		baseToken: p.baseToken
			? { address: p.baseToken.address ?? null, name: p.baseToken.name ?? null, symbol: p.baseToken.symbol ?? null }
			: null,
		quoteToken: p.quoteToken ? { symbol: p.quoteToken.symbol ?? null } : null,
		priceUsd: p.priceUsd ?? null,
		priceNative: p.priceNative ?? null,
		liquidity: { usd: p.liquidity?.usd ?? null },
		fdv: p.fdv ?? null,
		marketCap: p.marketCap ?? null,
		volume: { h24: p.volume?.h24 ?? null },
		priceChange: { h1: p.priceChange?.h1 ?? null, h6: p.priceChange?.h6 ?? null, h24: p.priceChange?.h24 ?? null },
		txns: { h24: p.txns?.h24 ?? null },
		pairCreatedAt: p.pairCreatedAt ?? null,
		url: p.url ?? null,
	};
}

// token/search/pair all return `{ schemaVersion, pairs: [...] }` — slim + sort
// by liquidity desc + cap so one call never ships a multi-MB payload.
function slimDexPairs(data, cap) {
	const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
	return pairs
		.map(slimDexPair)
		.filter(Boolean)
		.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
		.slice(0, cap);
}

// profiles/boosts are flat arrays of the same shape; slim to the identity +
// social fields agents actually use.
function slimDexProfile(entry) {
	if (!entry || typeof entry !== 'object') return null;
	return {
		chainId: entry.chainId ?? null,
		tokenAddress: entry.tokenAddress ?? null,
		description: entry.description ?? null,
		links: Array.isArray(entry.links) ? entry.links : [],
	};
}

function slimDexProfileList(data, cap = 30) {
	return Array.isArray(data) ? data.slice(0, cap).map(slimDexProfile).filter(Boolean) : [];
}

// ── Solana JSON-RPC helpers ──────────────────────────────────────────────────

// Primary Solana RPC — the best endpoint this deployment can name WITHOUT
// loading the heavy connection pool: an explicit operator URL, else a keyed
// provider (QuickNode/Helius/Alchemy), else the public endpoint. Production
// sets no SOLANA_RPC_URL but does hold HELIUS_API_KEY/ALCHEMY_API_KEY, and
// with the public endpoint as primary every call started with a near-certain
// 429 from a GCP egress IP and burned a failover hop (or two) recovering.
// Mirrors the priority order of solanaRpcEndpoints() in
// api/_lib/solana/connection.js, which remains the failover pool (`bases`).
// Computed once at module load per the registry contract — key changes need a
// redeploy to pick up, same as every other provider `base`.
const SOLANA_RPC_BASE =
	(process.env.SOLANA_RPC_URL && env.SOLANA_RPC_URL) ||
	process.env.QUICKNODE_RPC_URL ||
	(process.env.HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`) ||
	(process.env.ALCHEMY_API_KEY && `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) ||
	env.SOLANA_RPC_URL;

function rpcBody(method, params) {
	return { jsonrpc: '2.0', id: 1, method, params };
}

// Solana JSON-RPC returns errors as HTTP 200 with an `error` envelope — surface
// that as a real HTTP error (never as a 200 payload) before any transform runs.
// -32602/-32601/-32600 are caller mistakes (bad address, bad method/params);
// everything else (rate limits, internal errors) maps to a proxy 502.
function rpcResult(data) {
	if (data && typeof data === 'object' && data.error) {
		const code = data.error.code;
		const isCallerFault = code === -32602 || code === -32601 || code === -32600;
		const e = new Error(data.error.message || 'Solana RPC error');
		e.status = isCallerFault ? 400 : 502;
		e.code = isCallerFault ? 'rpc_invalid_request' : 'rpc_upstream_error';
		e.detail = data.error;
		throw e;
	}
	return data && typeof data === 'object' ? data.result : undefined;
}

function rpcNotFound(message, code) {
	const e = new Error(message);
	e.status = 404;
	e.code = code;
	throw e;
}

// p50/p75/p95/max over a numeric array — nearest-rank method (deterministic,
// no interpolation), sorted ascending internally so callers can pass raw order.
function percentiles(values) {
	const sorted = [...values].sort((a, b) => a - b);
	if (!sorted.length) return { p50: 0, p75: 0, p95: 0, max: 0 };
	const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
	return { p50: at(50), p75: at(75), p95: at(95), max: sorted[sorted.length - 1] };
}

export const PROVIDERS = [
	{
		id: 'coingecko',
		name: 'CoinGecko',
		category: 'crypto-market-data',
		base: 'https://api.coingecko.com/api/v3',
		requiresKey: false,
		// CoinGecko's optional Pro key lifts rate limits; works key-free otherwise.
		envVar: 'COINGECKO_API_KEY',
		byokHeader: 'x-provider-key',
		applyKey: (headers, _url, key) => {
			if (key) headers['x-cg-pro-api-key'] = key;
		},
		endpoints: [
			{
				id: 'price',
				method: 'GET',
				path: '/simple/price',
				query: (q) => ({
					ids: required(q.ids, 'ids'),
					vs_currencies: q.vs_currencies || 'usd',
					include_24hr_change: q.include_24hr_change,
					include_market_cap: q.include_market_cap,
				}),
				// Keyless CoinGecko public tier — generous free quota, funnel-sized.
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Spot price for one or more coins in any fiat/crypto.',
				params: {
					ids: 'comma-separated CoinGecko coin ids, e.g. "solana,bitcoin" (required)',
					vs_currencies: 'comma-separated quote currencies (default "usd")',
					include_24hr_change: 'true to include 24h change',
					include_market_cap: 'true to include market cap',
				},
			},
			{
				id: 'markets',
				method: 'GET',
				path: '/coins/markets',
				query: (q) => ({
					vs_currency: q.vs_currency || 'usd',
					ids: q.ids,
					order: q.order || 'market_cap_desc',
					per_page: Math.min(Math.max(1, Number(q.per_page) || 20), 100),
					page: Number(q.page) || 1,
					price_change_percentage: q.price_change_percentage,
				}),
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '2000',
				scope: 'agents:read',
				summary: 'Ranked market data (price, market cap, volume, change) per coin.',
				params: {
					vs_currency: 'quote currency (default "usd")',
					ids: 'comma-separated coin ids to filter (optional)',
					order: 'sort order (default "market_cap_desc")',
					per_page: 'number 1–100 (default 20)',
					page: 'page number (default 1)',
				},
			},
			{
				id: 'coin',
				method: 'GET',
				// Verified live 2026-07-08: /coins/{id} with the four heavy flags off
				// still returns a full market_data block + a per-language description.
				path: (q) => `/coins/${encodeURIComponent(required(q.id, 'id'))}`,
				query: () => ({
					localization: 'false',
					tickers: 'false',
					community_data: 'false',
					developer_data: 'false',
				}),
				// Full response is heavy (per-currency market_data + multi-language
				// descriptions); keep only USD market essentials + a truncated English
				// description so one call stays small.
				transform: (data) => {
					if (!data || typeof data !== 'object') return data;
					const md = data.market_data || {};
					const usd = (obj) => (obj && typeof obj === 'object' ? obj.usd : undefined);
					const description = typeof data.description?.en === 'string' ? data.description.en.slice(0, 500) : null;
					return {
						id: data.id,
						symbol: data.symbol,
						name: data.name,
						description,
						market_cap_rank: data.market_cap_rank,
						price_usd: usd(md.current_price),
						ath_usd: usd(md.ath),
						ath_change_percentage: usd(md.ath_change_percentage),
						atl_usd: usd(md.atl),
						atl_change_percentage: usd(md.atl_change_percentage),
						market_cap_usd: usd(md.market_cap),
						fully_diluted_valuation_usd: usd(md.fully_diluted_valuation),
						total_volume_usd: usd(md.total_volume),
						circulating_supply: md.circulating_supply,
						total_supply: md.total_supply,
						max_supply: md.max_supply,
						price_change_percentage_24h: md.price_change_percentage_24h,
						price_change_percentage_7d: md.price_change_percentage_7d,
						price_change_percentage_30d: md.price_change_percentage_30d,
						last_updated: md.last_updated,
					};
				},
				free: { perMin: 20, perDay: 1500 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Full market snapshot for one coin — price, ATH/ATL, supply, multi-window change, truncated description.',
				params: { id: 'CoinGecko coin id, e.g. "solana" (required)' },
			},
			{
				id: 'trending',
				method: 'GET',
				// Verified live 2026-07-08: /search/trending → { coins, nfts, categories }.
				path: '/search/trending',
				query: () => ({}),
				transform: (data) => {
					if (!data || typeof data !== 'object') return { coins: [], categories: [] };
					const coins = Array.isArray(data.coins)
						? data.coins.map((c) => ({
								id: c?.item?.id,
								symbol: c?.item?.symbol,
								name: c?.item?.name,
								market_cap_rank: c?.item?.market_cap_rank,
								price_btc: c?.item?.price_btc,
							}))
						: [];
					const categories = Array.isArray(data.categories)
						? data.categories.map((c) => ({
								id: c?.id,
								name: c?.name,
								slug: c?.slug,
								coins_count: c?.coins_count,
								market_cap_usd: c?.data?.market_cap,
							}))
						: [];
					return { coins, categories };
				},
				free: { perMin: 20, perDay: 1500 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Top trending searched coins and hot categories right now.',
				params: {},
			},
			{
				id: 'token-price',
				method: 'GET',
				// Verified live 2026-07-08: /simple/token_price/solana?contract_addresses=…
				path: (q) => `/simple/token_price/${encodeURIComponent(q.platform || 'solana')}`,
				query: (q) => ({
					contract_addresses: required(q.addresses, 'addresses'),
					vs_currencies: q.vs_currencies || 'usd',
				}),
				free: { perMin: 20, perDay: 1500 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Spot price for one or more token contract addresses on a given chain (default Solana).',
				params: {
					platform: 'CoinGecko asset platform id, e.g. "solana" or "ethereum" (default "solana")',
					addresses: 'comma-separated contract addresses, e.g. "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" (required)',
					vs_currencies: 'comma-separated quote currencies (default "usd")',
				},
			},
			{
				id: 'global',
				method: 'GET',
				// Verified live 2026-07-08: /global → { data: { ... } }.
				path: '/global',
				query: () => ({}),
				transform: (data) => {
					const d = data?.data || {};
					return {
						active_cryptocurrencies: d.active_cryptocurrencies,
						markets: d.markets,
						total_market_cap_usd: d.total_market_cap?.usd,
						total_volume_usd: d.total_volume?.usd,
						btc_dominance: d.market_cap_percentage?.btc,
						eth_dominance: d.market_cap_percentage?.eth,
						market_cap_change_percentage_24h_usd: d.market_cap_change_percentage_24h_usd,
						updated_at: d.updated_at,
					};
				},
				free: { perMin: 20, perDay: 1500 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Global crypto market snapshot — total market cap/volume, BTC/ETH dominance, active coin count.',
				params: {},
			},
			{
				id: 'ohlc',
				method: 'GET',
				// Verified live 2026-07-08: /coins/{id}/ohlc?vs_currency=usd&days=1 →
				// [[time_ms, open, high, low, close], …].
				path: (q) => `/coins/${encodeURIComponent(required(q.id, 'id'))}/ohlc`,
				query: (q) => ({
					vs_currency: q.vs_currency || 'usd',
					days: [1, 7, 14, 30].includes(Number(q.days)) ? String(Number(q.days)) : '1',
				}),
				transform: (data) =>
					Array.isArray(data)
						? data.map(([t, o, h, l, c]) => ({ t, o, h, l, c }))
						: [],
				free: { perMin: 20, perDay: 1500 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'OHLC candles for one coin over 1/7/14/30 days.',
				params: {
					id: 'CoinGecko coin id, e.g. "solana" (required)',
					vs_currency: 'quote currency (default "usd")',
					days: 'candle window: 1, 7, 14, or 30 (default 1)',
				},
			},
		],
	},
	{
		id: 'defillama',
		name: 'DefiLlama',
		category: 'defi-data',
		base: 'https://api.llama.fi',
		requiresKey: false,
		envVar: null,
		byokHeader: null,
		applyKey: () => {},
		endpoints: [
			{
				id: 'protocols',
				method: 'GET',
				path: '/protocols',
				query: () => ({}),
				// DefiLlama returns ~3k protocols; slim to the fields callers actually
				// use so one call doesn't ship a multi-MB payload.
				transform: (data) =>
					Array.isArray(data)
						? data
								.map((p) => ({
									name: p.name,
									symbol: p.symbol,
									category: p.category,
									chains: p.chains,
									tvl: p.tvl,
									change_1d: p.change_1d,
									change_7d: p.change_7d,
									mcap: p.mcap,
								}))
								.sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
						: data,
				// Keyless DefiLlama public tier — generous free quota, funnel-sized.
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'All DeFi protocols with current TVL, ranked.',
				params: {},
			},
			{
				id: 'tvl',
				method: 'GET',
				path: (q) => `/tvl/${encodeURIComponent(required(q.protocol, 'protocol'))}`,
				query: () => ({}),
				transform: (data) => ({ tvl_usd: typeof data === 'number' ? data : Number(data) }),
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Current total value locked (USD) for a single protocol.',
				params: { protocol: 'DefiLlama protocol slug, e.g. "uniswap" (required)' },
			},
			{
				id: 'chains',
				method: 'GET',
				// Verified live 2026-07-08: /v2/chains → flat array of every tracked chain.
				path: '/v2/chains',
				query: () => ({}),
				transform: (data) =>
					Array.isArray(data)
						? data
								.map((c) => ({ name: c.name, tvl: c.tvl, tokenSymbol: c.tokenSymbol, chainId: c.chainId }))
								.sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
						: [],
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Every chain DefiLlama tracks, with current TVL, ranked.',
				params: {},
			},
			{
				id: 'protocol',
				method: 'GET',
				// Verified live 2026-07-08: /protocol/{slug} → a HUGE object (full daily
				// TVL history per chain since inception); slim hard.
				path: (q) => `/protocol/${encodeURIComponent(required(q.slug, 'slug'))}`,
				query: () => ({}),
				transform: (data) => {
					if (!data || typeof data !== 'object') return data;
					const series = Array.isArray(data.tvl) ? data.tvl.slice(-30) : [];
					return {
						name: data.name,
						category: data.category,
						chains: data.chains,
						current_chain_tvls_usd: data.currentChainTvls,
						tvl_usd: series.map((p) => ({ date: p.date, tvl: p.totalLiquidityUSD })),
						mcap_usd: data.mcap,
					};
				},
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'One protocol: category, per-chain current TVL, and the last 30 points of its total TVL series.',
				params: { slug: 'DefiLlama protocol slug, e.g. "uniswap" (required)' },
			},
			{
				id: 'chain-tvl',
				method: 'GET',
				// Verified live 2026-07-08: /v2/historicalChainTvl/{chain} → full daily
				// series since inception; slim to the last 90 points.
				path: (q) => `/v2/historicalChainTvl/${encodeURIComponent(required(q.chain, 'chain'))}`,
				query: () => ({}),
				transform: (data) =>
					Array.isArray(data) ? data.slice(-90).map((p) => ({ date: p.date, tvl: p.tvl })) : [],
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Last 90 days of historical total TVL for one chain.',
				params: { chain: 'DefiLlama chain name, e.g. "Solana" (required)' },
			},
		],
	},
	{
		id: 'llama-prices',
		name: 'DefiLlama Prices',
		category: 'crypto-market-data',
		// Sibling API on its own base — separate provider so the descriptor `base`
		// stays a single static URL per the registry contract.
		base: 'https://coins.llama.fi',
		requiresKey: false,
		envVar: null,
		byokHeader: null,
		applyKey: () => {},
		endpoints: [
			{
				id: 'current',
				method: 'GET',
				// Verified live 2026-07-08: /prices/current/{chain:address,…} →
				// { coins: { "chain:address": { decimals, symbol, price, timestamp, confidence } } }.
				path: (q) => `/prices/current/${encodeURIComponent(required(q.coins, 'coins'))}`,
				query: () => ({}),
				transform: (data) => {
					const coins = data?.coins;
					if (!coins || typeof coins !== 'object') return {};
					const out = {};
					for (const [key, v] of Object.entries(coins)) {
						if (!v || typeof v !== 'object') continue;
						out[key] = {
							price: v.price,
							symbol: v.symbol,
							decimals: v.decimals,
							timestamp: v.timestamp,
							confidence: v.confidence,
						};
					}
					return out;
				},
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Current price for one or more chain:address tokens (DefiLlama coin-price oracle — covers tokens CoinGecko/Jupiter don\'t index).',
				params: {
					coins: 'comma-separated "chain:address" pairs, e.g. "solana:FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" (required)',
				},
			},
		],
	},
	{
		id: 'llama-stablecoins',
		name: 'DefiLlama Stablecoins',
		category: 'defi-data',
		base: 'https://stablecoins.llama.fi',
		requiresKey: false,
		envVar: null,
		byokHeader: null,
		applyKey: () => {},
		endpoints: [
			{
				id: 'list',
				method: 'GET',
				// Verified live 2026-07-08: /stablecoins?includePrices=true →
				// { peggedAssets: [...] }.
				path: '/stablecoins',
				query: () => ({ includePrices: 'true' }),
				transform: (data) => {
					const assets = data?.peggedAssets;
					if (!Array.isArray(assets)) return [];
					return assets
						.map((a) => ({
							name: a.name,
							symbol: a.symbol,
							pegType: a.pegType,
							price: a.price,
							circulating_usd: a.circulating?.peggedUSD,
							circulating_prev_day_usd: a.circulatingPrevDay?.peggedUSD,
						}))
						.sort((a, b) => (b.circulating_usd || 0) - (a.circulating_usd || 0))
						.slice(0, 50);
				},
				free: { perMin: 30, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Every tracked stablecoin — peg type, price, circulating supply — ranked by circulating USD.',
				params: {},
			},
		],
	},
	{
		id: 'jupiter',
		name: 'Jupiter',
		category: 'crypto-market-data',
		// Jupiter's keyless "lite" tier (no API key). The paid/keyed tier lives on
		// api.jup.ag behind an x-api-key header; the descriptor base is static, so
		// we intentionally stay on the lite base and expose no BYOK header — every
		// endpoint here is Jupiter's free keyless surface.
		base: 'https://lite-api.jup.ag',
		requiresKey: false,
		envVar: null,
		byokHeader: null,
		applyKey: () => {},
		endpoints: [
			{
				id: 'price',
				method: 'GET',
				// Verified live 2026-07-06: /price/v3 responds; /price/v2 → "Route not found".
				path: '/price/v3',
				query: (q) => ({ ids: required(q.ids, 'ids') }),
				// v3 returns { [mint]: { usdPrice, decimals, priceChange24h, liquidity,
				// blockId, createdAt, launchpad? } }. Keep the stable, agent-useful
				// fields under normalized names; unknown mints are simply absent.
				transform: (data) => {
					if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
					const out = {};
					for (const [mint, v] of Object.entries(data)) {
						if (!v || typeof v !== 'object') continue;
						out[mint] = {
							price_usd: v.usdPrice,
							decimals: v.decimals,
							price_change_24h: v.priceChange24h,
							liquidity: v.liquidity,
							block_id: v.blockId,
						};
					}
					return out;
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Live USD price for one or more Solana tokens by mint (Jupiter keyless tier).',
				params: {
					ids: 'comma-separated Solana mint addresses, e.g. "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump,So11111111111111111111111111111111111111112" (required)',
				},
			},
			{
				id: 'quote',
				method: 'GET',
				// Verified live 2026-07-06: /swap/v1/quote responds; /v6/quote → "Route not found".
				path: '/swap/v1/quote',
				query: (q) => ({
					inputMint: required(q.inputMint, 'inputMint'),
					outputMint: required(q.outputMint, 'outputMint'),
					amount: required(q.amount, 'amount'),
					slippageBps: q.slippageBps || '50',
				}),
				// The true executable price. Keep the amounts + impact + a slimmed route
				// (label, mints, percent per hop); drop the heavy AMM/quote-report noise.
				transform: (data) => {
					if (!data || typeof data !== 'object') return data;
					return {
						inputMint: data.inputMint,
						outputMint: data.outputMint,
						inAmount: data.inAmount,
						outAmount: data.outAmount,
						otherAmountThreshold: data.otherAmountThreshold,
						swapMode: data.swapMode,
						slippageBps: data.slippageBps,
						priceImpactPct: data.priceImpactPct,
						routePlan: Array.isArray(data.routePlan)
							? data.routePlan.map((hop) => ({
									label: hop?.swapInfo?.label,
									inputMint: hop?.swapInfo?.inputMint,
									outputMint: hop?.swapInfo?.outputMint,
									percent: hop?.percent,
								}))
							: [],
					};
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Executable swap quote (true routed price) between two Solana mints (Jupiter keyless tier).',
				params: {
					inputMint: 'input token mint address, e.g. "So11111111111111111111111111111111111111112" (required)',
					outputMint: 'output token mint address, e.g. USDC "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" (required)',
					amount: 'input amount in atomic units (integer string), e.g. "1000000000" for 1 SOL (required)',
					slippageBps: 'allowed slippage in basis points (default "50" = 0.5%)',
				},
			},
			{
				id: 'token-search',
				method: 'GET',
				// Verified live 2026-07-06: /tokens/v2/search responds; /tokens/v1/* → "Route not found".
				path: '/tokens/v2/search',
				query: (q) => ({ query: required(q.query, 'query') }),
				// v2 search returns a rich array; slim each hit to the identity fields
				// agents use and derive 24h volume from the stats24h buy/sell split.
				// Cap 20 so one call never ships a multi-hundred-KB payload.
				transform: (data) => {
					if (!Array.isArray(data)) return [];
					return data.slice(0, 20).map((t) => {
						const s = t?.stats24h;
						const daily_volume =
							s && (s.buyVolume != null || s.sellVolume != null)
								? (Number(s.buyVolume) || 0) + (Number(s.sellVolume) || 0)
								: undefined;
						return {
							address: t?.id,
							name: t?.name,
							symbol: t?.symbol,
							decimals: t?.decimals,
							logoURI: t?.icon,
							tags: Array.isArray(t?.tags) ? t.tags : undefined,
							daily_volume,
						};
					});
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Search Solana tokens by name/symbol/mint → address, metadata, tags, 24h volume (Jupiter keyless tier).',
				params: {
					query: 'search text — token name, symbol, or mint address, e.g. "three.ws" or a mint (required)',
				},
			},
		],
	},
	{
		id: 'openai',
		name: 'OpenAI-compatible LLM',
		category: 'ai-inference',
		base: 'https://api.openai.com/v1',
		requiresKey: true,
		envVar: 'OPENAI_API_KEY',
		byokHeader: 'x-provider-key',
		applyKey: (headers, _url, key) => {
			if (key) headers['authorization'] = `Bearer ${key}`;
		},
		endpoints: [
			{
				id: 'chat',
				method: 'POST',
				path: '/chat/completions',
				body: (b) => {
					if (!b || typeof b !== 'object' || !Array.isArray(b.messages)) {
						const err = new Error('body must include a "messages" array');
						err.status = 400;
						err.code = 'validation_error';
						throw err;
					}
					return b;
				},
				priceAtomics: '5000',
				scope: 'agents:write',
				summary: 'Chat completions against any OpenAI-compatible model (BYOK supported).',
				params: {
					model: 'model id (required)',
					messages: 'array of {role, content} (required)',
					'…': 'any other OpenAI chat-completions parameter is forwarded',
				},
			},
		],
	},
	{
		id: 'grok',
		name: 'Grok (xAI)',
		category: 'ai-inference',
		base: 'https://api.x.ai/v1',
		requiresKey: true,
		envVar: 'GROK_API_KEY',
		byokHeader: 'x-provider-key',
		applyKey: (headers, _url, key) => {
			if (key) headers['authorization'] = `Bearer ${key}`;
		},
		endpoints: [
			{
				id: 'chat',
				method: 'POST',
				path: '/chat/completions',
				body: (b) => {
					if (!b || typeof b !== 'object' || !Array.isArray(b.messages)) {
						const err = new Error('body must include a "messages" array');
						err.status = 400;
						err.code = 'validation_error';
						throw err;
					}
					return b;
				},
				priceAtomics: '5000',
				scope: 'agents:write',
				summary: 'Chat completions against xAI Grok models (grok-4.5, grok-4.3, grok-4.1-fast; BYOK supported).',
				params: {
					model: 'Grok model id, e.g. "grok-4.5" (required)',
					messages: 'array of {role, content} (required)',
					'…': 'any other OpenAI chat-completions parameter is forwarded',
				},
			},
		],
	},
	{
		id: 'dexscreener',
		name: 'DexScreener',
		category: 'crypto-market-data',
		// Keyless public API — no key, no BYOK header, no envVar. Upstream limits
		// are ~300/min for token/search/pair and ~60/min shared for profiles/
		// boosts; our `free` quotas below stay well under both.
		base: 'https://api.dexscreener.com',
		requiresKey: false,
		envVar: null,
		byokHeader: null,
		applyKey: () => {},
		endpoints: [
			{
				id: 'token',
				method: 'GET',
				// Verified live 2026-07-08: /latest/dex/tokens/{addresses} →
				// { schemaVersion, pairs: [...] } for the $THREE mint.
				path: (q) => `/latest/dex/tokens/${encodeURIComponent(capAddressList(required(q.addresses, 'addresses')))}`,
				query: () => ({}),
				transform: (data) => slimDexPairs(data, 30),
				free: { perMin: 30, perDay: 3000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Live DEX pairs (price, liquidity, volume, txns) for one or more token addresses, deepest liquidity first.',
				params: {
					addresses: 'comma-separated token contract addresses, up to 30, e.g. "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" (required)',
				},
			},
			{
				id: 'search',
				method: 'GET',
				// Verified live 2026-07-08: /latest/dex/search?q= → same { pairs: [...] } shape.
				path: '/latest/dex/search',
				query: (q) => ({ q: required(q.q, 'q') }),
				transform: (data) => slimDexPairs(data, 20),
				free: { perMin: 30, perDay: 3000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Search DEX pairs by token name, symbol, or address, deepest liquidity first.',
				params: {
					q: 'search text — token name, symbol, or address, e.g. "three.ws" or "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" (required)',
				},
			},
			{
				id: 'pair',
				method: 'GET',
				// Verified live 2026-07-08: /latest/dex/pairs/{chain}/{pair} → same { pairs: [...] } shape.
				path: (q) =>
					`/latest/dex/pairs/${encodeURIComponent(required(q.chain, 'chain'))}/${encodeURIComponent(required(q.pair, 'pair'))}`,
				query: () => ({}),
				transform: (data) => slimDexPairs(data, 30),
				free: { perMin: 30, perDay: 3000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Live pair data for one DexScreener chainId + on-chain pair address.',
				params: {
					chain: 'DexScreener chainId, e.g. "solana" (required)',
					pair: 'on-chain pair/pool address, e.g. the $THREE/SOL pumpswap pair "5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z" (required)',
				},
			},
			{
				id: 'profiles',
				method: 'GET',
				// Verified live 2026-07-08: /token-profiles/latest/v1 → flat array.
				path: '/token-profiles/latest/v1',
				query: () => ({}),
				transform: (data) => slimDexProfileList(data, 30),
				free: { perMin: 10, perDay: 500 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Latest DexScreener token profiles — freshly listed projects with descriptions and social links.',
				params: {},
			},
			{
				id: 'boosts',
				method: 'GET',
				// Verified live 2026-07-08: /token-boosts/latest/v1 → flat array.
				path: '/token-boosts/latest/v1',
				query: () => ({}),
				transform: (data) => slimDexProfileList(data, 30),
				free: { perMin: 10, perDay: 500 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Latest DexScreener boosted tokens — paid promotion signal, not an endorsement or ranking by quality.',
				params: {},
			},
		],
	},
	{
		id: 'solana',
		name: 'Solana RPC',
		category: 'onchain-data',
		// Same env resolution every other Solana caller on the platform uses
		// (api/_lib/env.js) — a configured Helius/Quicknode/Triton URL, or the
		// public mainnet endpoint as a working fallback.
		base: SOLANA_RPC_BASE,
		// The platform's full priority-ordered RPC pool (operator endpoint,
		// QuickNode, Helius, Alchemy, then public hosts), used by the aggregator
		// only after the primary answers 429/5xx — a public RPC rate-limiting us
		// is not a reason to fail a caller when six healthy alternates exist.
		// Imported lazily so the happy path never loads @solana/web3.js.
		bases: async () => {
			const { solanaRpcEndpoints } = await import('../_lib/solana/connection.js');
			return solanaRpcEndpoints('mainnet');
		},
		requiresKey: false,
		envVar: null,
		byokHeader: null,
		applyKey: () => {},
		endpoints: [
			{
				id: 'balance',
				method: 'GET',
				// GET caller-side; the upstream is Solana's single JSON-RPC POST
				// endpoint. See `upstreamMethod` in the descriptor contract above.
				upstreamMethod: 'POST',
				path: '',
				body: (q) => rpcBody('getBalance', [required(q.address, 'address')]),
				// Verified live 2026-07-08: { result: { context, value: <lamports> } }.
				transform: (data) => {
					const result = rpcResult(data);
					const lamports = typeof result?.value === 'number' ? result.value : null;
					return { lamports, sol: lamports != null ? lamports / 1e9 : null };
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Native SOL balance of any wallet address.',
				params: {
					address: 'Solana base58 wallet address, e.g. "11111111111111111111111111111111" (required)',
				},
			},
			{
				id: 'token-holdings',
				method: 'GET',
				upstreamMethod: 'POST',
				path: '',
				body: (q) =>
					rpcBody('getTokenAccountsByOwner', [
						required(q.owner, 'owner'),
						{ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
						{ encoding: 'jsonParsed' },
					]),
				// Verified live 2026-07-08: { result: { value: [{ pubkey, account: {
				// data: { parsed: { info: { mint, tokenAmount: { amount, decimals,
				// uiAmount } } } } } }] } }.
				transform: (data) => {
					const result = rpcResult(data);
					const value = Array.isArray(result?.value) ? result.value : [];
					return value
						.map((entry) => {
							const info = entry?.account?.data?.parsed?.info;
							const amt = info?.tokenAmount;
							if (!info || !amt) return null;
							return {
								mint: info.mint ?? null,
								amount: amt.amount ?? null,
								decimals: amt.decimals ?? null,
								uiAmount: amt.uiAmount ?? null,
							};
						})
						.filter((t) => t && t.uiAmount)
						.sort((a, b) => (b.uiAmount || 0) - (a.uiAmount || 0));
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'SPL token holdings of a wallet (mint, amount, decimals), zero balances filtered, largest first.',
				params: {
					owner: 'Solana base58 wallet address, e.g. "11111111111111111111111111111111" (required)',
				},
			},
			{
				id: 'token-supply',
				method: 'GET',
				upstreamMethod: 'POST',
				path: '',
				body: (q) => rpcBody('getTokenSupply', [required(q.mint, 'mint')]),
				// Verified live 2026-07-08 ($THREE mint): { result: { value: {
				// amount, decimals, uiAmount, uiAmountString } } }.
				transform: (data) => {
					const result = rpcResult(data);
					const v = result?.value;
					if (!v) rpcNotFound('mint not found or not an SPL token', 'mint_not_found');
					return { amount: v.amount ?? null, decimals: v.decimals ?? null, uiAmount: v.uiAmount ?? null };
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Total circulating supply of an SPL token mint.',
				params: {
					mint: 'Solana token mint address, e.g. "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" (required)',
				},
			},
			{
				id: 'largest-holders',
				method: 'GET',
				upstreamMethod: 'POST',
				path: '',
				body: (q) => rpcBody('getTokenLargestAccounts', [required(q.mint, 'mint')]),
				// Documented shape (getTokenLargestAccounts, top 20 by protocol limit):
				// { result: { value: [{ address, amount, decimals, uiAmount,
				// uiAmountString }] } }.
				transform: (data) => {
					const result = rpcResult(data);
					const value = Array.isArray(result?.value) ? result.value : [];
					return value
						.slice(0, 20)
						.map((v) => ({ address: v.address ?? null, uiAmount: v.uiAmount ?? null }));
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Top 20 holder token-accounts of an SPL token mint by balance.',
				params: {
					mint: 'Solana token mint address, e.g. "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" (required)',
				},
			},
			{
				id: 'transaction',
				method: 'GET',
				upstreamMethod: 'POST',
				path: '',
				body: (q) =>
					rpcBody('getTransaction', [
						required(q.signature, 'signature'),
						{ encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
					]),
				// Verified live 2026-07-08 (real $THREE transfer signature): { result: {
				// slot, blockTime, transaction: { message: { accountKeys: [{ pubkey,
				// signer }] }, signatures }, meta: { fee, err, logMessages,
				// preTokenBalances, postTokenBalances } } }. result is null when the
				// signature is unknown/not yet finalized — surfaced as 404, not a
				// payload of nulls.
				transform: (data) => {
					const result = rpcResult(data);
					if (!result) rpcNotFound('transaction not found (unknown signature or not yet finalized)', 'transaction_not_found');
					const meta = result.meta || {};
					const accountKeys = Array.isArray(result.transaction?.message?.accountKeys)
						? result.transaction.message.accountKeys
						: [];
					const signers = accountKeys.filter((k) => k?.signer).map((k) => k.pubkey);

					// Pre/post SPL token balance deltas keyed by accountIndex+mint — the
					// one number an agent actually wants ("how much moved"), not two
					// snapshots it has to diff itself.
					const byKey = new Map();
					for (const b of Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : []) {
						byKey.set(`${b.accountIndex}:${b.mint}`, { mint: b.mint, owner: b.owner ?? null, pre: b.uiTokenAmount?.uiAmount ?? 0, post: 0 });
					}
					for (const b of Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : []) {
						const key = `${b.accountIndex}:${b.mint}`;
						const existing = byKey.get(key);
						if (existing) existing.post = b.uiTokenAmount?.uiAmount ?? 0;
						else byKey.set(key, { mint: b.mint, owner: b.owner ?? null, pre: 0, post: b.uiTokenAmount?.uiAmount ?? 0 });
					}
					const tokenBalanceChanges = [...byKey.values()]
						.map((v) => ({ mint: v.mint, owner: v.owner, delta: (v.post || 0) - (v.pre || 0) }))
						.filter((v) => v.delta !== 0);

					return {
						slot: result.slot ?? null,
						blockTime: result.blockTime ?? null,
						fee: meta.fee ?? null,
						err: meta.err ?? null,
						signers,
						logMessages: Array.isArray(meta.logMessages) ? meta.logMessages.slice(0, 20) : [],
						tokenBalanceChanges,
					};
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Confirmed transaction detail by signature — fee, error, signers, log lines, and SPL token balance deltas.',
				params: {
					signature: 'base58 transaction signature (required)',
				},
			},
			{
				id: 'account',
				method: 'GET',
				upstreamMethod: 'POST',
				path: '',
				body: (q) => rpcBody('getAccountInfo', [required(q.address, 'address'), { encoding: 'jsonParsed' }]),
				// Verified live 2026-07-08 ($THREE mint): { result: { value: {
				// owner, lamports, executable, data: { program, parsed: { type } } } } }.
				// result.value is null for an unfunded/nonexistent address.
				transform: (data) => {
					const result = rpcResult(data);
					if (!result?.value) rpcNotFound('account not found (unfunded or nonexistent address)', 'account_not_found');
					const v = result.value;
					return {
						owner: v.owner ?? null,
						lamports: v.lamports ?? null,
						executable: Boolean(v.executable),
						program: v.data?.program ?? null,
						parsedType: v.data?.parsed?.type ?? null,
					};
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Account info for any address — owning program, lamports, executable flag, parsed data type.',
				params: {
					address: 'Solana base58 address, e.g. "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" (required)',
				},
			},
			{
				id: 'priority-fees',
				method: 'GET',
				upstreamMethod: 'POST',
				path: '',
				body: () => rpcBody('getRecentPrioritizationFees', []),
				// Verified live 2026-07-08: { result: [{ slot, prioritizationFee }, ...] }
				// for the last ~150 slots.
				transform: (data) => {
					const result = rpcResult(data);
					const fees = Array.isArray(result) ? result.map((r) => Number(r.prioritizationFee) || 0) : [];
					return percentiles(fees);
				},
				free: { perMin: 20, perDay: 2000 },
				priceAtomics: '1000',
				scope: 'agents:read',
				summary: 'Recent prioritization fee landscape (p50/p75/p95/max micro-lamports) over the last ~150 slots.',
				params: {},
			},
		],
	},
];

// Flat lookup map: "provider/endpoint" → { provider, endpoint }.
export const ENDPOINT_INDEX = new Map();
for (const provider of PROVIDERS) {
	for (const endpoint of provider.endpoints) {
		ENDPOINT_INDEX.set(`${provider.id}/${endpoint.id}`, { provider, endpoint });
	}
}

/** Machine-readable catalog of every aggregated endpoint, for discovery. */
export function providerCatalog() {
	return PROVIDERS.map((p) => ({
		id: p.id,
		name: p.name,
		category: p.category,
		key: p.requiresKey ? 'required (platform key or BYOK)' : 'optional',
		byok: Boolean(p.byokHeader),
		endpoints: p.endpoints.map((e) => ({
			id: e.id,
			method: e.method,
			path: `/api/v1/x/${p.id}/${e.id}`,
			scope: e.scope,
			price_usdc_atomics: e.priceAtomics,
			summary: e.summary,
			params: e.params,
			free: e.free || false,
		})),
	}));
}
