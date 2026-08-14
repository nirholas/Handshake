#!/usr/bin/env node
// Reputation Staking Market: the executable end-to-end proof (spec §10).
//
// Runs the full rsm.v1 contract against Solana devnet with airdropped
// lamports, no database and no live server required:
//
//   1. fund    : generate a staker + an agent identity, airdrop devnet SOL
//   2. attest  : write a real attested action history for the agent on-chain
//                (accept, passed validation, feedback: three signed SPL-Memo
//                envelopes naming the agent, exactly what the index crawls)
//   3. stake   : the staker signs a market stake (transfer + rsm.v1 memo)
//   4. verify  : verifyStakeTx re-derives the position from the chain alone
//   5. accrue  : quoteEarnings over the on-chain action history (the same
//                routine the HTTP surface and settlement path call)
//   6. withdraw: the escrow signs the settlement (principal + earnings back to
//                the staker, threews.unstake.v1 memo), then the chain is
//                re-read to confirm both the transfer and the memo
//
// Escrow resolution, in order:
//   1. REPUTATION_MARKET_ESCROW_SECRET_KEY (the real deployment escrow: the
//      settlement is signed by the same key the service would use)
//   2. an ephemeral escrow generated for the run, funded by the staker
// Either way the proof settles with a real signature; mode 2 exists so the
// proof is runnable by anyone with no credentials at all.
//
// Staker funding, in order:
//   1. REPUTATION_MARKET_PROOF_FUNDER_SECRET_KEY (a keypair you funded once)
//   2. the public devnet faucet
// The faucet rate-limits per source IP, so a shared machine can find it already
// exhausted. Rung 1 exists for exactly that case: fund any devnet keypair once
// at https://faucet.solana.com and the proof never touches the faucet again.
//
// Env (all optional):
//   REPUTATION_MARKET_ESCROW_SECRET_KEY  escrow secret (base58/base64/JSON)
//   REPUTATION_MARKET_PROOF_FUNDER_SECRET_KEY  pre-funded staker funder
//   SOLANA_RPC_URL_DEVNET                devnet RPC override
//   REPUTATION_MARKET_EPOCH_POOL_LAMPORTS  epoch pool for the quote
//                                          (default 2000000: 0.002 SOL)
//
// Exit 0 on a fully verified cycle, 1 with the failing stage named otherwise.

import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

import {
	marketConfig,
	verifyStakeTx,
	readActionHistoryFromChain,
	quoteEarnings,
	lamportsReceivedBy,
	feePayerOf,
	MARKET_TAG,
	MIN_STAKE_LAMPORTS,
	UNSTAKE_KIND,
} from '../api/_lib/reputation-market.js';
import { RPC, extractMemoPayload, validatePayload } from '../api/_lib/solana-attestations.js';
import { decodeAttesterSecret } from '../api/_lib/attest-event.js';
import { solanaConnection } from '../api/_lib/solana/connection.js';
import { sendAndConfirm } from '../api/_lib/solana/confirm.js';
import { epochOf, formatSol } from '../src/shared/reputation-staking.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const NETWORK = 'devnet';
const STAKE_LAMPORTS = 2_000_000n; // 0.002 SOL, twice the minimum
const DEFAULT_POOL_LAMPORTS = 2_000_000n;
const AIRDROP_LAMPORTS = 100_000_000; // 0.1 SOL per request, devnet-friendly
const FUNDER_FEE_HEADROOM = 5_000n; // one signature's fee, so the funder can pay for its own transfer
const CONFIRM_TIMEOUT_MS = 60_000;

const results = [];
function step(name, ok, detail) {
	results.push({ step: name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
	if (!ok) {
		console.error(JSON.stringify({ ok: false, failed: name, results }, null, 2));
		process.exit(1);
	}
}

async function fundWithAirdrops(conn, pubkey, targetLamports) {
	let balance = BigInt(await conn.getBalance(pubkey, 'confirmed'));
	while (balance < BigInt(targetLamports)) {
		let advanced = false;
		for (let attempt = 0; attempt < 5 && !advanced; attempt++) {
			try {
				const sig = await conn.requestAirdrop(pubkey, AIRDROP_LAMPORTS);
				await conn.confirmTransaction(sig, 'confirmed');
				advanced = true;
			} catch (err) {
				// Devnet faucets rate-limit hard; back off and retry.
				await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
				if (attempt === 4) {
					throw new Error(
						`airdrop failed: ${err.message}\n` +
							'The public devnet faucet rate-limits per source IP, so a shared machine can exhaust it ' +
							'for everyone on it. Fund any devnet keypair once at https://faucet.solana.com and re-run ' +
							'with REPUTATION_MARKET_PROOF_FUNDER_SECRET_KEY set to its secret; the proof then needs no faucet.',
					);
				}
			}
		}
		balance = BigInt(await conn.getBalance(pubkey, 'confirmed'));
	}
	return balance;
}

/**
 * Fund the staker for the run. The faucet is one rung, not the only one: a
 * pre-funded keypair in REPUTATION_MARKET_PROOF_FUNDER_SECRET_KEY takes
 * priority, which is what makes the proof runnable from a machine whose IP the
 * public devnet faucet has already cut off.
 */
async function fundStaker(conn, pubkey, targetLamports) {
	const secret = process.env.REPUTATION_MARKET_PROOF_FUNDER_SECRET_KEY;
	const bytes = secret ? decodeAttesterSecret(secret) : null;
	if (!bytes) return { balance: await fundWithAirdrops(conn, pubkey, targetLamports), source: 'faucet' };

	const funder = Keypair.fromSecretKey(bytes);
	const need = BigInt(targetLamports) + FUNDER_FEE_HEADROOM;
	const held = BigInt(await conn.getBalance(funder.publicKey, 'confirmed'));
	if (held < need) {
		throw new Error(
			`funder ${funder.publicKey.toBase58()} holds ${held} lamports but needs ${need}. ` +
				`Top it up on ${NETWORK} at https://faucet.solana.com and re-run.`,
		);
	}

	const tx = new Transaction().add(
		SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: pubkey, lamports: Number(targetLamports) }),
	);
	await sendAndConfirm(conn, tx, [funder], { commitment: 'confirmed', timeoutMs: CONFIRM_TIMEOUT_MS });
	return {
		balance: BigInt(await conn.getBalance(pubkey, 'confirmed')),
		source: `funder ${funder.publicKey.toBase58()}`,
	};
}

async function attest(conn, signer, agentAsset, payload) {
	const memoIx = new TransactionInstruction({
		keys: [
			{ pubkey: signer.publicKey, isSigner: true, isWritable: false },
			{ pubkey: agentAsset, isSigner: false, isWritable: false },
		],
		programId: MEMO_PROGRAM_ID,
		data: Buffer.from(JSON.stringify(payload), 'utf8'),
	});
	const tx = new Transaction().add(memoIx);
	return sendAndConfirm(conn, tx, [signer], { commitment: 'confirmed', timeoutMs: CONFIRM_TIMEOUT_MS });
}

const main = async () => {
	const conn = solanaConnection({ url: RPC[NETWORK], commitment: 'confirmed' });

	// ── 1. fund ───────────────────────────────────────────────────────────
	const staker = Keypair.generate();
	const agent = Keypair.generate();
	const agentAsset = agent.publicKey;

	const envSecret = process.env.REPUTATION_MARKET_ESCROW_SECRET_KEY;
	let escrowKeypair;
	let escrowMode;
	if (envSecret && decodeAttesterSecret(envSecret)) {
		escrowKeypair = Keypair.fromSecretKey(decodeAttesterSecret(envSecret));
		escrowMode = 'configured';
	} else {
		escrowKeypair = Keypair.generate();
		escrowMode = 'ephemeral';
	}
	const escrow = escrowKeypair.publicKey;
	step('config', true, `network=${NETWORK} escrow=${escrow.toBase58()} (${escrowMode})`);

	const funded = await fundStaker(conn, staker.publicKey, 20_000_000); // stake + fees + headroom
	step('fund', true, `staker=${staker.publicKey.toBase58()} via ${funded.source}`);

	const poolLamports = process.env.REPUTATION_MARKET_EPOCH_POOL_LAMPORTS
		? BigInt(process.env.REPUTATION_MARKET_EPOCH_POOL_LAMPORTS)
		: DEFAULT_POOL_LAMPORTS;

	// The escrow needs the earnings it will pay out, plus fees and its rent floor.
	// A configured escrow may already be funded; an ephemeral one never is, so
	// top up only the shortfall.
	const rentFloor = BigInt(await conn.getMinimumBalanceForRentExemption(0));
	const wantEscrow = poolLamports + rentFloor + 20_000n;
	const escrowHave = BigInt(await conn.getBalance(escrow, 'confirmed'));
	if (escrowHave < wantEscrow) {
		const topUp = new Transaction().add(
			SystemProgram.transfer({
				fromPubkey: staker.publicKey,
				toPubkey: escrow,
				lamports: wantEscrow - escrowHave,
			}),
		);
		await sendAndConfirm(conn, topUp, [staker], { commitment: 'confirmed', timeoutMs: CONFIRM_TIMEOUT_MS });
	}
	step('escrow-funded', true, `balance=${await conn.getBalance(escrow, 'confirmed')} lamports`);

	// ── 2. attest: a real action history for the agent ────────────────────
	const runId = Date.now().toString(36);
	const attestations = [
		{ v: 1, kind: 'threews.task.v1', agent: agentAsset.toBase58(), task_id: `rsm-proof-${runId}`, scope_hash: `rsm-proof-${runId}` },
		{ v: 1, kind: 'threews.accept.v1', agent: agentAsset.toBase58(), task_id: `rsm-proof-${runId}` },
		{ v: 1, kind: 'threews.validation.v1', agent: agentAsset.toBase58(), task_hash: `rsm-proof-${runId}`, passed: true },
		{ v: 1, kind: 'threews.feedback.v1', agent: agentAsset.toBase58(), score: 5, task_id: `rsm-proof-${runId}` },
	];
	for (const payload of attestations) {
		await attest(conn, staker, agentAsset, payload);
	}
	step('attest', true, `${attestations.length} signed memos on ${agentAsset.toBase58()}`);

	// ── 3. stake: staker-signed transfer + rsm.v1 memo ────────────────────
	const stakeMemo = JSON.stringify({
		v: 1,
		kind: 'threews.stake.v1',
		market: MARKET_TAG,
		agent: agentAsset.toBase58(),
		score: 4,
		escrow: escrow.toBase58(),
	});
	const stakeTx = new Transaction().add(
		SystemProgram.transfer({ fromPubkey: staker.publicKey, toPubkey: escrow, lamports: STAKE_LAMPORTS }),
		new TransactionInstruction({
			keys: [{ pubkey: staker.publicKey, isSigner: true, isWritable: false }],
			programId: MEMO_PROGRAM_ID,
			data: Buffer.from(stakeMemo, 'utf8'),
		}),
	);
	const stakeSignature = await sendAndConfirm(conn, stakeTx, [staker], {
		commitment: 'confirmed',
		timeoutMs: CONFIRM_TIMEOUT_MS,
	});
	step('stake', true, `signature=${stakeSignature} principal=${STAKE_LAMPORTS}`);

	// ── 4. verify: the position re-derived from the chain alone ───────────
	const env = {
		...process.env,
		REPUTATION_MARKET_ESCROW_PUBKEY: escrow.toBase58(),
		REPUTATION_MARKET_ESCROW_SECRET_KEY: undefined,
		REPUTATION_MARKET_EPOCH_POOL_LAMPORTS: poolLamports.toString(),
	};
	const verified = await verifyStakeTx({ signature: stakeSignature, network: NETWORK, env });
	const verifyOk =
		verified.staker === staker.publicKey.toBase58() &&
		verified.agentAsset === agentAsset.toBase58() &&
		verified.principalLamports === STAKE_LAMPORTS &&
		verified.score === 4;
	step('verify', verifyOk, `staker=${verified.staker} principal=${verified.principalLamports}`);

	// ── 5. accrue: earnings quoted from the on-chain action history ───────
	const now = Math.floor(Date.now() / 1000);
	const history = await readActionHistoryFromChain({ agentAsset: agentAsset.toBase58(), network: NETWORK });
	const epoch = epochOf(now);
	const inEpoch = history.filter((a) => epochOf(a.blockTime) === epoch);
	step('history', inEpoch.length >= attestations.length, `${inEpoch.length} attested actions in epoch ${epoch}`);

	const position = {
		id: stakeSignature,
		agentAsset: agentAsset.toBase58(),
		principalLamports: STAKE_LAMPORTS,
		openedAt: verified.openedAt,
		closedAt: null,
	};
	const { byPosition, agentWeightsByEpoch } = quoteEarnings({
		positions: [position],
		historyByAgent: new Map([[agentAsset.toBase58(), history]]),
		poolLamports,
		now,
	});
	const quote = byPosition.get(stakeSignature);
	const agentWeight = agentWeightsByEpoch.get(epoch)?.get(agentAsset.toBase58()) ?? 0;
	if (!(agentWeight > 0)) {
		step('accrue', false, `agentWeight is ${agentWeight}; the attested history produced no work`);
	}
	step(
		'accrue',
		quote && quote.lamports > 0n,
		`agentWeight=${agentWeight} earnings=${quote?.lamports} lamports over ${quote?.byEpoch.length} epoch(s)`,
	);

	// ── 6. withdraw: escrow-signed settlement, verified back on-chain ─────
	const earnings = quote.lamports;
	const payout = STAKE_LAMPORTS + earnings;
	const settleMemo = JSON.stringify({
		v: 1,
		kind: UNSTAKE_KIND,
		market: MARKET_TAG,
		agent: agentAsset.toBase58(),
		stake: stakeSignature,
		principal: STAKE_LAMPORTS.toString(),
		earnings: earnings.toString(),
	});
	const settleTx = new Transaction().add(
		SystemProgram.transfer({ fromPubkey: escrow, toPubkey: staker.publicKey, lamports: payout }),
		new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(settleMemo, 'utf8') }),
	);
	const settleSignature = await sendAndConfirm(conn, settleTx, [escrowKeypair], {
		commitment: 'confirmed',
		timeoutMs: CONFIRM_TIMEOUT_MS,
	});
	step('withdraw', true, `signature=${settleSignature} payout=${payout} lamports`);

	// Re-read the settlement from the chain: the staker received exactly the
	// payout, the memo validates as threews.unstake.v1, and it names this stake.
	const settledTx = await conn.getTransaction(settleSignature, {
		commitment: 'confirmed',
		maxSupportedTransactionVersion: 0,
	});
	const received = lamportsReceivedBy(settledTx, staker.publicKey.toBase58());
	const payer = feePayerOf(settledTx);
	const memoBack = extractMemoPayload(settledTx);
	const chainOk =
		received === payout &&
		payer === escrow.toBase58() &&
		memoBack &&
		validatePayload(memoBack) &&
		memoBack.kind === UNSTAKE_KIND &&
		memoBack.stake === stakeSignature &&
		memoBack.principal === STAKE_LAMPORTS.toString() &&
		memoBack.earnings === earnings.toString();
	step(
		'settlement-on-chain',
		Boolean(chainOk),
		`staker received ${received} lamports; memo validates and names stake ${stakeSignature.slice(0, 12)}…`,
	);

	const cfg = marketConfig(NETWORK, env);
	if (!cfg.escrow || cfg.escrow.toBase58() !== escrow.toBase58()) {
		step('config-echo', false, 'marketConfig did not resolve the escrow the proof used');
	}
	step('config-echo', true, 'marketConfig resolves the same escrow the proof settled from');

	console.log(
		JSON.stringify(
			{
				ok: true,
				network: NETWORK,
				escrowMode,
				escrow: escrow.toBase58(),
				agent: agentAsset.toBase58(),
				staker: staker.publicKey.toBase58(),
				stake: {
					signature: stakeSignature,
					principalLamports: STAKE_LAMPORTS.toString(),
					explorer: `https://explorer.solana.com/tx/${stakeSignature}?cluster=devnet`,
				},
				settlement: {
					signature: settleSignature,
					earningsLamports: earnings.toString(),
					payoutLamports: payout.toString(),
					explorer: `https://explorer.solana.com/tx/${settleSignature}?cluster=devnet`,
				},
				epoch,
				agentWeight,
				stakeSol: formatSol(STAKE_LAMPORTS),
				earningsSol: formatSol(earnings),
				steps: results.map((r) => r.step),
			},
			null,
			2,
		),
	);
};

main().catch((err) => {
	console.error(`FAIL  ${err.message}`);
	process.exit(1);
});
