// GET /api/club/leaderboard?window=hour|day|week|all
//
// Ranks dancers by total USDC atomics tipped within the requested window.
// Returns one row per dancer in the club_dancer_wallets registry (even if
// they have zero tips) so the UI stays stable as new dancers get added.
//
// `window` is a strict whitelist — never user-injected SQL. Each branch is a
// distinct tagged template so the underlying Neon HTTP client parameterizes
// the interval literal safely.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const window = (req.query?.window || 'all').toString();
	const rows = await runForWindow(window);
	if (rows === null) {
		return error(res, 400, 'bad_window', 'window must be hour|day|week|all');
	}

	return json(res, 200, { window, rows });
});

async function runForWindow(window) {
	switch (window) {
		case 'hour':
			return sql`
				select
					d.dancer,
					d.display_name,
					coalesce(sum(t.amount_atomics), 0)::text as total_atomics,
					count(t.*)::int as tip_count,
					coalesce(sum(case when t.paid_at is null then t.amount_atomics else 0 end), 0)::text as unpaid_atomics
				from club_dancer_wallets d
				left join club_tips t
					on t.dancer = d.dancer and t.created_at >= now() - interval '1 hour'
				group by d.dancer, d.display_name
				order by coalesce(sum(t.amount_atomics), 0) desc, d.dancer asc
			`;
		case 'day':
			return sql`
				select
					d.dancer,
					d.display_name,
					coalesce(sum(t.amount_atomics), 0)::text as total_atomics,
					count(t.*)::int as tip_count,
					coalesce(sum(case when t.paid_at is null then t.amount_atomics else 0 end), 0)::text as unpaid_atomics
				from club_dancer_wallets d
				left join club_tips t
					on t.dancer = d.dancer and t.created_at >= now() - interval '24 hours'
				group by d.dancer, d.display_name
				order by coalesce(sum(t.amount_atomics), 0) desc, d.dancer asc
			`;
		case 'week':
			return sql`
				select
					d.dancer,
					d.display_name,
					coalesce(sum(t.amount_atomics), 0)::text as total_atomics,
					count(t.*)::int as tip_count,
					coalesce(sum(case when t.paid_at is null then t.amount_atomics else 0 end), 0)::text as unpaid_atomics
				from club_dancer_wallets d
				left join club_tips t
					on t.dancer = d.dancer and t.created_at >= now() - interval '7 days'
				group by d.dancer, d.display_name
				order by coalesce(sum(t.amount_atomics), 0) desc, d.dancer asc
			`;
		case 'all':
			return sql`
				select
					d.dancer,
					d.display_name,
					coalesce(sum(t.amount_atomics), 0)::text as total_atomics,
					count(t.*)::int as tip_count,
					coalesce(sum(case when t.paid_at is null then t.amount_atomics else 0 end), 0)::text as unpaid_atomics
				from club_dancer_wallets d
				left join club_tips t on t.dancer = d.dancer
				group by d.dancer, d.display_name
				order by coalesce(sum(t.amount_atomics), 0) desc, d.dancer asc
			`;
		default:
			return null;
	}
}
