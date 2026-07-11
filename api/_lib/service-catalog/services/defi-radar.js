// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'defi-radar',
	title: 'DeFi Radar',
	category: 'market-data',
	useCase: 'three.ws DeFi Radar — one $0.005 USDC call returns the whole DeFi market at a glance: total TVL with the biggest 24 h gainers and losers, the top fee-earning protocols, and the top DEXes by 24 h volume.',
	path: '/api/x402/defi-radar',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '5000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws DeFi Radar',
	tags: ['defi', 'tvl', 'fees', 'dex', 'market-data'],
	description: 'three.ws DeFi Radar — one $0.005 USDC call returns the whole DeFi market at a glance: total TVL, the biggest 24 h TVL gainers and losers, the top fee-earning protocols (24 h / 7 d / 30 d), and the top DEXes by 24 h volume. Three upstream dimensions composed into one agent-ready JSON snapshot, refreshed every 5 minutes from live DeFiLlama data. Pass ?limit=1..25 to size each leaderboard. If any dimension is unavailable the call is refused before settlement — you are never charged for a partial radar.',
	input: { limit: 10 },
	inputSchema: {
		type: 'object',
		properties: {
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 25,
				default: 10,
				description: 'Rows per leaderboard (TVL top, gainers, losers, fees, DEX volume).',
			},
		},
	},
	outputExample: {
		tvl: {
			total_usd: 118400000000,
			top: [{ name: 'Example Protocol', tvl_usd: 21500000000, change_1d: 0.8, change_7d: 3.2, category: 'Liquid Staking', chains: ['Ethereum'] }],
			gainers: [{ name: 'Example Protocol', tvl_usd: 312000000, change_1d: 14.6 }],
			losers: [{ name: 'Example Protocol', tvl_usd: 98000000, change_1d: -11.2 }],
		},
		fees: { total_24h_usd: 41200000, top: [{ name: 'Example Protocol', total_24h_usd: 6100000, total_7d_usd: 40200000, category: 'DEX' }] },
		dex: { total_24h_usd: 3900000000, top: [{ name: 'Example Protocol', total_24h_usd: 1200000000, change_1d: 4.1 }] },
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
