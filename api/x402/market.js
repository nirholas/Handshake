// GET /api/x402/market — FREE front-door index for the paid Market Data API.
//
// Lists every /api/x402/market-* category with its price, params, and a
// runnable example so an agent (or a human with curl) can discover the whole
// bundle in one unauthenticated call. The paid endpoints themselves are
// x402-gated (USDC on Solana or Base); this index is free the same way
// /api/crypto is free for the crypto bundle — discovery costs nothing,
// data costs a micro-payment.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { MARKET_CATEGORIES, MARKET_SERVICE_NAME } from '../_lib/market-data/registry.js';

const usd = (atomics) => {
	const n = Number(atomics) / 1_000_000;
	return `$${n.toFixed(n < 0.01 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}`;
};

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
			endpoints: MARKET_CATEGORIES.map((c) => ({
				slug: c.slug,
				title: c.title,
				price_usdc: usd(c.priceAtomics),
				url: `${origin}/api/x402/${c.slug}`,
				summary: c.useCase,
				params: Object.fromEntries(
					Object.entries(c.inputSchema.properties || {}).map(([k, v]) => [k, v.description]),
				),
				example: `${origin}/api/x402/${c.slug}${
					Object.keys(c.inputExample).length
						? `?${new URLSearchParams(c.inputExample).toString()}`
						: ''
				}`,
			})),
		},
		{ 'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800' },
	);
});
