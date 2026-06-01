// $THREE on-chain token layer — HTTP surface.
//
//   GET  /api/token/config    — public token + split config (for clients)
//   GET  /api/token/price     — live USD price (+ optional ?usd= quote)
//   POST /api/token/quote     — issue a signed payment quote (auth)
//   POST /api/token/settle    — verify an on-chain tx + record it (auth)
//   GET  /api/token/payments  — settled-payment audit read (admin)
//
// The quote → settle pair is the generic, demoable end-to-end flow. Task 19 and
// Task 20 reuse the same library (api/_lib/token) directly from their own
// endpoints with purpose-specific refs; this surface keeps the layer exercisable
// on its own and powers shared UI (price display, the pay helper in src).

import { z } from 'zod';
import { env } from '../_lib/env.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { publicConfig } from '../_lib/token/config.js';
import { getTokenPriceUsd, quoteTokenForUsd } from '../_lib/token/price.js';
import { issueQuote, verifyAndSettlePayment, listPayments } from '../_lib/token/index.js';

// Allowlisted purposes for the generic quote endpoint. Each maps to a split
// policy and a sanity ceiling so this surface can't be used to mint an absurd
// quote. Task 19/20 set their own refs when calling the library directly.
const PURPOSES = {
	spin: { policy: 'spin', maxUsd: 100, requiresSeller: false },
	marketplace_sale: { policy: 'marketplace_sale', maxUsd: 1_000_000, requiresSeller: true },
};

const SOLANA_ADDRESS = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid Solana address');

function isAdmin(user) {
	if (!user) return false;
	if (user.is_admin) return true;
	const w = (user.wallet_address || '').toLowerCase();
	return Boolean(w) && env.ADMIN_ADDRESSES.has(w);
}

// ── GET /api/token/config ────────────────────────────────────────────────────

async function handleConfig(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	return json(res, 200, publicConfig());
}

// ── GET /api/token/price ───────────────────────────────────────────────────

async function handlePrice(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	const url = new URL(req.url, 'http://x');
	const price = await getTokenPriceUsd();
	const usdParam = url.searchParams.get('usd');
	let quote = null;
	if (usdParam != null) {
		const q = await quoteTokenForUsd(Number(usdParam));
		quote = { usd: q.usd, token_amount: q.tokenAmount, atomics: q.atomics.toString() };
	}
	return json(res, 200, {
		mint: price.mint,
		price_usd: price.priceUsd,
		source: price.source,
		as_of: price.at,
		...(quote ? { quote } : {}),
	});
}

// ── POST /api/token/quote ────────────────────────────────────────────────────

const quoteSchema = z.object({
	purpose: z.enum(Object.keys(PURPOSES)),
	usd: z.number().positive(),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	seller_wallet: SOLANA_ADDRESS.optional(),
	ref_type: z.string().max(64).optional(),
	ref_id: z.string().max(128).optional(),
});

async function handleQuote(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(quoteSchema, await readJson(req));
	const purpose = PURPOSES[body.purpose];
	if (body.usd > purpose.maxUsd) {
		return error(
			res,
			422,
			'amount_too_large',
			`usd exceeds the ${body.purpose} ceiling of ${purpose.maxUsd}`,
		);
	}
	if (purpose.requiresSeller && !body.seller_wallet) {
		return error(res, 400, 'seller_required', 'seller_wallet is required for this purpose');
	}

	const { token, quote, expiresAt } = await issueQuote({
		purpose: body.purpose,
		usd: body.usd,
		splitPolicy: purpose.policy,
		sellerWallet: body.seller_wallet ?? null,
		network: body.network,
		refType: body.ref_type ?? null,
		refId: body.ref_id ?? null,
	});

	return json(res, 201, {
		quote_token: token,
		purpose: quote.purpose,
		network: quote.network,
		mint: quote.mint,
		decimals: quote.decimals,
		symbol: quote.symbol,
		usd: quote.usd,
		price_usd: quote.priceUsd,
		price_source: quote.priceSource,
		total_atomics: quote.total,
		// Destinations + per-leg atomics + the memo the client must attach.
		legs: quote.legs,
		memo: quote.nonce,
		expires_at: expiresAt,
	});
}

// ── POST /api/token/settle ───────────────────────────────────────────────────

const settleSchema = z.object({
	quote_token: z.string().min(40),
	tx_signature: z.string().min(80).max(100),
	network: z.enum(['mainnet', 'devnet']).optional(),
	payer_wallet: SOLANA_ADDRESS.optional(),
});

async function handleSettle(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(settleSchema, await readJson(req));
	const result = await verifyAndSettlePayment({
		quoteToken: body.quote_token,
		txSignature: body.tx_signature,
		payerWallet: body.payer_wallet ?? user.wallet_address ?? null,
		userId: user.id,
		network: body.network,
	});

	return json(res, 200, {
		ok: true,
		payment_id: result.payment_id,
		purpose: result.quote.purpose,
		usd: result.quote.usd,
		total_atomics: result.quote.total,
		legs: result.quote.legs,
		credited: result.confirmation.credited,
		tx_signature: body.tx_signature,
		slot: result.confirmation.slot,
		ref_type: result.quote.refType ?? null,
		ref_id: result.quote.refId ?? null,
	});
}

// ── GET /api/token/payments (audit) ──────────────────────────────────────────

async function handlePayments(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!isAdmin(user)) return error(res, 403, 'forbidden', 'admin access required');

	const url = new URL(req.url, 'http://x');
	const page = await listPayments({
		purpose: url.searchParams.get('purpose') || null,
		refType: url.searchParams.get('ref_type') || null,
		refId: url.searchParams.get('ref_id') || null,
		limit: Number(url.searchParams.get('limit')) || 50,
		before: url.searchParams.get('before') || null,
	});
	return json(res, 200, page);
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = {
	config: handleConfig,
	price: handlePrice,
	quote: handleQuote,
	settle: handleSettle,
	payments: handlePayments,
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown token action: ${action}`);
	return fn(req, res);
});
