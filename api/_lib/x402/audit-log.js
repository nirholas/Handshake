// x402 audit log — durable ledger of every payment event.
//
// Three exports:
//   logPaymentEvent(event) — fire-and-forget INSERT. Never blocks, never throws.
//   getAuditLog({ route?, payer?, eventType?, since?, limit? }) — filtered query.
//   getPaymentStats({ since?, groupBy? }) — aggregate stats for dashboards.
//
// Schema: api/_lib/migrations/2026-05-27-x402-audit-log.sql
//
// Design rules:
//   1. logPaymentEvent is fire-and-forget via queueMicrotask. A DB hiccup must
//      NEVER cause a payment to fail or a response to delay.
//   2. Only on-chain identifiers enter the log (addresses, tx hashes, amounts).
//      IP and UA are captured for rate-limit forensics but never surfaced to
//      non-admin callers.
//   3. All queries use the covering indexes on (route, created_at),
//      (payer, created_at), and (event_type, created_at).

import { sql } from '../db.js';

/**
 * Fire-and-forget audit log write. Swallows all errors.
 *
 * @param {object} event
 * @param {string} event.eventType   — 'payment_settled' | 'payment_failed' | 'siwx_grant' | 'siwx_access' | 'bypass_granted'
 * @param {string} event.route       — e.g. '/api/x402/dance-tip'
 * @param {string|null} [event.resourceUrl]
 * @param {string|null} [event.payer]          — wallet address
 * @param {string|null} [event.network]        — CAIP-2 chain ID
 * @param {string|null} [event.amountAtomics]  — atomic USDC amount
 * @param {string|null} [event.asset]          — asset address/mint
 * @param {string|null} [event.txHash]         — on-chain transaction hash
 * @param {string|null} [event.settlementStatus] — 'success' | 'failed'
 * @param {object|null} [event.facilitatorResponse]
 * @param {number|null} [event.durationMs]     — ms from request start to settle
 * @param {string|null} [event.ipAddress]
 * @param {string|null} [event.userAgent]
 * @param {object|null} [event.metadata]       — small JSON blob
 */
export function logPaymentEvent(event) {
	queueMicrotask(async () => {
		try {
			await sql`
				INSERT INTO x402_audit_log
					(event_type, route, resource_url, payer, network, amount_atomics,
					 asset, tx_hash, settlement_status, facilitator_response,
					 duration_ms, ip_address, user_agent, metadata)
				VALUES
					(${event.eventType},
					 ${event.route},
					 ${event.resourceUrl ?? null},
					 ${event.payer ?? null},
					 ${event.network ?? null},
					 ${event.amountAtomics ?? null},
					 ${event.asset ?? null},
					 ${event.txHash ?? null},
					 ${event.settlementStatus ?? null},
					 ${event.facilitatorResponse ? JSON.stringify(event.facilitatorResponse) : null},
					 ${event.durationMs ?? null},
					 ${event.ipAddress ?? null},
					 ${event.userAgent ?? null},
					 ${event.metadata ? JSON.stringify(event.metadata) : null})
			`;
		} catch (err) {
			console.error('[x402-audit] insert failed', {
				eventType: event.eventType,
				route: event.route,
				error: err?.message,
			});
		}
	});
}

/**
 * Query the audit log with optional filters.
 *
 * @param {object} [filters]
 * @param {string} [filters.route]
 * @param {string} [filters.payer]
 * @param {string} [filters.eventType]
 * @param {string} [filters.network]
 * @param {string} [filters.since]   — ISO 8601 timestamp
 * @param {number} [filters.limit]   — max rows (default 100, max 1000)
 * @param {number} [filters.offset]  — pagination offset (default 0)
 * @returns {Promise<Array>}
 */
export async function getAuditLog({
	route,
	payer,
	eventType,
	network,
	since,
	limit = 100,
	offset = 0,
} = {}) {
	const effectiveLimit = Math.min(Math.max(1, Number(limit) || 100), 1000);
	const effectiveOffset = Math.max(0, Number(offset) || 0);

	const rows = await sql`
		SELECT
			id, event_type, route, resource_url, payer, network,
			amount_atomics, asset, tx_hash, settlement_status,
			duration_ms, metadata, created_at
		FROM x402_audit_log
		WHERE
			(${route ?? null}::text IS NULL OR route = ${route ?? null})
			AND (${payer ?? null}::text IS NULL OR payer = ${payer ?? null})
			AND (${eventType ?? null}::text IS NULL OR event_type = ${eventType ?? null})
			AND (${network ?? null}::text IS NULL OR network = ${network ?? null})
			AND (${since ?? null}::timestamptz IS NULL OR created_at >= ${since ?? null}::timestamptz)
		ORDER BY created_at DESC
		LIMIT ${effectiveLimit}
		OFFSET ${effectiveOffset}
	`;
	return rows;
}

/**
 * Aggregate payment statistics for the analytics dashboard.
 *
 * @param {object} [opts]
 * @param {string} [opts.since]    — ISO 8601 timestamp
 * @param {string} [opts.groupBy]  — 'route' | 'network' | 'day' (default: all)
 * @returns {Promise<object>}
 */
export async function getPaymentStats({ since, groupBy } = {}) {
	const sinceTs = since || null;

	// Overall totals
	const [totals] = await sql`
		SELECT
			count(*)::int AS total_payments,
			coalesce(sum(
				CASE WHEN amount_atomics IS NOT NULL AND amount_atomics ~ '^[0-9]+$'
				THEN amount_atomics::numeric ELSE 0 END
			), 0) AS total_volume_atomics,
			count(DISTINCT payer)::int AS unique_payers
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${sinceTs}::timestamptz IS NULL OR created_at >= ${sinceTs}::timestamptz)
	`;

	const totalVolume = totals.total_volume_atomics || 0;
	const totalPayments = totals.total_payments || 0;
	const uniquePayers = totals.unique_payers || 0;
	const avgPayment = totalPayments > 0
		? (Number(totalVolume) / totalPayments).toFixed(0)
		: '0';

	// By route
	const byRoute = await sql`
		SELECT
			route,
			count(*)::int AS count,
			coalesce(sum(
				CASE WHEN amount_atomics IS NOT NULL AND amount_atomics ~ '^[0-9]+$'
				THEN amount_atomics::numeric ELSE 0 END
			), 0)::text AS volume
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${sinceTs}::timestamptz IS NULL OR created_at >= ${sinceTs}::timestamptz)
		GROUP BY route
		ORDER BY count DESC
	`;

	// By network
	const byNetwork = await sql`
		SELECT
			network,
			count(*)::int AS count
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${sinceTs}::timestamptz IS NULL OR created_at >= ${sinceTs}::timestamptz)
		GROUP BY network
		ORDER BY count DESC
	`;

	// By day
	const byDay = await sql`
		SELECT
			to_char(created_at, 'YYYY-MM-DD') AS date,
			count(*)::int AS count,
			coalesce(sum(
				CASE WHEN amount_atomics IS NOT NULL AND amount_atomics ~ '^[0-9]+$'
				THEN amount_atomics::numeric ELSE 0 END
			), 0)::text AS volume
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${sinceTs}::timestamptz IS NULL OR created_at >= ${sinceTs}::timestamptz)
		GROUP BY to_char(created_at, 'YYYY-MM-DD')
		ORDER BY date DESC
	`;

	// SIWX stats
	const [siwxStats] = await sql`
		SELECT
			count(*) FILTER (WHERE event_type = 'siwx_grant')::int AS grants,
			count(*) FILTER (WHERE event_type = 'siwx_access')::int AS accesses
		FROM x402_audit_log
		WHERE event_type IN ('siwx_grant', 'siwx_access')
			AND (${sinceTs}::timestamptz IS NULL OR created_at >= ${sinceTs}::timestamptz)
	`;

	// Bypass stats
	const bypassRows = await sql`
		SELECT
			coalesce((metadata->>'reason')::text, 'unknown') AS reason,
			count(*)::int AS count
		FROM x402_audit_log
		WHERE event_type = 'bypass_granted'
			AND (${sinceTs}::timestamptz IS NULL OR created_at >= ${sinceTs}::timestamptz)
		GROUP BY coalesce((metadata->>'reason')::text, 'unknown')
	`;
	const bypassByReason = {};
	let bypassTotal = 0;
	for (const r of bypassRows) {
		bypassByReason[r.reason] = r.count;
		bypassTotal += r.count;
	}

	// Failed payments count
	const [failedStats] = await sql`
		SELECT count(*)::int AS total_failed
		FROM x402_audit_log
		WHERE event_type = 'payment_failed'
			AND (${sinceTs}::timestamptz IS NULL OR created_at >= ${sinceTs}::timestamptz)
	`;

	// Format volume to USDC (6 decimals)
	function atomicsToUsdc(atomics) {
		const n = Number(atomics || 0);
		return (n / 1e6).toFixed(6);
	}

	return {
		total_payments: totalPayments,
		total_volume_usdc: atomicsToUsdc(totalVolume),
		unique_payers: uniquePayers,
		avg_payment_usdc: atomicsToUsdc(avgPayment),
		total_failed: failedStats.total_failed || 0,
		by_route: byRoute.map((r) => ({
			route: r.route,
			count: r.count,
			volume: atomicsToUsdc(r.volume),
		})),
		by_network: byNetwork.map((r) => ({
			network: r.network,
			count: r.count,
		})),
		by_day: byDay.map((r) => ({
			date: r.date,
			count: r.count,
			volume: atomicsToUsdc(r.volume),
		})),
		siwx_stats: {
			grants: siwxStats?.grants || 0,
			accesses: siwxStats?.accesses || 0,
		},
		bypass_stats: {
			total: bypassTotal,
			by_reason: bypassByReason,
		},
	};
}

/**
 * Count recent payments — used by /api/healthz for the x402 health block.
 * @param {number} [withinMinutes=60]
 * @returns {Promise<number>}
 */
export async function countRecentPayments(withinMinutes = 60) {
	try {
		const [row] = await sql`
			SELECT count(*)::int AS n
			FROM x402_audit_log
			WHERE event_type = 'payment_settled'
				AND created_at >= NOW() - (${withinMinutes} || ' minutes')::interval
		`;
		return row?.n || 0;
	} catch {
		return -1;
	}
}
