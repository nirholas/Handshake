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

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { requireCron } from '../_lib/cron-auth.js';
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
	`.catch(() => []);
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
	// One failing lane must not strand the other: both run, both report.
	const [tips, pays] = await Promise.all([
		sweepStageTips().catch((err) => ({ error: err?.message || String(err) })),
		sweepIrlPays().catch((err) => ({ error: err?.message || String(err) })),
	]);
	return json(res, 200, { ok: true, tips, pays, took_ms: Date.now() - t0 });
});
