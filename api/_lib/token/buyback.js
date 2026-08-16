// Programmatic $THREE buyback engine.
//
// Converts accumulated platform USDC revenue into onchain buy pressure: market-buy
// $THREE on Jupiter and route the bought tokens into the treasury. This is the
// documented economy policy — "the treasury funds buybacks … buy pressure without
// deflation" (./config.js) — made programmatic, onchain, and publicly auditable.
// NO platform burn: supply is never destroyed by this lane.
//
// Custody vs. accounting are deliberately decoupled:
//   • SPEND is driven by the buyback wallet's live USDC balance (capped per run).
//     The wallet is funded by routing platform revenue into it.
//   • The public "revenue earned" figure reads the agent_revenue_events fee ledger.
// This keeps execution robust (we only ever spend USDC we actually hold) while the
// public ratio stays honest (earned vs. deployed).
//
// The buyback wallet pays SOL tx fees, so it is registered in solana-signers.js
// for the balance-check cron. EXECUTION is gated by THREE_BUYBACK_ENABLED — a
// scheduled run is a recorded no-op until an operator funds the wallet and opts in.

import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { sql } from '../db.js';
import { getConnection, solanaPubkey } from '../pump.js';
import { confirmOrThrow } from '../solana/confirm.js';
import { submitProtected } from '../execution-engine.js';
import { SOLANA_USDC_MINT } from '../../payments/_config.js';
import { TOKEN_MINT, TOKEN_DECIMALS } from './config.js';
import { treasuryWallet, treasuryWalletOrNull } from './config.js';
import { tokenProgramIdForMint } from './token-program.js';
import { jupiterQuote as jupQuote, jupiterSwapTx as jupSwapTx } from './jupiter.js';
import {
	computeSpend,
	deployedPct,
	committedUsd,
	commitmentProgressPct,
	envBps,
	envSlippageBps,
	envUsd,
	usdcAtomicsToUsd as usdcToUsd,
	atomicsToTokens,
} from './buyback-math.js';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// ── policy knobs (env, with safe defaults) ──────────────────────────────────

/** Execution gate. A scheduled run is a recorded no-op unless this is truthy. */
export function isEnabled() {
	return ['1', 'true', 'yes', 'on'].includes(String(process.env.THREE_BUYBACK_ENABLED || '').toLowerCase());
}

/** Max USD a single run may deploy — bounds a runaway/over-funded sweep. */
export function maxUsdPerRun() {
	return envUsd(process.env.THREE_BUYBACK_MAX_USD, 250);
}

/**
 * The PUBLISHED commitment: share of platform revenue the protocol commits to
 * convert into $THREE buybacks, in basis points (default 5000 = 50%). This is the
 * holder-facing promise rendered on the token page; it is policy, independent of
 * whether a given run is enabled or funded. Operators tune the published number via
 * THREE_BUYBACK_COMMIT_BPS without a code change. The data on comparable
 * fee-generating protocols puts the credible band at 50–80%; we default to the
 * conservative floor so the platform over-delivers rather than over-promises.
 */
export function commitBps() {
	return envBps(process.env.THREE_BUYBACK_COMMIT_BPS, 5000);
}

/** Below this, a run is skipped so dust doesn't pay more in fees than it buys. */
export function minUsdPerRun() {
	return envUsd(process.env.THREE_BUYBACK_MIN_USD, 10);
}

/** Jupiter slippage tolerance in basis points (default 3%). */
export function slippageBps() {
	return envSlippageBps(process.env.THREE_BUYBACK_SLIPPAGE_BPS, 300);
}

/** Load the buyback signer (base64 of 64 secret-key bytes). Null when unset. */
export async function loadBuybackSigner() {
	const b64 = process.env.THREE_BUYBACK_SECRET_KEY_B64;
	if (!b64) return null;
	const { Keypair } = await import('@solana/web3.js');
	const raw = Buffer.from(b64, 'base64');
	if (raw.byteLength !== 64) {
		throw Object.assign(
			new Error(`THREE_BUYBACK_SECRET_KEY_B64: expected 64-byte secret key, got ${raw.byteLength}`),
			{ code: 'bad_signer' },
		);
	}
	return Keypair.fromSecretKey(raw);
}

// ── helpers ─────────────────────────────────────────────────────────────────

const usd = (atomics) => usdcToUsd(atomics);
const threeTokens = (atomics) => atomicsToTokens(atomics, TOKEN_DECIMALS);

/** SPL balance of `owner` for `mint`, in atomics. Missing ATA → 0n (never throws). */
async function splBalanceAtomics(connection, ownerPk, mintPk) {
	try {
		// $THREE is Token-2022, so the spl-token default program would derive an ATA
		// that does not exist and report a zero balance for a wallet holding tokens.
		const programId = await tokenProgramIdForMint(connection, mintPk);
		const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, true, programId);
		const bal = await connection.getTokenAccountBalance(ata);
		return BigInt(bal.value.amount);
	} catch {
		return 0n; // ATA not yet created → zero balance
	}
}

/** ExactIn quote: how much $THREE `usdcAtomics` of USDC buys. */
async function jupiterQuote(usdcAtomics) {
	return jupQuote({
		inputMint: SOLANA_USDC_MINT,
		outputMint: TOKEN_MINT,
		amount: usdcAtomics,
		slippageBps: slippageBps(),
	});
}

/** Build the (unsigned) swap transaction (base64) for `quote`. */
async function jupiterSwapTx(quote, userPublicKey) {
	return jupSwapTx({ quote, userPublicKey, wrapAndUnwrapSol: false });
}

// ── plan ──────────────────────────────────────────────────────────────────-

/**
 * Decide how much to deploy this run and quote it. Pure of any signing/sending.
 * @param {string} signerPubkey base58 of the buyback wallet
 * @returns {Promise<object>} { ok, reason?, spendUsdcAtomics, walletUsdcAtomics, quote?, expectedThreeAtomics?, priceUsd? }
 */
export async function planBuyback(signerPubkey) {
	// Fail BEFORE spending if the treasury sink is unconfigured — otherwise a buy
	// could succeed with nowhere policy-correct to route the bought $THREE.
	if (!treasuryWalletOrNull()) {
		return { ok: false, reason: 'treasury_unavailable', walletUsdcAtomics: 0n, spendUsdcAtomics: 0n };
	}

	const connection = getConnection({ network: 'mainnet' });
	const walletUsdc = await splBalanceAtomics(connection, solanaPubkey(signerPubkey), solanaPubkey(SOLANA_USDC_MINT));

	const { spendAtomics: spend, reason } = computeSpend(walletUsdc, {
		maxUsd: maxUsdPerRun(),
		minUsd: minUsdPerRun(),
	});

	if (reason !== 'ok') {
		return { ok: false, reason, walletUsdcAtomics: walletUsdc, spendUsdcAtomics: 0n };
	}

	const quote = await jupiterQuote(spend);
	const expectedThree = BigInt(quote.outAmount ?? 0);
	if (expectedThree <= 0n) {
		return { ok: false, reason: 'no_quote', walletUsdcAtomics: walletUsdc, spendUsdcAtomics: spend };
	}
	const priceUsd = usd(spend) / threeTokens(expectedThree);

	return {
		ok: true,
		walletUsdcAtomics: walletUsdc,
		spendUsdcAtomics: spend,
		quote,
		expectedThreeAtomics: expectedThree,
		priceUsd,
	};
}

// ── execute ─────────────────────────────────────────────────────────────────

/**
 * Sign + send the Jupiter buy, then sweep the bought $THREE into the treasury
 * when the buyback wallet is not itself the treasury. Returns a receipt; throws
 * with a `.code` on hard failure so the caller records the precise reason.
 */
export async function executeBuyback(signer, plan) {
	const { VersionedTransaction, TransactionInstruction, PublicKey } = await import('@solana/web3.js');
	const connection = getConnection({ network: 'mainnet' });
	const payer = signer.publicKey;

	// 1) Buy: deserialize Jupiter's tx, sign as the buyer, broadcast, confirm.
	// NOT routed through submitProtected: Jupiter returns a fully-built tx tied to
	// its own quote, blockhash, and CU/priority-fee layout — rebuilding it from
	// instructions (what submitProtected does) would invalidate the quote. We sign
	// and broadcast the SDK's bytes as-is and confirm via confirmOrThrow (a revert
	// throws). The sweep that follows IS a plain transfer, so it uses submitProtected.
	const swapB64 = await jupiterSwapTx(plan.quote, payer.toBase58());
	const buyTx = VersionedTransaction.deserialize(Buffer.from(swapB64, 'base64'));
	buyTx.sign([signer]);
	const buySig = await connection.sendRawTransaction(buyTx.serialize(), { maxRetries: 5 });
	try {
		await confirmOrThrow(connection, buySig, 'confirmed');
	} catch (waitErr) {
		if (waitErr?.code === 'tx_reverted') throw waitErr;
		throw Object.assign(
			new Error(`buyback ${buySig} submitted but confirmation timed out (${waitErr?.message || waitErr})`),
			{ code: 'tx_unconfirmed', status: 'pending', buySignature: buySig },
		);
	}

	const mintPk = new PublicKey(TOKEN_MINT);
	const boughtAtomics = await splBalanceAtomics(connection, payer, mintPk);

	// 2) Sweep to treasury — unless the buyback wallet IS the treasury (then the
	// $THREE already lives there). treasuryWallet() fails closed in production.
	const treasury = treasuryWallet();
	let sweepSig = null;
	if (treasury !== payer.toBase58() && boughtAtomics > 0n) {
		const treasuryPk = new PublicKey(treasury);
		const programId = await tokenProgramIdForMint(connection, mintPk);
		const fromAta = getAssociatedTokenAddressSync(mintPk, payer, true, programId);
		const toAta = getAssociatedTokenAddressSync(mintPk, treasuryPk, true, programId);
		const tag = `three.ws buyback → treasury $${usd(plan.spendUsdcAtomics).toFixed(2)}`.slice(0, 180);
		const sweepIxs = [
			createAssociatedTokenAccountIdempotentInstruction(payer, toAta, treasuryPk, mintPk, programId),
			createTransferInstruction(fromAta, toAta, payer, boughtAtomics, [], programId),
			new TransactionInstruction({ keys: [], programId: new PublicKey(MEMO_PROGRAM_ID), data: Buffer.from(tag, 'utf8') }),
		];
		try {
			// Protected send: priority fee + CU estimate, rebroadcast with blockhash
			// refresh, hard throw on revert.
			({ signature: sweepSig } = await submitProtected({ network: 'mainnet', connection, payer: signer, instructions: sweepIxs }));
		} catch (waitErr) {
			// The buy already landed; surface a sweep-specific failure so the next
			// run self-heals (it sweeps any pre-existing $THREE before buying more).
			throw Object.assign(
				new Error(`buyback bought $THREE (${buySig}) but treasury sweep did not confirm (${waitErr?.message || waitErr})`),
				{ code: 'sweep_failed', status: 'pending', buySignature: buySig, sweepSignature: sweepSig, boughtAtomics },
			);
		}
	}

	return {
		buySignature: buySig,
		sweepSignature: sweepSig,
		boughtAtomics,
		treasury,
		priceUsd: plan.priceUsd,
	};
}

/**
 * Self-heal: if a prior run bought $THREE but the treasury sweep didn't land, the
 * tokens sit in the buyback wallet. Sweep them before buying more. Returns the
 * sweep signature, or null when there's nothing to sweep / wallet is the treasury.
 */
export async function sweepStrandedThree(signer) {
	const treasury = treasuryWalletOrNull();
	if (!treasury || treasury === signer.publicKey.toBase58()) return null;
	const { TransactionInstruction, PublicKey } = await import('@solana/web3.js');
	const connection = getConnection({ network: 'mainnet' });
	const payer = signer.publicKey;
	const mintPk = new PublicKey(TOKEN_MINT);
	const stranded = await splBalanceAtomics(connection, payer, mintPk);
	if (stranded <= 0n) return null;

	const treasuryPk = new PublicKey(treasury);
	const programId = await tokenProgramIdForMint(connection, mintPk);
	const fromAta = getAssociatedTokenAddressSync(mintPk, payer, true, programId);
	const toAta = getAssociatedTokenAddressSync(mintPk, treasuryPk, true, programId);
	const strandedIxs = [
		createAssociatedTokenAccountIdempotentInstruction(payer, toAta, treasuryPk, mintPk, programId),
		createTransferInstruction(fromAta, toAta, payer, stranded, [], programId),
		new TransactionInstruction({ keys: [], programId: new PublicKey(MEMO_PROGRAM_ID), data: Buffer.from('three.ws buyback → treasury (recover)', 'utf8') }),
	];
	// Protected send: priority fee + CU estimate, rebroadcast with blockhash
	// refresh, hard throw on revert.
	const { signature: sig } = await submitProtected({ network: 'mainnet', connection, payer: signer, instructions: strandedIxs });
	return sig;
}

// ── accounting / public stats ────────────────────────────────────────────────

// Resilient query: a public read path must degrade to a sane default whether the
// query rejects (table missing) OR sql throws synchronously (env unconfigured).
async function safeQuery(run, fallback) {
	try {
		return await run();
	} catch {
		return fallback;
	}
}

/** Lifetime platform USDC fee revenue (atomics, 6dp) — the "earned" figure. */
export async function revenueFeeAtomicsToDate() {
	const rows = await safeQuery(
		() => sql`
			select coalesce(sum(fee_amount), 0)::bigint as total
			from agent_revenue_events
			where currency_mint = ${SOLANA_USDC_MINT} and chain = 'solana'
		`,
		[{ total: 0 }],
	);
	return BigInt(rows[0]?.total ?? 0);
}

/**
 * Public buyback summary for the $THREE token page: revenue earned vs. USDC
 * deployed into $THREE buybacks, $THREE accumulated, and the latest run.
 */
export async function buybackStats() {
	const [agg, recentRows, revenueAtomics] = await Promise.all([
		safeQuery(
			() => sql`
				select
					coalesce(sum(usdc_spent_atomics), 0)::bigint   as usdc_spent,
					coalesce(sum(three_bought_atomics), 0)::bigint as three_bought,
					count(*)::int                                   as runs
				from three_buyback_runs
				where status = 'confirmed'
			`,
			[{ usdc_spent: 0, three_bought: 0, runs: 0 }],
		),
		// The verifiable receipt list: every recent confirmed buy with its on-chain
		// signature, so the token page can render "each buyback, clickable to Solscan"
		// — proof, not a claim. Capped so the public payload stays small.
		safeQuery(
			() => sql`
				select usdc_spent_atomics, three_bought_atomics, price_usd, buy_signature, created_at
				from three_buyback_runs
				where status = 'confirmed'
				order by created_at desc
				limit 10
			`,
			[],
		),
		revenueFeeAtomicsToDate(),
	]);

	const usdcSpent = BigInt(agg[0]?.usdc_spent ?? 0);
	const threeBought = BigInt(agg[0]?.three_bought ?? 0);
	const revenueUsd = usd(revenueAtomics);
	const deployedUsd = usd(usdcSpent);

	const recent = recentRows.map((r) => ({
		at: r.created_at,
		usdc: usd(r.usdc_spent_atomics),
		three: threeTokens(r.three_bought_atomics),
		price_usd: r.price_usd != null ? Number(r.price_usd) : null,
		signature: r.buy_signature,
	}));

	// The published commitment (policy) and how much of it has been honored on-chain.
	const bps = commitBps();
	const committed = committedUsd(revenueUsd, bps);

	return {
		enabled: isEnabled(),
		// Published promise: share of revenue committed to buybacks (policy, always shown).
		commit_bps: bps,
		commit_pct: bps / 100,
		committed_usd: committed,
		// Share of the *commitment* already converted to buy pressure (keeping the promise).
		commitment_progress_pct: commitmentProgressPct(deployedUsd, committed),
		revenue_usd: revenueUsd,
		deployed_usd: deployedUsd,
		// Share of total platform revenue already converted to onchain buy pressure.
		deployed_pct: deployedPct(deployedUsd, revenueUsd),
		three_bought: threeTokens(threeBought),
		runs: agg[0]?.runs ?? 0,
		recent_runs: recent,
		last_run: recent[0] || null,
	};
}

export { usd as usdcAtomicsToUsd, threeTokens as threeAtomicsToTokens };
