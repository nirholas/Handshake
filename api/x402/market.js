// GET /api/x402/market — FREE front-door index for the paid Market Data API.
//
// Lists every paid /api/x402/market-* endpoint (the registry family plus the
// hand-written siblings market-heatmap and market-mood) with its live price,
// params, and a runnable example, so an agent (or a human with curl) can
// discover the whole bundle in one unauthenticated call. The paid endpoints
// themselves are x402-gated (USDC on Solana or Base); this index is free the
// same way /api/crypto is free for the crypto bundle. Discovery costs nothing,
// data costs a micro-payment.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { priceFor } from '../_lib/x402-prices.js';
import {
	MARKET_CATEGORIES,
	MARKET_CATEGORY_BY_SLUG,
	MARKET_SERVICE_NAME,
} from '../_lib/market-data/registry.js';
import { PAID_SERVICES } from '../_lib/service-catalog/services/index.js';
import { datapointEndpointCount } from '../_lib/market-data/datapoints.js';

// USDC atomics to a display price. The decimal count is derived from the value
// so a sub-cent endpoint never renders as "$0": a fixed 3-decimal format turned
// $0.0005 into "$0.000" and then into "$0" once the trailing zeros were
// trimmed. Trailing zeros are still trimmed, but only inside the fraction.
const usd = (atomics) => {
	const n = Number(atomics) / 1_000_000;
	if (!Number.isFinite(n)) return null;
	const decimals = n > 0 ? Math.max(2, Math.min(6, Math.ceil(-Math.log10(n)) + 1)) : 2;
	return `$${n.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`;
};

// The index covers every paid /api/x402/market-* endpoint, not only the
// registry family. market-heatmap and market-mood are hand-written siblings
// with their own service-catalog descriptors, and an agent that discovers the
// bundle here has no other way to learn they exist. Both halves are derived
// (registry + catalog), so the next sibling shows up the day its descriptor
// lands rather than the day someone remembers to edit this file.
const SIBLING_SERVICES = PAID_SERVICES.filter(
	(s) =>
		s.status === 'live' &&
		!s.free &&
		typeof s.path === 'string' &&
		s.path.startsWith('/api/x402/market-') &&
		!MARKET_CATEGORY_BY_SLUG.has(s.slug),
);

const LISTED = [
	...MARKET_CATEGORIES.map((c) => ({
		slug: c.slug,
		title: c.title,
		priceAtomics: c.priceAtomics,
		summary: c.useCase,
		properties: c.inputSchema.properties || {},
		example: c.inputExample,
	})),
	...SIBLING_SERVICES.map((s) => ({
		slug: s.slug,
		title: s.title,
		priceAtomics: s.priceAtomics,
		summary: s.useCase,
		properties: s.inputSchema?.properties || {},
		example: s.input || {},
	})),
];

// Price through priceFor() rather than the declared default: the live endpoint
// resolves the same way, so an X402_PRICE_MARKET_* override moves the index and
// the 402 challenge together instead of leaving the free index quoting a price
// no longer charged.
function describeEndpoint(entry, origin) {
	const query = new URLSearchParams(
		Object.entries(entry.example || {}).map(([k, v]) => [k, String(v)]),
	).toString();
	return {
		slug: entry.slug,
		title: entry.title,
		price_usdc: usd(priceFor(entry.slug, entry.priceAtomics)),
		url: `${origin}/api/x402/${entry.slug}`,
		summary: entry.summary,
		params: Object.fromEntries(
			Object.entries(entry.properties).map(([k, v]) => [k, v.description]),
		),
		example: `${origin}/api/x402/${entry.slug}${query ? `?${query}` : ''}`,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.apiIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const origin = env.APP_ORIGIN || 'https://three.ws';
	return json(
		res,
		200,
		{
			name: MARKET_SERVICE_NAME,
			description:
				'Pay-per-call crypto market data for agents — the same live feeds behind the three.ws /markets pages, ' +
				'sold as x402 endpoints (HTTP 402, USDC on Solana or Base). No API key, no subscription, no rate-limit ' +
				'negotiation: request an endpoint, get a 402 challenge, pay ~$0.001 USDC, get the data.',
			how_to_pay:
				'GET any endpoint below without payment to receive its 402 challenge (price, networks, pay-to). ' +
				'Retry with an X-PAYMENT header per the x402 v2 spec, or use any x402 client SDK.',
			docs: `${origin}/docs/market-data-api`,
			discovery: `${origin}/.well-known/x402.json`,
			datapoints: {
				// Counted from the same family table /api/x402/d reports
				// endpoint_count_approx from. It was hardcoded at "480,000+" and drifted
				// to less than half the real fabric as families were added, so the two
				// free front doors advertised different sizes for one product.
				description:
					`Need one value instead of a payload? Every individual datapoint is its own $0.0005 endpoint, ${datapointEndpointCount().toLocaleString('en-US')}+ of them.`,
				catalog: `${origin}/api/x402/d`,
			},
			endpoints: LISTED.map((entry) => describeEndpoint(entry, origin)),
		},
		{ 'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800' },
	);
});
