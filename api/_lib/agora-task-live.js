// Agora — the live multi-worker task view (Task 09). Pure assembly of a real
// Arena (Competitive) or Guild (Collaborative) task's live state from three real
// sources, so it can be unit-tested without a DB or an RPC:
//
//   • posting      — the projected posted_task row (who opened it, the prize, the
//                    type + slot count). From agora_activity.
//   • activityRows — every agora_activity row for the task PDA joined to its
//                    citizen (claim / complete / stood_down / earned per worker).
//   • chain        — the on-chain lifecycle summary (getAgenCTaskLifecycle):
//                    authoritative fill (currentWorkers/maxWorkers), state,
//                    deadline, reward, and the real tx timeline.
//
// Every field traces to one of those — a roster entry's state comes from the real
// claim/complete rows it cites, the winner is whoever's proof the chain accepted,
// and a Guild share is the escrow-measured figure the engine projected. Nothing is
// fabricated: no roster entry, no winner, no split is invented here.

// Per-worker state, highest precedence first (leaderboard order). A worker that
// completed with the `won` outcome is the Arena winner; `contributed` is a Guild
// part landed; a bare claim is still `working`; a `stood_down` racer `lost` and
// sinks to the bottom — it's out of the race even though it did the work.
export const WORKER_STATES = ['won', 'contributed', 'completed', 'working', 'engaged', 'lost'];

/** Reduce one citizen's rows for a task into their live state. */
export function deriveWorkerState(rows) {
	const kinds = new Set((rows || []).map((r) => r.kind));
	const completed = (rows || []).find((r) => r.kind === 'completed_task');
	if (completed) {
		const outcome = completed.meta?.outcome;
		if (outcome === 'won') return 'won';
		if (outcome === 'contributed') return 'contributed';
		return 'completed';
	}
	if (kinds.has('stood_down')) return 'lost';
	if (kinds.has('claimed_task')) return 'working';
	return 'engaged';
}

function metaOf(row) {
	const m = row?.meta;
	if (!m) return {};
	if (typeof m === 'string') {
		try {
			return JSON.parse(m);
		} catch {
			return {};
		}
	}
	return m;
}

// Normalize a raw activity row into a plain object with a parsed meta. Accepts
// snake_case (DB) or camelCase (test) column names.
function shapeRow(row) {
	return {
		kind: row.kind,
		citizenId: row.citizen_id ?? row.citizenId ?? null,
		displayName: row.display_name ?? row.displayName ?? null,
		profession: row.profession ?? null,
		avatarUrl: row.avatar_url ?? row.avatarUrl ?? null,
		txSignature: row.tx_signature ?? row.txSignature ?? null,
		proofHash: row.proof_hash ?? row.proofHash ?? null,
		deliverableUrl: row.deliverable_url ?? row.deliverableUrl ?? null,
		amountAtomic: row.amount_atomic != null ? String(row.amount_atomic) : row.amountAtomic != null ? String(row.amountAtomic) : null,
		rewardLabel: row.reward_label ?? row.rewardLabel ?? null,
		rewardMint: row.reward_mint ?? row.rewardMint ?? null,
		at: row.created_at ?? row.at ?? null,
		meta: metaOf(row),
	};
}

/**
 * Build the roster: one entry per citizen who engaged the task, with their live
 * state and the real txs behind it. Sorted by progress (winners/contributors →
 * workers → losers) then by claim time so the leaderboard reads top-down.
 */
export function buildRoster(activityRows, { settledArena = false } = {}) {
	const byCitizen = new Map();
	for (const raw of activityRows || []) {
		const row = shapeRow(raw);
		if (!row.citizenId) continue;
		if (!byCitizen.has(row.citizenId)) byCitizen.set(row.citizenId, []);
		byCitizen.get(row.citizenId).push(row);
	}

	const roster = [];
	for (const [citizenId, rows] of byCitizen) {
		const claim = rows.find((r) => r.kind === 'claimed_task') || null;
		const completion = rows.find((r) => r.kind === 'completed_task') || null;
		const stoodDown = rows.find((r) => r.kind === 'stood_down') || null;
		const earned = rows.find((r) => r.kind === 'earned') || null;
		// Only citizens who actually engaged (claimed / completed / stood down) — the
		// poster and passers-by never appear here.
		if (!claim && !completion && !stoodDown) continue;
		const any = claim || completion || stoodDown;
		let state = deriveWorkerState(rows);
		// Chain truth beats a missing projection. Once a Competitive task has settled
		// on-chain, the escrow is gone to the winner and no further proof can be
		// accepted, so a racer still marked `working` has objectively lost, whether or
		// not its engine survived long enough to project the `stood_down` row. Reading
		// it as still racing would show a state the chain has already ruled out.
		if (settledArena && state === 'working') state = 'lost';
		const shareAtomic = completion?.meta?.shareAtomic ?? earned?.amountAtomic ?? null;
		roster.push({
			citizenId,
			displayName: any.displayName,
			profession: any.profession,
			avatarUrl: any.avatarUrl,
			state,
			claimTx: claim?.txSignature ?? null,
			claimedAt: claim?.at ?? null,
			completeTx: completion?.txSignature ?? null,
			completedAt: completion?.at ?? null,
			proofHash: completion?.proofHash ?? null,
			deliverableUrl: completion?.deliverableUrl ?? null,
			shareAtomic: shareAtomic != null ? String(shareAtomic) : null,
			shareLabel: earned?.rewardLabel ?? null,
			won: state === 'won',
			lostTo: stoodDown?.meta?.winner ?? null,
		});
	}

	const rank = (s) => WORKER_STATES.indexOf(s);
	roster.sort((a, b) => {
		const ra = rank(a.state);
		const rb = rank(b.state);
		if (ra !== rb) return ra - rb;
		return String(a.claimedAt || '').localeCompare(String(b.claimedAt || ''));
	});
	return roster;
}

/**
 * Derive the settlement from the roster + chain state. Arena → the single winner
 * (first accepted proof) takes the whole prize; Guild → the contributors split it.
 * `settled` is the chain's word (a Completed state or a `settled` row present),
 * never a client guess.
 */
export function buildSettlement({ taskType, roster, chain, posting, hasSettledRow }) {
	const normalized = String(taskType || 'Exclusive');
	const state = chain?.currentState || chain?.state || null;
	const chainSettled = state === 'Completed' || state === 'Cancelled';
	const settled = !!hasSettledRow || chainSettled;
	const prizeLabel = posting?.rewardLabel ?? (chain?.rewardAmount != null ? String(chain.rewardAmount) : null);

	if (normalized === 'Competitive') {
		const winner = roster.find((r) => r.state === 'won') || null;
		const stoodDown = roster.filter((r) => r.state === 'lost');
		return {
			type: 'arena',
			settled,
			prizeLabel,
			winner: winner
				? { citizenId: winner.citizenId, displayName: winner.displayName, tx: winner.completeTx, rewardLabel: winner.shareLabel || prizeLabel }
				: null,
			stoodDownCount: stoodDown.length,
		};
	}
	if (normalized === 'Collaborative') {
		const contributors = roster
			.filter((r) => r.state === 'contributed' || r.state === 'completed')
			.map((r) => ({ citizenId: r.citizenId, displayName: r.displayName, tx: r.completeTx, shareAtomic: r.shareAtomic, shareLabel: r.shareLabel }));
		const missedTarget = settled && chain?.maxWorkers != null && contributors.length < Number(chain.maxWorkers);
		return {
			type: 'guild',
			settled,
			poolLabel: prizeLabel,
			contributors,
			contributorCount: contributors.length,
			// A Guild that settled with fewer contributors than slots (via expiry)
			// returned its unspent pool to the creator — surfaced honestly.
			expiredUnderTarget: !!missedTarget,
		};
	}
	return { type: 'exclusive', settled, prizeLabel };
}

/**
 * Assemble the full live task view. `chain` is the serialized lifecycle summary
 * (already state-labelled by the caller); `posting` is the shaped posted_task row.
 */
export function assembleTaskLive({ taskPda, cluster, posting, activityRows, chain }) {
	const taskType = posting?.taskType || chain?.taskType || 'Exclusive';
	const chainState = chain?.currentState || chain?.state || null;
	const settledArena = taskType === 'Competitive' && (chainState === 'Completed' || chainState === 'Cancelled');
	const roster = buildRoster(activityRows, { settledArena });
	const hasSettledRow = (activityRows || []).some((r) => r.kind === 'settled');
	const settlement = buildSettlement({ taskType, roster, chain, posting, hasSettledRow });
	// Fill from the chain when available (authoritative), else count real claims.
	const workersCurrent = chain?.currentWorkers != null
		? Number(chain.currentWorkers)
		: roster.filter((r) => r.state !== 'engaged').length;
	const workersMax = chain?.maxWorkers != null ? Number(chain.maxWorkers) : posting?.maxWorkers ?? 1;
	return {
		taskPda: taskPda ?? posting?.taskPda ?? null,
		cluster: cluster || posting?.cluster || 'devnet',
		taskType,
		posting: posting || null,
		chain: chain || null,
		roster,
		settlement,
		workersCurrent,
		workersMax,
		empty: roster.length === 0 && !posting,
	};
}
