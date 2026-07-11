// GET /api/x402/defi-radar?limit=10
//
// DeFi Radar — $0.005 USDC per call on Solana or Base. One call returns the
// whole DeFi market at a glance: total TVL with the biggest 24 h gainers and
// losers, the top fee-earning protocols, and the top DEXes by 24 h volume —
// three DeFiLlama dimensions composed into one agent-ready snapshot.
//
// Data is live: api.llama.fi /protocols, /overview/fees and /overview/dexs
// (all keyless), cached 5 min in-memory. No mock path — if any dimension is
// unavailable the handler throws BEFORE settlement so the buyer is never
// charged for a partial radar.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import listing from '../_lib/service-catalog/services/defi-radar.js';

const ROUTE = '/api/x402/defi-radar';

// Single source of truth: the service-catalog descriptor is the storefront
// listing copy — importing it keeps the live 402 challenge from drifting from
// what /.well-known/x402.json advertises (same pattern as token-intel.js).
const DESCRIPTION = listing.description;

const TTL_MS = 300_000;
const MIN_MOVER_TVL_USD = 10_000_000; // a "top gainer" on $40k TVL is noise

let _cache = null; // { value, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

async function fetchLlama(path) {
	const r = await fetch(`https://api.llama.fi${path}`, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!r.ok) throw new Error(`llama ${path} ${r.status}`);
	return r.json();
}

// Fetch + normalize all three dimensions once, cache the full-size boards; the
// per-request `limit` slices the cached whole.
async function loadRadar() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const [protocols, fees, dexs] = await Promise.all([
		fetchLlama('/protocols'),
		fetchLlama('/overview/fees?excludeTotalDataChartBreakdown=true&dataType=dailyFees'),
		fetchLlama('/overview/dexs?excludeTotalDataChartBreakdown=true'),
	]);
	if (!Array.isArray(protocols) || !Array.isArray(fees?.protocols) || !Array.isArray(dexs?.protocols)) {
		throw new Error('unexpected upstream shape');
	}

	const rows = protocols
		.filter((p) => Number.isFinite(Number(p?.tvl)) && Number(p.tvl) > 0 && typeof p?.name === 'string')
		.map((p) => ({
			name: p.name,
			tvl_usd: Number(p.tvl),
			change_1d: finite(Number(p.change_1d)),
			change_7d: finite(Number(p.change_7d)),
			category: typeof p.category === 'string' ? p.category : null,
			chains: Array.isArray(p.chains) ? p.chains.filter((c) => typeof c === 'string').slice(0, 8) : [],
		}));

	const totalTvl = rows.reduce((s, p) => s + p.tvl_usd, 0);
	const byTvl = [...rows].sort((a, b) => b.tvl_usd - a.tvl_usd);
	const movers = rows.filter((p) => p.tvl_usd >= MIN_MOVER_TVL_USD && p.change_1d != null);
	const gainers = [...movers].sort((a, b) => b.change_1d - a.change_1d)
		.map((p) => ({ name: p.name, tvl_usd: p.tvl_usd, change_1d: p.change_1d }));
	const losers = [...movers].sort((a, b) => a.change_1d - b.change_1d)
		.map((p) => ({ name: p.name, tvl_usd: p.tvl_usd, change_1d: p.change_1d }));

	const feeRows = fees.protocols
		.filter((p) => Number.isFinite(Number(p?.total24h)))
		.sort((a, b) => Number(b.total24h) - Number(a.total24h))
		.map((p) => ({
			name: typeof p.displayName === 'string' && p.displayName ? p.displayName : String(p.name || 'Unknown'),
			total_24h_usd: Number(p.total24h),
			total_7d_usd: finite(Number(p.total7d)),
			category: typeof p.category === 'string' ? p.category : null,
		}));

	const dexRows = dexs.protocols
		.filter((p) => Number.isFinite(Number(p?.total24h)))
		.sort((a, b) => Number(b.total24h) - Number(a.total24h))
		.map((p) => ({
			name: typeof p.displayName === 'string' && p.displayName ? p.displayName : String(p.name || 'Unknown'),
			total_24h_usd: Number(p.total24h),
			change_1d: finite(Number(p.change_1d)),
		}));

	const value = {
		tvl: { total_usd: totalTvl, top: byTvl, gainers, losers },
		fees: { total_24h_usd: finite(Number(fees.total24h)), top: feeRows },
		dex: { total_24h_usd: finite(Number(dexs.total24h)), top: dexRows },
	};
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['tvl', 'fees', 'dex', 'ts'],
	properties: {
		tvl: {
			type: 'object',
			required: ['total_usd', 'top', 'gainers', 'losers'],
			properties: {
				total_usd: { type: 'number' },
				top: { type: 'array', items: { type: 'object' } },
				gainers: { type: 'array', items: { type: 'object' } },
				losers: { type: 'array', items: { type: 'object' } },
			},
		},
		fees: {
			type: 'object',
			required: ['total_24h_usd', 'top'],
			properties: {
				total_24h_usd: { type: ['number', 'null'] },
				top: { type: 'array', items: { type: 'object' } },
			},
		},
		dex: {
			type: 'object',
			required: ['total_24h_usd', 'top'],
			properties: {
				total_24h_usd: { type: ['number', 'null'] },
				top: { type: 'array', items: { type: 'object' } },
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['defi market overview', 'tvl movers', 'protocol fee leaderboard'],
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
	priceAtomics: priceFor('defi-radar', '5000'), // $0.005 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: listing.serviceName,
		tags: listing.tags,
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const raw = Number(new URL(req.url, 'http://x').searchParams.get('limit') || '10');
		const limit = Math.min(25, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 10));

		let radar = null;
		try { radar = await loadRadar(); } catch { /* refund below */ }
		if (!radar) {
			throw Object.assign(new Error('DeFi market data is temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		return {
			tvl: {
				total_usd: radar.tvl.total_usd,
				top: radar.tvl.top.slice(0, limit),
				gainers: radar.tvl.gainers.slice(0, limit),
				losers: radar.tvl.losers.slice(0, limit),
			},
			fees: { total_24h_usd: radar.fees.total_24h_usd, top: radar.fees.top.slice(0, limit) },
			dex: { total_24h_usd: radar.dex.total_24h_usd, top: radar.dex.top.slice(0, limit) },
			ts: new Date().toISOString(),
		};
	},
});
