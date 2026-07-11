// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'yield-scan',
	title: 'Yield Scanner',
	category: 'market-data',
	useCase: 'three.ws Yield Scanner — $0.005 USDC per call filters 15,000+ live DeFi yield pools by chain, TVL floor, and stablecoin-only, then returns the top pools with APY breakdown and per-pool risk flags.',
	path: '/api/x402/yield-scan',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '5000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Yield Scanner',
	tags: ['defi', 'yield', 'apy', 'staking', 'risk'],
	description: 'three.ws Yield Scanner — pay $0.005 USDC per call to screen 15,000+ live DeFi yield pools in one request. Filter by chain, minimum TVL, and stablecoin-only exposure; sort by APY or TVL. Every returned pool carries the full APY breakdown (base vs reward, 30-day mean), pool TVL, and derived risk flags: impermanent-loss exposure, APY volatility (sigma), an apy-spike flag when the current rate runs far above its 30-day mean, and the upstream outlier marker. Live DeFiLlama yields data, refreshed every 10 minutes. Unavailable data refuses before settlement — no charge for an empty scan.',
	input: { limit: 10, minTvlUsd: 1000000, stable: true },
	inputSchema: {
		type: 'object',
		properties: {
			chain: { type: 'string', description: 'Filter to one chain, e.g. Ethereum, Solana, Base (case-insensitive).' },
			stable: { type: 'boolean', description: 'true → stablecoin-denominated pools only.' },
			minTvlUsd: { type: 'number', minimum: 0, default: 100000, description: 'Minimum pool TVL in USD.' },
			sort: { type: 'string', enum: ['apy', 'tvl'], default: 'apy', description: 'Ranking dimension.' },
			limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Pools to return.' },
		},
	},
	outputExample: {
		count: 10,
		filters: { chain: null, stable: true, min_tvl_usd: 1000000, sort: 'apy' },
		pools: [{
			pool: '747c1d2a-c668-4682-b9f9-296708a3dd90',
			project: 'example-protocol',
			symbol: 'USDC',
			chain: 'Ethereum',
			tvl_usd: 52400000,
			apy: 9.42,
			apy_base: 6.1,
			apy_reward: 3.32,
			apy_mean_30d: 8.7,
			stablecoin: true,
			il_risk: 'no',
			sigma: 0.21,
			exposure: 'single',
			prediction: 'Stable/Up',
			risk_flags: [],
		}],
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
