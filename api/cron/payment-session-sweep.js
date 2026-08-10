// GET/POST /api/cron/payment-session-sweep - expire stale sessions and refund budgets.
//
// Runs on a schedule (every 5 minutes). Finds payment sessions whose expires_at
// has passed but are still 'active', marks them 'expired', and refunds any
// un-spent budget back to the creator's credit balance.
//
// Design:
//   - Claims up to BATCH_LIMIT sessions per tick; the next tick catches the rest.
//   - Refunds are idempotent (credit_ledger is keyed on the idempotency key) so
//     retries do not double-credit.
//   - All rows updated atomically per-session; a crash mid-batch leaves the
//     remaining sessions to be picked up on the next tick.
//
// Auth: the shared, fail-closed cron gate (api/_lib/cron-auth.js), same as every
// other cron in /api/cron/.

import { sql } from '../_lib/db.js';
import { creditAccount } from '../_lib/credits.js';
import { atomicsToUsd } from '../_lib/pay/spend-governor.js';
import { cors, json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';

export const maxDuration = 30;

const BATCH_LIMIT = Number(process.env.PAYMENT_SESSION_SWEEP_BATCH) || 100;

export default wrapCron(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const t0 = Date.now();

	// Expire and refund the SAME bounded set. The batch limit lives inside the
	// UPDATE (via a CTE, because Postgres has no LIMIT on UPDATE) rather than in a
	// JS slice of the result. An unbounded UPDATE flips every due session to
	// 'expired' but only the sliced head is ever refunded, and the remainder is
	// then invisible to the next tick, which only looks at status = 'active': the
	// un-spent budget of every session past the limit would be silently kept.
	// Whatever this tick does not claim stays active and is swept next tick.
	//
	// FOR UPDATE SKIP LOCKED keeps concurrent ticks on disjoint rows; the refund
	// is idempotent on `paysess_expire_<id>`, so a retry never double-credits.
	const expiredRows = await sql`
		WITH due AS (
			SELECT id FROM payment_sessions
			WHERE status = 'active'
			  AND expires_at < now()
			ORDER BY expires_at ASC
			LIMIT ${BATCH_LIMIT}
			FOR UPDATE SKIP LOCKED
		)
		UPDATE payment_sessions s
		SET status = 'expired', updated_at = now()
		FROM due
		WHERE s.id = due.id
		RETURNING s.id, s.user_id, s.budget_usdc, s.spent_usdc
	`;

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
		} catch (err) {
			// A refund that failed here is not lost: the idempotency key means the
			// repair is a re-credit, but the session row is already 'expired' and no
			// longer selected. Log the id so an operator can replay it.
			refundErrors++;
			console.error('[payment-session-sweep] refund failed', { sessionId: row.id, error: err?.message || String(err) });
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
			? `Batch limit (${BATCH_LIMIT}) reached. More sessions may remain; the next tick continues.`
			: null,
	});
});
