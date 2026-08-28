// GET /api/ca2x402/resolve?mint=<contract-address>
//
// The free resolver behind the CA → x402 tool (/ca2x402). Paste any token
// contract address and this returns two things:
//
//   1. token   — live identity + market preview (symbol, name, image, price,
//                24 h change, liquidity, volume, a signal) so the page can show
//                what it found before anyone pays.
//   2. service — the x402 paid service generated for that exact token: the
//                endpoint URL, price, networks, receivers, the bazaar schema,
//                and copy-paste call snippets (curl / x402-fetch / agent skill).
//
// The mint is supplied at runtime by the caller — generic, coin-agnostic
// plumbing. This endpoint is free (no payment); the paid data lives behind
// /api/x402/token-intel, which the snippets point at.
//
// Data is live DexScreener. When the token is unknown, we return a clean 404
// the page renders as a designed "not found" state — never a fabricated token.

import { cors, json, error, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { priceFor } from '../_lib/x402-prices.js';
import { env } from '../_lib/env.js';
import {
	fetchTokenMarket,
	fetchTokenMarketResult,
	buildTokenSignal,
	buildTokenRisk,
	isResolvableAddress,
	chainOf,
} from '../_lib/token-market.js';
import { BAZAAR, OUTPUT_SCHEMA } from '../x402/token-intel.js';

const PRICE_ATOMICS = priceFor('token-intel', '10000');
const PRICE_USD = Number(PRICE_ATOMICS) / 1e6; // USDC has 6 decimals
const NETWORKS = ['solana', 'base'];
const ENDPOINT_PATH = '/api/x402/token-intel';

function buildSnippets(endpointUrl) {
	const curl =
		`# 1) See the price (returns HTTP 402 + payment requirements)\n` +
		`curl -i "${endpointUrl}"\n\n` +
		`# 2) Pay: sign the requirement from step 1 into a base64 X-PAYMENT header,\n` +
		`#    then replay the same call with it. The Node tab below builds that\n` +
		`#    header for you; export it as X_PAYMENT to finish here in curl.\n` +
		`curl -i -H "X-PAYMENT: $X_PAYMENT" "${endpointUrl}"`;

	const node =
		`import { wrapFetchWithPayment } from 'x402-fetch';\n` +
		`import { createWalletClient, http } from 'viem';\n` +
		`import { privateKeyToAccount } from 'viem/accounts';\n` +
		`import { base } from 'viem/chains';\n\n` +
		`const account = privateKeyToAccount(process.env.PRIVATE_KEY);\n` +
		`const wallet = createWalletClient({ account, chain: base, transport: http() });\n` +
		`const fetchWithPay = wrapFetchWithPayment(fetch, wallet);\n\n` +
		`const res = await fetchWithPay('${endpointUrl}');\n` +
		`console.log(await res.json()); // { symbol, price_usd, signal, headline, ... }`;

	const agent =
		`// Inside a three.ws agent — pay from the agent wallet, no keys in code:\n` +
		`const intel = await agent.x402.pay('${endpointUrl}');\n` +
		`agent.log(intel.headline, intel.signal, intel.confidence);`;

	return { curl, node, agent };
}

async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	// Public, unauthenticated read that fans out to an external DexScreener fetch per
	// call — bound per IP so it can't be looped as an unmetered upstream relay that
	// gets the shared key/IP throttled for everyone.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const mint = (url.searchParams.get('mint') || '').trim();
	if (!mint) {
		return error(res, 400, 'missing_mint', 'Pass ?mint=<contract-address>.');
	}
	if (!isResolvableAddress(mint)) {
		return error(
			res,
			422,
			'invalid_mint',
			'That does not look like a Solana mint or EVM contract address.',
		);
	}

	// "The indexer says this token has no market" and "the indexer could not be
	// reached" are different answers, and only the first one is the caller's
	// business. fetchTokenMarket serves a remembered payload when it has one, so
	// a throw here means a cold instance during an outage: answering the designed
	// 404 there tells someone their real token does not exist, which is the exact
	// claim the last-good tier was added to stop making.
	const { market, unavailable } = await fetchTokenMarketResult(mint);
	if (unavailable) {
		res.setHeader('cache-control', 'no-store');
		res.setHeader('Retry-After', '15');
		return json(res, 503, {
			ok: false,
			mint,
			chain: chainOf(mint),
			error: 'market_unavailable',
			error_description:
				'The market indexer could not be reached, so this address could not be checked. Retry shortly.',
			retry_after: 15,
		});
	}

	if (!market) {
		// Designed "not found": the address is well-formed but no market exists
		// (unlaunched, dead liquidity, or wrong chain). The page tells the user so.
		res.setHeader('cache-control', 'no-store');
		return json(res, 404, {
			ok: false,
			mint,
			chain: chainOf(mint),
			error: 'token_not_found',
			error_description:
				'No live market found for this address on DexScreener. The token may be unlaunched or have no liquidity yet.',
		});
	}

	const signal = market.change_24h != null ? buildTokenSignal(market) : null;
	const risk = buildTokenRisk(market);

	// Anchor the advertised endpoint on env.APP_ORIGIN, never on `host` /
	// `x-forwarded-host`. Those headers are caller-controlled, and everything
	// downstream of this URL is a payment instruction: the copy-paste curl, the
	// x402-fetch snippet, and the agent call all point wherever it points. A
	// spoofed host would hand the buyer an attacker-owned 402 challenge to pay,
	// and because this response is CDN-cacheable that poisoned copy would be
	// served on to other visitors. Same reasoning as resolveResourceUrl() in
	// api/_lib/x402-spec.js.
	const endpointUrl = `${env.APP_ORIGIN}${ENDPOINT_PATH}?mint=${encodeURIComponent(market.mint)}`;

	const token = {
		mint: market.mint,
		symbol: market.symbol,
		name: market.name,
		image: market.image,
		chain: market.chain,
		dex: market.dex,
		pair_url: market.pair_url,
		price_usd: market.price_usd,
		change_24h: market.change_24h,
		market_cap_usd: market.market_cap_usd,
		liquidity_usd: market.liquidity_usd,
		volume_24h_usd: market.volume_24h_usd,
		momentum: market.momentum,
		signal: signal?.signal ?? null,
		headline: signal?.headline ?? null,
		rationale: signal?.rationale ?? null,
		confidence: signal?.confidence ?? null,
		risk,
	};

	const service = {
		name: 'three.ws Token Oracle',
		endpoint: endpointUrl,
		method: 'GET',
		price_usd: PRICE_USD,
		price_atomics: PRICE_ATOMICS,
		asset: 'USDC',
		networks: NETWORKS,
		pay_to: {
			solana: env.X402_PAY_TO_SOLANA || null,
			base: env.X402_PAY_TO_BASE || null,
		},
		description: BAZAAR.description,
		output_schema: OUTPUT_SCHEMA,
		example_output: { ...BAZAAR.output.example, mint: market.mint, symbol: market.symbol },
		bazaar_discoverable: true,
		snippets: buildSnippets(endpointUrl),
	};

	res.setHeader('cache-control', 'public, max-age=20, stale-while-revalidate=60');
	return json(res, 200, { ok: true, token, service });
}

export default wrap(handler);
