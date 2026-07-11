// GET /api/x402/stablecoin-health?symbol=&limit=
//
// Stablecoin Peg Monitor — $0.005 USDC per call on Solana or Base. Scores
// every USD-pegged stablecoin on live peg deviation (bps) with an
// on-peg / drifting / depegged verdict, circulating supply, and
// 24 h / 7 d / 30 d supply flow — the signal that front-runs visible depegs.
//
// Data is live: stablecoins.llama.fi (keyless), cached 5 min in-memory.
// No mock path — if the feed is unavailable the handler throws BEFORE
// settlement so the buyer is never charged.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import listing from '../_lib/service-catalog/services/stablecoin-health.js';

const ROUTE = '/api/x402/stablecoin-health';
const DESCRIPTION = listing.description;

const TTL_MS = 300_000;
const DRIFT_BPS = 25;
const DEPEG_BPS = 100;

let _cache = null; // { coins, totalCirculating, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

function pctChange(now, prev) {
	if (!Number.isFinite(now) || !Number.isFinite(prev) || prev <= 0) return null;
	return ((now - prev) / prev) * 100;
}

function pegStatus(deviationBps) {
	if (deviationBps == null) return 'unknown';
	const abs = Math.abs(deviationBps);
	if (abs >= DEPEG_BPS) return 'depegged';
	if (abs >= DRIFT_BPS) return 'drifting';
	return 'on-peg';
}

async function loadStablecoins() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache;

	const r = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true', {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!r.ok) throw new Error(`llama stablecoins ${r.status}`);
	const raw = await r.json();
	if (!Array.isArray(raw?.peggedAssets)) throw new Error('unexpected upstream shape');

	let totalCirculating = 0;
	const coins = [];
	for (const a of raw.peggedAssets) {
		// USD-pegged assets only — the bps deviation math below is against $1.
		if (a?.pegType !== 'peggedUSD') continue;
		const circulating = Number(a?.circulating?.peggedUSD);
		if (!Number.isFinite(circulating) || circulating <= 0) continue;
		totalCirculating += circulating;
		const price = finite(Number(a.price));
		const deviationBps = price != null ? Math.round((price - 1) * 10_000) : null;
		coins.push({
			symbol: typeof a.symbol === 'string' ? a.symbol : null,
			name: typeof a.name === 'string' ? a.name : null,
			price,
			deviation_bps: deviationBps,
			status: pegStatus(deviationBps),
			mechanism: typeof a.pegMechanism === 'string' ? a.pegMechanism : null,
			circulating_usd: circulating,
			change_24h_pct: finite(pctChange(circulating, Number(a?.circulatingPrevDay?.peggedUSD))),
			change_7d_pct: finite(pctChange(circulating, Number(a?.circulatingPrevWeek?.peggedUSD))),
			change_30d_pct: finite(pctChange(circulating, Number(a?.circulatingPrevMonth?.peggedUSD))),
			chains: a.chainCirculating && typeof a.chainCirculating === 'object'
				? Object.keys(a.chainCirculating).length
				: 0,
		});
	}
	coins.sort((a, b) => b.circulating_usd - a.circulating_usd);

	_cache = { coins, totalCirculating, expiresAt: now + TTL_MS };
	return _cache;
}

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['total_circulating_usd', 'depegged', 'coins', 'ts'],
	properties: {
		total_circulating_usd: { type: 'number' },
		depegged: {
			type: 'array',
			description: 'Coins currently ≥100 bps off peg, regardless of the page filter.',
			items: { type: 'object' },
		},
		coins: {
			type: 'array',
			items: {
				type: 'object',
				required: ['symbol', 'price', 'deviation_bps', 'status', 'circulating_usd'],
				properties: {
					symbol: { type: ['string', 'null'] },
					name: { type: ['string', 'null'] },
					price: { type: ['number', 'null'] },
					deviation_bps: { type: ['integer', 'null'] },
					status: { type: 'string', enum: ['on-peg', 'drifting', 'depegged', 'unknown'] },
					mechanism: { type: ['string', 'null'] },
					circulating_usd: { type: 'number' },
					change_24h_pct: { type: ['number', 'null'] },
					change_7d_pct: { type: ['number', 'null'] },
					change_30d_pct: { type: ['number', 'null'] },
					chains: { type: 'integer' },
				},
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['stablecoin peg monitoring', 'depeg alerts', 'supply flow tracking'],
	input: {
		type: 'query',
		example: listing.input,
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: listing.outputExample,
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('stablecoin-health', '5000'), // $0.005 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: listing.serviceName,
		tags: listing.tags,
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const params = new URL(req.url, 'http://x').searchParams;
		const symbol = (params.get('symbol') || '').trim().toUpperCase() || null;
		const limitRaw = Number(params.get('limit') || '25');
		const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 25));

		let data = null;
		try { data = await loadStablecoins(); } catch { /* refund below */ }
		if (!data || !data.coins.length) {
			throw Object.assign(new Error('stablecoin data is temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		let coins = data.coins;
		if (symbol) coins = coins.filter((c) => c.symbol && c.symbol.toUpperCase() === symbol);
		if (symbol && !coins.length) {
			// A named coin that isn't in the dataset is a bad request, not a billable
			// empty answer — thrown before settlement so the buyer isn't charged.
			throw Object.assign(new Error(`no USD-pegged stablecoin with symbol ${symbol}`), {
				status: 422,
				code: 'unknown_symbol',
			});
		}

		// The alert list always spans the whole dataset so a filtered call still
		// surfaces an active depeg elsewhere in the market.
		const depegged = data.coins
			.filter((c) => c.status === 'depegged')
			.map(({ symbol: s, name, price, deviation_bps, circulating_usd }) => ({
				symbol: s, name, price, deviation_bps, circulating_usd,
			}));

		return {
			total_circulating_usd: data.totalCirculating,
			depegged,
			coins: coins.slice(0, limit),
			ts: new Date().toISOString(),
		};
	},
});
