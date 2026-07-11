// GET /api/x402/yield-scan?chain=&stable=&minTvlUsd=&sort=&limit=
//
// Yield Scanner — $0.005 USDC per call on Solana or Base. Screens 15,000+
// live DeFi yield pools in one request: filter by chain, TVL floor, and
// stablecoin-only exposure; every returned pool carries the APY breakdown
// and derived risk flags (impermanent loss, APY volatility, apy-spike,
// upstream outlier marker).
//
// Data is live: yields.llama.fi /pools (keyless), cached 10 min in-memory.
// No mock path — if the pool feed is unavailable the handler throws BEFORE
// settlement so the buyer is never charged for an empty scan.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import listing from '../_lib/service-catalog/services/yield-scan.js';

const ROUTE = '/api/x402/yield-scan';
const DESCRIPTION = listing.description;

const TTL_MS = 600_000;
const APY_SPIKE_RATIO = 3; // current APY > 3× its 30-day mean → likely transient
const HIGH_SIGMA = 1; // upstream sigma above this → volatile APY

let _cache = null; // { pools, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

async function loadPools() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.pools;

	const r = await fetch('https://yields.llama.fi/pools', {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(15_000),
	});
	if (!r.ok) throw new Error(`llama yields ${r.status}`);
	const raw = await r.json();
	if (!Array.isArray(raw?.data)) throw new Error('unexpected upstream shape');

	const pools = raw.data
		.filter((p) => Number.isFinite(Number(p?.tvlUsd)) && Number.isFinite(Number(p?.apy)))
		.map((p) => ({
			pool: String(p.pool || ''),
			project: typeof p.project === 'string' ? p.project : null,
			symbol: typeof p.symbol === 'string' ? p.symbol : null,
			chain: typeof p.chain === 'string' ? p.chain : null,
			tvl_usd: Number(p.tvlUsd),
			apy: Number(p.apy),
			apy_base: finite(Number(p.apyBase)),
			apy_reward: finite(Number(p.apyReward)),
			apy_mean_30d: finite(Number(p.apyMean30d)),
			stablecoin: p.stablecoin === true,
			il_risk: typeof p.ilRisk === 'string' ? p.ilRisk : null,
			sigma: finite(Number(p.sigma)),
			exposure: typeof p.exposure === 'string' ? p.exposure : null,
			prediction: typeof p.predictions?.predictedClass === 'string' ? p.predictions.predictedClass : null,
			outlier: p.outlier === true,
		}));
	_cache = { pools, expiresAt: now + TTL_MS };
	return pools;
}

function riskFlags(p) {
	const flags = [];
	if (p.il_risk === 'yes') flags.push('impermanent-loss');
	if (p.sigma != null && p.sigma > HIGH_SIGMA) flags.push('volatile-apy');
	if (p.apy_mean_30d != null && p.apy_mean_30d > 0 && p.apy > p.apy_mean_30d * APY_SPIKE_RATIO) flags.push('apy-spike');
	if (p.outlier) flags.push('upstream-outlier');
	return flags;
}

export const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	...listing.inputSchema,
};

export const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['count', 'filters', 'pools', 'ts'],
	properties: {
		count: { type: 'integer' },
		filters: { type: 'object' },
		pools: {
			type: 'array',
			items: {
				type: 'object',
				required: ['pool', 'project', 'chain', 'tvl_usd', 'apy', 'risk_flags'],
				properties: {
					pool: { type: 'string' },
					project: { type: ['string', 'null'] },
					symbol: { type: ['string', 'null'] },
					chain: { type: ['string', 'null'] },
					tvl_usd: { type: 'number' },
					apy: { type: 'number' },
					apy_base: { type: ['number', 'null'] },
					apy_reward: { type: ['number', 'null'] },
					apy_mean_30d: { type: ['number', 'null'] },
					stablecoin: { type: 'boolean' },
					il_risk: { type: ['string', 'null'] },
					sigma: { type: ['number', 'null'] },
					exposure: { type: ['string', 'null'] },
					prediction: { type: ['string', 'null'] },
					risk_flags: { type: 'array', items: { type: 'string' } },
				},
			},
		},
		ts: { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['yield screening', 'stablecoin farming', 'apy risk flags'],
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
	priceAtomics: priceFor('yield-scan', '5000'), // $0.005 USDC
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
		const chain = (params.get('chain') || '').trim().toLowerCase() || null;
		const stable = params.get('stable') === 'true' ? true : params.get('stable') === 'false' ? false : null;
		const minTvlRaw = Number(params.get('minTvlUsd') || '100000');
		const minTvlUsd = Number.isFinite(minTvlRaw) && minTvlRaw >= 0 ? minTvlRaw : 100_000;
		const sort = params.get('sort') === 'tvl' ? 'tvl' : 'apy';
		const limitRaw = Number(params.get('limit') || '20');
		const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20));

		let pools = null;
		try { pools = await loadPools(); } catch { /* refund below */ }
		if (!pools) {
			throw Object.assign(new Error('yield pool data is temporarily unavailable'), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		let filtered = pools.filter((p) => p.tvl_usd >= minTvlUsd);
		if (chain) filtered = filtered.filter((p) => p.chain && p.chain.toLowerCase() === chain);
		if (stable !== null) filtered = filtered.filter((p) => p.stablecoin === stable);
		filtered.sort(sort === 'tvl' ? (a, b) => b.tvl_usd - a.tvl_usd : (a, b) => b.apy - a.apy);

		const page = filtered.slice(0, limit).map((p) => {
			const { outlier, ...rest } = p;
			return { ...rest, risk_flags: riskFlags(p) };
		});

		return {
			count: filtered.length,
			filters: { chain, stable, min_tvl_usd: minTvlUsd, sort },
			pools: page,
			ts: new Date().toISOString(),
		};
	},
});
