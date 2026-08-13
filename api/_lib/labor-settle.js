// Settlement for the Agent Labor Market (Moonshot 01) — where the $THREE actually
// moves. Shared by the POST /api/labor/settle endpoint and the autonomy driver so
// there is exactly ONE place that verifies a deliverable and releases escrow.
//
// Flow (idempotent by job settle_key — a retry never double-pays):
//   1. Claim the settle atomically (settle_key). A second caller no-ops.
//   2. A neutral verifier scores the deliverable against the spec.
//   3. On a PASS: release escrow on-chain — worker payout + skill-author royalty +
//      any unspent reward refunded to the poster — then record a real agent-
//      invocation receipt (worker invoked the poster's skill) and mark settled.
//   4. On a FAIL: refund the poster in full and mark the job failed (bad work
//      counts against the worker; an inability to perform is recorded as 'refunded'
//      so a network fault never tarnishes a worker's reputation).

import { sql } from './db.js';
import {
	settlementSplit, defaultRoyaltyBps, claimSettle, recordVerdict,
	markJobSettled, markJobFailed, setBountyStatus, atomicsToThree, _toBig as toBig,
} from './agent-labor.js';
import {
	verifyDeliverable, resolveSkillAuthorPayout, emitReasoning,
	autoBidForBounty, autoAwardIfReady, performJob,
} from './labor-match.js';
import { getBounty, getJobByBounty } from './agent-labor.js';
import { payFromEscrow, ensureEscrowGas } from './labor-escrow.js';
import { recoverSolanaAgentKeypair } from './agent-wallet.js';
import { recordInvocationReceipt } from './agent-invocation-onchain.js';
import { recordCustodyEvent } from './agent-trade-guards.js';

async function loadAgentWallet(agentId) {
	const [row] = await sql`
		SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	return row || null;
}

/**
 * Verify + settle a delivered job. Returns a result describing the on-chain
 * outcome. Safe to call more than once for the same job: only the first call that
 * wins the settle_key claim moves funds.
 *
 * @param {{ job: object, bounty: object, verdict?: object }} args
 */
export async function runSettlement({ job, bounty, verdict: providedVerdict = null }) {
	if (!job || !bounty) throw new Error('runSettlement: job and bounty required');

	const settleKey = `settle:${job.id}`;
	const claimed = await claimSettle(job.id, settleKey);
	if (!claimed) {
		// Already owned by a prior settle. Return the current terminal state.
		const [cur] = await sql`SELECT * FROM agent_jobs WHERE id = ${job.id}`;
		return { idempotent: true, status: cur?.status || job.status, job: cur || job };
	}

	// Both terminal paths below release SOL-paying transfers from escrow (payout or
	// refund). Top the escrow's gas buffer up first so a settlement never stalls on a
	// drained fee balance. Best-effort — never throws.
	await ensureEscrowGas().catch((e) => console.warn('[labor-settle] gas ensure failed', e?.message));

	// ── Verify ───────────────────────────────────────────────────────────────
	const verdict = providedVerdict || (await verifyDeliverable({ bounty, deliverable: claimed.deliverable }));
	await recordVerdict(job.id, verdict);

	const reward = toBig(bounty.reward_atomics);
	const awarded = toBig(job.price_atomics);

	// ── Failure path: refund poster (no release) ──────────────────────────────
	// A verifier rejection is the worker's fault → mark the job 'failed' (counts
	// against reputation). A moderator-administered refund is NOT the worker's
	// fault → mark it 'refunded' so a dispute resolution never tarnishes a worker.
	if (!verdict.pass) {
		const moderated = !!verdict.moderator;
		const failStatus = moderated ? 'refunded' : 'failed';
		let refundSig = null;
		let refundError = null;
		try {
			const poster = await loadAgentWallet(bounty.poster_agent_id);
			if (poster?.meta?.solana_address) {
				refundSig = await payFromEscrow({ toAddress: poster.meta.solana_address, amountAtomics: reward });
			}
		} catch (e) {
			refundError = e?.message || String(e);
			console.error('[labor-settle] refund failed', refundError);
		}
		const reason = moderated ? `moderator refund: ${verdict.reason}` : `verification failed: ${verdict.reason}`;
		await markJobFailed(job.id, { reason, refundSig, status: failStatus });
		await setBountyStatus(bounty.id, failStatus, { refundSig });
		emitReasoning({
			agentId: bounty.poster_agent_id, kind: moderated ? 'labor.moderator_refund' : 'labor.refund',
			summary: moderated ? `Moderator refunded "${bounty.title}"` : `Refunded "${bounty.title}" — work rejected`,
			detail: { bounty_id: bounty.id, job_id: job.id, verdict, refund_sig: refundSig, refund_error: refundError },
		});
		return { settled: false, status: failStatus, verdict, refund_sig: refundSig, refund_error: refundError };
	}

	// ── Pass path: resolve royalty + split ───────────────────────────────────
	const author = await resolveSkillAuthorPayout(bounty.required_skill, { excludeAgentId: job.worker_agent_id });
	const split = settlementSplit({
		rewardAtomics: reward, awardedAtomics: awarded,
		royaltyBps: defaultRoyaltyBps(), hasAuthor: !!author,
	});

	const worker = await loadAgentWallet(job.worker_agent_id);
	const poster = await loadAgentWallet(bounty.poster_agent_id);
	if (!worker?.meta?.solana_address) {
		// Cannot pay a worker with no wallet — refund and fail without penalizing the
		// worker's reputation (provisioning issue, not bad work).
		let refundSig = null;
		try {
			if (poster?.meta?.solana_address) refundSig = await payFromEscrow({ toAddress: poster.meta.solana_address, amountAtomics: reward });
		} catch (e) { console.error('[labor-settle] refund (no worker wallet) failed', e?.message); }
		await markJobFailed(job.id, { reason: 'worker has no wallet to receive payout', refundSig, status: 'refunded' });
		await setBountyStatus(bounty.id, 'refunded', { refundSig });
		return { settled: false, status: 'refunded', reason: 'worker_no_wallet', refund_sig: refundSig };
	}

	// ── Release escrow on-chain (worker payout is the critical leg) ───────────
	const settlementSig = await payFromEscrow({ toAddress: worker.meta.solana_address, amountAtomics: split.workerAtomics });

	// Royalty + poster refund are best-effort: a failure here leaves the residue in
	// escrow (sweepable) but must not undo the worker's confirmed payout.
	let royaltySig = null;
	if (author && split.royaltyAtomics > 0n) {
		try {
			royaltySig = await payFromEscrow({ toAddress: author.payoutAddress, amountAtomics: split.royaltyAtomics });
		} catch (e) { console.error('[labor-settle] royalty payout failed', e?.message); }
	}
	let posterRefundSig = null;
	if (split.posterRefundAtomics > 0n && poster?.meta?.solana_address) {
		try {
			posterRefundSig = await payFromEscrow({ toAddress: poster.meta.solana_address, amountAtomics: split.posterRefundAtomics });
		} catch (e) { console.error('[labor-settle] poster refund (auction surplus) failed', e?.message); }
	}

	// ── Record the real on-chain invocation receipt (non-fatal) ──────────────
	let invocationSig = null;
	let invocationError = null;
	try {
		if (!worker.meta?.encrypted_solana_secret) throw new Error('worker wallet not recoverable for receipt');
		if (!poster?.meta?.solana_address) throw new Error('poster has no Solana authority to record against');
		const invokerKeypair = await recoverSolanaAgentKeypair(worker.meta.encrypted_solana_secret, {
			agentId: job.worker_agent_id, userId: worker.user_id, reason: 'labor_invocation_receipt',
		});
		const receipt = await recordInvocationReceipt({
			invokerKeypair,
			targetAuthority: poster.meta.solana_address,
			skillName: bounty.required_skill || bounty.title,
			parameters: JSON.stringify({ bounty: bounty.id, job: job.id, three: atomicsToThree(split.workerAtomics) }).slice(0, 480),
		});
		invocationSig = receipt.signature;
	} catch (e) {
		invocationError = e?.message || String(e);
		console.error('[labor-settle] invocation receipt failed', invocationError);
	}

	await markJobSettled(job.id, {
		settlementSig, royaltySig, invocationSig,
		royaltyAtomics: split.royaltyAtomics, workerPayoutAtomics: split.workerAtomics,
		royaltyAuthorId: author?.authorAgentId || null,
		refundSig: posterRefundSig,
	});
	await setBountyStatus(bounty.id, 'settled');

	// Cross-wire: surface the worker's income in the custody ledger so it shows up
	// on the wallet HUD / live money pulse as real earnings.
	recordCustodyEvent({
		agentId: job.worker_agent_id, userId: null, eventType: 'tip', category: null,
		network: 'mainnet', asset: 'THREE', amountRaw: String(split.workerAtomics),
		signature: settlementSig, status: 'confirmed',
		meta: { source: 'labor_market', bounty_id: bounty.id, job_id: job.id, skill: bounty.required_skill || null },
	}).catch((e) => console.error('[labor-settle] worker income record failed', e?.message));

	emitReasoning({
		agentId: job.worker_agent_id, kind: 'labor.settle',
		summary: `Settled "${bounty.title}" — earned ${atomicsToThree(split.workerAtomics)} $THREE`,
		detail: {
			bounty_id: bounty.id, job_id: job.id, settlement_sig: settlementSig,
			worker_atomics: String(split.workerAtomics), royalty_atomics: String(split.royaltyAtomics),
			royalty_sig: royaltySig, invocation_sig: invocationSig,
		},
	});

	return {
		settled: true, status: 'settled', verdict,
		settlement_sig: settlementSig, royalty_sig: royaltySig,
		poster_refund_sig: posterRefundSig, invocation_sig: invocationSig, invocation_error: invocationError,
		worker_payout_atomics: String(split.workerAtomics),
		worker_payout_three: atomicsToThree(split.workerAtomics),
		royalty_atomics: String(split.royaltyAtomics),
		royalty_three: atomicsToThree(split.royaltyAtomics),
		explorer: settlementSig ? `https://solscan.io/tx/${settlementSig}` : null,
	};
}

/**
 * Drive a bounty as far as its participants' policies allow, autonomously: collect
 * auto-bids, auto-award if the poster opted in, then have an autonomous worker
 * perform the task and settle it on-chain. Each step is guarded — a failure in one
 * never throws out of the driver (the bounty just stops at a resumable state that
 * the manual endpoints or the /tick cron can pick up). Safe to call repeatedly.
 *
 * `settled` is the job's status after the attempt; `settledNow` is true only when
 * THIS call won the settle claim and released escrow. They differ when another
 * caller (a concurrent /settle, an earlier tick) already settled the job: the
 * status is 'settled' but no money moved here, so a counter that reports work
 * done must read `settledNow`.
 *
 * @returns {Promise<{ bids: number, awarded: boolean, settled: string|null, settledNow: boolean }>}
 */
export async function runAutopilot(bountyId) {
	const out = { bids: 0, awarded: false, settled: null, settledNow: false };
	try {
		let bounty = await getBounty(bountyId);
		if (!bounty) return out;

		if (bounty.status === 'open') {
			out.bids = await autoBidForBounty(bounty).catch((e) => {
				console.warn('[labor-autopilot] auto-bid failed', e?.message);
				return 0;
			});
			const awarded = await autoAwardIfReady(bountyId).catch((e) => {
				console.warn('[labor-autopilot] auto-award failed', e?.message);
				return null;
			});
			if (!awarded) return out;
			out.awarded = true;
			bounty = awarded.bounty || (await getBounty(bountyId));
		}

		// Drive an awarded job to delivery + settlement only when the worker is
		// autonomous (its policy enabled it to bid). A manual worker delivers via the
		// /deliver endpoint instead, so we never act on their behalf without consent.
		if (bounty?.status === 'working') {
			const job = await getJobByBounty(bountyId);
			if (!job) return out;
			const { isAutonomousWorker } = await import('./agent-labor.js')
				.then((m) => m.getLaborPolicy(job.worker_agent_id))
				.then((p) => ({ isAutonomousWorker: !!p?.worker_enabled }))
				.catch(() => ({ isAutonomousWorker: false }));
			if (!isAutonomousWorker) return out;

			let working = job;
			if (job.status === 'working') {
				const performed = await performJob({ job, bounty, workerUserId: job.worker_user_id }).catch((e) => {
					console.warn('[labor-autopilot] perform failed', e?.message);
					return null;
				});
				if (!performed) return out;
				working = performed.job;
			}
			if (working.status === 'delivered' || working.status === 'verifying') {
				const result = await runSettlement({ job: working, bounty }).catch((e) => {
					console.error('[labor-autopilot] settle failed', e?.message);
					return null;
				});
				out.settled = result?.status || null;
				out.settledNow = result?.status === 'settled' && result?.idempotent !== true;
			}
		}
	} catch (e) {
		console.error('[labor-autopilot] driver error', e?.message);
	}
	return out;
}
