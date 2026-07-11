// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'stablecoin-health',
	title: 'Stablecoin Peg Monitor',
	category: 'market-data',
	useCase: 'three.ws Stablecoin Peg Monitor — $0.005 USDC per call returns live peg deviation, supply, and 24 h / 7 d / 30 d supply flow for every major stablecoin, with an on-peg / drifting / depegged verdict per coin.',
	path: '/api/x402/stablecoin-health',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '5000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Stablecoin Monitor',
	tags: ['stablecoin', 'peg', 'depeg', 'risk', 'market-data'],
	description: 'three.ws Stablecoin Peg Monitor — pay $0.005 USDC per call for a live health report on the stablecoin market. Every USD-pegged asset is scored on current peg deviation in basis points with an on-peg / drifting / depegged verdict (25 bps and 100 bps thresholds), circulating supply, and 24 h / 7 d / 30 d supply change — the flow signal that front-runs visible depegs. Includes market-wide totals and a depeg alert list. Filter one coin with ?symbol= or size the board with ?limit=. Live DeFiLlama stablecoins data, refreshed every 5 minutes; unavailable data refuses before settlement.',
	input: { limit: 10 },
	inputSchema: {
		type: 'object',
		properties: {
			symbol: { type: 'string', description: 'Return only this stablecoin symbol, e.g. USDC (case-insensitive).' },
			limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Coins to return, largest supply first.' },
		},
	},
	outputExample: {
		total_circulating_usd: 254000000000,
		depegged: [],
		coins: [{
			symbol: 'USDC',
			name: 'USD Coin',
			price: 0.9998,
			deviation_bps: -2,
			status: 'on-peg',
			mechanism: 'fiat-backed',
			circulating_usd: 61200000000,
			change_24h_pct: 0.21,
			change_7d_pct: 1.4,
			change_30d_pct: 3.8,
			chains: 34,
		}],
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
