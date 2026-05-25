// GET /api/x402/symbol-availability?ticker=<symbol>&network=<mainnet|devnet>
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For $0.001 USDC the server
// checks whether a pump.fun token ticker collides with any mint deployed
// through three.ws's agent-payments pipeline. Returns exact matches plus
// trigram-similar tickers so launch agents can pick a name that won't
// trip user confusion or get filtered by aggregator search.
//
// Why this is defensible: three.ws indexes every mint deployed through its
// own launch pipeline (pump_agent_mints). Pre-launch collision checks are
// a tiny moat — but they save the agent from having to scrape every
// aggregator at launch time, and the trigram match handles "looks similar
// enough that humans confuse them" which exact-match APIs miss.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/symbol-availability';

const DESCRIPTION =
	'three.ws Symbol Availability — given a candidate ticker symbol, check for ' +
	'exact and fuzzy collisions across pump.fun mints indexed by three.ws. ' +
	'Returns exact matches (same symbol on the same network) plus trigram-similar ' +
	'symbols (e.g. "USDC" vs "USDCC", "PUMP" vs "PMP"). Use before launching a ' +
	'token to avoid name confusion and aggregator-search dilution.';

const INPUT_EXAMPLE = { ticker: 'HELIO', network: 'mainnet' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ticker'],
	properties: {
		ticker: { type: 'string', minLength: 1, maxLength: 32 },
		network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
	},
};

const OUTPUT_EXAMPLE = {
	ticker: 'HELIO',
	network: 'mainnet',
	exact_collision: false,
	exact_matches: [],
	similar: [
		{
			ticker: 'HELIOS',
			mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
			name: 'Helios',
			similarity: 0.71,
			deployed_at: '2026-04-30T14:08:22Z',
		},
	],
	recommendation: 'available — one near-match exists at similarity 0.71',
	indexed_at: '2026-05-14T17:00:00Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ticker', 'network', 'exact_collision', 'exact_matches', 'similar', 'recommendation'],
	properties: {
		ticker: { type: 'string' },
		network: { type: 'string' },
		exact_collision: { type: 'boolean' },
		exact_matches: { type: 'array', items: { type: 'object' } },
		similar: { type: 'array', items: { type: 'object' } },
		recommendation: { type: 'string' },
		indexed_at: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'GET',
			queryParams: INPUT_EXAMPLE,
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

const SIMILARITY_THRESHOLD = 0.4;

function deriveRecommendation({ exactMatches, similar }) {
	if (exactMatches.length > 0) {
		return `collision — ${exactMatches.length} mint(s) already use this exact ticker`;
	}
	if (similar.length === 0) return 'available — no exact or fuzzy collisions';
	if (similar[0].similarity >= 0.8) {
		return `caution — high-similarity match "${similar[0].ticker}" at ${similar[0].similarity.toFixed(2)}`;
	}
	return `available — ${similar.length} near-match(es) exist below 0.8 similarity`;
}

async function checkSymbol({ ticker, network }) {
	const exactMatches = await sql`
		select mint, name, symbol, created_at
		  from pump_agent_mints
		 where lower(symbol) = lower(${ticker})
		   and network = ${network}
		 order by created_at asc
		 limit 10
	`;

	const similarRows = await sql`
		select mint, name, symbol, similarity(symbol, ${ticker}) as score, created_at
		  from pump_agent_mints
		 where symbol % ${ticker}
		   and network = ${network}
		   and lower(symbol) <> lower(${ticker})
		 order by score desc, created_at asc
		 limit 10
	`;

	const similar = similarRows
		.filter((r) => Number(r.score) >= SIMILARITY_THRESHOLD)
		.map((r) => ({
			ticker: r.symbol,
			mint: r.mint,
			name: r.name,
			similarity: Number(Number(r.score).toFixed(3)),
			deployed_at: new Date(r.created_at).toISOString(),
		}));

	const exactMapped = exactMatches.map((r) => ({
		ticker: r.symbol,
		mint: r.mint,
		name: r.name,
		deployed_at: new Date(r.created_at).toISOString(),
	}));

	return {
		ticker,
		network,
		exact_collision: exactMapped.length > 0,
		exact_matches: exactMapped,
		similar,
		recommendation: deriveRecommendation({ exactMatches: exactMapped, similar }),
		indexed_at: new Date().toISOString(),
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('symbol-availability', '1000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Symbol Check',
		tags: ['ticker', 'pump.fun', 'collision', 'launch', 'solana'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		const ticker = String(req.query?.ticker || '').trim();
		const network = String(req.query?.network || 'mainnet').trim();
		if (!ticker) {
			const err = new Error('query param "ticker" is required');
			err.status = 400;
			err.code = 'missing_ticker';
			throw err;
		}
		if (ticker.length > 32) {
			const err = new Error('ticker must be 32 characters or fewer');
			err.status = 400;
			err.code = 'invalid_ticker';
			throw err;
		}
		if (network !== 'mainnet' && network !== 'devnet') {
			const err = new Error('network must be "mainnet" or "devnet"');
			err.status = 400;
			err.code = 'invalid_network';
			throw err;
		}
		return checkSymbol({ ticker, network });
	},
});
