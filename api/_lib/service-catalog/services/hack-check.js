// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'hack-check',
	title: 'Exploit History Check',
	category: 'market-data',
	useCase: 'three.ws Exploit History Check — $0.002 USDC per call searches the full DeFi exploit database for a protocol name and returns its incident history, amounts lost, techniques, and a clean / incident-history verdict.',
	path: '/api/x402/hack-check',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '2000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Exploit Check',
	tags: ['security', 'exploit', 'defi', 'due-diligence'],
	description: 'three.ws Exploit History Check — pay $0.002 USDC per call to run a protocol name against the full historical DeFi exploit database before you integrate, deposit, or route funds. Returns a clean / incident-history verdict, every matching incident with date, amount lost, attack technique, classification, affected chains, and recovered funds, plus market-wide loss statistics for context. Omit ?protocol= to get the latest incidents across the whole market. Live DeFiLlama hacks data, refreshed every 10 minutes; a truthful zero-match answer is a valid result, upstream outages refuse before settlement.',
	input: { limit: 5 },
	inputSchema: {
		type: 'object',
		properties: {
			protocol: { type: 'string', description: 'Protocol name to search (case-insensitive substring match). Omit for the latest incidents market-wide.' },
			limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Incidents to return, newest first.' },
		},
	},
	outputExample: {
		query: null,
		verdict: 'market-wide',
		matches: 5,
		total_lost_usd: 412000000,
		incidents: [{
			date: '2026-06-28T00:00:00.000Z',
			name: 'Example Protocol',
			amount_usd: 12000000,
			technique: 'Price oracle manipulation',
			classification: 'DeFi',
			chains: ['Ethereum'],
			bridge: false,
			returned_usd: null,
			source: 'https://example.com/post-mortem',
		}],
		stats: { total_stolen_all_time: 12100000000, total_stolen_12mo: 890000000, incidents_12mo: 61, bridge_hack_share_pct: 34.2 },
		ts: '2026-07-11T10:00:00Z',
	},
	storefronts: ['x402scan'],
};
