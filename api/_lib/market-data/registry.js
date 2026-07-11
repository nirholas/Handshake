// Market Data API registry — the single source of truth for the paid x402
// market-data endpoint family (/api/x402/market-*).
//
// One entry per category. Everything derives from here so nothing drifts:
//   • api/_lib/service-catalog/services/market-data.js — projects each entry
//     into a paid-service descriptor for the unified catalog (and from there
//     the /.well-known/x402.json discovery doc + OKX storefront).
//   • api/_lib/market-data/endpoint.js — builds each live paidEndpoint (the
//     402 challenge, bazaar block, and handler) from the same entry.
//   • api/x402/market.js — the free front-door index that lists the bundle.
//
// This file is PURE METADATA (no fetch imports) — the service-catalog barrel
// loads it inside api/wk.js, so it must stay dependency-free. The fetch
// implementations live in ./fetch.js, keyed by the same slug; endpoint.js
// asserts at module load that every entry has a fetcher.
//
// The data behind every category is the exact payload the three.ws /markets
// pages run on (api/coin/*, api/defi/* exported builders) — battle-tested
// normalization, in-memory caching, and upstream failover included. The paid
// surface exists for agents: machine-discoverable via the bazaar, no per-IP
// rate limits, one USDC micro-payment per call on Solana or Base.

export const MARKET_SERVICE_NAME = 'three.ws Market Data';

// $0.001 USDC per category call; the pulse bundle aggregates seven categories
// in one response and prices at $0.005. Ops override per endpoint via
// X402_PRICE_MARKET_<CATEGORY> (see api/_lib/x402-prices.js).
const LIST_PRICE = '1000';
const PULSE_PRICE = '5000';

const str = (description) => ({ type: 'string', description });

export const MARKET_CATEGORIES = Object.freeze([
	{
		slug: 'market-coins',
		title: 'Coin Markets',
		useCase:
			'Ranked coin market table — price, market cap, 24h volume, 24h/7d change, and a 7-day sparkline for up to 250 coins per call, with sector scoping and coin-id search.',
		description:
			'Ranked cryptocurrency market table for agents — pay $0.001 USDC per call. Returns price, market cap, 24h volume, 24h/7d percentage change, rank, logo, and a downsampled 7-day sparkline per coin (up to 250 per page). Scope to one sector with ?category=<coingecko-category-id>, page with ?page=&per_page=, or resolve names/tickers to coin ids with ?q=<text>. CoinGecko primary with CoinLore failover — the same feed behind three.ws/coins.',
		tags: ['crypto', 'market-data', 'prices', 'coins'],
		useCases: ['portfolio pricing', 'market screening', 'coin id resolution'],
		priceAtomics: LIST_PRICE,
		inputExample: { page: '1', per_page: '100' },
		inputSchema: {
			type: 'object',
			properties: {
				page: str('Page number, 1–20. Default 1.'),
				per_page: str('Rows per page, 10–250. Default 100.'),
				category: str('Optional CoinGecko category id (e.g. artificial-intelligence) to scope the table to one sector.'),
				q: str('Search mode: resolve a name/ticker to CoinGecko coin ids (returns top-10 matches instead of the table).'),
			},
		},
		outputExample: {
			coins: [
				{
					id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1,
					price: 108234.12, change_24h: 1.42, change_7d: 4.87,
					market_cap: 2140000000000, volume_24h: 38200000000,
					sparkline: [106900.1, 107544.8, 108234.12],
				},
			],
			page: 1, per_page: 100, category: null,
		},
	},
	{
		slug: 'market-coin',
		title: 'Coin Profile',
		useCase:
			'Full profile for one coin by CoinGecko id or Solana contract — market stats, ATH/ATL, supply, links, developer and community metrics, sentiment, plain-text description.',
		description:
			'Rich single-coin profile for agents — pay $0.001 USDC per call. Pass ?id=<coingecko-id> (e.g. bitcoin) or ?contract=<solana-mint>. Returns live market stats (price, cap, FDV, volume, 1h→1y change windows, ATH/ATL, supply), official links, per-chain contract addresses, developer activity, community size, sentiment votes, and a sanitized plain-text description. The id or contract is supplied at runtime — generic coin-agnostic plumbing, same data behind the three.ws/coin pages.',
		tags: ['crypto', 'market-data', 'coin', 'due-diligence'],
		useCases: ['token due-diligence', 'fundamental snapshot', 'agent research'],
		priceAtomics: LIST_PRICE,
		inputExample: { id: 'bitcoin' },
		inputSchema: {
			type: 'object',
			properties: {
				id: str('CoinGecko coin id (lowercase slug, e.g. bitcoin). Required unless contract is set.'),
				contract: str('Solana token mint (base58) — alternative lookup key to id.'),
			},
		},
		outputExample: {
			coin: {
				id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1,
				market: { price: 108234.12, market_cap: 2140000000000, ath: 126789.55 },
				links: { homepage: 'https://bitcoin.org' },
			},
		},
	},
	{
		slug: 'market-chart',
		title: 'Price History',
		useCase:
			'Historical USD price series for any coin — [timestamp, price] pairs over 1, 7, 30, 90, or 365 days, granularity auto-chosen per window.',
		description:
			'Historical price series for agents — pay $0.001 USDC per call. Pass ?id=<coingecko-id>&days=<1|7|30|90|365>. Returns a compact [[timestamp_ms, price_usd], …] array with upstream-chosen granularity (5-minutely for 1 day, hourly to 90 days, daily beyond). The coin id is supplied at runtime — the same series behind the three.ws/coin charts.',
		tags: ['crypto', 'market-data', 'chart', 'history'],
		useCases: ['backtesting', 'trend analysis', 'chart rendering'],
		priceAtomics: LIST_PRICE,
		inputExample: { id: 'bitcoin', days: '30' },
		inputSchema: {
			type: 'object',
			required: ['id'],
			properties: {
				id: str('CoinGecko coin id (lowercase slug, e.g. bitcoin).'),
				days: str('Window: 1, 7, 30, 90, or 365. Default 30.'),
			},
		},
		outputExample: { data: [[1751846400000, 107544.8], [1751932800000, 108234.12]], days: 30 },
	},
	{
		slug: 'market-categories',
		title: 'Sector Leaderboard',
		useCase:
			'Every CoinGecko sector ranked by market cap — AI, L1, memes, DeFi and hundreds more, with 24h cap change, volume, and top-3 coin logos.',
		description:
			'Crypto sector leaderboard for agents — pay $0.001 USDC per call. Returns every CoinGecko category (AI, layer-1, memecoins, DeFi, RWA, …) ranked by market cap, each with 24h market-cap change, 24h volume, and its top-3 coins. Feed a category id into the market-coins endpoint to drill into one sector. Same data behind three.ws/categories.',
		tags: ['crypto', 'market-data', 'sectors', 'narratives'],
		useCases: ['narrative rotation tracking', 'sector screening'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			categories: [
				{ id: 'artificial-intelligence', name: 'Artificial Intelligence', market_cap: 48200000000, market_cap_change_24h: 2.1, volume_24h: 3900000000 },
			],
		},
	},
	{
		slug: 'market-exchanges',
		title: 'Exchange Rankings',
		useCase:
			'Top 100 spot exchanges ranked by trust score, with 24h volume in BTC and USD, country, and year established.',
		description:
			'Spot exchange rankings for agents — pay $0.001 USDC per call. Returns the top 100 crypto exchanges ranked by CoinGecko trust score, each with 24h trading volume in BTC and USD (converted at the live BTC price), trust rank, country, year established, and homepage. Same data behind three.ws/exchanges.',
		tags: ['crypto', 'market-data', 'exchanges', 'volume'],
		useCases: ['venue selection', 'liquidity comparison'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			exchanges: [
				{ id: 'binance', name: 'Binance', trust_score: 10, trust_score_rank: 1, volume_24h_usd: 21400000000, country: 'Cayman Islands' },
			],
			btc_usd: 108234.12,
		},
	},
	{
		slug: 'market-derivatives',
		title: 'Derivatives Markets',
		useCase:
			'Perpetual futures tickers — price, funding rate, open interest, 24h volume across venues — or the derivatives-exchange leaderboard by open interest.',
		description:
			'Derivatives market data for agents — pay $0.001 USDC per call. Default mode returns the top 100 perpetual futures contracts by 24h volume with price, 24h change, funding rate, and open interest. Pass ?view=exchanges for the derivatives-venue leaderboard ranked by BTC open interest (perp/futures pair counts included). Same data behind three.ws/derivatives.',
		tags: ['crypto', 'market-data', 'derivatives', 'funding'],
		useCases: ['funding-rate scanning', 'open-interest tracking'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: {
			type: 'object',
			properties: {
				view: str("Set to 'exchanges' for the derivatives-venue leaderboard; omit for perp tickers."),
			},
		},
		outputExample: {
			tickers: [
				{ market: 'Binance (Futures)', symbol: 'BTCUSDT', price: 108250.5, funding_rate: 0.0042, open_interest: 8120000000, volume_24h: 19800000000 },
			],
		},
	},
	{
		slug: 'market-global',
		title: 'Global Market Snapshot',
		useCase:
			'Whole-market stats in one call — total market cap, 24h volume, BTC/ETH dominance, active coins, plus the Fear & Greed index.',
		description:
			'Global crypto market snapshot for agents — pay $0.001 USDC per call. Returns total market cap, 24h volume, top-2 dominance shares, active coin count (CoinGecko → CoinPaprika → CoinLore failover), and the alternative.me Fear & Greed index with its label. The one-call market-regime check. Same data behind the three.ws/coins stats bar and /fear-greed.',
		tags: ['crypto', 'market-data', 'sentiment', 'macro'],
		useCases: ['market-regime detection', 'risk dashboards'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			market: { total_market_cap: 3920000000000, total_volume_24h: 148000000000, btc_dominance: 54.6 },
			fear_greed: { value: 72, label: 'Greed' },
		},
	},
	{
		slug: 'market-gas',
		title: 'Ethereum Gas Oracle',
		useCase:
			'Live ETH gas in three tiers (slow/standard/fast) computed from on-chain fee history, with USD cost estimates for transfers, swaps, and mints.',
		description:
			'Live Ethereum gas oracle for agents — pay $0.001 USDC per call. Computes slow/standard/fast tiers from eth_feeHistory over the last ~20 blocks (base fee + 25th/50th/90th priority-fee percentiles, median-smoothed) across failover public RPCs — no third-party gas API. Each tier carries USD cost estimates for an ETH transfer, token transfer, DEX swap, and NFT mint at the live ETH price. Same oracle behind three.ws/gas.',
		tags: ['ethereum', 'gas', 'fees', 'onchain'],
		useCases: ['transaction timing', 'cost estimation'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			tiers: [
				{ key: 'standard', gas_price_gwei: 6.4, actions: [{ key: 'swap', label: 'DEX swap', gas: 150000, usd: 3.12 }] },
			],
			eth_price_usd: 3251.7,
		},
	},
	{
		slug: 'market-trending',
		title: 'Trending Assets',
		useCase:
			"The last 24h's most-searched coins, categories, and NFT collections — early attention signals before they show up in price.",
		description:
			'Trending crypto assets for agents — pay $0.001 USDC per call. Returns the most-searched coins on CoinGecko over the last 24 hours (with price, 24h change, market cap, and trending rank), the trending categories, and the trending NFT collections (floor price and 24h floor change). Attention flows before price — this is the early signal. Same data behind three.ws/markets/trending.',
		tags: ['crypto', 'market-data', 'trending', 'attention'],
		useCases: ['momentum discovery', 'narrative detection'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			coins: [{ id: 'sui', symbol: 'SUI', rank: 12, score: 0, price_usd: 4.82, change_24h_pct: 11.3 }],
			categories: [{ slug: 'ai-agents', name: 'AI Agents', mcap_change_1h_pct: 1.9 }],
		},
	},
	{
		slug: 'market-defi',
		title: 'DeFi Protocol TVL',
		useCase:
			'Top 100 DeFi protocols ranked by TVL with 1d/7d change, chains, category, and market cap, plus whole-market TVL totals (CEX reserves excluded).',
		description:
			'DeFi protocol rankings for agents — pay $0.001 USDC per call. Returns the top 100 DeFi protocols by TVL from DeFiLlama with 1d/7d TVL change, deployed chains, category, token symbol, and market cap — plus whole-market total TVL and protocol count with centralized-exchange reserves excluded so the totals mean actual DeFi. Same data behind three.ws/defi.',
		tags: ['defi', 'tvl', 'protocols', 'market-data'],
		useCases: ['protocol screening', 'TVL momentum tracking'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			total_tvl: 208000000000,
			protocol_count: 4213,
			protocols: [{ slug: 'aave-v3', name: 'AAVE V3', category: 'Lending', tvl: 28100000000, change_7d: 3.4, chain_count: 14 }],
		},
	},
	{
		slug: 'market-chains',
		title: 'Chain TVL Leaderboard',
		useCase:
			'Every chain ranked by DeFi TVL with native token symbol and share of total locked value — the cross-chain capital map.',
		description:
			'Cross-chain TVL leaderboard for agents — pay $0.001 USDC per call. Returns the top 100 blockchains ranked by DeFi TVL from DeFiLlama, each with its native token symbol and percentage share of total locked value, plus the whole-market TVL and chain count. Where the capital actually lives, one call. Same data behind three.ws/chains.',
		tags: ['defi', 'tvl', 'chains', 'market-data'],
		useCases: ['chain selection', 'capital-flow tracking'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			total_tvl: 208000000000,
			chains: [{ name: 'Ethereum', tvl: 112000000000, token_symbol: 'ETH', share_pct: 53.8 }],
		},
	},
	{
		slug: 'market-yields',
		title: 'DeFi Yield Explorer',
		useCase:
			'Query ~15,000 DeFi yield pools — filter by chain, project, stablecoin-only, or TVL floor, sort by APY or TVL, or pull one pool\'s APY/TVL history.',
		description:
			'DeFi yield-pool explorer for agents — pay $0.001 USDC per call. Queries ~15,000 pools from DeFiLlama: filter with ?chain=&project=&stablecoin=&search=&minTvl=, sort by tvl or apy (APY sort is dust-guarded to pools ≥ $10k TVL so fake five-digit APYs never outrank real venues), page with limit/offset. Each pool carries APY split (base/reward), 30-day mean, IL risk, exposure, and predicted outlook. Pass ?pool=<uuid> for one pool\'s APY/TVL history. Same engine behind three.ws/yields.',
		tags: ['defi', 'yield', 'apy', 'pools'],
		useCases: ['yield hunting', 'stablecoin farming', 'APY history'],
		priceAtomics: LIST_PRICE,
		inputExample: { chain: 'solana', stablecoin: 'true', sort: 'apy' },
		inputSchema: {
			type: 'object',
			properties: {
				chain: str('Filter to one chain (case-insensitive, e.g. solana).'),
				project: str('Filter to one protocol slug (e.g. aave-v3).'),
				stablecoin: str("'true' for stablecoin pools only, 'false' to exclude them."),
				search: str('Substring match over symbol, project, and chain.'),
				minTvl: str('Minimum pool TVL in USD.'),
				sort: str("'tvl' (default) or 'apy' (dust-guarded to pools ≥ $10k TVL)."),
				limit: str('Rows per page, 1–200. Default 100.'),
				offset: str('Pagination offset. Default 0.'),
				pool: str('Chart mode: a DeFiLlama pool uuid — returns that pool\'s APY/TVL history instead of the list.'),
			},
		},
		outputExample: {
			pools: [
				{ pool: '747c1d2a-c668-4682-b9f9-296708a3dd90', chain: 'Ethereum', project: 'lido', symbol: 'STETH', tvl_usd: 24100000000, apy: 2.9, stablecoin: false },
			],
			total: 15234, stats: { median_apy: 4.1 },
		},
	},
	{
		slug: 'market-stablecoins',
		title: 'Stablecoin Monitor',
		useCase:
			'Top 100 stablecoins by circulating supply with live price for peg health, peg mechanism, and chain deployments, plus total stablecoin market cap.',
		description:
			'Stablecoin market monitor for agents — pay $0.001 USDC per call. Returns the top 100 pegged assets by on-chain circulating supply from DeFiLlama, each with live price (peg-health check), peg type and mechanism, and the chains it lives on — plus the total stablecoin market cap across every tracked asset. Same data behind three.ws/stablecoins.',
		tags: ['stablecoins', 'defi', 'peg', 'market-data'],
		useCases: ['peg monitoring', 'stablecoin supply tracking'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			total_mcap: 254000000000,
			stablecoins: [{ id: '1', name: 'Tether', symbol: 'USDT', price: 0.9998, peg_mechanism: 'fiat-backed', circulating_usd: 156000000000, chain_count: 94 }],
		},
	},
	{
		slug: 'market-fees',
		title: 'Protocol Fees & Revenue',
		useCase:
			'Which protocols actually earn — top 100 by 24h fees or revenue with 1d/7d/30d totals and change, plus the whole-market daily chart.',
		description:
			'Protocol fee and revenue rankings for agents — pay $0.001 USDC per call. Returns the top 100 protocols by 24h fees from DeFiLlama with 24h/7d/30d totals and momentum. Default ?type=fees is what users pay to use each protocol; ?type=revenue is the slice the protocol keeps — the closest thing on-chain to an earnings report. Includes whole-market totals and the aggregate daily chart. Same data behind three.ws/fees.',
		tags: ['defi', 'fees', 'revenue', 'fundamentals'],
		useCases: ['fundamental screening', 'real-yield analysis'],
		priceAtomics: LIST_PRICE,
		inputExample: { type: 'fees' },
		inputSchema: {
			type: 'object',
			properties: {
				type: str("'fees' (default — what users pay) or 'revenue' (what the protocol keeps)."),
			},
		},
		outputExample: {
			type: 'fees', total24h: 61000000,
			protocols: [{ name: 'Tether', slug: 'tether', total24h: 18400000, total30d: 512000000 }],
		},
	},
	{
		slug: 'market-dex-volumes',
		title: 'DEX Volume Rankings',
		useCase:
			'Top 100 DEXs by 24h trading volume with 7d totals, market share, and the aggregate daily volume chart.',
		description:
			'DEX trading-volume rankings for agents — pay $0.001 USDC per call. Returns the top 100 decentralized exchanges by 24h volume from DeFiLlama, each with 7d volume, week-over-week change, deployed chains, and its share of whole-market 24h volume — plus market totals and the aggregate daily chart. Same data behind three.ws/dex-volumes.',
		tags: ['defi', 'dex', 'volume', 'market-data'],
		useCases: ['venue routing', 'DEX market-share tracking'],
		priceAtomics: LIST_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			total24h: 9800000000,
			protocols: [{ name: 'Uniswap V3', slug: 'uniswap-v3', total24h: 1820000000, share_pct: 18.6 }],
		},
	},
	{
		slug: 'market-hacks',
		title: 'Exploit Database',
		useCase:
			'Every recorded DeFi hack — amount stolen, technique, classification, chains, funds returned — searchable, with all-time and 12-month loss stats.',
		description:
			'DeFi exploit database for agents — pay $0.001 USDC per call. Returns DeFiLlama\'s full hack history newest-first: amount stolen in USD, attack technique and classification, affected chains, bridge-hack flag, target type, post-mortem link, and funds returned. Search with ?search=<text> over name/technique/classification, page with limit/offset. Headline stats cover all-time and trailing-12-month losses and the bridge-hack share. Same data behind three.ws/hacks.',
		tags: ['security', 'defi', 'hacks', 'risk'],
		useCases: ['protocol risk assessment', 'security research'],
		priceAtomics: LIST_PRICE,
		inputExample: { search: 'bridge' },
		inputSchema: {
			type: 'object',
			properties: {
				search: str('Case-insensitive match over incident name, technique, and classification.'),
				limit: str('Rows per page, 1–200. Default 100.'),
				offset: str('Pagination offset. Default 0.'),
			},
		},
		outputExample: {
			stats: { total_stolen_all_time: 12400000000, incidents_12mo: 61 },
			hacks: [{ name: 'Ronin Network', amount_usd: 624000000, technique: 'Compromised keys', chains: ['Ronin'], bridge: true }],
		},
	},
	{
		slug: 'market-pulse',
		title: 'Market Pulse',
		useCase:
			'The whole market in one paid call — global stats, Fear & Greed, top-10 coins, trending, ETH gas, DeFi TVL, stablecoin supply, DEX volume, and protocol fees.',
		description:
			'The flagship one-call market bundle for agents — pay $0.005 USDC for what would take eight separate calls: global market cap/volume/dominance, the Fear & Greed index, the top-10 coins with 24h/7d change, trending searches, the live ETH gas standard tier, DeFi total TVL with the top-10 protocols, total stablecoin supply, whole-market 24h DEX volume, and 24h protocol fees. Sections degrade independently — one upstream hiccup nulls its section instead of failing the call. The cheapest complete market context an agent can buy.',
		tags: ['crypto', 'market-data', 'bundle', 'macro'],
		useCases: ['agent market context', 'one-call briefing', 'trading loops'],
		priceAtomics: PULSE_PRICE,
		inputExample: {},
		inputSchema: { type: 'object', properties: {} },
		outputExample: {
			global: { total_market_cap: 3920000000000, btc_dominance: 54.6 },
			fear_greed: { value: 72, label: 'Greed' },
			top_coins: [{ id: 'bitcoin', symbol: 'BTC', price: 108234.12, change_24h: 1.42 }],
			gas: { standard_gwei: 6.4, eth_price_usd: 3251.7 },
			defi: { total_tvl: 208000000000 },
			stablecoins: { total_mcap: 254000000000 },
		},
	},
]);

export const MARKET_CATEGORY_BY_SLUG = new Map(MARKET_CATEGORIES.map((c) => [c.slug, c]));
