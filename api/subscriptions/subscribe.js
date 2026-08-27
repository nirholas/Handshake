/**
 * POST /api/subscriptions/subscribe
 *
 * First step of the user→agent subscription flow. Takes a tier (subscription_plans
 * row) + the buyer's wallet pubkey, quotes the exact USDC split, persists a
 * pending `subscription_checkouts` row, and returns a base64 VersionedTransaction
 * the browser wallet signs and sends. The platform pre-signs as fee-payer so the
 * subscriber needs no SOL — only the USDC for the first period.
 *
 * Fee split: (price − platform_fee) → creator, platform_fee → treasury, both in
 * one atomic transaction alongside the Solana-Pay reference key.
 *
 * Body: { tierId, buyerPublicKey }
 * Returns: { data: { transaction, reference, recipient, amount, creator_amount,
 *            currency_mint, mint_decimals, gasless, label, message, fee?, tier } }
 *
 * Activation happens in /api/subscriptions/verify once the tx lands.
 */

import {
	Keypair, PublicKey,
	TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
} from '@solana/spl-token';
import { z } from 'zod';

import { solanaConnection } from '../_lib/solana/connection.js';
import { blockhashKey, getRecentBlockhashInfo, mintDecimals } from '../_lib/solana/read-guards.js';
import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { resolveMarketplaceFee } from '../_lib/marketplace-platform-fee.js';
import { decodeSecretKey } from '../_lib/solana-signers.js';
import {
	USDC_MAINNET_MINT,
	usdToUsdcAtomics,
	resolveSubscriptionPayout,
} from '../_lib/subscription-checkout.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const bodySchema = z.object({
	tierId:         z.string().uuid(),
	buyerPublicKey: z.string().regex(BASE58_RE, 'invalid public key'),
});

// Platform fee-payer keypair (gasless UX). Prefers MARKETPLACE_PAYER_KEYPAIR;
// falls back to the treasury. When none is configured the buyer pays gas.
let _payerKeypair = undefined; // undefined = unresolved, null = not configured
async function resolvePlatformPayer() {
	if (_payerKeypair !== undefined) return _payerKeypair;
	const secret =
		process.env.MARKETPLACE_PAYER_KEYPAIR ||
		process.env.PLATFORM_TREASURY_KEYPAIR ||
		process.env.TREASURY_KEYPAIR ||
		'';
	if (!secret) { _payerKeypair = null; return null; }
	const bytes = await decodeSecretKey(secret);
	if (!bytes) { _payerKeypair = null; return null; }
	try {
		_payerKeypair = Keypair.fromSecretKey(bytes);
	} catch {
		_payerKeypair = null;
	}
	return _payerKeypair;
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on cookie-session requests; bearer tokens are exempt (the token proves intent).
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const parsed = bodySchema.safeParse(await readJson(req).catch(() => null));
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'validation error');
	}
	const { tierId, buyerPublicKey } = parsed.data;

	const [plan] = await sql`
		SELECT id, creator_id, agent_id, name, price_usd, interval, active
		FROM subscription_plans WHERE id = ${tierId}
	`;
	if (!plan) return error(res, 404, 'not_found', 'subscription tier not found');
	if (!plan.active) return error(res, 409, 'conflict', 'this tier is no longer available');
	if (plan.creator_id === auth.userId) {
		return error(res, 409, 'conflict', 'you cannot subscribe to your own tier');
	}

	// Already actively subscribed? Don't let them pay twice.
	const [active] = await sql`
		SELECT id, current_period_end FROM creator_subscriptions
		WHERE plan_id = ${tierId} AND subscriber_user_id = ${auth.userId}
		  AND status = 'active' AND current_period_end > now()
	`;
	if (active) {
		return error(res, 409, 'already_subscribed', 'you already have an active subscription to this tier', {
			current_period_end: active.current_period_end,
		});
	}

	const recipient = await resolveSubscriptionPayout(plan);
	if (!recipient) {
		return error(res, 412, 'creator_wallet_missing', 'this creator has not configured a payout wallet');
	}

	// Quote the split. USDC at parity with the USD price (6 decimals).
	const grossAtomics = usdToUsdcAtomics(plan.price_usd);
	const feeInfo = await resolveMarketplaceFee({ grossAtomics });
	const platformFeeAtomics = feeInfo ? feeInfo.feeAtomics : 0n;
	const creatorAtomics = grossAtomics - platformFeeAtomics;
	const currencyMint = USDC_MAINNET_MINT;

	// Reuse a fresh pending checkout (idempotent retry) or mint a new reference.
	const [pending] = await sql`
		SELECT reference, amount, creator_amount, platform_fee_amount, platform_fee_wallet,
		       currency_mint, recipient
		FROM subscription_checkouts
		WHERE user_id = ${auth.userId} AND plan_id = ${tierId}
		  AND status = 'pending' AND expires_at > now()
		ORDER BY created_at DESC
		LIMIT 1
	`;

	let checkout;
	if (pending) {
		checkout = pending;
	} else {
		const reference = Keypair.generate().publicKey.toBase58();
		try {
			[checkout] = await sql`
				INSERT INTO subscription_checkouts (
					reference, user_id, plan_id, agent_id, amount, creator_amount,
					platform_fee_amount, platform_fee_wallet, currency_mint, chain,
					recipient, buyer_public_key, interval, expires_at
				) VALUES (
					${reference}, ${auth.userId}, ${tierId}, ${plan.agent_id ?? null},
					${grossAtomics.toString()}, ${creatorAtomics.toString()},
					${platformFeeAtomics.toString()}, ${feeInfo ? feeInfo.recipient.toBase58() : null},
					${currencyMint}, 'solana', ${recipient}, ${buyerPublicKey}, ${plan.interval},
					now() + interval '30 minutes'
				)
				RETURNING reference, amount, creator_amount, platform_fee_amount, platform_fee_wallet,
				          currency_mint, recipient
			`;
		} catch (e) {
			// Lost a race for the (user, plan) pending slot — reuse the winner.
			if (e?.code === '23505') {
				[checkout] = await sql`
					SELECT reference, amount, creator_amount, platform_fee_amount, platform_fee_wallet,
					       currency_mint, recipient
					FROM subscription_checkouts
					WHERE user_id = ${auth.userId} AND plan_id = ${tierId} AND status = 'pending'
					ORDER BY created_at DESC LIMIT 1
				`;
			} else {
				throw e;
			}
		}
	}
	if (!checkout) return error(res, 500, 'checkout_failed', 'could not create the subscription checkout');

	// Build the SPL transfer (creator leg + reference, fee leg) the buyer signs.
	const connection = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	const { blockhash } = await getRecentBlockhashInfo(connection, blockhashKey({ url: SOLANA_RPC }));
	const mintKey = new PublicKey(checkout.currency_mint);
	// USDC and the other settlement mints have fixed, known decimals, so the
	// common case costs no network read at all and a dead RPC cannot stall a
	// checkout over a constant.
	const decimals = await mintDecimals(connection, mintKey);

	const buyer = new PublicKey(buyerPublicKey);
	const fromAta = getAssociatedTokenAddressSync(mintKey, buyer);
	const creatorKey = new PublicKey(checkout.recipient);
	const toAta = getAssociatedTokenAddressSync(mintKey, creatorKey);

	const referenceKey = new PublicKey(checkout.reference);
	const creatorLeg = BigInt(checkout.creator_amount);
	const creatorIx = createTransferCheckedInstruction(fromAta, mintKey, toAta, buyer, creatorLeg, decimals);
	creatorIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });
	const instructions = [creatorIx];

	const feeLeg = BigInt(checkout.platform_fee_amount || 0);
	if (feeLeg > 0n && checkout.platform_fee_wallet) {
		const treasuryAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(checkout.platform_fee_wallet));
		instructions.push(
			createTransferCheckedInstruction(fromAta, mintKey, treasuryAta, buyer, feeLeg, decimals),
		);
	}

	const platformPayer = await resolvePlatformPayer();
	const feePayer = platformPayer ? platformPayer.publicKey : buyer;

	const messageV0 = new TransactionMessage({
		payerKey: feePayer,
		recentBlockhash: blockhash,
		instructions,
	}).compileToV0Message();
	const tx = new VersionedTransaction(messageV0);
	if (platformPayer) tx.sign([platformPayer]);

	const serialized = Buffer.from(tx.serialize()).toString('base64');
	const cycle = plan.interval === 'weekly' ? 'week' : 'month';
	// Derive the fee block from the PERSISTED checkout (the source of truth for the
	// tx the buyer signs), so a reused pending checkout reports its own split even
	// if the fee config changed since it was minted.
	const feeBlock = feeLeg > 0n && checkout.platform_fee_wallet
		? {
				fee: {
					recipient: checkout.platform_fee_wallet,
					amount: feeLeg.toString(),
					bps: Number((feeLeg * 10000n) / BigInt(checkout.amount)),
				},
			}
		: {};

	return json(res, 200, {
		data: {
			transaction:    serialized,
			reference:      checkout.reference,
			recipient:      checkout.recipient,
			amount:         String(checkout.amount),
			creator_amount: String(checkout.creator_amount),
			currency_mint:  checkout.currency_mint,
			mint_decimals:  decimals,
			gasless:        !!platformPayer,
			label:          `Subscribe: ${plan.name.slice(0, 40)}`,
			message:        `Subscribe to '${plan.name}' (${cycle}ly)`,
			tier:           { id: plan.id, name: plan.name, price_usd: Number(plan.price_usd), interval: plan.interval },
			...feeBlock,
		},
	});
});
