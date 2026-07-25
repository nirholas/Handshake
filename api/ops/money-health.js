// GET /api/ops/money-health — ONE board for every money subsystem's health.
//
// Financial monitoring was fragmented across /admin/ring (ring-only), raw
// payment_reconciliation queries, and per-wallet balance logs — so "is the whole
// money system healthy right now?" had no single answer. This composes it: per
// subsystem, its open CRITICAL/WARN verdicts and last-activity, plus the leak-scan
// and tripwire state. Admin-authed, read-only, one aggregate query set (no N+1).

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { env } from '../_lib/env.js';

// Admin gate: CRON_SECRET bearer OR the admin token, matching api/admin/*.
function isAdmin(req) {
	const auth = req.headers['authorization'] || '';
	const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	const admin = process.env.ADMIN_TOKEN || env.ADMIN_TOKEN;
	const presented = bearer || req.headers['x-admin-token'] || '';
	if (secret && constantTimeEquals(presented, secret)) return true;
	if (admin && constantTimeEquals(presented, admin)) return true;
	return false;
}

// The verdict sources each money subsystem writes into payment_reconciliation.
const SUBSYSTEMS = [
	{ key: 'economy_master', label: 'Economy master (funding root)', sources: ['economy_master_chain', 'economy_master_onchain', 'economy_master_ledger'], activity: { table: 'economy_master_ledger', ts: 'ts' } },
	{ key: 'x402_ring', label: 'x402 ring economy', sources: ['ring_facilitator_settle', 'ring_ledger_sweep', 'ring_log_coherence', 'ring_fee_coherence', 'ring_tripwire', 'x402_ring_onchain'], activity: { table: 'x402_self_facilitator_log', ts: 'created_at' } },
	{ key: 'x402_revenue', label: 'x402 revenue', sources: ['autonomous_log', 'payment_intent'], activity: { table: 'x402_autonomous_log', ts: 'created_at' } },
	{ key: 'all_wallets', label: 'All controlled wallets (leak scan)', sources: ['wallets_onchain'], activity: null },
	{ key: 'tripwires', label: 'Enabled-but-silent tripwires', sources: ['financial_tripwire'], activity: null },
];

async function lastActivity(table, ts) {
	if (!table) return null;
	try {
		const rows = await sql(`SELECT extract(epoch from max(${ts})) * 1000 AS ms FROM ${table}`);
		return rows?.[0]?.ms != null ? Number(rows[0].ms) : null;
	} catch { return null; }
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	if (!isAdmin(req)) return error(res, 401, 'unauthorized', 'admin token required');

	// One grouped query for all open (unreconciled) verdicts by source + severity.
	let verdictRows = [];
	try {
		verdictRows = await sql`
			SELECT source,
			       count(*) FILTER (WHERE db_status IN ('onchain_leak','delegation_risk')
			                          OR chain_status ILIKE '%missing%' OR chain_status ILIKE '%mismatch%'
			                          OR chain_status ILIKE '%failed%') AS critical,
			       count(*) AS open_total,
			       max(checked_at) AS last_checked
			FROM payment_reconciliation
			WHERE reconciled = false
			GROUP BY source
		`;
	} catch (err) {
		if (!/relation .*payment_reconciliation.* does not exist/i.test(err?.message || '')) throw err;
	}
	const bySource = new Map(verdictRows.map((r) => [r.source, r]));

	const now = Date.now();
	const subsystems = [];
	for (const s of SUBSYSTEMS) {
		let critical = 0, open = 0, lastChecked = null;
		for (const src of s.sources) {
			const r = bySource.get(src);
			if (!r) continue;
			critical += Number(r.critical || 0);
			open += Number(r.open_total || 0);
			if (r.last_checked && (!lastChecked || r.last_checked > lastChecked)) lastChecked = r.last_checked;
		}
		const actMs = await lastActivity(s.activity?.table, s.activity?.ts);
		subsystems.push({
			key: s.key, label: s.label,
			open_critical: critical, open_warn: Math.max(0, open - critical),
			last_activity_at: actMs ? new Date(actMs).toISOString() : null,
			minutes_since_activity: actMs ? Math.round((now - actMs) / 60_000) : null,
			last_checked_at: lastChecked,
			status: critical > 0 ? 'critical' : open > 0 ? 'warn' : 'ok',
		});
	}

	const overall = subsystems.some((s) => s.status === 'critical') ? 'critical'
		: subsystems.some((s) => s.status === 'warn') ? 'warn' : 'ok';

	return json(res, 200, { ok: true, overall, subsystems, generated_at: new Date(now).toISOString() });
});
