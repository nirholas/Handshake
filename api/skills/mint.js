/**
 * POST /api/skills/mint
 * --------------------------------------------------------------------------
 * Mint a "skill ownership" NFT to the buyer's wallet after their payment is
 * confirmed on-chain. Called by the frontend once the purchase transaction has
 * settled; the NFT is the perpetual on-chain receipt + license.
 *
 * Body: { agent_id, skill_name (or skill), user_wallet, transaction_signature? }
 *
 * Verification (no fraudulent mints): we mint ONLY against a row in
 * skill_purchases that is `confirmed` for THIS user + agent + skill. That row is
 * proven by the existing confirmation pipeline (api/_lib/purchase-confirm.js),
 * which locates the tx on-chain and asserts the correct amount reached the
 * agent's payout wallet. If the purchase is still pending we run that same
 * confirmation here before minting, so a caller cannot mint without a real,
 * correctly-routed payment. The recipient wallet must also be linked to the
 * buyer's account, so nobody can mint a license into a stranger's wallet.
 *
 * Idempotent: one NFT per confirmed purchase. A second call returns the mint
 * that already exists.
 */

import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, error, method, readJson, wrap, rateLimited, serverError, respondError } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { insertNotification } from '../_lib/notify.js';
import { confirmSkillPurchase } from '../_lib/purchase-confirm.js';
import { mintSkillNft } from '../_lib/skill-nft.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{43,128}$/;

const bodySchema = z
	.object({
		agent_id: z.string().trim().regex(UUID_RE, 'agent_id must be a uuid'),
		skill_name: z.string().trim().min(1).max(100).optional(),
		skill: z.string().trim().min(1).max(100).optional(),
		user_wallet: z.string().trim().regex(BASE58_RE, 'user_wallet must be a Solana address'),
		transaction_signature: z
			.string()
			.trim()
			.regex(SIGNATURE_RE, 'invalid transaction signature')
			.optional(),
	})
	.refine((b) => b.skill_name || b.skill, {
		message: 'skill_name required',
		path: ['skill_name'],
	});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, viaSession: true };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, viaSession: false };
	return null;
}

function mintResponse(purchase, mint) {
	return {
		nftMint: mint.mint ?? purchase.skill_nft_mint,
		signature: mint.signature ?? purchase.skill_nft_signature,
		collection: mint.collection ?? null,
		network: mint.network ?? purchase.skill_nft_network,
		explorer: mint.explorer ?? null,
		skill: purchase.skill,
		agent_id: purchase.agent_id,
		purchase_id: purchase.id,
		already_minted: mint.alreadyMinted === true,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	// Cookie-session mutation: CSRF required (bearer callers exempt inside requireCsrf).
	if (auth.viaSession && !(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(bodySchema, await readJson(req));
	const skill = body.skill_name || body.skill;
	const { agent_id: agentId, user_wallet: userWallet, transaction_signature: txSig } = body;

	// The NFT recipient wallet must belong to the caller. Never mint a license
	// into a wallet the buyer hasn't linked to their account.
	const [linked] = await sql`
		SELECT id FROM user_wallets
		WHERE user_id = ${auth.userId} AND address = ${userWallet} AND chain_type = 'solana'
		LIMIT 1
	`;
	if (!linked) {
		return error(
			res,
			403,
			'wallet_not_linked',
			'user_wallet must be a Solana wallet linked to your account',
		);
	}

	// Resolve the buyer's purchase for this exact skill. Prefer the row carrying
	// the provided signature; otherwise the most recent attempt.
	let purchase;
	if (txSig) {
		[purchase] = await sql`
			SELECT * FROM skill_purchases
			WHERE user_id = ${auth.userId} AND agent_id = ${agentId} AND skill = ${skill}
			  AND tx_signature = ${txSig}
			ORDER BY created_at DESC
			LIMIT 1
		`;
	}
	if (!purchase) {
		[purchase] = await sql`
			SELECT * FROM skill_purchases
			WHERE user_id = ${auth.userId} AND agent_id = ${agentId} AND skill = ${skill}
			ORDER BY created_at DESC
			LIMIT 1
		`;
	}
	if (!purchase) {
		return error(res, 404, 'no_purchase', 'no purchase found for this skill; buy it first');
	}

	// A caller-supplied signature that contradicts the recorded one is a red
	// flag: refuse rather than mint against the wrong payment.
	if (txSig && purchase.tx_signature && purchase.tx_signature !== txSig) {
		return error(
			res,
			400,
			'signature_mismatch',
			'transaction_signature does not match this purchase',
		);
	}

	// Idempotency: already minted → return the existing NFT.
	if (purchase.skill_nft_mint) {
		return json(res, 200, { data: mintResponse(purchase, { alreadyMinted: true }) });
	}

	// Confirm the payment if it hasn't been confirmed yet. This is the on-chain
	// verification step: it locates the tx and asserts the correct amount
	// reached the agent's payout wallet before we mint anything.
	if (purchase.status !== 'confirmed') {
		let result;
		try {
			result = await confirmSkillPurchase(purchase, { txHash: txSig });
		} catch (e) {
			console.error('[skills/mint] payment verify failed', e?.message);
			return serverError(res, 502, 'confirm_failed', e);
		}
		if (result.status !== 'confirmed') {
			const map = { pending: 402, expired: 410, tipped: 409, mismatch: 409 };
			return error(
				res,
				map[result.status] || 402,
				`payment_${result.status}`,
				result.message || `payment is ${result.status}; cannot mint until confirmed`,
			);
		}
		// Re-read the freshly confirmed row (status + tx_signature now set).
		[purchase] = await sql`SELECT * FROM skill_purchases WHERE id = ${purchase.id}`;
		if (purchase.skill_nft_mint) {
			return json(res, 200, { data: mintResponse(purchase, { alreadyMinted: true }) });
		}
	}

	// Mint the skill NFT to the buyer's wallet (server-signed + paid by the
	// three.ws collection authority). Skill collections live on Solana
	// regardless of the payment chain.
	let minted;
	try {
		minted = await mintSkillNft({
			agentId,
			skill,
			ownerWallet: userWallet,
			preferredNetwork: 'mainnet',
		});
	} catch (e) {
		console.error('[skills/mint] mint failed', e?.message);
		return respondError(res, e.status || 502, e.code || 'mint_failed', e);
	}

	// Persist the mint, guarded so a concurrent call can't double-record. The
	// unique index on skill_nft_mint is the hard backstop.
	let recorded;
	try {
		[recorded] = await sql`
			UPDATE skill_purchases
			SET skill_nft_mint      = ${minted.mint},
			    skill_nft_signature = ${minted.signature},
			    skill_nft_network   = ${minted.network},
			    skill_nft_minted_at = now()
			WHERE id = ${purchase.id} AND skill_nft_mint IS NULL
			RETURNING skill_nft_mint
		`;
	} catch (e) {
		if (e?.code === '23505') {
			// Another call recorded a mint first, so return the canonical one.
			const [row] = await sql`SELECT * FROM skill_purchases WHERE id = ${purchase.id}`;
			return json(res, 200, { data: mintResponse(row, { alreadyMinted: true }) });
		}
		throw e;
	}
	if (!recorded) {
		// Lost the race; the persisted mint wins. Our freshly minted asset is a
		// harmless orphan. Surface the canonical one.
		const [row] = await sql`SELECT * FROM skill_purchases WHERE id = ${purchase.id}`;
		console.warn('[skills/mint] mint recorded by concurrent call; orphaned asset', {
			purchase_id: purchase.id,
			orphan: minted.mint,
			kept: row?.skill_nft_mint,
		});
		return json(res, 200, { data: mintResponse(row, { alreadyMinted: true }) });
	}

	await insertNotification(auth.userId, 'skill_nft_minted', {
		agent_id: agentId,
		skill,
		nft_mint: minted.mint,
		collection_mint: minted.collection,
		network: minted.network,
		tx_signature: minted.signature,
		purchase_id: purchase.id,
	});

	return json(res, 201, { data: mintResponse(purchase, minted) });
});
