// Programmatic $THREE micro-buy primitive — the buy-only engine behind the x402
// micro-buy loop.
//
// WHAT IT IS. A small, fixed-size market buy of $THREE on Jupiter (USDC → $THREE,
// ExactIn), executed once per settled x402 call so the platform can run a high
// cadence of tiny, continuous buys (target ~60/min) that show up as constant,
// real on-chain buy pressure. It reuses the same Jupiter client (jupiter.js) and
// treasury policy (config.js) as the daily buyback (buyback.js); it is the
// high-frequency, small-ticket sibling of that low-frequency, large-ticket lane.
//
// BUY-ONLY. This engine never sells $THREE. It quotes USDC→$THREE, buys, and lets
// the tokens accrue in the micro-buy wallet; the treasury sweep (buyback.sweep-
// StrandedThree) is the only thing that moves them, and it moves them TO the
// treasury, never back to USDC. There is no sell path.
//
// CUSTODY. Buys are funded by the micro-buy wallet's own USDC balance
// (THREE_MICROBUY_SECRET_KEY_B64, or the shared buyback wallet
// THREE_BUYBACK_SECRET_KEY_B64 when the dedicated key is unset). The x402 toll the
// caller pays for each buy routes to the ring treasury (X402_PAY_TO_SOLANA) exactly
// like every other ring endpoint — it is NOT the buy funding, so the two money
// streams stay independent and auditable.
//
// SAFETY. Every buy is bounded by a per-buy size cap AND a UTC-daily USD ceiling
// enforced atomically (Redis reserve-before-execute, DB-sum fallback) so a flood
// of calls — from the loop or a direct payer — can never drain the wallet or burn
// unbounded SOL beyond the day's cap. Execution is gated by THREE_MICROBUY_ENABLED;
// until an operator funds the wallet and opts in, the engine is a recorded no-op.

import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { getConnection, solanaPubkey } from '../pump.js';
import { confirmOrThrow } from '../solana/confirm.js';
import { submitProtected } from '../execution-engine.js';
import { getRedis } from '../redis.js';
import { sql } from '../db.js';
import { SOLANA_USDC_MINT } from '../../payments/_config.js';
import { TOKEN_MINT, TOKEN_DECIMALS, treasuryWallet, treasuryWalletOrNull } from './config.js';
import { jupiterQuote, jupiterSwapTx } from './jupiter.js';
import {
	envUsd,
	envSlippageBps,
	usdToUsdcAtomics,
	usdcAtomicsToUsd,
	atomicsToTokens,
} from './buyback-math.js';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// ── policy knobs (env, with safe defaults) ──────────────────────────────────

/** Execution gate. A run is a recorded no-op unless this is truthy. */
export function isEnabled() {
	return ['1', 'true', 'yes', 'on'].includes(
		String(process.env.THREE_MICROBUY_ENABLED || '').toLowerCase(),
	);
}

/** USD spent per single micro-buy (default $0.01). Bounded to a sane band. */
export function buyUsd() {
	const v = envUsd(process.env.THREE_MICROBUY_USD, 0.01);
	// Never let a fat-fingered env turn a "micro" buy into a wallet-drainer.
	return Math.min(v, 5);
}

/** Per-buy size in USDC atomics (6dp). */
export function buyUsdcAtomics() {
	return usdToUsdcAtomics(buyUsd());
}

/** UTC-daily ceiling on total micro-buy USD (default $50). */
export function dailyCapUsd() {
	return envUsd(process.env.THREE_MICROBUY_DAILY_CAP_USD, 50);
}

/** Jupiter slippage tolerance in bps (default 3%). */
export function slippageBps() {
	return envSlippageBps(process.env.THREE_MICROBUY_SLIPPAGE_BPS, 300);
}

/** Seconds to wait for buy confirmation before returning `pending` (default 12). */
function confirmTimeoutMs() {
	const n = Number(process.env.THREE_MICROBUY_CONFIRM_TIMEOUT_MS);
	return Number.isFinite(n) && n >= 1_000 && n <= 60_000 ? n : 12_000;
}

/**
 * Load the micro-buy signer. Prefers a DEDICATED key so micro-buys and the daily
 * buyback don't fight over one wallet's USDC; falls back to the buyback wallet so
 * a single funded wallet powers both lanes out of the box. Null when neither is set.
 */
export async function loadMicrobuySigner() {
	const b64 =
		process.env.THREE_MICROBUY_SECRET_KEY_B64 || process.env.THREE_BUYBACK_SECRET_KEY_B64;
	if (!b64) return null;
	const { Keypair } = await import('@solana/web3.js');
	const raw = Buffer.from(b64, 'base64');
	if (raw.byteLength !== 64) {
		throw Object.assign(
			new Error(`micro-buy signer: expected 64-byte secret key, got ${raw.byteLength}`),
			{ code: 'bad_signer' },
		);
	}
	return Keypair.fromSecretKey(raw);
}

// ── daily spend ceiling (atomic reserve-before-execute) ─────────────────────

const utcDay = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const dailyKey = () => `three:microbuy:daily:${utcDay()}`;

/**
 * DB fallback for today's micro-buy spend when Redis is unavailable — sums the
 * confirmed/pending rows so the cap still holds (best-effort; the Redis counter is
 * the fast path). Returns atomics.
 */
async function dbDailySpentAtomics() {
	try {
		const rows = await sql`
			SELECT COALESCE(SUM(usdc_spent_atomics), 0)::bigint AS spent
			FROM three_microbuy_runs
			WHERE status IN ('confirmed', 'pending') AND created_at >= date_trunc('day', now())
		`;
		return BigInt(rows[0]?.spent || 0);
	} catch {
		return 0n;
	}
}

/**
 * Atomically reserve `atomics` of today's budget. Returns { ok, dailySpentAtomics,
 * dailyCapAtomics }. When the reservation would cross the daily cap it is rolled
 * back and ok:false is returned, so the caller never buys past the ceiling. Redis
 * is the fast atomic path; if it is down we fall back to a (racy) DB sum so the cap
 * degrades to best-effort rather than failing open.
 */
export async function reserveDailySpend(atomics) {
	const capAtomics = usdToUsdcAtomics(dailyCapUsd());
	const need = BigInt(atomics);
	const redis = getRedis();
	if (redis) {
		try {
			const key = dailyKey();
			const total = BigInt(await redis.incrby(key, Number(need)));
			// First writer sets a 2-day TTL so the key self-expires after the UTC day.
			if (total === need) {
				try { await redis.expire(key, 86_400 * 2); } catch { /* non-fatal */ }
			}
			if (total > capAtomics) {
				try { await redis.incrby(key, -Number(need)); } catch { /* best-effort rollback */ }
				return { ok: false, dailySpentAtomics: total - need, dailyCapAtomics: capAtomics };
			}
			return { ok: true, dailySpentAtomics: total, dailyCapAtomics: capAtomics };
		} catch {
			/* fall through to DB */
		}
	}
	const spent = await dbDailySpentAtomics();
	if (spent + need > capAtomics) {
		return { ok: false, dailySpentAtomics: spent, dailyCapAtomics: capAtomics };
	}
	return { ok: true, dailySpentAtomics: spent + need, dailyCapAtomics: capAtomics };
}

/** Release a previously-reserved amount (a buy that never broadcast). Redis only. */
export async function releaseDailySpend(atomics) {
	const redis = getRedis();
	if (!redis) return;
	try { await redis.incrby(dailyKey(), -Number(BigInt(atomics))); } catch { /* non-fatal */ }
}

/**
 * Cheap best-effort check: is there room under today's cap for at least one more
 * buy? Used to refuse a call BEFORE quoting Jupiter when the day's budget is spent.
 * The atomic reserve in executeMicrobuy remains the real guard; this only avoids
 * needless work on the exhausted path. Fails OPEN (returns true) on a read error so
 * a transient Redis/DB blip never wrongly halts buys — the reserve still enforces.
 */
export async function hasDailyBudget() {
	try {
		const spent = await dailySpentAtomics();
		return spent + buyUsdcAtomics() <= usdToUsdcAtomics(dailyCapUsd());
	} catch {
		return true;
	}
}

/** Today's micro-buy spend so far (atomics) for status/read paths. */
export async function dailySpentAtomics() {
	const redis = getRedis();
	if (redis) {
		try {
			const v = await redis.get(dailyKey());
			if (v != null) return BigInt(v);
		} catch { /* fall through */ }
	}
	return dbDailySpentAtomics();
}

// ── helpers ─────────────────────────────────────────────────────────────────

const usd = (a) => usdcAtomicsToUsd(a);
const threeTokens = (a) => atomicsToTokens(a, TOKEN_DECIMALS);

/** SPL balance of `owner` for `mint`, in atomics. Missing ATA → 0n (never throws). */
async function splBalanceAtomics(connection, ownerPk, mintPk) {
	const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, true);
	try {
		const bal = await connection.getTokenAccountBalance(ata);
		return BigInt(bal.value.amount);
	} catch {
		return 0n;
	}
}

/** Bounded confirmation: resolve 'confirmed' or throw/timeout without hanging the request. */
async function confirmBounded(connection, sig) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(Object.assign(new Error('confirm_timeout'), { code: 'tx_unconfirmed' })),
			confirmTimeoutMs(),
		);
	});
	try {
		await Promise.race([confirmOrThrow(connection, sig, 'confirmed'), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// ── plan + execute ──────────────────────────────────────────────────────────

/**
 * Size + quote a single micro-buy against the wallet's live USDC balance. Pure of
 * signing/sending. Returns { ok, reason?, spendUsdcAtomics, walletUsdcAtomics,
 * quote?, expectedThreeAtomics?, priceUsd? }.
 */
export async function planMicrobuy(signerPubkey) {
	if (!treasuryWalletOrNull()) {
		return { ok: false, reason: 'treasury_unavailable', walletUsdcAtomics: 0n, spendUsdcAtomics: 0n };
	}
	const spend = buyUsdcAtomics();
	const connection = getConnection({ network: 'mainnet' });
	const walletUsdc = await splBalanceAtomics(
		connection,
		solanaPubkey(signerPubkey),
		solanaPubkey(SOLANA_USDC_MINT),
	);
	if (walletUsdc < spend) {
		return { ok: false, reason: 'insufficient_usdc', walletUsdcAtomics: walletUsdc, spendUsdcAtomics: spend };
	}
	const quote = await jupiterQuote({
		inputMint: SOLANA_USDC_MINT,
		outputMint: TOKEN_MINT,
		amount: spend,
		slippageBps: slippageBps(),
	});
	const expectedThree = BigInt(quote.outAmount ?? 0);
	if (expectedThree <= 0n) {
		return { ok: false, reason: 'no_quote', walletUsdcAtomics: walletUsdc, spendUsdcAtomics: spend };
	}
	return {
		ok: true,
		walletUsdcAtomics: walletUsdc,
		spendUsdcAtomics: spend,
		quote,
		expectedThreeAtomics: expectedThree,
		priceUsd: usd(spend) / threeTokens(expectedThree),
	};
}

/**
 * Execute one micro-buy: reserve the daily budget, sign + broadcast the Jupiter
 * buy, and confirm within a bounded window. The bought $THREE accrues in the
 * micro-buy wallet (swept to the treasury on a cadence by the loop). Returns a
 * receipt; on a hard failure throws with a `.code` so the caller records the reason
 * and (on a never-broadcast failure) releases the reservation.
 *
 * @returns {Promise<{ status:'confirmed'|'pending', buySignature:string, spendUsdcAtomics:bigint, boughtAtomics:bigint, priceUsd:number|null }>}
 */
export async function executeMicrobuy(signer, plan) {
	const { VersionedTransaction } = await import('@solana/web3.js');
	const connection = getConnection({ network: 'mainnet' });
	const payer = signer.publicKey;

	// Reserve budget BEFORE broadcasting so concurrent buys can't collectively
	// overshoot the daily cap. Released by the caller only if we never broadcast.
	const reservation = await reserveDailySpend(plan.spendUsdcAtomics);
	if (!reservation.ok) {
		throw Object.assign(new Error('daily micro-buy cap reached'), {
			code: 'daily_cap_reached',
			dailySpentAtomics: reservation.dailySpentAtomics,
			dailyCapAtomics: reservation.dailyCapAtomics,
		});
	}

	let swapB64;
	try {
		swapB64 = await jupiterSwapTx({ quote: plan.quote, userPublicKey: payer.toBase58() });
	} catch (err) {
		await releaseDailySpend(plan.spendUsdcAtomics);
		throw err;
	}

	const buyTx = VersionedTransaction.deserialize(Buffer.from(swapB64, 'base64'));
	buyTx.sign([signer]);

	let buySig;
	try {
		buySig = await connection.sendRawTransaction(buyTx.serialize(), { maxRetries: 5 });
	} catch (err) {
		// Never broadcast → the budget was not spent; give it back.
		await releaseDailySpend(plan.spendUsdcAtomics);
		throw Object.assign(new Error(`micro-buy broadcast failed: ${err?.message || err}`), {
			code: 'swap_failed',
		});
	}

	// Broadcast succeeded — the USDC is committed, so the reservation STANDS even if
	// confirmation times out (the buy is in flight, not free).
	try {
		await confirmBounded(connection, buySig);
	} catch (waitErr) {
		if (waitErr?.code === 'tx_reverted') {
			// A revert means the transfer did not happen — reclaim the reservation.
			await releaseDailySpend(plan.spendUsdcAtomics);
			throw waitErr;
		}
		return {
			status: 'pending',
			buySignature: buySig,
			spendUsdcAtomics: plan.spendUsdcAtomics,
			boughtAtomics: 0n,
			priceUsd: plan.priceUsd ?? null,
		};
	}

	const boughtAtomics = await splBalanceAtomics(connection, payer, solanaPubkey(TOKEN_MINT));
	return {
		status: 'confirmed',
		buySignature: buySig,
		spendUsdcAtomics: plan.spendUsdcAtomics,
		boughtAtomics,
		priceUsd: plan.priceUsd ?? null,
	};
}

/**
 * Sweep all $THREE held by the micro-buy wallet into the treasury. Buy-only lane:
 * this is the ONLY thing that moves the accrued tokens, and it only moves them to
 * the treasury. Returns the sweep signature, or null when there is nothing to sweep
 * or the wallet already IS the treasury. Reuses submitProtected (priority fee + CU
 * estimate, blockhash-refresh rebroadcast, hard throw on revert).
 */
export async function sweepMicrobuyThree(signer) {
	const treasury = treasuryWalletOrNull();
	if (!treasury || treasury === signer.publicKey.toBase58()) return null;
	const { TransactionInstruction, PublicKey } = await import('@solana/web3.js');
	const connection = getConnection({ network: 'mainnet' });
	const payer = signer.publicKey;
	const mintPk = new PublicKey(TOKEN_MINT);
	const held = await splBalanceAtomics(connection, payer, mintPk);
	if (held <= 0n) return null;

	const treasuryPk = new PublicKey(treasury);
	const fromAta = getAssociatedTokenAddressSync(mintPk, payer, true);
	const toAta = getAssociatedTokenAddressSync(mintPk, treasuryPk, true);
	const ixs = [
		createAssociatedTokenAccountIdempotentInstruction(payer, toAta, treasuryPk, mintPk),
		createTransferInstruction(fromAta, toAta, payer, held),
		new TransactionInstruction({
			keys: [],
			programId: new PublicKey(MEMO_PROGRAM_ID),
			data: Buffer.from('three.ws micro-buy → treasury', 'utf8'),
		}),
	];
	const { signature } = await submitProtected({
		network: 'mainnet',
		connection,
		payer: signer,
		instructions: ixs,
	});
	return signature;
}

export { usd as usdcAtomicsToUsd, threeTokens as threeAtomicsToTokens };
