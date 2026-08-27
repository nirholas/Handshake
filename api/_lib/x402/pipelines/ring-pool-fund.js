// api/_lib/x402/pipelines/ring-pool-fund.js
//
// Keeps the ring payer POOL (api/_lib/x402/pool.js) topped up so every rotating
// wallet can settle: a little SOL for its own 1-signature self-pay fee, and a
// small recirculating USDC float. This is the threshold-based "top up when low"
// funder the pool needs — the economy master's treasury-topup only funds
// solana-signers.js entries, and pool wallets are deliberately NOT signers.
//
// Efficiency: balances are read in BATCHES (getMultipleAccountsInfo, ≤100/call)
// and top-ups are BATCHED into few transactions (many SystemProgram transfers per
// SOL tx; several USDC transfers per USDC tx), so funding 500–1,000 wallets costs a
// handful of transactions per run, not one per wallet. Bounded by
// X402_RING_POOL_FUND_MAX_PER_RUN so a single run can never fan out unboundedly.
//
// Closed-loop invariants:
//   • SOL comes from the sponsor/master fee wallet (X402_FEE_PAYER_SECRET_BASE58);
//     USDC comes from the treasury (X402_TREASURY_SECRET_BASE58). Both are inside
//     ringAllowedAddresses(); every recipient is a pool wallet, also inside the set.
//   • Recirculation, not spend: returns amountAtomic:0, never consumes the daily
//     cap. Overfull wallets are swept back to the treasury to keep the float flat.
//   • Every move is recorded in x402_ring_ledger as kind='fund'.

import bs58 from 'bs58';
import {
	PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { solanaConnection } from '../../solana/connection.js';
import { blockhashKey, getRecentBlockhashInfo, mintDecimals } from '../../solana/read-guards.js';
import { USDC_MINT } from '../pay.js';
import { ringPoolEnabled, listEnabledPubkeys, recoverPoolKeypair, poolCount } from '../pool.js';
import { ringAllowedAddresses } from '../ring-allowlist.js';

const log = logger('x402-ring-pool-fund');

// ── Tunable floors/targets (lamports for SOL, USDC atomics for USDC) ──────────
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export function poolSolFloorLamports() { return num(process.env.X402_RING_POOL_SOL_FLOOR_LAMPORTS, 8_000_000); }   // 0.008 SOL
export function poolSolTargetLamports() { return num(process.env.X402_RING_POOL_SOL_TARGET_LAMPORTS, 12_000_000); } // 0.012 SOL
export function poolUsdcFloorAtomic() { return num(process.env.X402_RING_POOL_USDC_FLOOR_ATOMIC, 500_000); }       // $0.50
export function poolUsdcTargetAtomic() { return num(process.env.X402_RING_POOL_USDC_TARGET_ATOMIC, 2_000_000); }   // $2.00
export function poolUsdcCeilingAtomic() { return num(process.env.X402_RING_POOL_USDC_CEIL_ATOMIC, 4_000_000); }    // $4.00
export function poolFundMaxPerRun() { return Math.max(1, num(process.env.X402_RING_POOL_FUND_MAX_PER_RUN, 60)); }

const SOL_TRANSFERS_PER_TX = 14;   // System transfers batched per funding tx
const USDC_TRANSFERS_PER_TX = 6;   // (idempotent-create + transferChecked) pairs per tx
const ACCOUNTS_PER_READ = 100;     // getMultipleAccountsInfo hard limit

function loadKp(secret) {
	const s = String(secret || '').trim();
	if (!s) throw new Error('empty secret');
	try { const b = bs58.decode(s); if (b.length === 64) return Keypair.fromSecretKey(b); } catch { /* try base64 */ }
	const b = Buffer.from(s, 'base64');
	if (b.length === 64) return Keypair.fromSecretKey(Uint8Array.from(b));
	throw new Error(`secret decodes to ${b.length} bytes, expected 64`);
}

async function confirmSignature(conn, signature, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const st = await conn.getSignatureStatuses([signature]).catch(() => null);
		const v = st?.value?.[0];
		if (v?.err) return { confirmed: false, err: JSON.stringify(v.err) };
		if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) return { confirmed: true };
		await new Promise((r) => setTimeout(r, 1500));
	}
	return { confirmed: false, err: 'timeout' };
}

// SPL token account layout: `amount` is a little-endian u64 at byte offset 64.
export function tokenAmountFromAccountData(data) {
	if (!data || data.length < 72) return 0n;
	return data.readBigUInt64LE(64);
}

/**
 * PURE — decide the funding work for a pass. Given each wallet's SOL (lamports) and
 * USDC (atomic) balances plus the floors/targets, return the wallets that need SOL,
 * need USDC, or are overfull (sweep back), each capped at `maxPerRun`. No I/O, no
 * signing — unit-tested independently of the chain.
 *
 * @returns {{ solNeed:Array<{pk,add}>, usdcNeed:Array<{pk,add:bigint}>, usdcSweep:Array<{pk,take:bigint}> }}
 */
export function planPoolFunding({ pubkeys, solByPubkey, usdcByPubkey, allowed, floors }) {
	const { solFloor, solTarget, usdcFloor, usdcTarget, usdcCeil, maxPerRun } = floors;
	const solNeed = [];
	const usdcNeed = [];
	const usdcSweep = [];
	for (const pk of pubkeys) {
		if (allowed && !allowed.has(pk)) continue; // defence-in-depth: only fund controlled wallets
		const sol = Number(solByPubkey.get(pk) ?? 0);
		if (sol < solFloor) solNeed.push({ pk, add: solTarget - sol });
		const usdc = BigInt(usdcByPubkey.get(pk) ?? 0n);
		if (usdc < BigInt(usdcFloor)) usdcNeed.push({ pk, add: BigInt(usdcTarget) - usdc });
		else if (usdc > BigInt(usdcCeil)) usdcSweep.push({ pk, take: usdc - BigInt(usdcTarget) });
	}
	solNeed.splice(maxPerRun);
	usdcNeed.splice(maxPerRun);
	usdcSweep.splice(maxPerRun);
	return { solNeed, usdcNeed, usdcSweep };
}

async function readBalances(conn, pubkeys, mint) {
	const solByPubkey = new Map();
	const usdcByPubkey = new Map();
	const ataByPubkey = new Map();
	for (const pk of pubkeys) {
		ataByPubkey.set(pk, getAssociatedTokenAddressSync(mint, new PublicKey(pk), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
	}
	// SOL: read the wallet accounts themselves.
	for (let i = 0; i < pubkeys.length; i += ACCOUNTS_PER_READ) {
		const chunk = pubkeys.slice(i, i + ACCOUNTS_PER_READ);
		const infos = await conn.getMultipleAccountsInfo(chunk.map((p) => new PublicKey(p)), 'confirmed');
		chunk.forEach((pk, j) => solByPubkey.set(pk, infos[j] ? infos[j].lamports : 0));
	}
	// USDC: read each wallet's ATA (absent ATA → 0 balance, top-up creates it).
	const ataList = pubkeys.map((pk) => ({ pk, ata: ataByPubkey.get(pk) }));
	for (let i = 0; i < ataList.length; i += ACCOUNTS_PER_READ) {
		const chunk = ataList.slice(i, i + ACCOUNTS_PER_READ);
		const infos = await conn.getMultipleAccountsInfo(chunk.map((c) => c.ata), 'confirmed');
		chunk.forEach((c, j) => usdcByPubkey.set(c.pk, infos[j] ? tokenAmountFromAccountData(infos[j].data) : 0n));
	}
	return { solByPubkey, usdcByPubkey, ataByPubkey };
}

async function sendIxs(conn, feePayer, signers, instructions) {
	// A cron tick that cannot read a blockhash used to throw straight through the
	// handler into an ops alert. The guard answers from a hash still inside its
	// validity window when the chain is unreadable, and raises a typed
	// rpc_unavailable only when there is genuinely nothing to sign with.
	const { blockhash } = await getRecentBlockhashInfo(conn, blockhashKey({ url: env.SOLANA_RPC_URL }));
	const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	vtx.sign(signers);
	const signature = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
	const conf = await confirmSignature(conn, signature);
	if (!conf.confirmed) return { ok: false, signature, err: conf.err };
	return { ok: true, signature };
}

/**
 * Run one pool-funding pass. Conforms to the run()-style registry contract.
 * @param {{ sql?:Function, conn?:object, runId?:string }} ctx
 */
export async function run(ctx = {}) {
	const sql = ctx.sql || defaultSql;
	const runId = ctx.runId || null;

	if (!ringPoolEnabled()) return { success: true, skipped: true, amountAtomic: 0, note: 'pool_disabled' };
	if (!USDC_MINT) return { success: true, skipped: true, amountAtomic: 0, note: 'usdc_mint_unset' };

	const treasurySecret = process.env.X402_TREASURY_SECRET_BASE58;
	const solFunderSecret = process.env.X402_FEE_PAYER_SECRET_BASE58 || treasurySecret;
	if (!treasurySecret) return { success: true, skipped: true, amountAtomic: 0, note: 'treasury_secret_unset' };
	if (!solFunderSecret) return { success: true, skipped: true, amountAtomic: 0, note: 'sol_funder_secret_unset' };

	let treasury, solFunder;
	try { treasury = loadKp(treasurySecret); solFunder = loadKp(solFunderSecret); }
	catch (err) { return { success: false, amountAtomic: 0, errorMsg: `bad_funder_key:${err.message}` }; }

	if (env.X402_PAY_TO_SOLANA && treasury.publicKey.toBase58() !== env.X402_PAY_TO_SOLANA) {
		return { success: false, amountAtomic: 0, errorMsg: 'treasury_pubkey_mismatch' };
	}

	const total = await poolCount(sql);
	if (total === 0) return { success: true, skipped: true, amountAtomic: 0, note: 'pool_empty' };

	const allowed = await ringAllowedAddresses({ sql });
	// Fail closed: both funders must be inside the controlled set.
	if (!allowed.has(treasury.publicKey.toBase58()) || !allowed.has(solFunder.publicKey.toBase58())) {
		return { success: false, amountAtomic: 0, errorMsg: 'funder_not_allowlisted' };
	}

	const conn = ctx.conn || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	const mint = new PublicKey(USDC_MINT);
	// USDC's decimals are a constant, so the ring never spends an RPC call, or a
	// tick, on re-reading them.
	const decimals = await mintDecimals(conn, mint);
	const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

	const pubkeys = await listEnabledPubkeys(sql);
	const { solByPubkey, usdcByPubkey, ataByPubkey } = await readBalances(conn, pubkeys, mint);

	const { solNeed, usdcNeed, usdcSweep } = planPoolFunding({
		pubkeys, solByPubkey, usdcByPubkey, allowed,
		floors: {
			solFloor: poolSolFloorLamports(), solTarget: poolSolTargetLamports(),
			usdcFloor: poolUsdcFloorAtomic(), usdcTarget: poolUsdcTargetAtomic(),
			usdcCeil: poolUsdcCeilingAtomic(), maxPerRun: poolFundMaxPerRun(),
		},
	});

	const moves = { sol_funded: 0, usdc_funded: 0, usdc_swept: 0, sigs: [] };
	const ledgerRows = [];

	// ── SOL top-ups (batched System transfers, funded by the sponsor/master) ──────
	for (let i = 0; i < solNeed.length; i += SOL_TRANSFERS_PER_TX) {
		const chunk = solNeed.slice(i, i + SOL_TRANSFERS_PER_TX);
		const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 })];
		for (const w of chunk) {
			ixs.push(SystemProgram.transfer({ fromPubkey: solFunder.publicKey, toPubkey: new PublicKey(w.pk), lamports: Math.floor(w.add) }));
		}
		const res = await sendIxs(conn, solFunder, [solFunder], ixs);
		if (res.ok) {
			moves.sol_funded += chunk.length; moves.sigs.push(res.signature);
			for (const w of chunk) ledgerRows.push({ from: solFunder.publicKey.toBase58(), to: w.pk, amount: 0, sig: res.signature });
		} else {
			log.warn('pool_sol_fund_failed', { count: chunk.length, err: res.err });
		}
	}

	// ── USDC top-ups: USDC moves treasury→wallet, but ALL SOL (each pool wallet's
	// new-ATA rent + the tx fee) is paid by the sponsor/master fee wallet, so an
	// operator funds SOL in exactly ONE place. The treasury only signs as the token
	// transfer authority; the sponsor is fee payer + ATA-create funder.
	const solFunderIsTreasury = solFunder.publicKey.equals(treasury.publicKey);
	for (let i = 0; i < usdcNeed.length; i += USDC_TRANSFERS_PER_TX) {
		const chunk = usdcNeed.slice(i, i + USDC_TRANSFERS_PER_TX);
		const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 })];
		for (const w of chunk) {
			const ata = ataByPubkey.get(w.pk);
			ixs.push(createAssociatedTokenAccountIdempotentInstruction(solFunder.publicKey, ata, new PublicKey(w.pk), mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
			ixs.push(createTransferCheckedInstruction(treasuryAta, mint, ata, treasury.publicKey, BigInt(w.add), decimals, [], TOKEN_PROGRAM_ID));
		}
		const signers = solFunderIsTreasury ? [treasury] : [solFunder, treasury];
		const res = await sendIxs(conn, solFunder, signers, ixs);
		if (res.ok) {
			moves.usdc_funded += chunk.length; moves.sigs.push(res.signature);
			for (const w of chunk) ledgerRows.push({ from: treasury.publicKey.toBase58(), to: w.pk, amount: Number(w.add), sig: res.signature });
		} else {
			log.warn('pool_usdc_fund_failed', { count: chunk.length, err: res.err });
		}
	}

	// ── Overfull sweeps (pool wallet → treasury). The sponsor pays the SOL fee, so a
	// pool wallet never needs SOL beyond its own settle fees; the pool wallet signs
	// only as the token transfer authority.
	for (const w of usdcSweep) {
		const kp = await recoverPoolKeypair(w.pk, sql);
		if (!kp) { log.warn('pool_sweep_key_unavailable', { pubkey: w.pk }); continue; }
		const fromAta = ataByPubkey.get(w.pk);
		const ixs = [
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
			createAssociatedTokenAccountIdempotentInstruction(solFunder.publicKey, treasuryAta, treasury.publicKey, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
			createTransferCheckedInstruction(fromAta, mint, treasuryAta, kp.publicKey, w.take, decimals, [], TOKEN_PROGRAM_ID),
		];
		const signers = solFunder.publicKey.equals(kp.publicKey) ? [kp] : [solFunder, kp];
		const res = await sendIxs(conn, solFunder, signers, ixs);
		if (res.ok) {
			moves.usdc_swept += 1; moves.sigs.push(res.signature);
			ledgerRows.push({ from: w.pk, to: treasury.publicKey.toBase58(), amount: Number(w.take), sig: res.signature });
		} else {
			log.warn('pool_sweep_failed', { pubkey: w.pk, err: res.err });
		}
	}

	// Record every move to x402_ring_ledger as kind='fund' (recirculation).
	for (const r of ledgerRows) {
		try {
			await sql`INSERT INTO x402_ring_ledger (kind, from_wallet, to_wallet, mint, amount_atomic, tx_sig, run_id)
				VALUES ('fund', ${r.from}, ${r.to}, ${USDC_MINT}, ${r.amount}, ${r.sig}, ${runId})`;
		} catch (err) { log.warn('pool_fund_ledger_write_failed', { message: err?.message }); }
	}

	log.info('ring_pool_funded', { total, ...moves, sigs: moves.sigs.length });
	return {
		success: true, amountAtomic: 0,
		note: `pool_fund sol=${moves.sol_funded} usdc=${moves.usdc_funded} swept=${moves.usdc_swept}`,
		moves: { sol_funded: moves.sol_funded, usdc_funded: moves.usdc_funded, usdc_swept: moves.usdc_swept, tx_count: moves.sigs.length },
	};
}
