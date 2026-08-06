// GET/POST /api/cron/reconcile-decisions — resolve open ledger predictions
// against real on-chain outcomes, then anchor each agent's chain head.
//
// The Reasoning Ledger captures a snipe as a tamper-evident DECISION at entry
// time (workers/agent-sniper/executor.js → recordDecision). This cron closes the
// loop: when the linked position settles on-chain (agent_sniper_positions.status =
// 'closed', realized P&L proven by the sell signature), it writes the OUTCOME —
// was the call right, and by how much. Idempotent: a decision already reconciled
// is skipped, so re-runs over late/again data never double-count.
//
// After reconciling, it commits each agent's new chain head on-chain via an
// SPL-Memo anchor (best-effort), making the history independently verifiable at
// GET /api/ledger/verify/:agentId. Anomalies (a sudden hit-rate collapse) raise an
// ops alert.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { recordOutcome, computeReputation, getReputationRecords } from '../_lib/reasoning-ledger.js';
import { anchorLedgerHead, latestAnchoredAnchor } from '../_lib/ledger-anchor.js';
import { requireCron } from '../_lib/cron-auth.js';

const LAMPORTS_PER_SOL = 1e9;
const MAX_RECONCILE = 1000;   // decisions resolved per run
const MAX_ANCHOR_AGENTS = 25; // agents whose head is committed on-chain per run
const ANOMALY_MIN_SAMPLE = 10;
const ANOMALY_HIT_RATE = 0.25;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const report = { reconciled: 0, wins: 0, losses: 0, anchored: 0, anchor_pending: 0, anomalies: 0, errors: 0 };
	const touchedAgents = new Set();

	// 1. Reconcile snipe decisions whose position has settled on-chain.
	let pending = [];
	try {
		pending = await sql`
			select d.id as decision_id, d.agent_id,
			       p.realized_pnl_lamports, p.realized_pnl_pct, p.sell_sig, p.exit_reason, p.closed_at
			from agent_decisions d
			join agent_sniper_positions p on p.id = (d.inputs->>'position_id')::uuid
			left join decision_outcomes o on o.decision_id = d.id
			where d.kind = 'snipe' and o.decision_id is null and p.status = 'closed'
			order by p.closed_at asc
			limit ${MAX_RECONCILE}
		`;
	} catch (err) {
		report.errors++;
		report.reconcile_error = err.message;
	}

	for (const row of pending) {
		try {
			const pnlLamports = BigInt(row.realized_pnl_lamports ?? 0);
			const pnlSol = Number(pnlLamports) / LAMPORTS_PER_SOL;
			const wasCorrect = pnlLamports > 0n;
			const out = await recordOutcome({
				decisionId: row.decision_id,
				agentId: row.agent_id,
				observed: {
					pnl_sol: Number(pnlSol.toFixed(6)),
					pnl_pct: row.realized_pnl_pct != null ? Number(row.realized_pnl_pct) : null,
					sell_sig: row.sell_sig && row.sell_sig !== 'SIMULATED' ? row.sell_sig : null,
					exit_reason: row.exit_reason || null,
					closed_at: row.closed_at,
				},
				wasCorrect,
				pnlSol: Number(pnlSol.toFixed(6)),
				impact: Number(pnlSol.toFixed(6)),
			});
			if (out.reconciled) {
				report.reconciled++;
				report[wasCorrect ? 'wins' : 'losses']++;
				touchedAgents.add(row.agent_id);
			}
		} catch {
			report.errors++;
		}
	}

	// 2. Anchor each agent whose chain head moved past its last on-chain commitment.
	let heads = [];
	try {
		heads = await sql`
			select agent_id, max(seq) as head_seq, count(*)::bigint as cnt
			from agent_decisions group by agent_id
		`;
	} catch (err) {
		report.errors++;
		report.heads_error = err.message;
	}

	let anchoredCount = 0;
	for (const h of heads) {
		if (anchoredCount >= MAX_ANCHOR_AGENTS) break;
		try {
			const anchor = await latestAnchoredAnchor(h.agent_id);
			if (anchor && Number(anchor.through_seq) >= Number(h.head_seq)) continue; // already committed
			const [head] = await sql`
				select entry_hash, network from agent_decisions
				where agent_id = ${h.agent_id} and seq = ${Number(h.head_seq)} limit 1
			`;
			if (!head) continue;
			anchoredCount++;
			const r = await anchorLedgerHead({
				agentId: h.agent_id,
				network: head.network || 'mainnet',
				headHash: head.entry_hash,
				throughSeq: Number(h.head_seq),
				entryCount: Number(h.cnt),
			});
			if (r.status === 'anchored' || r.status === 'deduped') report.anchored++;
			else report.anchor_pending++;
		} catch {
			report.errors++;
		}
	}

	// 3. Anomaly watch: a verified track record that suddenly collapses is worth
	//    surfacing — it can mean a broken strategy or market regime change.
	for (const agentId of touchedAgents) {
		try {
			const records = await getReputationRecords(agentId);
			const rep = computeReputation(records);
			if (rep.sample_size >= ANOMALY_MIN_SAMPLE && rep.hit_rate < ANOMALY_HIT_RATE) {
				report.anomalies++;
				sendOpsAlert(
					'Reasoning ledger: hit-rate collapse',
					`Agent ${agentId} hit rate ${(rep.hit_rate * 100).toFixed(0)}% over ${rep.sample_size} reconciled calls (score ${rep.score}).`,
					{ signature: `ledger-anomaly:${agentId}` },
				);
			}
		} catch {
			report.errors++;
		}
	}

	return json(res, 200, { ok: true, ...report, t: Date.now() });
});
