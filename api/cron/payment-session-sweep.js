// GET /api/cron/payment-session-sweep — expire stale sessions and refund budgets.
//
// Runs on a schedule (recommended: every 5 minutes). Finds payment sessions whose
// expires_at has passed but are still 'active', marks them 'expired', and refunds
// any un-spent budget back to the creator's credit balance.
//
// Design:
//   • Processes up to BATCH_LIMIT sessions per tick — the next tick catches the rest.
//   • Refunds are idempotent (ON CONFLICT DO NOTHING on credit_ledger) so retries
//     don't double-credit.
//   • All rows updated atomically per-session; a crash mid-batch leaves the
//     remaining sessions to be picked up on the next tick.
//
// Auth: the shared, fail-closed cron gate (api/_lib/cron-auth.js), same as every
// other cron in /api/cron/.

import { sql } from '../_lib/db.js';
import { creditAccount } from '../_lib/credits.js';
import { atomicsToUsd } from '../_lib/pay/spend-governor.js';
import { cors, json, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';

export const maxDuration = 30;

const BATCH_LIMIT = Number(process.env.PAYMENT_SESSION_SWEEP_BATCH) || 100;

export default wrapCron(async (req, res) => {
	cors(req, res, { methods: 'GET,POST,OPTIONS' });
	if (req.method?.toUpperCase() === 'OPTIONS') return;
	if (!requireCron(req, res)) return;

	const t0 = Date.now();

	// UPDATE ... RETURNING all expired sessions atomically. The refund step
	// is idempotent (ON CONFLICT DO NOTHING in credit_ledger), so concurrent
	// ticks processing the same row are safe. We slice to BATCH_LIMIT in JS
	// to keep each tick bounded; the next tick handles any remainder.
	const allExpired = await sql`
		UPDATE payment_sessions
		SET status = 'expired', updated_at = now()
		WHERE status = 'active'
		  AND expires_at < now()
		RETURNING id, user_id, budget_usdc, spent_usdc
	`;
	const expiredRows = allExpired.slice(0, BATCH_LIMIT);

	let refunded = 0;
	let refundErrors = 0;

	// Refund un-spent budget for each expired session
	await Promise.all(expiredRows.map(async (row) => {
		const refundAtomics = BigInt(row.budget_usdc) - BigInt(row.spent_usdc);
		if (refundAtomics <= 0n) return;

		try {
			await creditAccount({
				userId: row.user_id,
				amountUsd: atomicsToUsd(refundAtomics),
				kind: 'refund',
				action: 'payment_session_expire',
				refType: 'payment_session',
				refId: row.id,
				idempotencyKey: `paysess_expire_${row.id}`,
			});
			refunded++;
		} catch {
			refundErrors++;
		}
	}));

	const durationMs = Date.now() - t0;
	return json(res, 200, {
		ok: true,
		expired: expiredRows.length,
		refunded,
		refund_errors: refundErrors,
		duration_ms: durationMs,
		note: expiredRows.length === BATCH_LIMIT
			? `Batch limit (${BATCH_LIMIT}) reached — more sessions may remain. Next tick will continue.`
			: null,
	});
});
