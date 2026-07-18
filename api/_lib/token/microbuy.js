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
	wouldExceedCap,
} from './buyback-math.js';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// One-time DDL guard per warm instance. The migration owns this table in a real
// deploy; this makes the lane self-healing so the daily-cap DB fallback and the
// ledger never silently no-op on a fresh/behind database (which, combined with a
// Redis outage, would otherwise let the cap fail open).
let _schemaReady = false;
export async function ensureMicrobuySchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS three_microbuy_runs (
			id                   uuid primary key default gen_random_uuid(),
			status               text not null,
			reason               text,
			usdc_spent_atomics   bigint not null default 0,
			three_bought_atomics bigint not null default 0,
			price_usd            numeric,
			slippage_bps         integer,
			buy_signature        text,
			created_at           timestamptz not null default now()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS three_microbuy_runs_created ON three_microbuy_runs (created_at desc)`;
	_schemaReady = true;
}

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
 * Wait for on-chain confirmation of each buy before returning? OFF by default: the
 * micro-buy lane is built for throughput (target ~60 buys/min). Waiting for
 * confirmation would pin each call to the ~2–12s block time and make 60/min
 * impossible inside the 60s tick budget. Broadcast-and-go is correct here because
 * the daily cap is reserved BEFORE broadcast (so spend is bounded regardless) and
 * the treasury sweep reads real on-chain balances (so accounting self-corrects).
 * Set THREE_MICROBUY_AWAIT_CONFIRM=true to trade throughput for per-call confirmation.
 */
function awaitConfirm() {
	return ['1', 'true', 'yes', 'on'].includes(
		String(process.env.THREE_MICROBUY_AWAIT_CONFIRM || '').toLowerCase(),
	);
}

// Micro-buy ledger statuses that count as real spend (deducted from the daily cap):
// a submitted-but-unconfirmed buy has already committed its USDC on-chain, so it
// must count exactly like a confirmed one — otherwise the DB cap fallback would
// under-count and let the day overspend.
export const SPENT_STATUSES = ['confirmed', 'pending', 'submitted'];

// ── per-buy amount jitter (transaction-distinctness) ─────────────────────────
// At ~60 buys/min, many buys of the SAME size fire within one blockhash window. If
// two used an identical quote+amount, Jupiter can build byte-identical transactions
// → the same signature → the second is rejected as already-processed and that buy
// is silently lost. A tiny per-buy jitter on the input amount (0–255 atomics, up to
// $0.000255 on a $0.01 buy) makes every buy a genuinely distinct market order:
// distinct amount → distinct quote → distinct transaction → distinct signature. The
// counter cycles every 256 buys (~4 min at 60/min), far longer than any blockhash
// window, so the same jittered amount never collides in practice. Jupiter's keyless
// tier absorbs the per-buy quote load (measured: 20 concurrent quotes, 0 throttling).
let _jitterSeq = 0;
function nextBuyAmountAtomics() {
	const jitter = BigInt(_jitterSeq++ & 0xff);
	return buyUsdcAtomics() + jitter;
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
 * DB sum of today's micro-buy spend (confirmed + pending rows). STRICT: throws on a
 * query fault so the caller can decide whether to fail closed. The read-path
 * wrappers (dailySpentAtomics, hasDailyBudget) swallow the throw; the reserve path
 * treats it as "cap unverifiable" and refuses the buy.
 */
async function dbDailySpentAtomicsStrict() {
	const rows = await sql`
		SELECT COALESCE(SUM(usdc_spent_atomics), 0)::bigint AS spent
		FROM three_microbuy_runs
		WHERE status IN ('confirmed', 'pending', 'submitted') AND created_at >= date_trunc('day', now())
	`;
	return BigInt(rows[0]?.spent || 0);
}

/**
 * Atomically reserve `atomics` of today's budget. Returns { ok, reason?,
 * dailySpentAtomics, dailyCapAtomics }. When the reservation would cross the daily
 * cap it is rolled back and ok:false is returned, so the caller never buys past the
 * ceiling. Redis is the fast atomic path; if it is down we fall back to a (racy) DB
 * sum. Crucially this FAILS CLOSED: if neither Redis nor the DB can tell us today's
 * spend, the buy is refused (reason:'cap_unverifiable') rather than letting an
 * uncapped flood through — an unbounded real-money spend is the one outcome the cap
 * exists to prevent.
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
				return { ok: false, reason: 'daily_cap_reached', dailySpentAtomics: total - need, dailyCapAtomics: capAtomics };
			}
			return { ok: true, dailySpentAtomics: total, dailyCapAtomics: capAtomics };
		} catch {
			/* Redis faulted — fall through to the DB fallback below. */
		}
	}
	// Fallback: sum the ledger. STRICT — a query fault here means we cannot prove the
	// cap, so refuse (fail closed) instead of assuming zero spent.
	let spent;
	try {
		spent = await dbDailySpentAtomicsStrict();
	} catch {
		return { ok: false, reason: 'cap_unverifiable', dailySpentAtomics: 0n, dailyCapAtomics: capAtomics };
	}
	if (wouldExceedCap(spent, need, capAtomics)) {
		return { ok: false, reason: 'daily_cap_reached', dailySpentAtomics: spent, dailyCapAtomics: capAtomics };
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

/** Today's micro-buy spend so far (atomics) for status/read paths. Tolerant → 0n. */
export async function dailySpentAtomics() {
	const redis = getRedis();
	if (redis) {
		try {
			const v = await redis.get(dailyKey());
			if (v != null) return BigInt(v);
		} catch { /* fall through */ }
	}
	try { return await dbDailySpentAtomicsStrict(); } catch { return 0n; }
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
	// Jittered per-buy amount so concurrent buys never build identical transactions.
	const spend = nextBuyAmountAtomics();
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
 * Execute one micro-buy: reserve the daily budget, sign + broadcast the Jupiter buy.
 * Broadcast-and-go by default (THREE_MICROBUY_AWAIT_CONFIRM off) so the lane can
 * sustain ~60 buys/min without pinning each call to block time; confirmation is
 * optional. The bought $THREE accrues in the micro-buy wallet (swept to the
 * treasury on a cadence by the loop). Returns a receipt; on a hard failure throws
 * with a `.code` so the caller records the reason and (on a never-broadcast
 * failure) releases the reservation.
 *
 * `boughtAtomics` is the QUOTED out amount (plan.expectedThreeAtomics), not a
 * wallet-balance read — the wallet holds the accrued total of every prior buy, so
 * reading its balance would over-count each row. The sweep reconciles against real
 * on-chain balances, so the quoted figure is the honest per-buy estimate.
 *
 * @returns {Promise<{ status:'submitted'|'confirmed', buySignature:string, spendUsdcAtomics:bigint, boughtAtomics:bigint, priceUsd:number|null }>}
 */
export async function executeMicrobuy(signer, plan) {
	const { VersionedTransaction } = await import('@solana/web3.js');
	const connection = getConnection({ network: 'mainnet' });
	const payer = signer.publicKey;

	// Reserve budget BEFORE broadcasting so concurrent buys can't collectively
	// overshoot the daily cap. Released only if we never broadcast.
	const reservation = await reserveDailySpend(plan.spendUsdcAtomics);
	if (!reservation.ok) {
		const code = reservation.reason || 'daily_cap_reached';
		throw Object.assign(
			new Error(code === 'cap_unverifiable'
				? 'micro-buy cap unverifiable (Redis and DB both unavailable) — refusing to buy'
				: 'daily micro-buy cap reached'),
			{ code, dailySpentAtomics: reservation.dailySpentAtomics, dailyCapAtomics: reservation.dailyCapAtomics },
		);
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

	const boughtAtomics = plan.expectedThreeAtomics ?? 0n;

	// Throughput path (default): the tx is broadcast and the USDC is committed —
	// return immediately as 'submitted' without waiting for a block. The sweep and
	// on-chain state are the source of truth for what actually landed.
	if (!awaitConfirm()) {
		return {
			status: 'submitted',
			buySignature: buySig,
			spendUsdcAtomics: plan.spendUsdcAtomics,
			boughtAtomics,
			priceUsd: plan.priceUsd ?? null,
		};
	}

	// Opt-in confirmation path: wait within a bounded window. The reservation STANDS
	// on a timeout (the buy is in flight, not free); only a revert reclaims it.
	try {
		await confirmBounded(connection, buySig);
	} catch (waitErr) {
		if (waitErr?.code === 'tx_reverted') {
			await releaseDailySpend(plan.spendUsdcAtomics);
			throw waitErr;
		}
		return {
			status: 'submitted',
			buySignature: buySig,
			spendUsdcAtomics: plan.spendUsdcAtomics,
			boughtAtomics,
			priceUsd: plan.priceUsd ?? null,
		};
	}
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

// ── public stats ─────────────────────────────────────────────────────────────

/**
 * Public micro-buy summary: lifetime + today's buy count, $THREE bought, USDC
 * deployed, and how much of today's budget is spent. Resilient — degrades to a sane
 * default whether the query rejects (table missing) or sql throws synchronously
 * (env unconfigured), so a status surface never 500s on it.
 */
export async function microbuyStats() {
	let agg = { runs: 0, confirmed: 0, pending: 0, usdc: 0, three: 0 };
	let today = { runs: 0, usdc: 0 };
	try {
		const [lifetime] = await sql`
			SELECT
				count(*) FILTER (WHERE status IN ('confirmed', 'pending', 'submitted'))::int AS runs,
				count(*) FILTER (WHERE status = 'confirmed')::int                            AS confirmed,
				count(*) FILTER (WHERE status IN ('pending', 'submitted'))::int              AS pending,
				COALESCE(SUM(usdc_spent_atomics) FILTER (WHERE status IN ('confirmed', 'pending', 'submitted')), 0)::bigint AS usdc,
				COALESCE(SUM(three_bought_atomics) FILTER (WHERE status IN ('confirmed', 'pending', 'submitted')), 0)::bigint AS three
			FROM three_microbuy_runs
		`;
		if (lifetime) {
			agg = {
				runs: lifetime.runs, confirmed: lifetime.confirmed, pending: lifetime.pending,
				usdc: Number(lifetime.usdc), three: Number(lifetime.three),
			};
		}
		const [day] = await sql`
			SELECT count(*)::int AS runs,
				COALESCE(SUM(usdc_spent_atomics), 0)::bigint AS usdc
			FROM three_microbuy_runs
			WHERE status IN ('confirmed', 'pending', 'submitted') AND created_at >= date_trunc('day', now())
		`;
		if (day) today = { runs: day.runs, usdc: Number(day.usdc) };
	} catch { /* degrade to defaults */ }

	const capUsd = dailyCapUsd();
	const spentTodayUsd = today.usdc / 1e6;
	return {
		enabled: isEnabled(),
		buy_usd: buyUsd(),
		lifetime: {
			buys: agg.runs,
			confirmed: agg.confirmed,
			pending: agg.pending,
			usdc_deployed: usd(agg.usdc),
			three_bought: threeTokens(agg.three),
		},
		today: {
			buys: today.runs,
			usdc_deployed: spentTodayUsd,
			cap_usd: capUsd,
			cap_used_pct: capUsd > 0 ? Math.min(100, (spentTodayUsd / capUsd) * 100) : 0,
		},
	};
}

export { usd as usdcAtomicsToUsd, threeTokens as threeAtomicsToTokens };
