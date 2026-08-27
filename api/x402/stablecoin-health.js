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
import { fetchUpstream } from '../_lib/upstream-fetch.js';
import { cacheWrapLastGood } from '../_lib/cache.js';

const ROUTE = '/api/x402/stablecoin-health';
const DESCRIPTION = listing.description;

const TTL_MS = 300_000;
const DRIFT_BPS = 25;
const DEPEG_BPS = 100;

// A paid call refuses before settlement when its upstream is down, so the buyer
// is never charged for nothing. That is right for a cold start and wrong for a
// blip: the shared last-good copy below serves a recent board through a short
// outage and the pre-settle 503 fires only when there has never been data.
const STALE_TTL_S = 15 * 60;
let _cache = null; // { coins, totalCirculating, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

function pctChange(now, prev) {
	if (!Number.isFinite(now) || !Number.isFinite(prev) || prev <= 0) return null;
	return ((now - prev) / prev) * 100;
}

export function pegStatus(deviationBps) {
	if (deviationBps == null) return 'unknown';
	const abs = Math.abs(deviationBps);
	if (abs >= DEPEG_BPS) return 'depegged';
	if (abs >= DRIFT_BPS) return 'drifting';
	return 'on-peg';
}

// Normalize one upstream pegged asset into a scored coin row. Returns null for
// anything that is not a USD-pegged asset with real circulating supply, so the
// caller can skip it. Pure, so the peg verdict is testable without the network.
export function toCoin(a) {
	// USD-pegged assets only. The bps deviation math below is against $1.
	if (a?.pegType !== 'peggedUSD') return null;
	const circulating = Number(a?.circulating?.peggedUSD);
	if (!Number.isFinite(circulating) || circulating <= 0) return null;
	// Upstream omits `price` (null) for ~75 of the USD-pegged assets it tracks.
	// Number(null) is 0, so coercing first scored every one of them as a total
	// depeg (-10000 bps) and filled the alert list with coins that simply have
	// no quote. Only an actual number is a price; anything else is unknown.
	const price = typeof a.price === 'number' && Number.isFinite(a.price) ? a.price : null;
	const deviationBps = price != null ? Math.round((price - 1) * 10_000) : null;
	return {
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
	};
}

async function loadStablecoins() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache;
	const { coins, totalCirculating } = await cacheWrapLastGood(
		'x402:stablecoin-health', TTL_MS / 1000, buildStablecoins, { staleTtlSeconds: STALE_TTL_S },
	);
	_cache = { coins, totalCirculating, expiresAt: now + TTL_MS };
	return _cache;
}

async function buildStablecoins() {
	const r = await fetchUpstream('https://stablecoins.llama.fi/stablecoins?includePrices=true', {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
	}, { timeoutMs: 10_000, attempts: 2, label: 'llama stablecoins' });
	const raw = await r.json();
	if (!Array.isArray(raw?.peggedAssets)) throw new Error('unexpected upstream shape');

	let totalCirculating = 0;
	const coins = [];
	for (const a of raw.peggedAssets) {
		const coin = toCoin(a);
		if (!coin) continue;
		totalCirculating += coin.circulating_usd;
		coins.push(coin);
	}
	coins.sort((a, b) => b.circulating_usd - a.circulating_usd);
	return { coins, totalCirculating };
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
