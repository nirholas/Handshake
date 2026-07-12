// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.

export default {
	slug: 'robinhood-portfolio',
	title: 'Robinhood Chain Portfolio',
	category: 'market-data',
	useCase:
		'Robinhood Chain Portfolio — the multiplier-correct USD value of any wallet\'s ' +
		'tokenized-equity holdings on Robinhood Chain (4663), corporate-action-adjusted ' +
		'via ERC-8056 uiMultiplier and priced against live Chainlink NAV feeds.',
	path: '/api/v1/robinhood/portfolio',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '2000',
	acceptsBuilder: 'standard',
	serviceName: 'Robinhood Chain Portfolio',
	tags: ['robinhood', 'stocks', 'portfolio', 'rwa', 'x402'],
	description:
		'Robinhood Chain Portfolio — every Stock Token a wallet holds on Robinhood Chain (4663), ' +
		'with the true position (raw ERC-20 balance × ERC-8056 uiMultiplier — ignoring the multiplier ' +
		'misstates value after a split or dividend) and current USD value from the on-chain Chainlink ' +
		'NAV feed for each symbol. Returns per-position shares, NAV price, and USD value, plus a ' +
		'total portfolio value. Zero balances are omitted.',
	input: { address: '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52' },
	inputSchema: {
		type: 'object',
		required: ['address'],
		properties: {
			address: { type: 'string', description: 'EVM wallet address to value (0x…40 hex chars).' },
		},
	},
	outputExample: {
		owner: '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52',
		positions: [
			{
				symbol: 'AAPL',
				name: 'Apple • Robinhood Token',
				address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
				rawBalance: '1000000000000000000',
				uiMultiplier: '1000000000000000000',
				shares: 1,
				navPriceUsd: 315.5,
				valueUsd: 315.5,
			},
		],
		totalValueUsd: 315.5,
		positionCount: 1,
	},
	storefronts: ['x402scan'],
};
