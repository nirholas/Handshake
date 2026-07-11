// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'gas-oracle',
	title: 'Multi-Chain Gas Oracle',
	category: 'market-data',
	useCase: 'three.ws Multi-Chain Gas Oracle — $0.001 USDC per call returns live fee tiers for Ethereum and Base (slow / standard / fast from real fee history) plus Solana priority-fee percentiles, in one call.',
	path: '/api/x402/gas-oracle',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Gas Oracle',
	tags: ['gas', 'fees', 'ethereum', 'base', 'solana'],
	description: 'three.ws Multi-Chain Gas Oracle — pay $0.001 USDC per call for live transaction-fee intelligence across the chains agents actually settle on. Ethereum and Base each return three tiers (slow / standard / fast) computed from real eth_feeHistory percentiles over the last 20 blocks — no third-party gas API — and Solana returns recent priority-fee percentiles (p25 / p50 / p90 micro-lamports) plus the base signature fee. Computed directly from public RPC quorums with per-chain failover; a chain whose RPCs are all unreachable reports null while the rest of the report stays live. If every chain fails the call refuses before settlement.',
	input: {},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	outputExample: {
		ethereum: {
			base_fee_gwei: 4.2,
			tiers: [{ key: 'standard', priority_fee_gwei: 0.8, gas_price_gwei: 5.0 }],
		},
		base: {
			base_fee_gwei: 0.012,
			tiers: [{ key: 'standard', priority_fee_gwei: 0.004, gas_price_gwei: 0.016 }],
		},
		solana: { priority_fee_micro_lamports: { p25: 0, p50: 1200, p90: 48000 }, base_fee_lamports: 5000 },
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
