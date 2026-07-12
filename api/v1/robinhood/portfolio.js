// GET /api/v1/robinhood/portfolio?address=0x… — x402-paid, $0.002 USDC.
//
// Multiplier-correct full Stock Token portfolio for any Robinhood Chain wallet:
// every held symbol's true position (raw ERC-20 balance × ERC-8056
// uiMultiplier — corporate actions already folded in) priced against the
// on-chain Chainlink NAV feed, plus a total USD value. One multicall for
// balances, joined against the cached Chainlink snapshot — never 95 reads.

import { paidEndpoint } from '../../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../../_lib/x402-spec.js';
import { installAccessControl } from '../../_lib/x402/access-control.js';
import { withService } from '../../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../../_lib/x402-prices.js';
import { isValidEvmAddress } from '../../_lib/validate.js';
import robinhoodPortfolioListing from '../../_lib/service-catalog/services/robinhood-portfolio.js';
import { walletStockPortfolio, asOf } from '../../_lib/robinhood.js';

const ROUTE = '/api/v1/robinhood/portfolio';

// Single source of truth: the service-catalog descriptor is the storefront
// listing copy — importing it here keeps the live 402 challenge in sync with
// what /.well-known/x402.json and the OKX projection advertise.
const DESCRIPTION = robinhoodPortfolioListing.description;

const INPUT_EXAMPLE = { address: '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['address'],
	properties: {
		address: { type: 'string', description: 'EVM wallet address to value (0x… 40 hex chars).' },
	},
};

const OUTPUT_EXAMPLE = {
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
	source: 'chainlink (on-chain multicall)',
	asOf: '2026-07-12T00:00:00.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['owner', 'positions', 'totalValueUsd', 'positionCount'],
	properties: {
		owner: { type: 'string' },
		positions: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					symbol: { type: 'string' },
					name: { type: 'string' },
					address: { type: 'string' },
					rawBalance: { type: 'string' },
					uiMultiplier: { type: 'string' },
					shares: { type: 'number' },
					navPriceUsd: { type: ['number', 'null'] },
					valueUsd: { type: ['number', 'null'] },
				},
			},
		},
		totalValueUsd: { type: 'number' },
		positionCount: { type: 'integer' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({ method: 'GET', queryParamsSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('robinhood-portfolio', '2000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'Robinhood Chain Portfolio',
		tags: ['robinhood', 'stocks', 'portfolio', 'rwa', 'x402'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		const address = String(req.query?.address || '').trim();
		if (!address || !isValidEvmAddress(address)) {
			const err = new Error('query param "address" must be a valid EVM address');
			err.status = 400;
			err.code = 'validation_error';
			throw err;
		}
		const portfolio = await walletStockPortfolio(address);
		return { ...portfolio, source: 'chainlink (on-chain multicall)', asOf: asOf() };
	},
});
