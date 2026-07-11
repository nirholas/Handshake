// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'market-heatmap',
	title: 'Market Heatmap',
	category: 'market-data',
	useCase: 'three.ws Market Heatmap — $0.002 USDC per call returns the top coins by market cap with 1 h / 24 h / 7 d momentum plus market-breadth stats (advancers, decliners, average move) in one normalized snapshot.',
	path: '/api/x402/market-heatmap',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '2000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Market Heatmap',
	tags: ['crypto', 'market-data', 'momentum', 'heatmap'],
	description: 'three.ws Market Heatmap — pay $0.002 USDC per call for a normalized snapshot of the top coins by market cap: rank, price, 1 h / 24 h / 7 d momentum, market cap, and 24 h volume per coin, plus market-breadth statistics (advancers vs decliners, average and median 24 h move) that tell an agent whether strength is broad or narrow. Dual live sources with automatic failover (CoinGecko primary, CoinPaprika fallback) so a single upstream rate-limit never breaks a paid call. Size the board with ?limit=1..100. Refreshed every 60 seconds; upstream outages refuse before settlement.',
	input: { limit: 50 },
	inputSchema: {
		type: 'object',
		properties: {
			limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Coins to return, largest market cap first.' },
		},
	},
	outputExample: {
		breadth: { advancers: 31, decliners: 18, flat: 1, avg_change_24h: 1.2, median_change_24h: 0.8 },
		coins: [{
			rank: 1,
			symbol: 'BTC',
			name: 'Bitcoin',
			price_usd: 118250,
			change_1h: 0.1,
			change_24h: 2.4,
			change_7d: 5.9,
			market_cap_usd: 2350000000000,
			volume_24h_usd: 48200000000,
		}],
		source: 'coingecko',
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
