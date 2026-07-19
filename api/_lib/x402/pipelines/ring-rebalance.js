// api/_lib/x402/pipelines/ring-rebalance.js
//
// Ring rebalancer — recirculate the closed-loop float so it never drains.
//
// In the closed agent economy, ring payer wallets pay USDC to the treasury
// (X402_PAY_TO_SOLANA). Left alone the payer drains and the treasury fills, and
// the loop halts on insufficient balance. This pipeline sweeps USDC from the
// treasury BACK to the payer so the same float cycles indefinitely — which is
// what makes "thousands in gross volume" cost only network fees instead of
// thousands in principal.
//
// Every transfer is between platform-controlled wallets only (treasury → payer).
// The sponsor (X402_FEE_PAYER_SECRET_BASE58) pays the Solana fee so all SOL burn
// stays on ONE monitored wallet; if the sponsor key is absent the treasury
// self-pays. Recorded in x402_ring_ledger (kind='sweep'). It moves OUR money in a
// circle — it is NOT spend, so it returns amountAtomic:0 and never consumes the
// autonomous loop's daily spend cap.
//
// OFF unless X402_TREASURY_SECRET_BASE58 is set (the treasury signing key). Until
// then run() is a graceful no-op.

import bs58 from 'bs58';
import {
	PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, getAccount, getMint,
	createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { solanaConnection } from '../../solana/connection.js';
import { loadSeedKeypair, USDC_MINT } from '../pay.js';
import { ECONOMY_MASTER_ADDRESS } from '../../economy-master.js';

const log = logger('x402-ring-rebalance');

function loadKp(b58) {
	const raw = bs58.decode(b58);
	if (raw.length !== 64) throw new Error(`keypair expected 64 bytes, got ${raw.length}`);
	return Keypair.fromSecretKey(raw);
}

// Keep this much USDC in the treasury after a sweep (default 0 — sweep all).
const TREASURY_BUFFER_ATOMIC = BigInt(process.env.X402_RING_TREASURY_BUFFER_ATOMIC || 0);
// Don't bother sweeping dust — default $0.10 minimum. Env-tunable via
// X402_RING_MIN_SWEEP_ATOMIC: lower it when the per-minute ring tick cycles the
// float in small increments so the rebalancer sweeps sooner and the payer never
// starves between the (now 120s) rebalance ticks.
const MIN_SWEEP_ATOMIC = BigInt(process.env.X402_RING_MIN_SWEEP_ATOMIC || 100_000);
// Revenue share routed to the economy master on every sweep, in basis points.
// The master's fuel module (economy-fuel.js) was built on the assumption that
// "the master accumulates USDC revenue (x402, marketplace)", but nothing ever
// delivered that revenue, so the funding root could never refuel SOL and every
// engine below it starved. This cut closes the loop: treasury → master USDC →
// fuel swap → SOL → treasury-topup → circulation/sponsor floors. Still wallet-
// to-wallet inside the controlled set (master is a SOLANA_SIGNERS role, so the
// leak scanner classifies it internal). 0 disables the leg entirely.
const MASTER_REVSHARE_BPS = (() => {
	const v = Number(process.env.X402_RING_MASTER_REVSHARE_BPS);
	return Number.isFinite(v) && v >= 0 && v <= 10_000 ? Math.floor(v) : 2_000;
})();
// Don't bother with a dust-sized master leg (default $0.10).
const MIN_REVSHARE_ATOMIC = 100_000n;

/**
 * Pure split of a sweep amount into { payerCut, masterCut } per the revshare
 * bps, with the dust floor applied to the master leg.
 * @param {bigint} sweep total atomic USDC being swept
 * @param {number} [bps] override for tests; defaults to the env-derived cut
 */
export function splitSweep(sweep, bps = MASTER_REVSHARE_BPS) {
	let masterCut = (sweep * BigInt(bps)) / 10_000n;
	if (masterCut < MIN_REVSHARE_ATOMIC) masterCut = 0n;
	return { payerCut: sweep - masterCut, masterCut };
}

async function confirmSignature(conn, signature, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { value } = await conn.getSignatureStatuses([signature]);
		const st = value?.[0];
		if (st) {
			if (st.err) return { confirmed: false, err: JSON.stringify(st.err) };
			if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
				return { confirmed: true };
			}
		}
		if (Date.now() > deadline) return { confirmed: false, err: 'confirm_timeout' };
		await new Promise((r) => setTimeout(r, 1200));
	}
}

export async function run(ctx = {}) {
	const sql = ctx.sql || defaultSql;
	const runId = ctx.runId || null;

	const treasurySecret = process.env.X402_TREASURY_SECRET_BASE58;
	if (!treasurySecret) return { success: true, skipped: true, amountAtomic: 0, note: 'treasury_secret_unset' };
	if (!USDC_MINT) return { success: true, skipped: true, amountAtomic: 0, note: 'usdc_mint_unset' };

	let treasury;
	try {
		treasury = loadKp(treasurySecret);
	} catch (err) {
		return { success: false, amountAtomic: 0, errorMsg: `bad_treasury_key:${err.message}` };
	}
	if (env.X402_PAY_TO_SOLANA && treasury.publicKey.toBase58() !== env.X402_PAY_TO_SOLANA) {
		return {
			success: false,
			amountAtomic: 0,
			errorMsg: `treasury_pubkey_mismatch:${treasury.publicKey.toBase58()}!=${env.X402_PAY_TO_SOLANA}`,
		};
	}

	let payerKp;
	try {
		payerKp = loadSeedKeypair();
	} catch {
		return { success: true, skipped: true, amountAtomic: 0, note: 'payer_unset' };
	}
	const payerPub = payerKp.publicKey;

	const conn = ctx.conn || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	const mint = new PublicKey(USDC_MINT);
	const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

	let balance = 0n;
	try {
		const acc = await getAccount(conn, treasuryAta);
		balance = acc.amount;
	} catch {
		return { success: true, skipped: true, amountAtomic: 0, note: 'treasury_ata_empty' };
	}

	if (balance <= TREASURY_BUFFER_ATOMIC) {
		return { success: true, skipped: true, amountAtomic: 0, note: `below_buffer:${balance}` };
	}
	const sweep = balance - TREASURY_BUFFER_ATOMIC;
	if (sweep < MIN_SWEEP_ATOMIC) {
		return { success: true, skipped: true, amountAtomic: 0, note: `below_min_sweep:${sweep}` };
	}

	// Sponsor pays the fee so SOL burn stays on one wallet; else treasury self-pays.
	let feePayerKp = treasury;
	const sponsorSecret = process.env.X402_FEE_PAYER_SECRET_BASE58;
	if (sponsorSecret) {
		try {
			feePayerKp = loadKp(sponsorSecret);
		} catch {
			feePayerKp = treasury;
		}
	}

	// Split the sweep: a bounded revenue share funds the economy master (the SOL
	// fuel source for every engine floor), the rest recycles to the payer float.
	const split = splitSweep(sweep);
	let masterCut = split.masterCut;
	const payerCut = split.payerCut;

	const payerAta = getAssociatedTokenAddressSync(mint, payerPub, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
	const payerAtaInfo = await conn.getAccountInfo(payerAta).catch(() => null);
	const mintInfo = await getMint(conn, mint);
	const { blockhash } = await conn.getLatestBlockhash('confirmed');

	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 90_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
	];
	if (!payerAtaInfo) {
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayerKp.publicKey, payerAta, payerPub, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
	}
	if (payerCut > 0n) {
		ixs.push(createTransferCheckedInstruction(
			treasuryAta, mint, payerAta, treasury.publicKey, payerCut, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
		));
	}
	let masterPub = null;
	if (masterCut > 0n && ECONOMY_MASTER_ADDRESS) {
		masterPub = new PublicKey(ECONOMY_MASTER_ADDRESS);
		const masterAta = getAssociatedTokenAddressSync(mint, masterPub, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayerKp.publicKey, masterAta, masterPub, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
		ixs.push(createTransferCheckedInstruction(
			treasuryAta, mint, masterAta, treasury.publicKey, masterCut, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
		));
	} else {
		masterCut = 0n;
	}

	const msg = new TransactionMessage({
		payerKey: feePayerKp.publicKey,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	const signers = feePayerKp.publicKey.equals(treasury.publicKey)
		? [treasury]
		: [feePayerKp, treasury];
	vtx.sign(signers);

	let signature;
	try {
		signature = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
	} catch (err) {
		return { success: false, amountAtomic: 0, errorMsg: `sweep_broadcast_failed:${String(err?.message || err).slice(0, 200)}` };
	}

	const conf = await confirmSignature(conn, signature);
	if (!conf.confirmed) {
		return { success: false, amountAtomic: 0, txSig: signature, errorMsg: `sweep_not_confirmed:${conf.err}` };
	}

	try {
		if (payerCut > 0n) {
			await sql`
				INSERT INTO x402_ring_ledger (kind, from_wallet, to_wallet, mint, amount_atomic, tx_sig, run_id)
				VALUES ('sweep', ${treasury.publicKey.toBase58()}, ${payerPub.toBase58()},
				        ${USDC_MINT}, ${Number(payerCut)}, ${signature}, ${runId})
			`;
		}
		if (masterCut > 0n && masterPub) {
			await sql`
				INSERT INTO x402_ring_ledger (kind, from_wallet, to_wallet, mint, amount_atomic, tx_sig, run_id)
				VALUES ('revshare', ${treasury.publicKey.toBase58()}, ${masterPub.toBase58()},
				        ${USDC_MINT}, ${Number(masterCut)}, ${signature}, ${runId})
			`;
		}
	} catch (err) {
		log.warn('sweep_ledger_write_failed', { message: err?.message });
	}

	log.info('ring_rebalance_swept', {
		amount_atomic: Number(sweep),
		payer_cut_atomic: Number(payerCut),
		master_cut_atomic: Number(masterCut),
		to: payerPub.toBase58(),
		tx: signature,
	});

	return {
		success: true,
		amountAtomic: 0, // recirculation, not spend — cap-neutral
		txSig: signature,
		note: `swept ${Number(payerCut) / 1e6} USDC treasury→payer`
			+ (masterCut > 0n ? ` + ${Number(masterCut) / 1e6} USDC treasury→master` : ''),
	};
}

// ── Agent float top-up / sweep (Task 09) ───────────────────────────────────────
//
// The treasury→payer sweep above keeps the seed PAYER funded. This step does the
// same for the ROSTER AGENTS (api/_lib/x402/agents/): it keeps each agent's USDC
// balance inside a floor/target/ceiling band by moving float between the treasury
// and the agent — top up a hungry agent, sweep an overfull one back. Same closed
// loop, same platform-controlled wallets, recorded to x402_ring_ledger as
// kind='fund'. It deliberately does NOT touch the treasury→payer core above.
//
// Every counterparty is asserted against ringAllowedAddresses() before any move —
// a wallet outside the controlled set is skipped (fail-closed), never funded.
// Recirculation, not spend: returns amountAtomic:0 so it never consumes the daily
// spend cap. No-op until the treasury secret is set (same gate as run()).

/**
 * Build, sign, broadcast and confirm ONE USDC transfer between two ring wallets.
 * `from` is the token-transfer authority (must sign); `feePayer` pays the SOL fee
 * (may be the same as `from`). Returns { ok, signature } | { ok:false, err }.
 */
async function transferUsdcBetween({ conn, mint, mintInfo, fromKp, toPub, amountAtomic, feePayerKp }) {
	const fromAta = getAssociatedTokenAddressSync(mint, fromKp.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
	const toAta = getAssociatedTokenAddressSync(mint, toPub, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
	const toAtaInfo = await conn.getAccountInfo(toAta).catch(() => null);
	const { blockhash } = await conn.getLatestBlockhash('confirmed');

	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
	];
	if (!toAtaInfo) {
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayerKp.publicKey, toAta, toPub, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
	}
	ixs.push(createTransferCheckedInstruction(
		fromAta, mint, toAta, fromKp.publicKey, BigInt(amountAtomic), mintInfo.decimals, [], TOKEN_PROGRAM_ID,
	));

	const msg = new TransactionMessage({
		payerKey: feePayerKp.publicKey,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	const signers = feePayerKp.publicKey.equals(fromKp.publicKey) ? [fromKp] : [feePayerKp, fromKp];
	vtx.sign(signers);

	let signature;
	try {
		signature = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
	} catch (err) {
		return { ok: false, err: `broadcast_failed:${String(err?.message || err).slice(0, 160)}` };
	}
	const conf = await confirmSignature(conn, signature);
	if (!conf.confirmed) return { ok: false, err: `not_confirmed:${conf.err}`, signature };
	return { ok: true, signature };
}

/**
 * Keep every roster agent's USDC float inside its band. Conforms to the run()-style
 * registry contract (cap-neutral recirculation). Standalone-safe.
 *
 * @param {object} ctx { sql?, conn?, runId? }
 * @returns {Promise<{ success:boolean, amountAtomic:0, skipped?:boolean, note?:string, moves?:Array }>}
 */
export async function floatTopUp(ctx = {}) {
	const sql = ctx.sql || defaultSql;
	const runId = ctx.runId || null;

	const treasurySecret = process.env.X402_TREASURY_SECRET_BASE58;
	if (!treasurySecret) return { success: true, skipped: true, amountAtomic: 0, note: 'treasury_secret_unset' };
	if (!USDC_MINT) return { success: true, skipped: true, amountAtomic: 0, note: 'usdc_mint_unset' };

	let treasury;
	try {
		treasury = loadKp(treasurySecret);
	} catch (err) {
		return { success: false, amountAtomic: 0, errorMsg: `bad_treasury_key:${err.message}` };
	}
	if (env.X402_PAY_TO_SOLANA && treasury.publicKey.toBase58() !== env.X402_PAY_TO_SOLANA) {
		return { success: false, amountAtomic: 0, errorMsg: 'treasury_pubkey_mismatch' };
	}

	// Lazy imports: keep the rebalancer's core dependency graph small, and avoid a
	// module-load cycle with the agents driver (which imports pay.js).
	const [{ ensureRosterAgents }, { planFloatMove, floatBand, recoverAgentBuyer }, { ringAllowedAddresses }] = await Promise.all([
		import('../agents/index.js'),
		import('../agents/persona-kit.js'),
		import('../ring-allowlist.js'),
	]);

	const roster = await ensureRosterAgents(sql);
	if (roster.length === 0) return { success: true, skipped: true, amountAtomic: 0, note: 'no_roster_agents' };

	const allowed = await ringAllowedAddresses({ sql });
	if (!allowed.has(treasury.publicKey.toBase58())) {
		return { success: false, amountAtomic: 0, errorMsg: 'treasury_not_allowlisted' };
	}

	const conn = ctx.conn || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	const mint = new PublicKey(USDC_MINT);
	const mintInfo = await getMint(conn, mint);
	const band = floatBand();

	// Sponsor pays fees when configured so SOL burn stays on one wallet.
	let sponsorKp = null;
	if (process.env.X402_FEE_PAYER_SECRET_BASE58) {
		try { sponsorKp = loadKp(process.env.X402_FEE_PAYER_SECRET_BASE58); } catch { sponsorKp = null; }
	}

	const moves = [];
	const minMove = Math.max(0, Number(process.env.X402_RING_AGENT_MIN_FLOAT_MOVE_ATOMIC || 100_000)); // $0.10

	for (const member of roster) {
		// Both counterparties must be inside the controlled set — fail-closed.
		if (!allowed.has(member.address)) {
			moves.push({ agent: member.id, action: 'skip', reason: 'agent_not_allowlisted' });
			continue;
		}
		const agentPub = new PublicKey(member.address);
		const agentAta = getAssociatedTokenAddressSync(mint, agentPub, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		let balance = 0n;
		try {
			const acc = await getAccount(conn, agentAta);
			balance = acc.amount;
		} catch {
			balance = 0n; // no ATA yet → treated as empty; a top-up creates it
		}

		const plan = planFloatMove({
			balanceAtomic: balance, floorAtomic: band.floorAtomic,
			targetAtomic: band.targetAtomic, ceilingAtomic: band.ceilingAtomic,
		});
		if (plan.action === 'none' || plan.amountAtomic < minMove) {
			moves.push({ agent: member.id, action: 'none', balance_atomic: Number(balance) });
			continue;
		}

		let res;
		let fromWallet;
		let toWallet;
		if (plan.action === 'top_up') {
			// treasury → agent, sponsor (or treasury) pays the fee.
			fromWallet = treasury.publicKey.toBase58();
			toWallet = member.address;
			res = await transferUsdcBetween({
				conn, mint, mintInfo, fromKp: treasury, toPub: agentPub,
				amountAtomic: plan.amountAtomic, feePayerKp: sponsorKp || treasury,
			});
		} else {
			// agent → treasury (sweep overflow). The agent signs; sponsor (or the
			// agent) pays the fee. Needs the agent's custodial key.
			const agentKp = await recoverAgentBuyer(member);
			if (!agentKp) {
				moves.push({ agent: member.id, action: 'sweep', reason: 'agent_key_unavailable' });
				continue;
			}
			fromWallet = member.address;
			toWallet = treasury.publicKey.toBase58();
			res = await transferUsdcBetween({
				conn, mint, mintInfo, fromKp: agentKp, toPub: treasury.publicKey,
				amountAtomic: plan.amountAtomic, feePayerKp: sponsorKp || agentKp,
			});
		}

		if (!res.ok) {
			moves.push({ agent: member.id, action: plan.action, reason: res.err });
			continue;
		}

		try {
			await sql`
				INSERT INTO x402_ring_ledger (kind, from_wallet, to_wallet, mint, amount_atomic, tx_sig, run_id)
				VALUES ('fund', ${fromWallet}, ${toWallet}, ${USDC_MINT}, ${plan.amountAtomic}, ${res.signature}, ${runId})
			`;
		} catch (err) {
			log.warn('float_fund_ledger_write_failed', { agent: member.id, message: err?.message });
		}
		moves.push({ agent: member.id, persona: member.persona.id, action: plan.action, amount_atomic: plan.amountAtomic, tx: res.signature });
		log.info('ring_float_move', { agent: member.id, action: plan.action, amount_atomic: plan.amountAtomic, tx: res.signature });
	}

	const funded = moves.filter((m) => m.tx).length;
	return {
		success: true,
		amountAtomic: 0, // recirculation, not spend — cap-neutral
		recorded: false,
		skipped: funded === 0,
		note: `float_top_up moves=${funded}/${roster.length}`,
		moves,
	};
}
