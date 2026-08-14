// Settlement sweep: resolve every quarantined money row against the chain.
//
// Stage tips and IRL pays are verified on-chain at write time (security review
// M4). When our RPC has not yet seen a transaction the handler keeps the row with
// verified_at null rather than discarding what may be a real payment: the row
// counts for nothing, notifies nobody, and appears on no leaderboard.
//
// This tick is what resolves those rows without the client having to come back:
//
//   match    → promote. The tip joins its show's total and leaderboard.
//   mismatch → discard. Nothing was paid, so nothing should persist; a stage tip
//              keeps a verify_error breadcrumb for one grace period before the
//              row is deleted, so a support question has something to read.
//   pending  → leave it. Retried next tick, until GRACE_MINUTES is up, after
//              which a settlement that has never appeared is treated as fiction.
//
// Idempotent and swarm-safe: promotion flips verified_at from null in a
// conditional UPDATE, so overlapping ticks cannot double-count a tip.
//
// Failure reporting: each lane is caught so one broken lane cannot strand the
// other, but a caught error must never be invisible. wrapCron only heartbeats
// ok:false and pages ops when a handler THROWS, so a lane error swallowed into
// the 200 body would leave this sweep silently dead: tips stop being promoted,
// every tick still answers 200, and nothing reads the body. A lane that errors
// therefore flips ok:false and pages ops (deduped per lane per hour).
//
// The tables both lanes read are created lazily by their write endpoints
// (show_tips/stages by api/stage/index.js, irl_interactions by the IRL pay
// path), so a deployment that has never hosted a show or taken an IRL pay is
// missing them legitimately. Those are probed with to_regclass and reported as
// absent rather than as an error, the same guard api/cron/irl-reap.js uses, so
// a fresh deployment never pages for a table nobody has needed yet.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { requireCron } from '../_lib/cron-auth.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { verifySettlement } from '../_lib/settlement-verify.js';
import { promoteTip } from '../stage/tip.js';
import { hostPayoutWallets } from '../_lib/stage-wallets.js';
import { agentPayoutWallets } from '../_lib/agent-payout-wallets.js';

export const maxDuration = 60;

// How long a settlement gets to show up before we call it fiction. Solana
// finality is seconds and Base is ~2s blocks plus a confirmation buffer, so an
// hour is generous for RPC lag, a reorg, or a provider outage.
const GRACE_MINUTES = 60;
// Bound the batch so a tick stays well inside maxDuration; the next one picks up
// the rest.
const BATCH = 40;

// Which of the lazily-created tables this sweep reads actually exist yet. One
// round trip, no error path: to_regclass returns null for an absent relation
// instead of raising, so this can run against a database that has never served
// a show or an IRL pay.
async function presentTables() {
	const [row] = await sql`
		SELECT
			to_regclass('public.show_tips')        AS show_tips,
			to_regclass('public.stages')           AS stages,
			to_regclass('public.irl_interactions') AS irl_interactions
	`;
	return {
		stageTips: Boolean(row?.show_tips && row?.stages),
		irlPays: Boolean(row?.irl_interactions),
	};
}

async function sweepStageTips() {
	const rows = await sql`
		SELECT t.id, t.show_id, t.stage_id, t.amount_atomic, t.currency_mint, t.settlement_sig,
		       t.network, t.created_at, s.agent_id
		FROM show_tips t
		JOIN stages s ON s.id = t.stage_id
		WHERE t.verified_at IS NULL
		ORDER BY t.created_at ASC
		LIMIT ${BATCH}
	`;
	let promoted = 0; let discarded = 0; let stillPending = 0;
	for (const row of rows) {
		const recipients = await hostPayoutWallets(row.agent_id);
		const proof = await verifySettlement({
			signature: row.settlement_sig,
			mint: row.currency_mint,
			amountAtomic: BigInt(row.amount_atomic),
			recipients,
			network: row.network,
		});
		if (proof.status === 'match') {
			if (await promoteTip({ tipId: row.id, showId: row.show_id, amount: Number(row.amount_atomic) })) promoted++;
			continue;
		}
		const expired = Date.now() - new Date(row.created_at).getTime() > GRACE_MINUTES * 60_000;
		if (proof.status === 'mismatch' || expired) {
			await sql`DELETE FROM show_tips WHERE id = ${row.id} AND verified_at IS NULL`;
			discarded++;
			console.warn('[settlement-verify] discarded an unprovable tip', {
				tipId: row.id, stageId: row.stage_id, reason: proof.reason || 'never appeared on-chain',
			});
			continue;
		}
		stillPending++;
	}
	return { scanned: rows.length, promoted, discarded, pending: stillPending };
}

async function sweepIrlPays() {
	const rows = await sql`
		SELECT id, agent_id, amount, currency_mint, payload, created_at
		FROM irl_interactions
		WHERE type = 'pay' AND verified_at IS NULL
		ORDER BY created_at ASC
		LIMIT ${BATCH}
	`;
	let promoted = 0; let discarded = 0; let stillPending = 0;
	for (const row of rows) {
		const recipients = await agentPayoutWallets(row.agent_id);
		const proof = await verifySettlement({
			signature: row.payload?.signature,
			mint: row.currency_mint,
			amountAtomic: Math.round(Number(row.amount) || 0),
			recipients,
			network: row.payload?.network,
			allowAnyRecipient: recipients.length === 0,
		});
		if (proof.status === 'match') {
			await sql`UPDATE irl_interactions SET verified_at = now() WHERE id = ${row.id} AND verified_at IS NULL`;
			promoted++;
			continue;
		}
		const expired = Date.now() - new Date(row.created_at).getTime() > GRACE_MINUTES * 60_000;
		if (proof.status === 'mismatch' || expired) {
			await sql`DELETE FROM irl_interactions WHERE id = ${row.id} AND verified_at IS NULL`;
			discarded++;
			continue;
		}
		stillPending++;
	}
	return { scanned: rows.length, promoted, discarded, pending: stillPending };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const t0 = Date.now();

	// A probe failure is a real database fault, not a missing table, so it is
	// left to throw into wrapCron (which classifies db-unavailable separately and
	// pages ops on anything else).
	const present = await presentTables();

	// One failing lane must not strand the other: both run, both report. A lane
	// whose tables do not exist yet reports skipped; a lane that genuinely errors
	// reports the error AND pages ops below.
	const [tips, pays] = await Promise.all([
		present.stageTips
			? sweepStageTips().catch((err) => ({ error: err?.message || String(err) }))
			: Promise.resolve({ skipped: 'table_absent' }),
		present.irlPays
			? sweepIrlPays().catch((err) => ({ error: err?.message || String(err) }))
			: Promise.resolve({ skipped: 'table_absent' }),
	]);

	// Surface a swallowed lane failure. Without this the sweep answers 200
	// forever while no tip is ever promoted again. Deduped per lane per hour by
	// sendOpsAlert's signature so a persistent fault pages once, not every tick.
	const broken = [['tips', tips], ['pays', pays]].filter(([, lane]) => lane?.error);
	for (const [lane, result] of broken) {
		console.error('[settlement-verify] lane failed', { lane, error: result.error });
		sendOpsAlert(
			'Settlement sweep lane failing',
			`The ${lane} lane of /api/cron/settlement-verify errored: ${result.error}. Settlements in that lane are not being resolved, so verified payments stay quarantined.`,
			{ signature: `settlement-verify:${lane}:${Math.floor(Date.now() / 3_600_000)}` },
		);
	}

	return json(res, 200, { ok: broken.length === 0, tips, pays, took_ms: Date.now() - t0 });
});
