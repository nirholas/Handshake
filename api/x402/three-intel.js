// INTERNAL-USE ONLY; not an agent product. De-listed from the x402 discovery
// catalog (api/wk.js) in the 2026-07 overhaul: the paid intel kiosk in the /play town buys from it.
// The route stays live for those consumers; do not re-add it to the catalog.
// GET /api/x402/three-intel
//
// $THREE Town Oracle — $0.01 USDC per call on Solana or Base.
//
// The paid intel kiosk in the $THREE town (/play) buys from this endpoint:
// live $THREE market intel — price, 24 h change, market cap, liquidity,
// volume, and a bullish/bearish/neutral signal with a short rationale.
// Agents can call it directly too (it's cataloged in the bazaar), so the
// same oracle the town kiosk sells from is buyable by any x402 client.
//
// Response: { mint, symbol, price_usd, change_24h, market_cap_usd,
//             liquidity_usd, volume_24h_usd, signal, headline, rationale,
//             confidence, ts }
//
// Data is live: DexScreener public API (no key required). No mock path.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { env } from '../_lib/env.js';
import { fetchTokenMarketData } from '../_lib/market/token-market.js';
import {
	mppEnabled,
	looksLikeMppPayment,
	mppRequirements,
	mppVerify,
	mppSettle,
} from '../_lib/bnb/mpp-server.js';

const ROUTE = '/api/x402/three-intel';

const DESCRIPTION =
	'$THREE Town Oracle — pay $0.01 USDC per call for live $THREE market intel: ' +
	'price, 24 h change, market cap, liquidity, 24 h volume, and a ' +
	'bullish / bearish / neutral signal with a two-sentence rationale. ' +
	'Powered by live DexScreener data. This is the oracle behind the paid ' +
	'intel kiosk in the $THREE town on three.ws/play.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mint', 'symbol', 'signal', 'headline', 'rationale', 'confidence', 'ts'],
	properties: {
		mint:            { type: 'string' },
		symbol:          { type: 'string' },
		price_usd:       { type: ['number', 'null'] },
		change_24h:      { type: ['number', 'null'] },
		market_cap_usd:  { type: ['number', 'null'] },
		liquidity_usd:   { type: ['number', 'null'] },
		volume_24h_usd:  { type: ['number', 'null'] },
		signal:          { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
		headline:        { type: 'string' },
		rationale:       { type: 'string' },
		confidence:      { type: 'number', minimum: 0, maximum: 1 },
		ts:              { type: 'string', format: 'date-time' },
	},
};

export const BAZAAR = {
	// De-listed per the 2026-07-08 storefront cleanup (prompt 18) — stays live
	// for the /play town kiosk; not agent-discoverable via the bazaar.
	discoverable: false,
	description: DESCRIPTION,
	useCases: ['$THREE market signal', 'in-world paid oracle', 'token intel'],
	input: { type: 'query', example: {}, schema: INPUT_SCHEMA },
	output: {
		type: 'json',
		example: {
			mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			symbol: 'THREE',
			price_usd: 0.003685, change_24h: 12.4, market_cap_usd: 3685000,
			liquidity_usd: 412000, volume_24h_usd: 1268079,
			signal: 'bullish',
			headline: 'THREE climbs +12.40% — moderate upside',
			rationale: 'THREE gained +12.40% over 24 h with price at $0.003685. Volume is healthy against liquidity; momentum favors the upside.',
			confidence: 0.86, ts: '2026-06-12T10:00:00Z',
		},
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// The shared market reader fails over across Birdeye, tokens.xyz, DexScreener,
// GeckoTerminal, DefiLlama and Raydium and keeps a stale copy, so one indexer
// having a bad minute no longer refuses every paid call. The 24h change is the
// one field only some rungs carry; without it the signal cannot be computed
// honestly, and computeThreeIntel refuses before settlement as before.
export async function fetchThreeMarket(mint) {
	const md = await fetchTokenMarketData(mint);
	if (!md || !(md.price_usd > 0)) return null;
	const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
	return {
		price_usd: md.price_usd,
		change_24h: num(md.price_change_24h),
		market_cap_usd: num(md.market_cap),
		liquidity_usd: num(md.liquidity),
		volume_24h_usd: num(md.volume_24h),
	};
}

export function buildSignal({ price_usd, change_24h, volume_24h_usd, liquidity_usd }) {
	const fmt = (n) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(6));
	const pStr = price_usd != null ? `$${fmt(price_usd)}` : '?';
	const sign = change_24h >= 0 ? '+' : '';
	const cStr = `${sign}${change_24h.toFixed(2)}%`;
	// Volume/liquidity turnover colors the rationale: high turnover = conviction.
	const turnover =
		volume_24h_usd != null && liquidity_usd ? volume_24h_usd / liquidity_usd : null;
	const flowLine =
		turnover == null ? 'Flow data is thin; weigh the move accordingly.'
		: turnover > 3 ? 'Volume is running hot against liquidity — high conviction behind the move.'
		: turnover > 1 ? 'Volume is healthy against liquidity; participation is real.'
		: 'Volume is light against liquidity; the move has limited backing so far.';
	let signal, headline;
	if (change_24h > 5) {
		signal = 'bullish';
		headline = `THREE surges ${cStr} in 24 h — strong momentum`;
	} else if (change_24h > 1) {
		signal = 'bullish';
		headline = `THREE climbs ${cStr} — moderate upside`;
	} else if (change_24h < -5) {
		signal = 'bearish';
		headline = `THREE drops ${Math.abs(change_24h).toFixed(2)}% — sellers in control`;
	} else if (change_24h < -1) {
		signal = 'bearish';
		headline = `THREE slips ${cStr} — mild weakness`;
	} else {
		signal = 'neutral';
		headline = `THREE flat at ${cStr} — consolidating at ${pStr}`;
	}
	const rationale = `THREE is ${change_24h >= 0 ? 'up' : 'down'} ${cStr} over 24 h, trading at ${pStr}. ${flowLine}`;
	const confidence = Math.min(0.93, 0.64 + Math.min(Math.abs(change_24h) / 20, 0.29));
	return { signal, headline, rationale, confidence };
}

const PRICE_ATOMICS = priceFor('three-intel', '10000'); // $0.01 USDC

/**
 * The oracle's business logic, shared by the x402 handler and the MPP
 * (BNB Chain) alternate payment path. Throws a 503 when live data is
 * unavailable — a paid endpoint never charges for a fabricated signal.
 */
export async function computeThreeIntel() {
	const mint = env.THREE_TOKEN_MINT;
	let live = null;
	try { live = await fetchThreeMarket(mint); } catch { /* upstream hiccup */ }

	if (!live || live.change_24h == null) {
		throw Object.assign(new Error('live THREE market data is temporarily unavailable'), {
			status: 503,
			code: 'data_unavailable',
		});
	}

	const { signal, headline, rationale, confidence } = buildSignal(live);
	return {
		mint,
		symbol: 'THREE',
		...live,
		signal,
		headline,
		rationale,
		confidence,
		ts: new Date().toISOString(),
	};
}

const x402Handler = paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: PRICE_ATOMICS,
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: '$THREE Town Oracle',
		tags: ['three', 'market', 'signal', 'play', 'solana'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	handler: computeThreeIntel,
});

// Additive MPP (BNB Chain / b402) alternate payment path. A BNB-network
// X-PAYMENT settles through the b402 facilitator; every Solana/Base x402
// request (and every unpaid request) falls through to the untouched x402
// handler. Order is verify (free) → compute → settle so a data-outage 503
// never charges the buyer. Advertising header lets MPP clients discover us.
export default async function handler(req, res) {
	if (mppEnabled() && looksLikeMppPayment(req)) {
		const requirements = await mppRequirements({
			route: ROUTE,
			priceAtomics: PRICE_ATOMICS,
			description: DESCRIPTION,
		});
		const verified = await mppVerify(req, requirements);
		if (!verified.ok) {
			return sendJson(res, verified.status, { error: verified.code, message: verified.reason });
		}
		let body;
		try {
			body = await computeThreeIntel();
		} catch (err) {
			// Business failure BEFORE settle — buyer is not charged.
			return sendJson(res, err.status || 500, { error: err.code || 'error', message: err.message });
		}
		const settled = await mppSettle(verified.payload, requirements, { client: verified.client });
		if (!settled.ok) {
			return sendJson(res, settled.status, { error: settled.code, message: settled.reason });
		}
		res.setHeader('X-PAYMENT-RESPONSE', settled.paymentResponseHeader);
		res.setHeader('X-Settled-Via', 'mpp-b402');
		return sendJson(res, 200, body);
	}
	// Advertise MPP payability to discovery clients without altering x402.
	if (mppEnabled() && typeof res.setHeader === 'function') {
		res.setHeader('X-Accept-Payment-MPP', ROUTE);
	}
	return x402Handler(req, res);
}

function sendJson(res, status, obj) {
	res.statusCode = status;
	if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(obj));
}
