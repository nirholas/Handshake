// Subscription checkout — the on-chain "build tx → sign → verify → activate"
// path for a user subscribing to an agent's tier (subscription_plans row).
//
// Flow:
//   1. /api/subscriptions/subscribe quotes the exact USDC split, mints a
//      Solana-Pay reference, persists a `subscription_checkouts` row, and returns
//      a server-built VersionedTransaction the buyer signs.
//   2. /api/subscriptions/verify hands the broadcast signature back here. We
//      validate the on-chain transfer against the PERSISTED quote (never the
//      client's numbers), then activate the subscription:
//        · creator_subscriptions      — the tier subscription record (status active)
//        · subscription_payments       — the first-period payment ledger row
//        · user_agent_subscriptions    — the access gate hasSkillAccess() reads
//
// Mirrors api/_lib/purchase-confirm.js (one-off skill unlocks) for the
// subscription context.

import { PublicKey } from '@solana/web3.js';
import { findReference, validateTransfer } from '@solana/pay';
import BigNumber from 'bignumber.js';

import { sql } from './db.js';
import { rpcFallbackFromEnv } from './solana/rpc-fallback.js';
import { insertNotification } from './notify.js';
import { resolvePayoutAddress } from './purchase-confirm.js';
import {
	USDC_MAINNET_MINT,
	USDC_DECIMALS,
	usdToUsdcAtomics,
	intervalMs,
	computePeriod,
} from './subscription-pricing.js';

// Re-export the pure pricing helpers so existing callers keep importing them
// from here; the math itself lives in subscription-pricing.js (I/O-free, tested).
export { USDC_MAINNET_MINT, USDC_DECIMALS, usdToUsdcAtomics, intervalMs, computePeriod };

let _rpc;
function rpc() {
	if (!_rpc) _rpc = rpcFallbackFromEnv({ network: 'mainnet' });
	return _rpc;
}

// ── Payout resolution ────────────────────────────────────────────────────────

/**
 * Resolve the Solana payout address that should receive the subscription
 * payment. Agent-scoped tiers route to the agent owner's payout wallet; the
 * marketplace UI only ever surfaces agent-scoped tiers.
 * @param {{ agent_id: string|null }} plan
 * @returns {Promise<string|null>}
 */
export async function resolveSubscriptionPayout(plan) {
	if (plan.agent_id) {
		const direct = await resolvePayoutAddress(plan.agent_id, 'solana');
		if (direct) return direct;
		// Fall back to the agent metadata's recorded Solana address.
		const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${plan.agent_id}`;
		return row?.meta?.solana_address ?? null;
	}
	// Creator-scoped plan (no agent): use the creator's default Solana payout wallet.
	const [row] = await sql`
		SELECT address FROM agent_payout_wallets
		WHERE user_id = ${plan.creator_id} AND chain = 'solana' AND is_default = true
		ORDER BY created_at ASC
		LIMIT 1
	`;
	return row?.address ?? null;
}

// ── On-chain verification ────────────────────────────────────────────────────

// The fee leg carries no Solana-Pay reference of its own (the reference rides
// the seller leg, which validateTransfer checks), so confirm it via the same
// balance-delta technique @solana/pay uses — matched on the parsed token
// balance's `owner`, robust to versioned txs and ATA addressing.
async function feeLegSatisfied(txSignature, feeWallet, splTokenMint, minAtomics) {
	if (minAtomics <= 0n) return true;
	const tx = await rpc().withFallback((conn) =>
		conn.getParsedTransaction(txSignature, {
			commitment: 'confirmed',
			maxSupportedTransactionVersion: 0,
		}),
	);
	if (!tx || tx.meta?.err) return false;
	const mintStr = splTokenMint.toBase58();
	const matches = (b) => b && b.mint === mintStr && b.owner === feeWallet;
	const pre = tx.meta.preTokenBalances?.find(matches);
	const post = tx.meta.postTokenBalances?.find(matches);
	const preAmt = BigInt(pre?.uiTokenAmount?.amount ?? '0');
	const postAmt = BigInt(post?.uiTokenAmount?.amount ?? '0');
	return postAmt - preAmt >= minAtomics;
}

/**
 * Validate that the on-chain transaction settles the persisted checkout quote.
 *
 * The buyer signs a server-built tx with two legs — (price − fee) to the creator
 * and the fee to the treasury — both bound by the shared reference. We also
 * accept a single full-amount transfer to the creator (no fee taken), so a buyer
 * who paid the full price via a fallback path is never blocked.
 *
 * @param {object} checkout — a subscription_checkouts row.
 * @param {string|null} txSignature — the broadcast signature (preferred); when
 *        absent we locate the tx by reference.
 * @returns {Promise<{ status: 'confirmed'|'pending'|'mismatch', tx_signature?: string, message?: string }>}
 */
export async function verifySubscriptionPayment(checkout, txSignature = null) {
	const refKey = new PublicKey(checkout.reference);
	const recipient = new PublicKey(checkout.recipient);
	const splToken = new PublicKey(checkout.currency_mint);
	const pow = new BigNumber(10).pow(USDC_DECIMALS);
	const gross = new BigNumber(checkout.amount);
	const creatorLeg = new BigNumber(checkout.creator_amount);
	const feeAtomics = new BigNumber(checkout.platform_fee_amount || 0);
	const feeWallet = checkout.platform_fee_wallet || null;

	// Resolve the signature: trust a caller-supplied one, else scan by reference.
	let signature = txSignature;
	if (!signature) {
		try {
			const info = await rpc().withFallback((conn) =>
				findReference(conn, refKey, { finality: 'confirmed' }),
			);
			signature = info.signature;
		} catch (e) {
			if (/FindReferenceError|not found/i.test(e?.message || '')) return { status: 'pending' };
			throw e;
		}
	}

	const validateLeg = (who, amountAtomics) =>
		rpc().withFallback((conn) =>
			validateTransfer(
				conn,
				signature,
				{ recipient: who, amount: amountAtomics.dividedBy(pow), splToken, reference: refKey },
				{ commitment: 'confirmed' },
			),
		);

	// Attempt the quoted split first, then the full-amount fallback.
	const attempts = [];
	if (feeAtomics.gt(0) && feeWallet) {
		attempts.push({ creator: creatorLeg, feeTaken: feeAtomics, feeWallet });
	}
	attempts.push({ creator: gross, feeTaken: new BigNumber(0), feeWallet: null });

	let lastErr = null;
	for (const a of attempts) {
		try {
			await validateLeg(recipient, a.creator);
			if (a.feeTaken.gt(0)) {
				const ok = await feeLegSatisfied(signature, a.feeWallet, splToken, BigInt(a.feeTaken.toFixed(0)));
				if (!ok) throw new Error('platform fee leg missing or short');
			}
			return { status: 'confirmed', tx_signature: signature };
		} catch (e) {
			// A tx that simply isn't on-chain yet surfaces as a validation error too;
			// treat "not found / not finalized" as still-pending so the client retries.
			if (/not found|was not found|not.*confirmed|not.*finalized/i.test(e?.message || '')) {
				return { status: 'pending' };
			}
			lastErr = e;
		}
	}
	return { status: 'mismatch', tx_signature: signature, message: lastErr?.message || 'transfer did not match the quoted amount' };
}

// ── Activation ───────────────────────────────────────────────────────────────

/**
 * Activate a verified checkout: flip the checkout to confirmed (once), then
 * create/refresh the tier subscription, ledger the payment, and open the
 * agent-level access gate. Idempotent — a second call returns the existing
 * subscription without double-writing.
 *
 * @param {object} checkout — a subscription_checkouts row (must include plan_id,
 *        user_id, agent_id, amount, currency_mint, chain, interval, reference).
 * @param {string} txSignature
 * @param {string|null} buyerWallet — the buyer's wallet address (for the record).
 */
export async function activateSubscription(checkout, txSignature, buyerWallet = null) {
	// Claim the checkout exactly once.
	const claimed = await sql`
		UPDATE subscription_checkouts
		SET status = 'confirmed', tx_signature = ${txSignature}, confirmed_at = now()
		WHERE id = ${checkout.id} AND status = 'pending'
		RETURNING id
	`;
	if (claimed.length === 0) {
		// Already processed (concurrent verify / double-click) — return current state.
		const [sub] = await sql`
			SELECT cs.id, cs.status, cs.current_period_start, cs.current_period_end, cs.plan_id
			FROM creator_subscriptions cs
			WHERE cs.plan_id = ${checkout.plan_id} AND cs.subscriber_user_id = ${checkout.user_id}
		`;
		return { subscription: sub || null, already_processed: true };
	}

	const [plan] = await sql`
		SELECT id, creator_id, agent_id, name, price_usd, interval
		FROM subscription_plans WHERE id = ${checkout.plan_id}
	`;
	const interval = checkout.interval || plan?.interval || 'monthly';
	const { start, end } = computePeriod(interval);
	const priceUsd = plan?.price_usd != null ? Number(plan.price_usd) : Number(checkout.amount) / 10 ** USDC_DECIMALS;

	// 1. Tier subscription record (creator_subscriptions). Re-activate a prior
	//    cancelled/past_due row, else insert fresh.
	const [existing] = await sql`
		SELECT id FROM creator_subscriptions
		WHERE plan_id = ${checkout.plan_id} AND subscriber_user_id = ${checkout.user_id}
	`;
	let subscription;
	if (existing) {
		[subscription] = await sql`
			UPDATE creator_subscriptions
			SET status = 'active',
			    current_period_start = ${start.toISOString()},
			    current_period_end = ${end.toISOString()},
			    payment_method = 'solana',
			    wallet_address = ${buyerWallet},
			    chain = ${checkout.chain || 'solana'},
			    currency_mint = ${checkout.currency_mint},
			    cancelled_at = NULL
			WHERE id = ${existing.id}
			RETURNING id, plan_id, status, current_period_start, current_period_end
		`;
	} else {
		[subscription] = await sql`
			INSERT INTO creator_subscriptions
				(plan_id, subscriber_user_id, status, current_period_start, current_period_end,
				 payment_method, wallet_address, chain, currency_mint)
			VALUES
				(${checkout.plan_id}, ${checkout.user_id}, 'active', ${start.toISOString()},
				 ${end.toISOString()}, 'solana', ${buyerWallet},
				 ${checkout.chain || 'solana'}, ${checkout.currency_mint})
			RETURNING id, plan_id, status, current_period_start, current_period_end
		`;
	}

	// 2. First-period payment ledger row.
	await sql`
		INSERT INTO subscription_payments (subscription_id, amount_usd, status, tx_hash, paid_at)
		VALUES (${subscription.id}, ${priceUsd}, 'succeeded', ${txSignature}, now())
	`;

	// 3. Open the access gate hasSkillAccess() reads. Agent-scoped only.
	if (checkout.agent_id) {
		try {
			await sql`
				INSERT INTO user_agent_subscriptions
					(user_id, agent_id, status, current_period_ends_at, tx_signature,
					 price_amount, currency_mint, chain)
				VALUES
					(${checkout.user_id}, ${checkout.agent_id}, 'active', ${end.toISOString()},
					 ${txSignature}, ${checkout.amount}, ${checkout.currency_mint}, ${checkout.chain})
				ON CONFLICT (user_id, agent_id) DO UPDATE SET
					status = 'active',
					current_period_ends_at = EXCLUDED.current_period_ends_at,
					tx_signature = EXCLUDED.tx_signature,
					price_amount = EXCLUDED.price_amount,
					currency_mint = EXCLUDED.currency_mint,
					chain = EXCLUDED.chain,
					cancelled_at = NULL,
					updated_at = now()
			`;
		} catch (e) {
			// Access still tracked via creator_subscriptions; never block the
			// confirm on the gate write.
			console.warn('[subscription-checkout] access gate upsert failed', e?.message);
		}
	}

	// 4. Notify both sides.
	await insertNotification(checkout.user_id, 'subscription_activated', {
		plan_id: checkout.plan_id,
		agent_id: checkout.agent_id,
		plan_name: plan?.name || null,
		amount_usd: priceUsd,
		current_period_end: end.toISOString(),
		tx_signature: txSignature,
	}).catch(() => {});
	if (plan?.creator_id && plan.creator_id !== checkout.user_id) {
		await insertNotification(plan.creator_id, 'new_subscriber', {
			plan_id: checkout.plan_id,
			agent_id: checkout.agent_id,
			plan_name: plan?.name || null,
			amount_usd: priceUsd,
			tx_signature: txSignature,
		}).catch(() => {});
	}

	return {
		subscription,
		current_period_start: start.toISOString(),
		current_period_end: end.toISOString(),
		already_processed: false,
	};
}
