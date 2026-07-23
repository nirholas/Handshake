// Consolidated Solana payment endpoints (checkout + confirm).

import { z } from 'zod';
import { solanaConnection } from '../../_lib/solana/connection.js';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { randomToken } from '../../_lib/crypto.js';
import { sendSubscriptionConfirmEmail } from '../../_lib/email.js';
import { TOKEN_MINT as THREE_MINT, TOKEN_DECIMALS as THREE_DECIMALS } from '../../_lib/token/config.js';
import { getTokenPriceUsd } from '../../_lib/token/price.js';
import { solanaMintUsdPrice } from '../../_lib/balances.js';
import {
	PLANS, PLAN_ASSETS, SOLANA_USDC_MINT, getSolanaRecipient,
	INTENT_TTL_MINUTES, QUOTED_INTENT_TTL_MINUTES,
	planPriceUsd, threePlanDiscountBps,
} from '../_config.js';

const SOLANA_RPC_MAINNET = process.env.SOLANA_RPC_URL        || 'https://api.mainnet-beta.solana.com';
const SOLANA_RPC_DEVNET  = process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com';

const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000n;

// Exact decimal string for `atomics` at `decimals` — Solana Pay amounts must be
// plain decimals (no scientific notation, no float drift).
function atomicsToDecimalString(atomics, decimals) {
	const base = 10n ** BigInt(decimals);
	const whole = atomics / base;
	const frac = (atomics % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : whole.toString();
}

// Ceil so a live-price quote never rounds the payment below the USD price.
function usdToAtomicsCeil(usd, assetPriceUsd, decimals) {
	return BigInt(Math.ceil((usd / assetPriceUsd) * 10 ** decimals));
}

// ── checkout ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
	plan:    z.enum(['pro', 'team', 'enterprise']),
	// USDC settles 1:1 with the USD price. SOL and $THREE are quoted at the
	// live market price when the session is created; paying in $THREE takes the
	// platform-coin discount (threePlanDiscountBps).
	asset:   z.enum(['USDC', 'SOL', 'THREE']).default('USDC'),
	// Devnet is only accepted in non-production environments. Accepting devnet
	// USDC (free from faucet) in production would let anyone upgrade for free.
	network: z.enum(process.env.NODE_ENV === 'production' ? ['mainnet'] : ['mainnet', 'devnet']).default('mainnet'),
});

async function handleCheckout(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(checkoutSchema, await readJson(req));
	const { plan, asset, network } = body;
	const recipient = getSolanaRecipient();
	if (!recipient) return error(res, 503, 'not_configured', 'Solana payment recipient not configured');
	// $THREE only exists on mainnet — a devnet $THREE intent could never confirm.
	if (asset === 'THREE' && network === 'devnet') return error(res, 400, 'bad_request', '$THREE payments are mainnet-only');
	const planConfig = PLANS[plan];
	const amountUsd = planPriceUsd(plan, asset);

	// Resolve the on-chain amount for the chosen asset.
	const usdcMint = network === 'devnet' ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : SOLANA_USDC_MINT;
	let mint = null;          // spl-token mint, null for native SOL
	let decimals;
	let assetPriceUsd = null; // live quote price, null for USDC (always 1)
	if (asset === 'USDC') {
		mint = usdcMint;
		decimals = 6;
	} else if (asset === 'SOL') {
		decimals = 9;
		assetPriceUsd = await solanaMintUsdPrice(SOL_NATIVE_MINT);
		if (!(assetPriceUsd > 0)) return error(res, 503, 'price_unavailable', 'live SOL price unavailable — try again shortly');
	} else {
		mint = THREE_MINT;
		decimals = THREE_DECIMALS;
		const p = await getTokenPriceUsd().catch(() => null);
		assetPriceUsd = p?.priceUsd;
		if (!(assetPriceUsd > 0)) return error(res, 503, 'price_unavailable', 'live $THREE price unavailable — try again shortly');
	}
	const atomics = asset === 'USDC'
		? BigInt(Math.round(amountUsd * 1_000_000))
		: usdToAtomicsCeil(amountUsd, assetPriceUsd, decimals);
	const amountAsset = atomicsToDecimalString(atomics, decimals);

	const nonce = await randomToken(16);
	// Live-price quotes expire faster: the pinned amount drifts from the market.
	const ttlMinutes = asset === 'USDC' ? INTENT_TTL_MINUTES : QUOTED_INTENT_TTL_MINUTES;
	const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
	const [intent] = await sql`insert into plan_payment_intents (user_id, plan, chain_type, amount_usdc, asset, amount_asset, asset_price_usd, recipient, nonce, memo, expires_at) values (${user.id}, ${plan}, 'solana', ${amountUsd}, ${asset}, ${amountAsset}, ${assetPriceUsd}, ${recipient}, ${nonce}, ${nonce}, ${expiresAt}) returning id, nonce, expires_at`;
	const solanaPay = new URL(`solana:${recipient}`);
	solanaPay.searchParams.set('amount', amountAsset);
	if (mint) solanaPay.searchParams.set('spl-token', mint);
	solanaPay.searchParams.set('memo', nonce);
	solanaPay.searchParams.set('label', 'three.ws');
	solanaPay.searchParams.set('message', `${planConfig.label} plan subscription`);
	return json(res, 201, {
		intent_id: intent.id,
		plan,
		asset,
		network,
		solana_pay_url: solanaPay.toString(),
		recipient,
		mint,
		usdc_mint: asset === 'USDC' ? usdcMint : undefined, // legacy field for existing clients
		amount_asset: amountAsset,
		amount_usd: amountUsd,
		amount_usdc: asset === 'USDC' ? amountUsd : undefined, // legacy field
		asset_price_usd: assetPriceUsd,
		discount_bps: asset === 'THREE' ? threePlanDiscountBps() : 0,
		nonce,
		expires_at: intent.expires_at,
	});
}

// ── confirm ───────────────────────────────────────────────────────────────────

const confirmSchema = z.object({
	intent_id:    z.string().uuid(),
	tx_signature: z.string().min(80).max(100),
	network:      z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(confirmSchema, await readJson(req));
	const { intent_id, tx_signature, network } = body;
	const [intent] = await sql`select * from plan_payment_intents where id = ${intent_id} and user_id = ${user.id} and chain_type = 'solana' limit 1`;
	if (!intent) return error(res, 404, 'not_found', 'intent not found');
	if (intent.status === 'confirmed') return error(res, 409, 'already_confirmed', 'payment already confirmed');
	if (intent.status === 'failed') return error(res, 410, 'intent_expired', 'payment session is no longer usable');
	// The client hides the payment UI the moment the quote expires, so a confirm
	// arriving after expires_at is almost always a payment sent just before the
	// quote lapsed (plus finalization time). Honor it within a bounded grace
	// window instead of stranding the funds — the on-chain amount was pinned at
	// quote time, so the window caps price-drift exposure, not the price.
	const CONFIRM_GRACE_MS = 60 * 60 * 1000;
	if (new Date(intent.expires_at).getTime() + CONFIRM_GRACE_MS < Date.now()) {
		await sql`update plan_payment_intents set status='expired' where id=${intent_id} and status='pending'`;
		return error(res, 410, 'intent_expired', 'payment session expired');
	}
	const rpcUrl = network === 'devnet' ? SOLANA_RPC_DEVNET : SOLANA_RPC_MAINNET;
	// A confirmed plan payment grants 30 days of paid plan — an irreversible,
	// latency-tolerant, one-time grant. Require 'finalized' so a short reorg
	// can't roll back the tx after we've already upgraded the account.
	const connection = solanaConnection({ url: rpcUrl, commitment: 'finalized' });
	const usdcMint = network === 'devnet' ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : SOLANA_USDC_MINT;
	let tx;
	try { tx = await connection.getParsedTransaction(tx_signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' }); }
	catch { return error(res, 422, 'tx_not_found', 'transaction not found — may need more confirmations'); }
	if (!tx) return error(res, 422, 'tx_not_found', 'transaction not found');
	if (tx.meta?.err) return error(res, 422, 'tx_failed', 'transaction failed on-chain');
	const memoIx = tx.transaction.message.instructions.find((ix) => ix.programId?.toString() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
	// Memo carries the per-intent nonce. Require it: a tx without a memo (or
	// with a memo of any non-string type) is a replay or wrong-intent attempt
	// even if the on-chain transfer numbers happen to line up.
	const memo = typeof memoIx?.parsed === 'string' ? memoIx.parsed : null;
	if (!memo || memo !== intent.nonce) return error(res, 422, 'memo_mismatch', 'transaction memo does not match intent nonce');
	const expectedRecipient = intent.recipient;

	// Which asset this intent is denominated in, and the exact on-chain amount
	// owed. Legacy USDC rows predate amount_asset — their amount is amount_usdc
	// itself (USDC settles 1:1 with USD).
	const asset = intent.asset || 'USDC';
	const mint = asset === 'USDC' ? usdcMint : asset === 'THREE' ? THREE_MINT : null;
	const decimals = asset === 'USDC' ? 6 : asset === 'THREE' ? THREE_DECIMALS : 9;
	const expectedAtomics = BigInt(Math.round(Number(intent.amount_asset ?? intent.amount_usdc) * 10 ** decimals));

	let paid = false;
	if (asset === 'SOL') {
		// Native SOL: verify via the recipient's lamport balance delta —
		// index-aligned pre/post balances cover every transfer variant.
		const keys = tx.transaction.message.accountKeys || [];
		const idx = keys.findIndex((k) => (k?.pubkey?.toString?.() || String(k?.pubkey ?? '')) === expectedRecipient);
		if (idx >= 0) {
			const delta = BigInt(tx.meta?.postBalances?.[idx] ?? 0) - BigInt(tx.meta?.preBalances?.[idx] ?? 0);
			paid = delta >= expectedAtomics;
		}
	} else {
		const tokenBalances = tx.meta?.postTokenBalances || [];
		const preBalances   = tx.meta?.preTokenBalances  || [];
		const matchingTransfer = tx.transaction.message.instructions.find((ix) => {
			// Either SPL token program: $THREE (like all pump.fun mints) is Token-2022,
			// so a classic-program-only match forced every $THREE payment onto the
			// balance-delta fallback below.
			const prog = ix.programId?.toString();
			if (
				prog !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
				prog !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
			) {
				return false;
			}
			const parsed = ix.parsed;
			if (parsed?.type !== 'transferChecked' && parsed?.type !== 'transfer') return false;
			const info = parsed.info;
			// Require an explicit mint match. `type='transfer'` (legacy Token Program)
			// omits mint from parsed.info — we reject it rather than accepting any token.
			// The balance-delta fallback below correctly requires post.mint === mint.
			const mintMatch = info.mint === mint;
			const amount = BigInt(info.tokenAmount?.amount ?? info.amount ?? '0');
			return mintMatch && amount >= expectedAtomics && (info.destination === expectedRecipient || info.destinationOwner === expectedRecipient);
		});
		paid = Boolean(matchingTransfer);
		if (!paid) {
			for (const post of tokenBalances) {
				if (post.mint !== mint) continue;
				const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
				const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount?.amount ?? '0');
				if (delta >= expectedAtomics) {
					const accountKeys = tx.transaction.message.accountKeys;
					const owner = accountKeys[post.accountIndex]?.pubkey?.toString();
					if (owner === expectedRecipient || post.owner === expectedRecipient) { paid = true; break; }
				}
			}
		}
	}
	if (!paid) return error(res, 422, 'transfer_not_found', `No ${asset === 'THREE' ? '$THREE' : asset} transfer of ${intent.amount_asset ?? intent.amount_usdc} to ${expectedRecipient} found in tx`);
	// Atomically claim the intent: the status read at the top and this write are
	// not in one transaction, so two concurrent confirms for the same intent could
	// both pass the status guard. The conditional UPDATE lets exactly one win; if
	// it claims no row, another request already confirmed → 409 (no double grant).
	// All three writes in one transaction: intent claim + subscription grant + user
	// plan update. A crash between claim and grant can't leave the user paid but
	// unsubscribed (the 409 they'd get on retry would permanently block recovery).
	const planConfig = PLANS[intent.plan];
	const activeUntil = new Date(Date.now() + planConfig.duration_days * 86400 * 1000);
	const [claimed] = await sql.transaction([
		sql`update plan_payment_intents set status='confirmed', tx_hash=${tx_signature}, confirmed_at=now() where id=${intent_id} and status in ('pending', 'expired') returning id`,
		sql`insert into subscriptions (user_id, plan, chain_type, token_address, tx_hash, amount_usd, status, active_until) values (${user.id}, ${intent.plan}, 'solana', ${mint ?? SOL_NATIVE_MINT}, ${tx_signature}, ${intent.amount_usdc}, 'active', ${activeUntil}) on conflict (user_id) where status='active' do update set plan=excluded.plan, chain_type=excluded.chain_type, token_address=excluded.token_address, tx_hash=excluded.tx_hash, amount_usd=excluded.amount_usd, active_until=excluded.active_until, updated_at=now()`,
		sql`update users set plan=${intent.plan} where id=${user.id}`,
	]);
	if (!claimed?.[0]) return error(res, 409, 'already_confirmed', 'payment already confirmed');
	queueMicrotask(() => sendSubscriptionConfirmEmail({ to: user.email, plan: intent.plan, chain: `Solana ${network}`, txId: tx_signature }).catch(() => {}));
	return json(res, 200, { ok: true, plan: intent.plan, asset, active_until: activeUntil.toISOString(), tx_signature });
}

// ── plans (public) ────────────────────────────────────────────────────────────
// Server-truth plan prices + accepted assets, so pricing UIs never hardcode a
// figure that drifts from what checkout actually charges.

async function handlePlans(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	return json(res, 200, {
		plans: Object.fromEntries(Object.entries(PLANS).map(([id, p]) => [id, {
			label: p.label,
			price_usd: p.price_usd,
			three_price_usd: planPriceUsd(id, 'THREE'),
			duration_days: p.duration_days,
		}])),
		assets: PLAN_ASSETS,
		three_discount_bps: threePlanDiscountBps(),
		three_mint: THREE_MINT,
	});
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = { checkout: handleCheckout, confirm: handleConfirm, plans: handlePlans };

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown solana payment action: ${action}`);
	return fn(req, res);
});
