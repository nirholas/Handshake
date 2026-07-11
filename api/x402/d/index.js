// GET /api/x402/d — FREE catalog of the datapoint fabric.
//
// Enumerates every family and metric of the 400,000+ standalone paid
// datapoint endpoints served by /api/x402/d/<family>/<id>/<metric>, with
// prices, id guidance, and runnable example URLs. For the DeFiLlama-backed
// families it can also expand the live id space page by page
// (?family=pool&ids=1&page=2), so a crawler or agent can walk the entire
// endpoint universe without guessing. Discovery costs nothing; each datapoint
// costs a fraction of a cent.

import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { priceFor } from '../../_lib/x402-prices.js';
import {
	DATAPOINT_FAMILIES,
	DATAPOINT_DEFAULT_ATOMICS,
	datapointEndpointCount,
	allProtocols,
	allChains,
	allStablecoins,
} from '../../_lib/market-data/datapoints.js';
import { loadYieldPools } from '../../defi/yields.js';
import { buildExchanges } from '../../coin/exchanges.js';

const PAGE_SIZE = 200;

const usd = (atomics) => {
	const n = Number(atomics) / 1_000_000;
	return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
};

// Live id enumeration per family, for crawlers that want concrete URLs.
// Each returns the full id list (from the same cached full-set feeds the
// paid route resolves against); coin ids live upstream at CoinGecko scale
// (~17k) and are resolved at runtime instead — use /api/x402/market-coins?q=.
// Each reads the SAME cached full-set feed the paid route resolves against,
// so every id listed here is guaranteed addressable.
const ID_SOURCES = {
	pool: async () => (await loadYieldPools()).pools.map((p) => p.pool),
	exchange: async () => (await buildExchanges()).exchanges.map((e) => e.id),
	protocol: async () => [...(await allProtocols()).keys()],
	chain: async () => [...(await allChains()).values()].map((c) => c.name),
	stablecoin: async () => {
		// The stablecoin map keys ids AND symbols to the same rows — enumerate
		// each row once by its canonical numeric id.
		const seen = new Set();
		const ids = [];
		for (const [key, row] of (await allStablecoins()).entries()) {
			if (seen.has(row)) continue;
			seen.add(row);
			ids.push(/^\d+$/.test(key) ? key : row.symbol || key);
		}
		return ids;
	},
};

function familySummary(origin, slug, def) {
	const price = priceFor(`datapoint-${slug}`, DATAPOINT_DEFAULT_ATOMICS);
	const needsId = def.describeId != null;
	const metricSlugs = Object.keys(def.metrics);
	return {
		family: slug,
		price_usdc: usd(price),
		id: needsId ? def.describeId : null,
		id_count_approx: def.approxCount,
		endpoint_pattern: needsId
			? `${origin}/api/x402/d/${slug}/{id}/{metric}`
			: `${origin}/api/x402/d/${slug}/{metric}`,
		metrics: Object.fromEntries(
			metricSlugs.map((k) => [k, `${def.metrics[k].label} (${def.metrics[k].unit})`]),
		),
		endpoint_count_approx: def.approxCount * metricSlugs.length,
		...(ID_SOURCES[slug] ? { expand_ids: `${origin}/api/x402/d?family=${slug}&ids=1` } : {}),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.apiIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const origin = env.APP_ORIGIN || 'https://three.ws';
	const params = new URL(req.url, 'http://x').searchParams;
	const family = (params.get('family') || '').trim();

	// Id-expansion mode: page through a family's live id space.
	if (family && params.get('ids')) {
		const def = DATAPOINT_FAMILIES[family];
		if (!def) return error(res, 404, 'unknown_family', `unknown family "${family}"`);
		const source = ID_SOURCES[family];
		if (!source) {
			return error(
				res,
				400,
				'no_id_expansion',
				family === 'coin'
					? 'coin ids are resolved at runtime — any CoinGecko id or Solana mint works; find ids via /api/x402/market-coins?q=<text>'
					: `family "${family}" has no id expansion`,
			);
		}
		try {
			const ids = await source();
			const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
			const start = (page - 1) * PAGE_SIZE;
			const metrics = Object.keys(def.metrics);
			return json(
				res,
				200,
				{
					family,
					page,
					page_size: PAGE_SIZE,
					total_ids: ids.length,
					total_pages: Math.ceil(ids.length / PAGE_SIZE),
					metrics,
					endpoints: ids.slice(start, start + PAGE_SIZE).map((id) => ({
						id,
						urls: metrics.map(
							(metric) => `${origin}/api/x402/d/${family}/${encodeURIComponent(id)}/${metric}`,
						),
					})),
				},
				{ 'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800' },
			);
		} catch {
			return error(res, 502, 'upstream_error', 'id catalog is unavailable right now — retry shortly');
		}
	}

	// Single-family detail.
	if (family) {
		const def = DATAPOINT_FAMILIES[family];
		if (!def) return error(res, 404, 'unknown_family', `unknown family "${family}"`);
		return json(res, 200, familySummary(origin, family, def), {
			'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800',
		});
	}

	// Front door.
	return json(
		res,
		200,
		{
			name: 'three.ws Datapoints',
			description:
				'The datapoint fabric: every market datapoint three.ws aggregates, as its own standalone x402 ' +
				'endpoint. One URL = one value = one micro-payment. No API key, no subscription — request a ' +
				'datapoint, get its 402 challenge, pay a fraction of a cent in USDC (Solana or Base), get the value.',
			endpoint_count_approx: datapointEndpointCount(),
			how_to_pay:
				'GET any datapoint URL without payment to receive its 402 challenge, then retry with an ' +
				'X-PAYMENT header per the x402 v2 spec — any x402 client SDK automates this.',
			example: `${origin}/api/x402/d/global/btc-dominance`,
			category_api: `${origin}/api/x402/market`,
			docs: `${origin}/docs/market-data-api`,
			families: Object.entries(DATAPOINT_FAMILIES).map(([slug, def]) =>
				familySummary(origin, slug, def),
			),
		},
		{ 'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800' },
	);
});
