// GET /api/ops/payment-outcomes: the payment-outcome board.
//
// The fable-audit called out that the x402 griefing classes (verify-reject
// floods, settle failures, sponsor-fee starvation) only become visible after
// they halt the economy. This endpoint aggregates the durable payment ledger
// (x402_audit_log), the self-facilitator settle log, the outbound ring settle
// sensor, and the live ring wallet balances into one read-only JSON board:
//
//   inbound      : settle / verify-reject / replay-reject / unsettled-flush
//                  counts and rates over 1h / 3h / 24h windows, replay stage
//                  split, top failure reasons, settled volume.
//   ring_settle  : gatherX402SettleHealth(), the outbound settle-success-rate
//                  sensor (3h window, rail-fault allowlist).
//   sponsor      : fee-wallet SOL vs its floor plus measured burn (fee_lamports
//                  over a stated window) and the runway in days that implies,
//                  including the threshold the scheduled monitor alerts on.
//   stranded_custody : custodial wallets whose secret no longer decrypts, with
//                  the SOL behind them split platform vs customer. Capital the
//                  treasury cannot reclaim and customers cannot withdraw is a
//                  payment-outcome fact, and it was previously visible only to
//                  whoever ran a CLI audit by hand. Snapshot-cached for six
//                  hours (custody loss is a rotation event, not a live metric),
//                  so polling this board never turns into fleet-wide RPC load.
//
// The panels are read independently and a failed one does not blank the others.
// `ok` says whether all three rendered (never whether payments are healthy, which
// is a per-panel verdict); the ones that failed are named in `degraded` and the
// response is 207 Multi-Status, matching /api/ops/health.
//
// Auth: authorizeOps (admin session, or x-ops-secret / OPS_SECRET): the same
// gate as /api/ops/health, so ops tooling reuses one stored secret.
// Read-only; moves no funds; reads balances via RPC only.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { authorizeOps } from '../_lib/ops-auth.js';
import { gatherX402SettleHealth } from '../_lib/ops/x402-settle-health.js';
import { checkRingWallets } from '../_lib/x402/wallet-balance-monitor.js';
import { strandedCustodyPanel } from '../_lib/custodial-key-health.js';

export const maxDuration = 30;

const INBOUND_EVENTS = [
	'payment_settled',
	'payment_failed',
	'payment_verify_rejected',
	'payment_replay_rejected',
	'payment_unsettled_flush',
];

function rate(numerator, denominator) {
	if (!denominator) return null;
	return Math.round((numerator / denominator) * 1000) / 1000;
}

function windowStats(counts) {
	const settled = counts.payment_settled || 0;
	const settleFailed = counts.payment_failed || 0;
	const verifyRejected = counts.payment_verify_rejected || 0;
	const replayRejected = counts.payment_replay_rejected || 0;
	const unsettledFlush = counts.payment_unsettled_flush || 0;
	// Attempts that reached verify: replays are refused before verify, so they
	// are reported but excluded from both denominators.
	const verifyAttempts = settled + settleFailed + verifyRejected;
	const settleAttempts = settled + settleFailed;
	return {
		settled,
		settle_failed: settleFailed,
		verify_rejected: verifyRejected,
		replay_rejected: replayRejected,
		unsettled_flush: unsettledFlush,
		settle_success_rate: rate(settled, settleAttempts),
		verify_reject_rate: rate(verifyRejected, verifyAttempts),
	};
}

async function inboundBoard() {
	// One 24h index scan carries all three windows via FILTER.
	const rows = await sql`
		SELECT event_type,
		       count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int  AS h1,
		       count(*) FILTER (WHERE created_at >= now() - interval '3 hours')::int AS h3,
		       count(*)::int AS h24
		FROM x402_audit_log
		WHERE created_at >= now() - interval '24 hours'
		  AND event_type = ANY(${INBOUND_EVENTS})
		GROUP BY event_type
	`;
	const byWindow = { h1: {}, h3: {}, h24: {} };
	for (const r of rows) {
		byWindow.h1[r.event_type] = r.h1;
		byWindow.h3[r.event_type] = r.h3;
		byWindow.h24[r.event_type] = r.h24;
	}

	const [replayStages, reasons, [volume]] = await Promise.all([
		sql`
			SELECT coalesce(metadata->>'stage', 'unknown') AS stage, count(*)::int AS n
			FROM x402_audit_log
			WHERE created_at >= now() - interval '24 hours'
			  AND event_type = 'payment_replay_rejected'
			GROUP BY 1
		`,
		sql`
			SELECT coalesce(metadata->>'code', metadata->>'reason', 'unknown') AS reason,
			       event_type, count(*)::int AS n
			FROM x402_audit_log
			WHERE created_at >= now() - interval '24 hours'
			  AND event_type IN ('payment_failed', 'payment_verify_rejected')
			GROUP BY 1, 2
			ORDER BY n DESC
			LIMIT 12
		`,
		sql`
			SELECT coalesce(sum(
				CASE WHEN amount_atomics IS NOT NULL AND amount_atomics ~ '^[0-9]+$'
				THEN amount_atomics::numeric ELSE 0 END
			), 0) AS atomics
			FROM x402_audit_log
			WHERE created_at >= now() - interval '24 hours'
			  AND event_type = 'payment_settled'
		`,
	]);

	return {
		windows: {
			'1h': windowStats(byWindow.h1),
			'3h': windowStats(byWindow.h3),
			'24h': windowStats(byWindow.h24),
		},
		replay_stages_24h: Object.fromEntries(replayStages.map((r) => [r.stage, r.n])),
		top_failure_reasons_24h: reasons.map((r) => ({
			reason: r.reason,
			stage: r.event_type === 'payment_failed' ? 'settle' : 'verify',
			count: r.n,
		})),
		settled_volume_usd_24h: Number(volume?.atomics || 0) / 1e6,
	};
}

async function sponsorBoard() {
	// Balances AND runway via the ring monitor with alerting disabled: a dashboard
	// READ must never page anyone; the scheduled monitor owns alerting. The burn
	// and runway are computed there (api/_lib/x402/sponsor-runway.js) so the number
	// this board renders and the number the alert fires on are the same number,
	// measured the same way, over the same window.
	const ring = await checkRingWallets({ sendAlert: async () => {} });
	const sponsor = ring.wallets.find((w) => w.role === 'sponsor') || null;
	const runway = ring.sponsorRunway || null;

	return {
		configured: Boolean(sponsor?.address),
		address: sponsor?.address || null,
		// Every configured ring wallet against its OWN floor, not the sponsor alone.
		// "the wallets are dry" and "the sponsor is under the settle floor" are
		// different outages with opposite fixes and identical symptoms from outside
		// (the premise of the x402-economy-triage runbook), and a board that shows
		// only the sponsor cannot tell them apart: a starved payer reads as healthy.
		wallets: (ring.wallets || [])
			.filter((w) => w.configured)
			.map((w) => ({
				role: w.role,
				address: w.address,
				sol: w.sol ?? null,
				sol_floor: w.sol_floor ?? null,
				sol_low: Boolean(w.sol_low),
				usdc: w.usdc ?? null,
				usdc_floor: w.usdc_floor ?? null,
				usdc_low: Boolean(w.usdc_low),
			})),
		// Pre-rendered breach lines from the monitor, so the board's wording and the
		// alert's wording are the same string rather than two drifting phrasings.
		breaches: ring.breaches || [],
		sol: sponsor?.sol ?? null,
		// The ring's 1.5x watch floor (what `below_floor` compares against) and the
		// facilitator's hard floor (where settling actually stops) are different
		// numbers, and conflating them is how a "safe" reading precedes an outage.
		sol_floor: sponsor?.sol_floor ?? null,
		settle_floor_sol: runway?.floor_sol ?? null,
		below_floor: Boolean(sponsor?.sol_low),
		// Measured burn, never a remembered constant: fee_lamports over successful
		// settles in the stated window (ISSUES.md item 6 records the folklore number
		// being wrong by roughly 10x, so it is derived on every read).
		burn_window_days: runway?.burn_window_days ?? null,
		settles_in_window: runway?.settles_in_window ?? 0,
		burn_sol_per_day: runway?.burn_sol_per_day ?? null,
		runway_days: runway?.runway_days ?? null,
		runway_days_to_floor: runway?.runway_days_to_floor ?? null,
		runway_alert_days: runway?.alert_days ?? null,
		runway_status: runway?.status ?? 'unknown',
		runway_reason: runway?.reason ?? null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// Every request here runs a session lookup before the gate can answer, then
	// three aggregate queries and a live RPC balance read, so an unauthorized
	// flood is expensive. `authedReadIp` (300/5m), not the strict `authIp`
	// credential bucket: an ops board is polled, and draining the login budget of
	// the office IP that watches it is exactly the cross-contamination that bucket
	// was split out to end.
	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await authorizeOps(req);
	if (!auth.ok) return error(res, 401, 'unauthorized', 'ops secret or admin session required');

	// The panels are independent reads; one failing must not blank the others
	// (an RPC outage is exactly when the settle panels matter most).
	const [inbound, ringSettle, sponsor, stranded] = await Promise.allSettled([
		inboundBoard(),
		gatherX402SettleHealth(),
		sponsorBoard(),
		strandedCustodyPanel(),
	]);
	const unwrap = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message || 'unavailable' });

	const panels = {
		inbound: unwrap(inbound),
		ring_settle: unwrap(ringSettle),
		sponsor: unwrap(sponsor),
		stranded_custody: unwrap(stranded),
	};
	// `ok` reports whether the BOARD rendered, not whether payments are healthy
	// (that verdict is per panel). It used to be the literal `true`, so a read
	// where every panel threw still answered 200 ok:true with a body full of
	// error objects: a monitoring surface that reports success while it is
	// blind. A failed panel now names itself in `degraded` and the response is
	// 207 Multi-Status, the same convention /api/ops/health uses.
	const degraded = Object.keys(panels).filter((k) => panels[k]?.error);

	return json(res, degraded.length ? 207 : 200, {
		ok: degraded.length === 0,
		degraded,
		generated_at: new Date().toISOString(),
		...panels,
	}, { 'cache-control': 'no-store' });
});
