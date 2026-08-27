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
import { getSessionUser } from '../_lib/auth.js';
import { isAdminUser } from '../_lib/admin.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { isRpcOutageError } from '../_lib/rpc-degrade.js';
import { publicConfig, ATOMICS_PER_TOKEN } from '../_lib/token/config.js';
import { getTokenPriceUsd, quoteTokenForUsd } from '../_lib/token/price.js';
import {
	issueQuote,
	verifyAndSettlePayment,
	listPayments,
	getAllowanceStatus,
	buildGrantTransaction,
	confirmAllowance,
	buildRevokeTransaction,
	delegateAddress,
} from '../_lib/token/index.js';

// Allowlisted purposes for the generic quote endpoint. Each maps to a split
// policy and a sanity ceiling so this surface can't be used to mint an absurd
// quote. Task 19/20 set their own refs when calling the library directly.
const PURPOSES = {
	spin: { policy: 'spin', maxUsd: 100, requiresSeller: false },
	marketplace_sale: { policy: 'marketplace_sale', maxUsd: 1_000_000, requiresSeller: true },
	// Pay-per-use compute (Forge paid tiers, voice clone, MCP-3D, Granite, selfie).
	// Priced server-side from the pricing catalog; the ceiling guards the generic
	// surface against an absurd client-supplied amount.
	consumption: { policy: 'consumption', maxUsd: 100, requiresSeller: false },
	// Scarcity drops, rare-name auctions, pay-to-mint. Platform mints the scarce
	// good (no seller leg); the high ceiling allows premium auctions.
	scarcity_mint: { policy: 'scarcity_mint', maxUsd: 1_000_000, requiresSeller: false },
};

const SOLANA_ADDRESS = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid Solana address');

// Typed failures from the pricing / fund-routing layer that mean "briefly
// unavailable", not "internal fault". Their messages carry no secrets, so we
// answer them with an honest 503 + retry hint here — before they reach wrap()'s
// generic sanitizer, which would otherwise flatten them into the scary
// "internal error — quote ref …" support dump and strip the actionable code.
const QUOTE_UNAVAILABLE_DETAIL = {
	price_unavailable: 'Live $THREE price is briefly unavailable. Try again in a moment.',
	treasury_unavailable: 'The $THREE payment rail is briefly unavailable. Try again shortly.',
	rewards_unavailable: 'The $THREE payment rail is briefly unavailable. Try again shortly.',
	rpc_unavailable: 'Solana RPC is briefly unavailable, so a live quote cannot be priced. Try again shortly.',
};

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
	const rl = await limits.tokenPriceIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, 'http://x');
	const price = await getTokenPriceUsd();
	const usdParam = url.searchParams.get('usd');
	let quote = null;
	if (usdParam != null) {
		// Quote against the price this response reports, not a second lookup that
		// could cross the cache boundary and disagree with the `price_usd` beside it.
		const q = await quoteTokenForUsd(Number(usdParam), { price });
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
	const rl = await limits.tokenQuote(user.id);
	if (!rl.success) return rateLimited(res, rl);

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

	let issued;
	try {
		issued = await issueQuote({
			purpose: body.purpose,
			usd: body.usd,
			splitPolicy: purpose.policy,
			sellerWallet: body.seller_wallet ?? null,
			network: body.network,
			refType: body.ref_type ?? null,
			refId: body.ref_id ?? null,
		});
	} catch (err) {
		// A quote is never served stale: it prices a live payment. When the price
		// or treasury read died because every RPC lane was exhausted, the honest
		// answer is the same retryable 503 the named codes already get.
		const code = QUOTE_UNAVAILABLE_DETAIL[err?.code] ? err.code : isRpcOutageError(err) ? 'rpc_unavailable' : null;
		const detail = code ? QUOTE_UNAVAILABLE_DETAIL[code] : null;
		if (detail) {
			// Honest, safe-to-show 503 with the actionable code preserved + a back-off
			// hint, so the client renders a clean "try again shortly" retry state.
			res.setHeader('retry-after', '15');
			return error(res, 503, code, detail, { retry_after: 15 });
		}
		throw err; // genuine fault → wrap() logs, alerts, and sanitizes it.
	}
	const { token, quote, expiresAt } = issued;

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
	const rl = await limits.tokenSettle(user.id);
	if (!rl.success) return rateLimited(res, rl);

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

// ── GET /api/token/allowance-status ──────────────────────────────────────────
//
// The signed-in holder's live $THREE spend allowance (remaining cap they've
// pre-authorized to the platform delegate). Powers the wallet panel's "frictionless
// spend" state and the decision to skip a wallet popup on the next paid action.

async function handleAllowanceStatus(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.tokenPriceIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const delegate = await delegateAddress();
	if (!delegate) {
		return json(res, 200, { enabled: false, delegate: null, remaining_atomics: '0', delegations: [] });
	}
	if (!user.wallet_address) {
		return json(res, 200, { enabled: true, delegate, wallet: null, remaining_atomics: '0', delegations: [] });
	}

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const status = await getAllowanceStatus(user.wallet_address, { network });
	return json(res, 200, { wallet: user.wallet_address, ...status });
}

// ── POST /api/token/allowance-grant ──────────────────────────────────────────
//
// Build the user-signed transaction that authorizes a $THREE spend cap. The
// client signs + sends it once; afterwards paid actions debit the cap with no
// popup until it's exhausted, expires, or the user revokes. Non-custodial: funds
// never leave the user's wallet until an actual charge pulls them.

const grantSchema = z.object({
	cap_tokens: z.number().positive().max(1_000_000_000),
	expiry_days: z.number().int().min(1).max(365).optional(),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleAllowanceGrant(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!user.wallet_address) {
		return error(res, 400, 'wallet_required', 'connect a Solana wallet to authorize spending');
	}
	const rl = await limits.tokenQuote(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const delegate = await delegateAddress();
	if (!delegate) {
		return error(res, 503, 'allowance_unavailable', 'the spend-allowance rail is not configured');
	}

	const body = parse(grantSchema, await readJson(req));
	// cap_tokens (whole $THREE, possibly fractional) → atomics. Max 1e9 tokens ×
	// 1e6 atomics = 1e15, within Number.MAX_SAFE_INTEGER, so the round is exact.
	const capAtomics = BigInt(Math.round(body.cap_tokens * Number(ATOMICS_PER_TOKEN)));
	const expiryTs = body.expiry_days
		? Math.floor(Date.now() / 1000) + body.expiry_days * 86_400
		: 0;

	const built = await buildGrantTransaction({
		userWallet: user.wallet_address,
		capAtomics,
		expiryTs,
		network: body.network,
		userId: user.id,
	});

	return json(res, 200, {
		delegate,
		cap_tokens: body.cap_tokens,
		cap_atomics: capAtomics.toString(),
		expiry_ts: expiryTs,
		...built,
	});
}

// ── POST /api/token/allowance-confirm ────────────────────────────────────────
//
// Called by the client right after it sends a signed grant or revoke. Reconciles
// the one delegation PDA against the chain and updates the registry, so the wallet
// panel reflects the new cap (or revocation) instantly without waiting on the
// status cache to expire.

const DELEGATION_PDA = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid delegation address');
const confirmSchema = z.object({
	delegation_pda: DELEGATION_PDA,
	revoked: z.boolean().optional(),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleAllowanceConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!user.wallet_address) return error(res, 400, 'wallet_required', 'connect a Solana wallet');
	const rl = await limits.tokenSettle(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(confirmSchema, await readJson(req));
	const result = await confirmAllowance({
		userWallet: user.wallet_address,
		delegationPda: body.delegation_pda,
		revoked: body.revoked === true,
		network: body.network,
	});
	return json(res, 200, result);
}

// ── POST /api/token/allowance-revoke ─────────────────────────────────────────
//
// Build the user-signed transaction that cancels a delegation and reclaims its
// rent. The client signs + sends it, then calls allowance-confirm with revoked:true.

const revokeSchema = z.object({
	delegation_pda: DELEGATION_PDA,
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleAllowanceRevoke(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!user.wallet_address) return error(res, 400, 'wallet_required', 'connect a Solana wallet');
	const rl = await limits.tokenQuote(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(revokeSchema, await readJson(req));
	const built = await buildRevokeTransaction({
		userWallet: user.wallet_address,
		delegationPda: body.delegation_pda,
		network: body.network,
	});
	return json(res, 200, built);
}

// ── GET /api/token/payments (audit) ──────────────────────────────────────────

async function handlePayments(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await isAdminUser(user))) return error(res, 403, 'forbidden', 'admin access required');

	const url = new URL(req.url, 'http://x');
	const page = await listPayments({
		purpose: url.searchParams.get('purpose') || null,
		refType: url.searchParams.get('ref_type') || null,
		refId: url.searchParams.get('ref_id') || null,
		limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200),
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
	'allowance-status': handleAllowanceStatus,
	'allowance-grant': handleAllowanceGrant,
	'allowance-confirm': handleAllowanceConfirm,
	'allowance-revoke': handleAllowanceRevoke,
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown token action: ${action}`);
	return fn(req, res);
});
