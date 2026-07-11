// GET /api/x402/market-heatmap?limit=50
//
// Market Heatmap — $0.002 USDC per call on Solana or Base. Returns the top
// coins by market cap with 1 h / 24 h / 7 d momentum plus market-breadth
// statistics (advancers vs decliners, average and median move) in one
// normalized snapshot.
//
// Dual live sources with automatic failover: CoinGecko /coins/markets first
// (richest fields), CoinPaprika /tickers second (keyless, generous quota) —
// so one upstream rate-limit never breaks a paid call. Cached 60 s in-memory.
// No mock path — if both sources fail the handler throws BEFORE settlement
// so the buyer is never charged.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import listing from '../_lib/service-catalog/services/market-heatmap.js';

const ROUTE = '/api/x402/market-heatmap';
const DESCRIPTION = listing.description;

const TTL_MS = 60_000;
const MAX_LIMIT = 100;

let _cache = null; // { coins, source, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

async function fetchCoinGecko() {
	const url =
		'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc' +
		`&per_page=${MAX_LIMIT}&page=1&sparkline=false&price_change_percentage=1h%2C24h%2C7d`;
	const r = await fetch(url, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(8000),
	});
	if (!r.ok) throw new Error(`coingecko ${r.status}`);
	const raw = await r.json();
	if (!Array.isArray(raw) || !raw.length) throw new Error('coingecko empty');
	return raw.map((c, i) => ({
		rank: finite(Number(c.market_cap_rank)) ?? i + 1,
		symbol: typeof c.symbol === 'string' ? c.symbol.toUpperCase() : null,
		name: typeof c.name === 'string' ? c.name : null,
		price_usd: finite(Number(c.current_price)),
		change_1h: finite(Number(c.price_change_percentage_1h_in_currency)),
		change_24h: finite(Number(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h)),
		change_7d: finite(Number(c.price_change_percentage_7d_in_currency)),
		market_cap_usd: finite(Number(c.market_cap)),
		volume_24h_usd: finite(Number(c.total_volume)),
	}));
}

async function fetchCoinPaprika() {
	const r = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(8000),
	});
	if (!r.ok) throw new Error(`coinpaprika ${r.status}`);
	const raw = await r.json();
	if (!Array.isArray(raw) || !raw.length) throw new Error('coinpaprika empty');
	return raw
		.filter((c) => Number.isFinite(Number(c?.rank)) && Number(c.rank) > 0 && c?.quotes?.USD)
		.sort((a, b) => Number(a.rank) - Number(b.rank))
		.slice(0, MAX_LIMIT)
		.map((c) => {
			const q = c.quotes.USD;
			return {
				rank: Number(c.rank),
				symbol: typeof c.symbol === 'string' ? c.symbol.toUpperCase() : null,
				name: typeof c.name === 'string' ? c.name : null,
				price_usd: finite(Number(q.price)),
				change_1h: finite(Number(q.percent_change_1h)),
				change_24h: finite(Number(q.percent_change_24h)),
				change_7d: finite(Number(q.percent_change_7d)),
				market_cap_usd: finite(Number(q.market_cap)),
				volume_24h_usd: finite(Number(q.volume_24h)),
			};
		});
}

async function loadBoard() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache;

	let coins = null;
	let source = null;
	try {
		coins = await fetchCoinGecko();
		source = 'coingecko';
	} catch {
		coins = await fetchCoinPaprika(); // throws through to the caller if it also fails
		source = 'coinpaprika';
	}

	_cache = { coins, source, expiresAt: now + TTL_MS };
	return _cache;
}

function breadth(coins) {
	const moves = coins.map((c) => c.change_24h).filter((n) => n != null);
	const advancers = moves.filter((n) => n > 0.05).length;
	const decliners = moves.filter((n) => n < -0.05).length;
	const flat = moves.length - advancers - decliners;
	const avg = moves.length ? moves.reduce((s, n) => s + n, 0) / moves.length : null;
	let median = null;
	if (moves.length) {
		const s = [...moves].sort((a, b) => a - b);
		const m = Math.floor(s.length / 2);
		median = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	}
	return {
		advancers,
		decliners,
		flat,
		avg_change_24h: avg != null ? Number(avg.toFixed(2)) : null,
		median_change_24h: median != null ? Number(median.toFixed(2)) : null,
	};
}

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['breadth', 'coins', 'source', 'ts'],
	properties: {
		breadth: {
			type: 'object',
			required: ['advancers', 'decliners', 'flat', 'avg_change_24h', 'median_change_24h'],
			properties: {
				advancers: { type: 'integer' },
				decliners: { type: 'integer' },
				flat: { type: 'integer' },
				avg_change_24h: { type: ['number', 'null'] },
				median_change_24h: { type: ['number', 'null'] },
			},
		},
		coins: {
			type: 'array',
			items: {
				type: 'object',
				required: ['rank', 'symbol', 'price_usd', 'change_24h', 'market_cap_usd'],
				properties: {
					rank: { type: 'integer' },
					symbol: { type: ['string', 'null'] },
					name: { type: ['string', 'null'] },
					price_usd: { type: ['number', 'null'] },
					change_1h: { type: ['number', 'null'] },
					change_24h: { type: ['number', 'null'] },
					change_7d: { type: ['number', 'null'] },
					market_cap_usd: { type: ['number', 'null'] },
					volume_24h_usd: { type: ['number', 'null'] },
				},
			},
		},
		source: { type: 'string', enum: ['coingecko', 'coinpaprika'] },
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['market overview', 'momentum screening', 'breadth analysis'],
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
	priceAtomics: priceFor('market-heatmap', '2000'), // $0.002 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: listing.serviceName,
		tags: listing.tags,
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const raw = Number(new URL(req.url, 'http://x').searchParams.get('limit') || '50');
		const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 50));

		let board = null;
		try { board = await loadBoard(); } catch { /* refund below */ }
		if (!board || !board.coins.length) {
			throw Object.assign(new Error('market data is temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		const coins = board.coins.slice(0, limit);
		return {
			breadth: breadth(coins),
			coins,
			source: board.source,
			ts: new Date().toISOString(),
		};
	},
});
