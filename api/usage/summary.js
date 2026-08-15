// GET /api/usage/summary: per-user usage numbers for the dashboard.
//
// Returns three blocks:
//   plan   the caller's plan quota row (limits, not consumption)
//   counts avatar count / stored bytes / MCP tool calls in 24h / events in 30d
//   llm    LLM calls, tokens, and a per-model breakdown for the current month
//
// The `llm` block powers the "LLM usage" panel in /dashboard/settings; the
// counts block powers the avatar-quota gate on /create.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';

// Distinct models a single account touches in a month is naturally small (the
// LLM chain has a fixed roster), but the table is caller-influenced, so the
// rendered breakdown is capped. Totals are still summed over every group.
const MAX_MODEL_ROWS = 25;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	let userId = null;
	const session = await getSessionUser(req);
	if (session) userId = session.id;
	else {
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer && hasScope(bearer.scope, 'profile')) userId = bearer.userId;
	}
	if (!userId) return error(res, 401, 'unauthorized', 'authentication required');

	const [quotaRows, modelRows] = await Promise.all([
		sql`
			select
				q.plan,
				q.max_avatars,
				q.max_bytes_per_avatar,
				q.max_total_bytes,
				q.mcp_calls_per_day,
				q.updated_at,
				(select count(*) from avatars where owner_id = ${userId} and deleted_at is null) as avatars,
				(select coalesce(sum(size_bytes),0) from avatars where owner_id = ${userId} and deleted_at is null) as bytes,
				(select count(*) from usage_events where user_id = ${userId} and created_at > now() - interval '24 hours' and kind = 'tool_call') as mcp_calls_24h,
				(select count(*) from usage_events where user_id = ${userId} and created_at > now() - interval '30 days') as events_30d
			from users u
			join plan_quotas q on q.plan = u.plan
			where u.id = ${userId}
		`,
		sql`
			select
				coalesce(model, 'unknown') as model,
				count(*) as calls,
				coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0) as tokens,
				coalesce(sum(coalesce(cost_micro_usd,0)),0) as cost_micro_usd
			from usage_events
			where user_id = ${userId}
			  and kind = 'llm'
			  and created_at >= date_trunc('month', now())
			group by 1
			order by calls desc, model asc
		`,
	]);

	const row = quotaRows[0];
	if (!row) return error(res, 500, 'internal', 'plan quota record missing for user');

	const byModel = modelRows.map((m) => ({
		model: m.model,
		calls: Number(m.calls),
		tokens: Number(m.tokens),
		cost_micro_usd: Number(m.cost_micro_usd),
	}));
	const sum = (key) => byModel.reduce((total, m) => total + m[key], 0);

	return json(res, 200, {
		plan: {
			plan: row.plan,
			max_avatars: Number(row.max_avatars),
			max_bytes_per_avatar: Number(row.max_bytes_per_avatar),
			max_total_bytes: Number(row.max_total_bytes),
			mcp_calls_per_day: Number(row.mcp_calls_per_day),
			updated_at: row.updated_at,
		},
		counts: {
			avatars: Number(row.avatars),
			bytes: Number(row.bytes),
			mcp_calls_24h: Number(row.mcp_calls_24h),
			events_30d: Number(row.events_30d),
		},
		llm: {
			calls_month: sum('calls'),
			tokens_month: sum('tokens'),
			cost_micro_usd_month: sum('cost_micro_usd'),
			by_model: byModel.slice(0, MAX_MODEL_ROWS),
		},
	});
});
