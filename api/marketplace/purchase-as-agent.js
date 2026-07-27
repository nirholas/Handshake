/**
 * POST /api/marketplace/purchase-as-agent
 *
 * Autonomous skill purchase. The buyer-agent signs a Solana SPL transfer from
 * its server-stored keypair to acquire persistent skill access from a seller-
 * agent. Session user must own the buyer-agent.
 *
 * Body: { buyer_agent_id, seller_agent_id, skill }
 *
 * Safety controls:
 *   - Per-agent rate limit: 10 purchases/hour  (limits.agentBuy)
 *   - Per-IP rate limit: 30 writes/10 min       (limits.authIp)
 *   - Daily spend cap: enforced against the sum of today's confirmed+pending
 *     purchases across BOTH skills and whole assets (see _lib/agent-purchase.js),
 *     so one budget covers every autonomous purchase this agent makes.
 *     Set buyer_agent.meta.auto_purchase_daily_limit_usdc (e.g. 10 = $10/day).
 *     Default: no cap.
 *   - Self-dealing (buyer_user_id === seller_user_id): allowed but flagged in DB.
 *
 * Revenue + notifications are handled by confirmSkillPurchase (purchase-confirm.js).
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { submitProtected } from '../_lib/execution-engine.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	getMint,
} from '@solana/spl-token';

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited, respondError } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { recoverSolanaAgentKeypair } from '../_lib/agent-wallet.js';
import { confirmSkillPurchase, resolvePayoutAddress, logEvent } from '../_lib/purchase-confirm.js';
import { sumDailyPurchaseAtomics, readPurchaseCap, capExceededMessage } from '../_lib/agent-purchase.js';
import { z } from 'zod';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_DECIMALS = 6;

const bodySchema = z.object({
	buyer_agent_id:  z.string().uuid(),
	seller_agent_id: z.string().uuid(),
	skill:           z.string().trim().min(1).max(100),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, fromSession: true };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, fromSession: false };
	return null;
}

function log(event, fields) {
	console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	// Session-cookie writes need CSRF; bearer-token callers are exempt.
	if (auth.fromSession && !(await requireCsrf(req, res, auth.userId))) return;

	// Per-IP rate limit (coarse gate)
	const rlIp = await limits.authIp(clientIp(req));
	if (!rlIp.success) return rateLimited(res, rlIp);

	const body = await readJson(req).catch(() => null);
	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'validation error');
	}
	const { buyer_agent_id, seller_agent_id, skill } = parsed.data;

	if (buyer_agent_id === seller_agent_id) {
		return error(res, 400, 'validation_error', 'buyer_agent_id and seller_agent_id must differ');
	}

	// Per-agent rate limit (fine-grained: prevents runaway autonomous spending)
	const rlAgent = await limits.agentBuy(buyer_agent_id);
	if (!rlAgent.success) {
		log('purchase_as_agent.rate_limited', { buyer_agent_id, seller_agent_id, skill });
		return rateLimited(res, rlAgent, 'too many autonomous purchases — try again later');
	}

	// Verify caller owns the buyer agent
	const [buyer] = await sql`
		SELECT id, user_id, meta FROM agent_identities
		WHERE id = ${buyer_agent_id} AND deleted_at IS NULL
	`;
	if (!buyer) return error(res, 404, 'not_found', 'buyer agent not found');
	if (buyer.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// Self-dealing detection (buyer and seller owned by same user)
	const [seller] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${seller_agent_id} AND deleted_at IS NULL
	`;
	if (!seller) return error(res, 404, 'not_found', 'seller agent not found');
	const isSelfDealing = buyer.user_id === seller.user_id;
	if (isSelfDealing) {
		log('purchase_as_agent.self_dealing', {
			buyer_agent_id, seller_agent_id, skill, user_id: auth.userId,
		});
	}

	// Already purchased?
	const [existing] = await sql`
		SELECT reference, status, tx_signature, confirmed_at
		FROM skill_purchases
		WHERE user_id = ${auth.userId} AND agent_id = ${seller_agent_id} AND skill = ${skill}
		  AND status IN ('confirmed', 'trial')
		LIMIT 1
	`;
	if (existing) {
		log('purchase_as_agent.already_owned', { buyer_agent_id, seller_agent_id, skill });
		return json(res, 200, { data: { already_owned: true, ...existing } });
	}

	// Fetch active skill price
	const [price] = await sql`
		SELECT amount, currency_mint, chain,
		       COALESCE(mint_decimals, ${USDC_DECIMALS}) AS mint_decimals
		FROM agent_skill_prices
		WHERE agent_id = ${seller_agent_id} AND skill = ${skill} AND is_active = true
		LIMIT 1
	`;
	if (!price) return error(res, 404, 'not_found', 'skill is not for sale');
	if (price.chain !== 'solana') {
		return error(res, 400, 'unsupported_chain', `only solana auto-purchase supported, got '${price.chain}'`);
	}

	// Daily spending cap — fast pre-check. This is a cheap early rejection; the
	// authoritative, race-safe enforcement happens AFTER the pending row is
	// inserted (see below). On its own this check is a TOCTOU: concurrent
	// purchases all read the same pre-spend SUM and each pass, collectively
	// blowing past the cap and spending real funds beyond the user's limit.
	// The cap spans skills AND whole assets (shared with /api/marketplace/buy-asset
	// via _lib/agent-purchase.js), so a budget spent on assets is not silently
	// available again here.
	const { enabled: capEnabled, limitUsdc, limitAtomics } = readPurchaseCap(buyer.meta);
	const sumSpentAtomics = () =>
		sumDailyPurchaseAtomics({ userId: auth.userId, currencyMint: price.currency_mint });
	if (capEnabled) {
		const spentAtomics = await sumSpentAtomics();
		if (spentAtomics + BigInt(price.amount) > limitAtomics) {
			log('purchase_as_agent.spend_cap_exceeded', {
				buyer_agent_id, skill, spent: spentAtomics.toString(),
				amount: price.amount, limit_atomics: limitAtomics.toString(),
			});
			return error(res, 402, 'spend_cap_exceeded', capExceededMessage(limitUsdc));
		}
	}

	// Recover buyer keypair
	const encryptedSecret = buyer.meta?.encrypted_solana_secret;
	if (!encryptedSecret) {
		return error(res, 412, 'no_buyer_wallet',
			'buyer agent has no Solana wallet — provision via POST /api/agents/:id/solana');
	}
	let buyerKeypair;
	try {
		buyerKeypair = await recoverSolanaAgentKeypair(encryptedSecret, {
			agentId: buyer_agent_id,
			userId: auth.userId,
			reason: 'autonomous_skill_purchase',
			meta: { seller_agent_id, skill, is_self_dealing: isSelfDealing },
		});
	} catch (e) {
		return respondError(res, 500, 'wallet_decrypt_failed', e);
	}

	// Resolve seller payout wallet
	const recipientAddr = await resolvePayoutAddress(seller_agent_id, price.chain).catch(() => null);
	if (!recipientAddr) {
		return error(res, 412, 'creator_wallet_missing', 'seller agent has no payout wallet configured');
	}

	// Generate Solana Pay reference + insert pending row
	const referenceKeypair = Keypair.generate();
	const referenceKey = referenceKeypair.publicKey;
	const reference = referenceKey.toBase58();

	const [pur] = await sql`
		INSERT INTO skill_purchases
			(user_id, agent_id, skill, status, reference, amount, currency_mint, chain,
			 expires_at, kind)
		VALUES
			(${auth.userId}, ${seller_agent_id}, ${skill}, 'pending', ${reference},
			 ${price.amount}, ${price.currency_mint}, 'solana',
			 NOW() + INTERVAL '15 minutes', 'purchase')
		RETURNING id, user_id, agent_id, skill, status, amount, currency_mint, chain,
		          reference, expires_at, mint_decimals
	`;
	// Attach mint_decimals from the price row (not stored in skill_purchases)
	pur.mint_decimals = price.mint_decimals;

	log('purchase_as_agent.pending', {
		purchase_id: pur.id, buyer_agent_id, seller_agent_id, skill,
		amount: price.amount, is_self_dealing: isSelfDealing,
	});

	// Authoritative, race-safe spend-cap enforcement. Our pending row is now
	// persisted and counted by sumSpentAtomics(), so re-reading the SUM here
	// includes every concurrent in-flight purchase. If the total (already
	// including this row) exceeds the cap we void this row and abort BEFORE
	// broadcasting any transaction — concurrent requests can no longer each pass
	// a stale pre-check and overspend. Fails safe: under a tie, contending
	// requests abort rather than risk exceeding the user's configured limit.
	if (capEnabled) {
		const spentAtomics = await sumSpentAtomics();
		if (spentAtomics > limitAtomics) {
			await sql`UPDATE skill_purchases SET status = 'failed' WHERE id = ${pur.id} AND status = 'pending'`;
			log('purchase_as_agent.spend_cap_exceeded_reserved', {
				purchase_id: pur.id, buyer_agent_id, skill,
				spent: spentAtomics.toString(), limit_atomics: limitAtomics.toString(),
			});
			return error(res, 402, 'spend_cap_exceeded', capExceededMessage(limitUsdc));
		}
	}

	// Build, sign, and submit the SPL transferChecked
	const connection = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	const mintKey  = new PublicKey(price.currency_mint);
	const recipKey = new PublicKey(recipientAddr);
	const mintInfo = await getMint(connection, mintKey);

	const fromAta = getAssociatedTokenAddressSync(mintKey, buyerKeypair.publicKey);
	const toAta   = getAssociatedTokenAddressSync(mintKey, recipKey);

	const ixs = [
		// Idempotently create seller's ATA (buyer pays the rent)
		createAssociatedTokenAccountIdempotentInstruction(
			buyerKeypair.publicKey, toAta, recipKey, mintKey,
		),
	];
	const transferIx = createTransferCheckedInstruction(
		fromAta, mintKey, toAta, buyerKeypair.publicKey,
		BigInt(price.amount), mintInfo.decimals,
	);
	transferIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });
	ixs.push(transferIx);

	let txSig;
	try {
		// Protected send: priority fee + CU estimate, rebroadcast with blockhash
		// refresh until it lands, hard throw on an on-chain revert.
		({ signature: txSig } = await submitProtected({ network: 'mainnet', connection, payer: buyerKeypair, instructions: ixs }));
		log('purchase_as_agent.tx_confirmed', { purchase_id: pur.id, tx_signature: txSig });
	} catch (e) {
		await sql`
			UPDATE skill_purchases SET status = 'failed'
			WHERE id = ${pur.id} AND status = 'pending'
		`;
		await logEvent(pur.id, 'tx_send_failed', { error: e.message }).catch(() => {});
		log('purchase_as_agent.tx_failed', { purchase_id: pur.id, error: e.message, buyer_agent_id });
		return respondError(res, 502, 'tx_send_failed', e);
	}

	// Validate on-chain + record revenue + emit notifications via canonical lib
	const result = await confirmSkillPurchase({ ...pur, tx_signature: txSig, referrer_user_id: null });

	if (result.status === 'confirmed') {
		log('purchase_as_agent.confirmed', {
			purchase_id: pur.id, buyer_agent_id, seller_agent_id, skill,
			amount: price.amount, tx_signature: result.tx_signature, is_self_dealing: isSelfDealing,
		});
		return json(res, 200, {
			data: {
				status: 'confirmed',
				reference,
				tx_signature: result.tx_signature,
				amount: String(price.amount),
				currency_mint: price.currency_mint,
				seller_agent_id,
				skill,
				is_self_dealing: isSelfDealing,
			},
		});
	}

	// Partial payment (tipped) or mismatch — report faithfully
	log('purchase_as_agent.validation_result', { purchase_id: pur.id, result, buyer_agent_id });
	return error(res, 502, `purchase_${result.status}`,
		result.message || `on-chain validation returned status: ${result.status}`);
});
