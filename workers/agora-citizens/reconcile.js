// agora-citizens — reconcile sweep (Task 03). The board renders a posted_task as
// OPEN until a terminal projection closes it. If a task is claimed by an external
// agent, cancelled by its creator, or lapses past its deadline, nothing in our
// own loop would notice — so this sweep RE-READS each open posting from the chain
// (the source of truth) and projects the matching transition. The board then
// never shows a stale "open" task.
//
// It also LINKS agent-to-agent hires: a `hired` row (the hirer's sub-task) and
// the `claimed_task`/`completed_task` row (the worker's) share the same on-chain
// task_pda, so we backfill the hired row's counterparty_citizen_id by that join —
// an honest link, both rows citing the same real task.
//
// Pure on-chain reads + idempotent projection writes. The worker owns its own
// Neon client (it runs outside api/), exactly like store.js.

import { neon } from '@neondatabase/serverless';
import { getTask, withRetry, cancelTask, TASK_STATE } from './agenc.js';
import { reconcileTransition, EXCLUSIVE_TERMINAL_KINDS, MULTI_TERMINAL_KINDS, isMultiWorkerType, isArenaType } from './policy.js';
import { reconcileNarrative, settledNarrative } from './narrative.js';
import { log } from './log.js';

// Lazy SDK import (mirrors agenc.js) so reconcile loads even before the TS SDK is
// built — only the live sweep needs the lifecycle reader.
let _sdk = null;
async function sdk() {
	if (_sdk) return _sdk;
	_sdk = await import('@three-ws/solana-agent');
	return _sdk;
}

// Open postings = posted_task / hired rows with no later terminal projection for
// the same PDA. Mirrors the board's open-lane query (api/agora/[action].js) so
// reconcile and the board agree on exactly what "open" means. The terminal set is
// PER TYPE: an Exclusive posting closes on its first claim; a multi-worker Arena /
// Guild stays live through its claims and per-contributor completions and closes
// only on a whole-task `settled` (or cancel / expire / slash). Both sets are bound
// as Postgres text[] and picked by the posting's meta.taskType so the two lanes
// (board + reconcile) stay in lockstep.
async function listOpenPostings(sql, cluster) {
	return sql`
		select a.id, a.citizen_id, a.task_pda, a.task_id, a.kind, a.profession, a.meta,
		       a.reward_label, a.created_at, c.display_name as poster, c.agenc_cluster
		from agora_activity a
		join agora_citizens c on c.id = a.citizen_id
		where a.kind in ('posted_task', 'hired')
		  and a.task_pda is not null
		  and coalesce(c.agenc_cluster, 'devnet') = ${cluster}
		  and a.created_at > now() - interval '14 days'
		  and not exists (
		      select 1 from agora_activity x
		      where x.task_pda = a.task_pda
		        and x.created_at >= a.created_at
		        and x.kind = any(
		          case when coalesce(a.meta->>'taskType', 'Exclusive') in ('Competitive', 'Collaborative')
		            then ${MULTI_TERMINAL_KINDS}::text[]
		            else ${EXCLUSIVE_TERMINAL_KINDS}::text[]
		          end
		        )
		  )
		order by a.created_at asc
		limit 500
	`;
}

// Expired postings whose escrow may still be locked: a posting we already projected
// as `expired_task` with no `cancelled_task` row citing the refund. A lapsed deadline
// does not move any money on its own, so without this the pool sits in escrow forever.
// Kept separate from listOpenPostings because that query deliberately excludes anything
// already closed, and this is precisely the closed-but-unpaid case.
async function listExpiredUnreclaimed(sql, cluster) {
	return sql`
		select a.id, a.citizen_id, a.task_pda, a.profession, a.meta,
		       a.reward_label, a.created_at, c.display_name as poster
		from agora_activity a
		join agora_citizens c on c.id = a.citizen_id
		where a.kind = 'posted_task'
		  and a.task_pda is not null
		  and coalesce(c.agenc_cluster, 'devnet') = ${cluster}
		  and a.created_at > now() - interval '14 days'
		  and exists (
		      select 1 from agora_activity e
		      where e.task_pda = a.task_pda and e.kind = 'expired_task'
		  )
		  and not exists (
		      select 1 from agora_activity x
		      where x.task_pda = a.task_pda and x.kind = 'cancelled_task'
		  )
		order by a.created_at asc
		limit 100
	`;
}

// Pull the terminal event's real tx signature (and actor) from the lifecycle so
// the projected transition cites the on-chain action that closed the task.
async function terminalTx(readClient, taskPda) {
	try {
		const s = await sdk();
		const { PublicKey } = await import('@solana/web3.js');
		const summary = await s.getAgenCTaskLifecycle(readClient, new PublicKey(taskPda));
		const tl = summary?.timeline || [];
		const last = tl.length ? tl[tl.length - 1] : null;
		return last?.txSignature || null;
	} catch {
		return null;
	}
}

/**
 * Reclaim an expired posting's escrow for its creator. A deadline passing does NOT
 * return the money on its own: the reward stays locked in the task's escrow until the
 * creator cancels, so an Arena nobody raced or a Guild that missed its worker target
 * would strand its pool on-chain forever. Needs the creator's own signer, so it only
 * runs for postings by a citizen this process is running. Returns the refund tx, or
 * null when we cannot sign for the creator or the cancel did not land (the projection
 * still records the expiry honestly, without claiming a refund that never happened).
 */
async function reclaimExpiredEscrow({ cfg, signerFor, readClient, row }) {
	if (typeof signerFor !== 'function') return null;
	const client = signerFor(row.citizen_id);
	if (!client) return null;
	try {
		const { PublicKey } = await import('@solana/web3.js');
		const result = await cancelTask(client, { taskPda: new PublicKey(row.task_pda) }, cfg);
		log.info('expired escrow reclaimed', { taskPda: row.task_pda, tx: result?.txSignature || null });
		return result?.txSignature || null;
	} catch (err) {
		// Same lost-response trap as a claim: the cancel can land while its RPC reply
		// goes missing. Re-read before calling it a failure, or the refund happens and
		// nothing records it (and the next sweep tries to cancel an already-cancelled
		// task forever). No signature to cite when the reply was lost, so say so.
		const settled = await isCancelledOnChain(cfg, readClient, row.task_pda);
		if (settled) {
			log.warn('expired escrow reclaimed, response lost', { taskPda: row.task_pda });
			return 'reclaimed-signature-unavailable';
		}
		log.warn('expired escrow reclaim failed', { taskPda: row.task_pda, err: err?.message });
		return null;
	}
}

/** Did this task end up cancelled (or closed) on-chain? Used to confirm a lost cancel. */
async function isCancelledOnChain(cfg, readClient, taskPda) {
	if (!readClient) return false;
	try {
		const task = await withRetry(() => getTask(readClient, taskPda), cfg, 'reclaim:confirm');
		if (task === null) return true; // account closed
		return task.state === TASK_STATE.Cancelled;
	} catch {
		return false;
	}
}

/**
 * Run one reconcile pass. Returns counts for the heartbeat/log.
 *
 * @param {object} args
 * @param {object} args.cfg         loaded config (cluster, databaseUrl, retry)
 * @param {object} args.store       projection sink (appendActivity, publishFeed)
 * @param {object} args.readClient  a read-only AgenC client (makeReadClient)
 * @param {function} [args.signerFor] citizenId → that citizen's signer-bound client,
 *                                    used to refund an expired posting's escrow.
 */
export async function reconcileOnce({ cfg, store, readClient, signerFor }) {
	if (!cfg.databaseUrl) {
		log.warn('reconcile skipped — no DATABASE_URL');
		return { checked: 0, closed: 0, linked: 0 };
	}
	const sql = neon(cfg.databaseUrl);

	let open;
	try {
		open = await listOpenPostings(sql, cfg.cluster);
	} catch (err) {
		log.error('reconcile list failed', { err: err?.message });
		return { checked: 0, closed: 0, linked: 0 };
	}

	let closed = 0;
	for (const row of open) {
		try {
			const taskType = row.meta?.taskType || 'Exclusive';
			const transition = await resolveTransition({ cfg, readClient, taskPda: row.task_pda, taskType });
			if (!transition) continue; // still open on-chain — leave it on the board

			// One terminal row per (task_pda, kind) — idempotent across sweeps even
			// when the chain gives us no tx to dedup on (e.g. a reclaimed account). For
			// a multi-worker task the engine's winning tick may already have projected
			// the `settled` row — this check finds it and skips, so there's one settle
			// per PDA regardless of who wrote it.
			const exists = await sql`
				select 1 from agora_activity
				where task_pda = ${row.task_pda} and kind = ${transition.kind}
				limit 1
			`;
			if (exists.length) continue;

			// An expired posting still holds its reward in escrow. Cancel it so the pool
			// goes back to the creator, and cite THAT refund as the transition's tx.
			const refundTx =
				transition.kind === 'expired_task' ? await reclaimExpiredEscrow({ cfg, signerFor, readClient, row }) : null;
			const txSignature = refundTx || (await terminalTx(readClient, row.task_pda));
			// A `settled` terminal narrates the whole Arena/Guild resolving; everything
			// else keeps the plain "poster's bounty <verb>" line.
			let narrative;
			if (transition.kind === 'settled') {
				const winner = isArenaType(taskType) ? await store.winnerNameForTask(row.task_pda).catch(() => null) : null;
				narrative = settledNarrative({ poster: row.poster, kind: isArenaType(taskType) ? 'arena' : 'guild', winner });
			} else {
				narrative = reconcileNarrative({ poster: row.poster, profession: row.profession || 'worker', verb: transition.verb });
			}

			await store.appendActivity({
				citizenId: row.citizen_id,
				kind: transition.kind,
				taskPda: row.task_pda,
				taskId: row.task_id,
				profession: row.profession,
				txSignature,
				narrative,
				meta: { reconciled: true, fromKind: row.kind, taskType },
			});
			closed++;
			log.loop('reconciled task', { taskPda: row.task_pda, to: transition.kind });
		} catch (err) {
			log.warn('reconcile row failed', { taskPda: row.task_pda, err: err?.message });
		}
	}

	// Second pass: return the money on anything already marked expired whose escrow was
	// never released. The first pass only reaches a posting at the moment it closes, so a
	// restart (or another projector winning the race to write `expired_task`) would leave
	// the pool locked for good. Driven by chain state and idempotent: once the cancel
	// lands the task is gone from chain and the `cancelled_task` row keeps us off it.
	const refunded = await refundStrandedEscrows({ cfg, sql, store, readClient, signerFor });

	const linked = await linkHires(sql);

	if (closed || linked || refunded) log.info('reconcile sweep', { checked: open.length, closed, refunded, linked });
	return { checked: open.length, closed, refunded, linked };
}

/**
 * Cancel every expired posting that still holds escrow, refunding its creator, and
 * project the on-chain cancel. Only postings by a citizen this process can sign for are
 * touched. Returns how many refunds landed.
 */
async function refundStrandedEscrows({ cfg, sql, store, readClient, signerFor }) {
	if (typeof signerFor !== 'function') return 0;
	let rows;
	try {
		rows = await listExpiredUnreclaimed(sql, cfg.cluster);
	} catch (err) {
		log.warn('expired-escrow list failed', { err: err?.message });
		return 0;
	}
	let refunded = 0;
	for (const row of rows) {
		if (!signerFor(row.citizen_id)) continue; // someone else's posting: not ours to cancel
		// Still on-chain and not already settled? Then the reward is genuinely stranded.
		let task;
		try {
			task = await withRetry(() => getTask(readClient, row.task_pda), cfg, 'refund:getTask');
		} catch {
			continue;
		}
		if (!task) continue; // account already closed: nothing left to reclaim
		const txSignature = await reclaimExpiredEscrow({ cfg, signerFor, readClient, row });
		if (!txSignature) continue;
		await store.appendActivity({
			citizenId: row.citizen_id,
			kind: 'cancelled_task',
			taskPda: row.task_pda,
			profession: row.profession,
			txSignature,
			narrative: `${row.poster}'s expired bounty returned its ${row.reward_label || 'reward'} to the treasury.`,
			meta: { reconciled: true, escrowRefund: true, taskType: row.meta?.taskType || 'Exclusive' },
		});
		refunded++;
	}
	return refunded;
}

// Decide the transition for one task by reading its on-chain state. A missing
// account (getTask → null) means the creator cancelled and the rent was reclaimed
// — that's a Cancelled transition, not a phantom open task.
async function resolveTransition({ cfg, readClient, taskPda, taskType }) {
	const task = await withRetry(() => getTask(readClient, taskPda), cfg, 'reconcile:getTask').catch(() => undefined);
	if (task === null) return reconcileTransition('cancelled', taskType);
	if (task === undefined) return null; // RPC failed after retries — try again next sweep, don't fabricate

	let label;
	try {
		const s = await sdk();
		label = s.formatTaskState(task.state); // "Open" | "In Progress" | "Completed" | …
	} catch {
		label = task.state; // number fallback if the SDK import fails
	}
	// A multi-worker task is still LIVE while it's Open OR mid-fill (In Progress /
	// Pending Validation) with slots or contributions left — the Arena is racing,
	// the Guild is filling. Only a whole-task Completed (→ `settled`), Cancelled, or
	// Disputed closes it; a per-contributor completion never does. So for a
	// multi-worker task we ignore the InProgress/PendingValidation → claimed_task
	// mapping (which is an Exclusive-only close) and keep it on the board.
	const transition = reconcileTransition(label, taskType);
	if (transition) {
		if (isMultiWorkerType(taskType) && transition.kind === 'claimed_task') {
			// mid-fill, not settled — fall through to the deadline check
		} else {
			return transition; // Completed→settled / Cancelled / Disputed → close it
		}
	}

	// Still live on-chain. AgenC has no on-chain "Expired" state — expiry is
	// deadline-driven — so a past-deadline task would linger on the board forever
	// (no worker will claim it; the board + engine both gate on deadline). Flip it
	// to Expired so it drops off the open board. Honest: completeTask itself rejects
	// a past-deadline task, so no real fulfillment can still happen — and for a
	// Guild that missed its worker target, expiry is exactly "reward returns".
	const deadline = Number(task.deadline || 0);
	if (deadline > 0 && deadline <= Math.floor(Date.now() / 1000)) {
		return reconcileTransition('expired', taskType);
	}
	return null; // genuinely live — leave it on the board
}

// Backfill the hirer↔worker link. A `hired` sub-task and the worker's
// claim/complete row share the on-chain task_pda; join on it to set the
// counterparty. Honest: both rows independently cite the same real task.
async function linkHires(sql) {
	try {
		const res = await sql`
			update agora_activity h
			set counterparty_citizen_id = w.citizen_id
			from agora_activity w
			where h.kind = 'hired'
			  and h.counterparty_citizen_id is null
			  and w.task_pda = h.task_pda
			  and w.kind in ('claimed_task', 'completed_task')
			  and w.citizen_id <> h.citizen_id
			returning h.id
		`;
		return res.length;
	} catch (err) {
		log.warn('hire link backfill failed', { err: err?.message });
		return 0;
	}
}
