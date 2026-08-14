// GET  /api/x402/symbol-availability?ticker=<symbol>&network=<mainnet|devnet>
// POST /api/x402/symbol-availability  { symbols: string[], network?: string }
//
// DEPRECATED: symbol-availability is now a FREE, keyless discovery utility at
// GET/POST /api/crypto/symbol (up to 20 symbols/call, exact + fuzzy collisions
// across live registries). Prefer that route. The 2026-07 overhaul (prompt 20)
// kept this route cataloged as a paid convenience alongside the free one.
//
// GET: single-ticker collision check ($0.001 USDC) — original endpoint.
// POST: batch scan of up to 10 symbols ($0.005 USDC) — returns
//   { scanned_count, available_count, taken_count, available_list,
//     taken_list, availability_ratio, headline, results[] }.
//   It is a collision checker, not a market oracle: `availability_ratio` is
//   simply available_count / scanned_count (a convenience roll-up), NOT a
//   trading signal. The 2026-07-08 storefront cleanup (prompt 18) removed the
//   bullish/bearish/neutral `signal` field this endpoint used to return —
//   this is a collision checker, sold as exactly that. The autonomous scan
//   loop's registry entry (`symbol-scan-common`) now derives its own coarse
//   bucket from `available_count`/`scanned_count` locally instead of reading
//   it off the wire.
//
// Why this is defensible: three.ws indexes every mint deployed through its
// own launch pipeline (pump_agent_mints). Pre-launch collision checks are
// a tiny moat — but they save the agent from having to scrape every
// aggregator at launch time, and the trigram match handles "looks similar
// enough that humans confuse them" which exact-match APIs miss.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';
import symbolAvailabilityListing from '../_lib/service-catalog/services/symbol-availability.js';

const ROUTE = '/api/x402/symbol-availability';

// Single source of truth:
// api/_lib/service-catalog/services/symbol-availability.js is the storefront
// listing copy — importing it here keeps the live 402 challenge (single-ticker
// GET) from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js). BATCH_DESCRIPTION
// below stays local — the batch POST mode is intentionally not advertised to
// external buyers.
const DESCRIPTION = symbolAvailabilityListing.description;

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

// ── Single-ticker endpoint (GET) ─────────────────────────────────────────────

const singleEndpoint = paidEndpoint({
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

// ── Batch scan (POST) ────────────────────────────────────────────────────────
// Accepts { symbols: string[], network?: string } and checks all symbols in
// parallel. Returns counts + available/taken lists + availability_ratio + a
// factual `headline` summary. It does not return a bullish/bearish/neutral
// signal — this is a collision checker, not a market oracle. The autonomous
// scan loop's registry entry (`symbol-scan-common` in autonomous-registry.js)
// derives its own coarse bucket from available_count/scanned_count for its
// internal oracle_intel_signals row; that classification never ships on the
// wire to external buyers.

const BATCH_MAX = 10;

const BATCH_DESCRIPTION =
	'three.ws Symbol Availability Batch Scan — POST { symbols: string[], network? } ' +
	'to check up to 10 candidate ticker symbols for exact and fuzzy collisions against ' +
	'the mints three.ws has launched, in a single call. Returns available_count, ' +
	'taken_count, available_list, taken_list, and availability_ratio (share of scanned ' +
	'symbols with no exact collision). A collision checker — not a trading signal. The ' +
	'free /api/crypto/symbol route covers the whole market keyless; prefer it unless you ' +
	'need this authenticated batch path.';

const BATCH_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['symbols'],
	properties: {
		symbols: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: BATCH_MAX },
		network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
	},
};

const BATCH_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['scanned_count', 'available_count', 'taken_count', 'available_list', 'taken_list', 'availability_ratio', 'results'],
	properties: {
		scanned_count: { type: 'number' },
		available_count: { type: 'number' },
		taken_count: { type: 'number' },
		available_list: { type: 'array', items: { type: 'string' } },
		taken_list: { type: 'array', items: { type: 'string' } },
		availability_ratio: { type: 'number', description: 'available_count / scanned_count (0–1). A convenience roll-up, not a market signal.' },
		results: { type: 'array', items: { type: 'object' } },
	},
};

const BATCH_BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyExample: { symbols: ['MOON', 'ROCKET', 'FROG'], network: 'mainnet' },
		},
		output: { type: 'json' },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: BATCH_INPUT_SCHEMA,
		outputSchema: BATCH_OUTPUT_SCHEMA,
	}),
};

async function readJsonBody(req) {
	const raw = (await readBody(req, 1_000_000)).toString('utf8');
	return JSON.parse(raw || '{}');
}

const batchEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('symbol-availability-batch', '5000'),
	networks: ['base', 'solana'],
	description: BATCH_DESCRIPTION,
	bazaar: BATCH_BAZAAR,
	service: withService({
		serviceName: 'three.ws Symbol Batch Scan',
		tags: ['ticker', 'pump.fun', 'collision', 'launch', 'solana', 'batch'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			const err = new Error('request body must be valid JSON');
			err.status = 400;
			err.code = 'invalid_json';
			throw err;
		}

		const rawSymbols = Array.isArray(body?.symbols) ? body.symbols : [];
		if (rawSymbols.length === 0) {
			const err = new Error('symbols array is required and must not be empty');
			err.status = 400;
			err.code = 'missing_symbols';
			throw err;
		}
		if (rawSymbols.length > BATCH_MAX) {
			const err = new Error(`symbols array may contain at most ${BATCH_MAX} entries`);
			err.status = 400;
			err.code = 'too_many_symbols';
			throw err;
		}

		const network = String(body?.network || 'mainnet').trim();
		if (network !== 'mainnet' && network !== 'devnet') {
			const err = new Error('network must be "mainnet" or "devnet"');
			err.status = 400;
			err.code = 'invalid_network';
			throw err;
		}

		const symbols = rawSymbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);

		const results = await Promise.all(symbols.map((ticker) => checkSymbol({ ticker, network })));

		const availableList = results.filter((r) => !r.exact_collision).map((r) => r.ticker);
		const takenList = results.filter((r) => r.exact_collision).map((r) => r.ticker);
		const availableCount = availableList.length;
		const takenCount = takenList.length;
		const availabilityRatio = symbols.length > 0
			? Number((availableCount / symbols.length).toFixed(3))
			: 0;

		const headline =
			availableCount === symbols.length
				? `All ${symbols.length} scanned symbols are collision-free`
				: availableCount === 0
					? `All ${symbols.length} scanned symbols already have an exact collision`
					: `${availableCount}/${symbols.length} symbols collision-free — taken: ${takenList.join(', ')}`;

		return {
			scanned_count: symbols.length,
			available_count: availableCount,
			taken_count: takenCount,
			available_list: availableList,
			taken_list: takenList,
			availability_ratio: availabilityRatio,
			headline,
			network,
			results,
			scanned_at: new Date().toISOString(),
		};
	},
});

// Route by method: GET → single ticker, POST → batch scan.
export default function symbolAvailabilityRouter(req, res) {
	const method = String(req.method || 'GET').toUpperCase();
	if (method === 'POST') return batchEndpoint(req, res);
	if (method === 'OPTIONS') {
		const requested = String(req.headers['access-control-request-method'] || '').toUpperCase();
		return requested === 'POST' ? batchEndpoint(req, res) : singleEndpoint(req, res);
	}
	return singleEndpoint(req, res);
}
