// GET /api/monetization/revenue?agent_id=X&period=7d
//
// Returns aggregated revenue for the authenticated user's agents.
// Periods: 1d, 7d, 30d, 90d, all
// Response: { total_usdc, total_fees_usdc, net_usdc, event_count,
//             by_skill: [{skill, total, count}],
//             by_day: [{date, total}] }

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERIOD_TO_INTERVAL = {
	'1d': '1 day',
	'7d': '7 days',
	'30d': '30 days',
	'90d': '90 days',
	'all': null,
};

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'Sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const params = new URL(req.url, 'http://x').searchParams;

	const agentId = params.get('agent_id') || null;
	if (agentId && !UUID_RE.test(agentId)) {
		return error(res, 400, 'validation_error', 'agent_id must be a UUID');
	}

	// Verify agent ownership if agent_id is specified
	if (agentId) {
		const [agent] = await sql`
			SELECT id, user_id FROM agent_identities
			WHERE id = ${agentId} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 404, 'not_found', 'Agent not found');
		if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'You don\'t own this agent');
	}

	const period = params.get('period') || '7d';
	if (!PERIOD_TO_INTERVAL.hasOwnProperty(period)) {
		return error(res, 400, 'validation_error', 'period must be one of: 1d, 7d, 30d, 90d, all');
	}

	const interval = PERIOD_TO_INTERVAL[period];
	const now = new Date();
	const fromDate = interval
		? new Date(now.getTime() - parseIntervalMs(interval))
		: new Date('2020-01-01');
	const toDate = now;

	// Build queries with conditional agent filter
	const baseParams = [userId, fromDate, toDate];
	const agentFilter = agentId ? 'AND re.agent_id = $4::uuid' : '';
	const filterParams = agentId ? [...baseParams, agentId] : baseParams;

	// Summary aggregation
	const [summary] = await sql(
		`SELECT
			COALESCE(SUM(re.gross_amount), 0)::bigint AS gross_total,
			COALESCE(SUM(re.fee_amount), 0)::bigint   AS fee_total,
			COALESCE(SUM(re.net_amount), 0)::bigint   AS net_total,
			COUNT(*)::int                             AS event_count
		FROM agent_revenue_events re
		JOIN agent_identities ai ON ai.id = re.agent_id
		WHERE ai.user_id = $1
		  AND re.created_at BETWEEN $2 AND $3
		  ${agentFilter}`,
		filterParams,
	);

	// Per-skill breakdown
	const bySkill = await sql(
		`SELECT
			re.skill,
			COALESCE(SUM(re.net_amount), 0)::bigint AS net_total,
			COUNT(*)::int                           AS count
		FROM agent_revenue_events re
		JOIN agent_identities ai ON ai.id = re.agent_id
		WHERE ai.user_id = $1
		  AND re.created_at BETWEEN $2 AND $3
		  ${agentFilter}
		GROUP BY re.skill
		ORDER BY net_total DESC`,
		filterParams,
	);

	// Daily timeseries
	const byDay = await sql(
		`SELECT
			date_trunc('day', re.created_at) AS period,
			COALESCE(SUM(re.net_amount), 0)::bigint AS net_total,
			COUNT(*)::int                           AS count
		FROM agent_revenue_events re
		JOIN agent_identities ai ON ai.id = re.agent_id
		WHERE ai.user_id = $1
		  AND re.created_at BETWEEN $2 AND $3
		  ${agentFilter}
		GROUP BY period
		ORDER BY period`,
		filterParams,
	);

	return json(res, 200, {
		total_usdc: Number(summary.gross_total) / 1_000_000,
		total_fees_usdc: Number(summary.fee_total) / 1_000_000,
		net_usdc: Number(summary.net_total) / 1_000_000,
		event_count: summary.event_count,
		// Raw atomic values for precision-sensitive clients
		total_atomic: Number(summary.gross_total),
		fees_atomic: Number(summary.fee_total),
		net_atomic: Number(summary.net_total),
		by_skill: bySkill.map((r) => ({
			skill: r.skill,
			total: Number(r.net_total) / 1_000_000,
			total_atomic: Number(r.net_total),
			count: r.count,
		})),
		by_day: byDay.map((r) => ({
			date: r.period instanceof Date ? r.period.toISOString().slice(0, 10) : String(r.period).slice(0, 10),
			total: Number(r.net_total) / 1_000_000,
			total_atomic: Number(r.net_total),
			count: r.count,
		})),
	});
});

function parseIntervalMs(interval) {
	const m = /^(\d+)\s*(day|days|hour|hours)$/.exec(interval);
	if (!m) return 7 * 86400e3;
	const n = parseInt(m[1], 10);
	const unit = m[2].startsWith('hour') ? 3600e3 : 86400e3;
	return n * unit;
}
