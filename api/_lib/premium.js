// three.ws Premium — the monthly developer pass.
//
// One purchase on Solana ($THREE, SOL, or USDC) buys 30 days of premium API
// access. Instead of paying the x402 challenge on every call (the AIXBT
// complaint), a pass holder gets:
//   • an `x402_live_…` API key (an x402_subscriptions row) that the existing
//     installAccessControl() lane already honours on every paid route — no
//     per-route changes needed for the key lane;
//   • SIWX grants on each premium resource so a browser wallet re-enters by
//     signature (the paidEndpoint SIWX short-circuit), no key required.
//
// Flow: quote (lock USD→asset price for 10 min, build the unsigned Solana tx)
//   → buyer signs + sends from their own wallet
//   → subscribe (verify the LANDED tx on-chain against the locked quote,
//     one-shot claim, mint/extend the pass + key + grants).
//
// Payment verification is balance-delta based (the technique
// subscription-checkout.js uses): parse the confirmed transaction and require
// the treasury's token (or lamport) balance to have grown by at least the
// quoted amount, with the paying wallet among the signers. The tx_signature
// UNIQUE constraint makes claims idempotent and replay-proof.
//
// $THREE gets a configurable discount (default 20%) — the platform coin is the
// cheapest way to go premium, by design.

import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
} from '@solana/spl-token';

import { sql } from './db.js';
import { env } from './env.js';
import { solPriceUsd } from './sol-price.js';
import { getTokenPriceUsd } from './token/price.js';
import { usdToUsdcAtomics, USDC_DECIMALS } from './subscription-pricing.js';
import { createSubscription } from './x402/api-keys.js';
import { siwxStorage } from './siwx-storage.js';
import { solanaConnection } from './solana/connection.js';
import { rpcFallbackFromEnv } from './solana/rpc-fallback.js';
import { NETWORK_SOLANA_MAINNET } from './x402-spec.js';

// ── Plan ─────────────────────────────────────────────────────────────────────

const num = (v, fallback) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function premiumPlan() {
	const usd = num(process.env.PREMIUM_PASS_USD, 9.99);
	const threeDiscount = Math.min(0.9, Math.max(0, num(process.env.PREMIUM_PASS_THREE_DISCOUNT, 0.2)));
	return {
		id: 'premium',
		name: 'three.ws Premium',
		usd,
		days: num(process.env.PREMIUM_PASS_DAYS, 30),
		threeDiscount,
		threeUsd: Math.round(usd * (1 - threeDiscount) * 100) / 100,
		rateLimitPerMinute: num(process.env.PREMIUM_RATE_LIMIT_PER_MINUTE, 120),
	};
}

// Resources the pass unlocks via SIWX browser grants. The API-key lane is
// route-agnostic (installAccessControl honours the key on every paid route);
// this list only controls which resources a browser wallet can re-enter by
// signature. Grow it as more freemium surfaces join the pass.
export const PREMIUM_RESOURCES = ['https://three.ws/api/news/archive'];

const QUOTE_TTL_MS = 10 * 60_000;
const SOL_DECIMALS = 9;

function assetConfig(asset) {
	if (asset === 'USDC') {
		return { mint: env.X402_ASSET_MINT_SOLANA, decimals: USDC_DECIMALS };
	}
	if (asset === 'THREE') {
		return { mint: env.THREE_TOKEN_MINT, decimals: Number(env.THREE_TOKEN_DECIMALS) || 6 };
	}
	if (asset === 'SOL') {
		return { mint: null, decimals: SOL_DECIMALS }; // native
	}
	const err = new Error('asset must be THREE, SOL, or USDC');
	err.status = 400;
	err.code = 'bad_asset';
	throw err;
}

export function treasuryWallet() {
	const to = env.X402_PAY_TO_SOLANA;
	if (!to) {
		const err = new Error('premium purchases are not configured (X402_PAY_TO_SOLANA unset)');
		err.status = 503;
		err.code = 'not_configured';
		throw err;
	}
	return to;
}

// ── Pricing ──────────────────────────────────────────────────────────────────

/**
 * Convert the plan's USD price into an atomic amount of `asset` at the current
 * oracle price. Returns { atomics, assetUsd, priceSource, usd }.
 */
export async function priceAsset(asset) {
	const plan = premiumPlan();
	if (asset === 'USDC') {
		return { atomics: BigInt(usdToUsdcAtomics(plan.usd)), assetUsd: null, priceSource: 'parity', usd: plan.usd };
	}
	if (asset === 'SOL') {
		const sol = await solPriceUsd();
		if (!Number.isFinite(sol) || sol <= 0) {
			const err = new Error('SOL price unavailable right now — pay in USDC or $THREE, or retry shortly');
			err.status = 503;
			err.code = 'price_unavailable';
			throw err;
		}
		const lamports = BigInt(Math.ceil((plan.usd / sol) * 1e9));
		return { atomics: lamports, assetUsd: sol, priceSource: 'sol-oracle', usd: plan.usd };
	}
	if (asset === 'THREE') {
		// $THREE holders pay the discounted price — the platform coin is the
		// cheapest way in.
		const { priceUsd, source } = await getTokenPriceUsd({});
		const decimals = Number(env.THREE_TOKEN_DECIMALS) || 6;
		const atomics = BigInt(Math.ceil((plan.threeUsd / priceUsd) * 10 ** decimals));
		return { atomics, assetUsd: priceUsd, priceSource: source, usd: plan.threeUsd };
	}
	return assetConfig(asset); // throws bad_asset
}

// ── Quote (price lock + unsigned tx) ─────────────────────────────────────────

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function assertWallet(wallet) {
	if (!wallet || !BASE58_RE.test(wallet)) {
		const err = new Error('wallet must be a base58 Solana address');
		err.status = 400;
		err.code = 'bad_wallet';
		throw err;
	}
	return wallet;
}

/**
 * Build the unsigned payment transaction (buyer is fee payer, single transfer
 * to the treasury) and persist the locked quote. Returns
 * { quote, tx_base64 } where quote carries id/asset/atomics/expiry.
 */
export async function createQuote({ wallet, asset, userId = null }) {
	assertWallet(wallet);
	const { mint, decimals } = assetConfig(asset);
	const payTo = treasuryWallet();
	const plan = premiumPlan();
	const priced = await priceAsset(asset);

	const buyer = new PublicKey(wallet);
	const dest = new PublicKey(payTo);
	const instructions = [];
	if (asset === 'SOL') {
		instructions.push(
			SystemProgram.transfer({ fromPubkey: buyer, toPubkey: dest, lamports: priced.atomics }),
		);
	} else {
		const mintKey = new PublicKey(mint);
		const fromAta = getAssociatedTokenAddressSync(mintKey, buyer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const toAta = getAssociatedTokenAddressSync(mintKey, dest, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		instructions.push(
			// Buyer funds the treasury ATA if it doesn't exist yet (idempotent, a
			// few cents once, no-op forever after).
			createAssociatedTokenAccountIdempotentInstruction(buyer, toAta, dest, mintKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
			createTransferCheckedInstruction(fromAta, mintKey, toAta, buyer, priced.atomics, decimals, [], TOKEN_PROGRAM_ID),
		);
	}

	const conn = solanaConnection();
	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	const message = new TransactionMessage({
		payerKey: buyer,
		recentBlockhash: blockhash,
		instructions,
	}).compileToV0Message();
	const tx = new VersionedTransaction(message);
	const txBase64 = Buffer.from(tx.serialize()).toString('base64');

	// Opportunistic GC — dead quotes are worthless after their redeem window;
	// pruning here keeps the table tiny without needing a cron.
	sql`delete from premium_quotes where status = 'pending' and created_at < now() - interval '7 days'`
		.catch(() => {});

	const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
	const [quote] = await sql`
		insert into premium_quotes
			(wallet, plan, asset, amount_atomics, usd_price, asset_usd, price_source, user_id, expires_at)
		values
			(${wallet}, ${plan.id}, ${asset}, ${priced.atomics.toString()}, ${priced.usd},
			 ${priced.assetUsd}, ${priced.priceSource}, ${userId}, ${expiresAt})
		returning id, wallet, plan, asset, amount_atomics, usd_price, expires_at
	`;
	return { quote, tx_base64: txBase64 };
}

// ── On-chain verification ────────────────────────────────────────────────────

const rpc = () => rpcFallbackFromEnv({ network: 'mainnet', commitment: 'confirmed' });

/**
 * Verify that `txSignature` is a landed, successful transaction in which
 * `quote.wallet` (a signer) moved ≥ quote.amount_atomics of the quoted asset
 * to the treasury. Balance-delta based, robust to ATA addressing and versioned
 * transactions. Returns { ok: true } or { ok: false, pending?, reason }.
 */
export async function verifyPassPayment(quote, txSignature) {
	const payTo = treasuryWallet();
	const { mint } = assetConfig(quote.asset);
	let tx;
	try {
		tx = await rpc().withFallback((conn) =>
			conn.getParsedTransaction(txSignature, {
				commitment: 'confirmed',
				maxSupportedTransactionVersion: 0,
			}),
		);
	} catch (e) {
		// "Invalid param" from the RPC means the signature itself is malformed —
		// that never becomes confirmable, so fail hard instead of telling the
		// client to keep polling.
		if (/invalid param/i.test(e.message || '')) {
			return { ok: false, reason: `not a valid transaction signature: ${e.message}` };
		}
		return { ok: false, pending: true, reason: `rpc lookup failed: ${e.message}` };
	}
	if (!tx) return { ok: false, pending: true, reason: 'transaction not found yet — still confirming' };
	if (tx.meta?.err) return { ok: false, reason: 'transaction failed on-chain' };

	const keys = tx.transaction?.message?.accountKeys || [];
	const signers = keys.filter((k) => k.signer).map((k) => String(k.pubkey));
	if (!signers.includes(quote.wallet)) {
		return { ok: false, reason: 'the quoted wallet did not sign this transaction' };
	}

	const need = BigInt(quote.amount_atomics);
	if (quote.asset === 'SOL') {
		const idx = keys.findIndex((k) => String(k.pubkey) === payTo);
		if (idx === -1) return { ok: false, reason: 'treasury wallet not present in transaction' };
		const delta = BigInt(tx.meta.postBalances?.[idx] ?? 0) - BigInt(tx.meta.preBalances?.[idx] ?? 0);
		if (delta < need) return { ok: false, reason: `treasury received ${delta} lamports, need ${need}` };
		return { ok: true };
	}

	const matches = (b) => b && b.mint === mint && b.owner === payTo;
	const pre = tx.meta.preTokenBalances?.find(matches);
	const post = tx.meta.postTokenBalances?.find(matches);
	const delta = BigInt(post?.uiTokenAmount?.amount ?? '0') - BigInt(pre?.uiTokenAmount?.amount ?? '0');
	if (delta < need) return { ok: false, reason: `treasury received ${delta} atomics of ${quote.asset}, need ${need}` };
	return { ok: true };
}

// ── Activation ───────────────────────────────────────────────────────────────

async function currentPass(wallet) {
	const [row] = await sql`
		select * from premium_passes
		where wallet = ${wallet} and expires_at > now()
		order by expires_at desc
		limit 1
	`;
	return row || null;
}

/**
 * One-shot claim of a verified quote: appends the pass period (renewals start
 * at the previous expiry — no lost days), mints or extends the linked
 * `x402_live_` API key, and records SIWX grants for every premium resource.
 *
 * Idempotent: re-submitting the same tx_signature returns the existing pass
 * (with the key prefix, not the plaintext — that is shown exactly once).
 */
export async function activatePass({ quote, txSignature, userId = null }) {
	const plan = premiumPlan();

	// Claim the quote first — a lost race here means someone else's request is
	// already activating this exact payment; fall through to the idempotent read.
	const [claimed] = await sql`
		update premium_quotes
		   set status = 'used', tx_signature = ${txSignature}
		 where id = ${quote.id} and status = 'pending'
		returning id
	`;
	if (!claimed) {
		const [existing] = await sql`
			select * from premium_passes where tx_signature = ${txSignature} limit 1
		`;
		if (existing) return { pass: existing, apiKey: null, renewed: true };
		const err = new Error('quote already used with a different transaction');
		err.status = 409;
		err.code = 'quote_used';
		throw err;
	}

	const prev = await currentPass(quote.wallet);
	const startsAt = prev ? new Date(prev.expires_at) : new Date();
	const expiresAt = new Date(startsAt.getTime() + plan.days * 86_400_000);

	// Key: extend the wallet's existing premium key, else mint a fresh one.
	let apiKey = null;
	let subscriptionId = prev?.api_subscription_id || null;
	if (subscriptionId) {
		const [extended] = await sql`
			update x402_subscriptions
			   set expires_at = ${expiresAt.toISOString()}
			 where id = ${subscriptionId} and revoked_at is null
			returning id
		`;
		if (!extended) subscriptionId = null; // key was revoked — mint a new one
	}
	if (!subscriptionId) {
		const sub = await createSubscription({
			name: `Premium pass · ${quote.wallet.slice(0, 4)}…${quote.wallet.slice(-4)}`,
			rateLimitPerMinute: plan.rateLimitPerMinute,
			expiresAt: expiresAt.toISOString(),
			meta: { source: 'premium-pass', wallet: quote.wallet, user_id: userId },
			createdBy: userId,
		});
		subscriptionId = sub.id;
		apiKey = sub.token; // plaintext — surfaced exactly once
	}

	let pass;
	try {
		[pass] = await sql`
			insert into premium_passes
				(wallet, user_id, plan, asset, amount_atomics, usd_price, tx_signature,
				 network, api_subscription_id, started_at, expires_at, meta)
			values
				(${quote.wallet}, ${userId}, ${plan.id}, ${quote.asset}, ${quote.amount_atomics},
				 ${quote.usd_price}, ${txSignature}, ${NETWORK_SOLANA_MAINNET}, ${subscriptionId},
				 ${startsAt.toISOString()}, ${expiresAt.toISOString()},
				 ${JSON.stringify({ quote_id: quote.id })})
			returning *
		`;
	} catch (e) {
		// UNIQUE(tx_signature) race — the concurrent claimer won; serve its pass.
		const [existing] = await sql`
			select * from premium_passes where tx_signature = ${txSignature} limit 1
		`;
		if (existing) return { pass: existing, apiKey: null, renewed: true };
		throw e;
	}

	// Browser lane: SIWX grants until the pass expires. Failures here must not
	// eat a settled payment — the key lane already works; grants self-heal on
	// the next renewal.
	const ttlSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
	for (const resource of PREMIUM_RESOURCES) {
		try {
			await siwxStorage.recordPayment(resource, quote.wallet, {
				network: NETWORK_SOLANA_MAINNET,
				ttlSeconds,
			});
		} catch (e) {
			console.error('[premium] siwx grant failed', resource, e.message);
		}
	}

	return { pass, apiKey, renewed: Boolean(prev) };
}

// ── Status ───────────────────────────────────────────────────────────────────

/** Everything the dashboard needs for one wallet, in one query round. */
export async function passStatus(wallet) {
	assertWallet(wallet);
	const pass = await currentPass(wallet);
	const history = await sql`
		select id, plan, asset, amount_atomics, usd_price, tx_signature, started_at, expires_at, created_at
		from premium_passes
		where wallet = ${wallet}
		order by created_at desc
		limit 24
	`;
	let keys = [];
	if (pass?.api_subscription_id) {
		keys = await sql`
			select s.id, s.name, s.key_prefix, s.rate_limit_per_minute, s.expires_at, s.revoked_at,
			       u.granted, u.denied, u.last_seen
			from x402_subscriptions s
			left join lateral (
				select count(*) filter (where granted)     as granted,
				       count(*) filter (where not granted) as denied,
				       max(created_at)                     as last_seen
				from x402_access_log
				where caller_id = 'subscription:' || s.id
			) u on true
			where s.id = ${pass.api_subscription_id}
		`;
	}
	return {
		active: Boolean(pass),
		pass: pass
			? { id: pass.id, plan: pass.plan, started_at: pass.started_at, expires_at: pass.expires_at, asset: pass.asset }
			: null,
		resources: PREMIUM_RESOURCES,
		keys: keys.map((k) => ({
			id: k.id,
			name: k.name,
			key_prefix: k.key_prefix,
			rate_limit_per_minute: k.rate_limit_per_minute,
			expires_at: k.expires_at,
			status: k.revoked_at ? 'revoked' : 'active',
			usage: { granted: Number(k.granted || 0), denied: Number(k.denied || 0), last_seen: k.last_seen || null },
		})),
		history,
	};
}
