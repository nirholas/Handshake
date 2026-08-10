// GET /api/club/leaderboard?window=hour|day|week|all
//
// Ranks dancers by total USDC atomics tipped within the requested window.
// Returns one row per dancer in the club_dancer_wallets registry (even if
// they have zero tips) so the UI stays stable as new dancers get added.
//
// `window` is a strict whitelist, never user-injected SQL. Each entry in
// QUERIES is its own tagged template so the underlying Neon HTTP client
// parameterizes the interval literal safely.

import { sql, isDbUnavailableError, isDbCapacityError } from '../_lib/db.js';
import { cacheWrap } from '../_lib/cache.js';
import { cors, json, method, wrap, error, serverError } from '../_lib/http.js';

// Every open /club tab re-polls this on a 30s cadence and each window is a full
// aggregate over club_tips (hundreds of thousands of rows, ~1s on the week
// window), so the result is memoized. A room of viewers then costs one aggregate
// per window per interval instead of one per viewer, and the staleness stays far
// shorter than the poll cadence it feeds.
const CACHE_TTL_S = 15;

const QUERIES = {
	hour: () => sql`
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
	`,
	day: () => sql`
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
	`,
	week: () => sql`
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
	`,
	all: () => sql`
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
	`,
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const window = (req.query?.window || 'all').toString();
	const run = QUERIES[window];
	if (!run) {
		return error(res, 400, 'bad_window', 'window must be hour|day|week|all');
	}

	let rows;
	try {
		rows = await cacheWrap(`club:leaderboard:${window}`, CACHE_TTL_S, run);
	} catch (err) {
		// Surface the Postgres error code so schema drift is diagnosable from
		// logs alone: 42703 = column not found, 42P01 = undefined table.
		// `detail` carries the offending identifier when Neon provides it. A
		// database outage is skipped here: it is not schema drift, and one line per
		// poll per open tab is exactly the flood serverError() throttles for us.
		if (!isDbUnavailableError(err) && !isDbCapacityError(err)) {
			console.error(
				'[club/leaderboard]',
				'window=' + window,
				'code=' + (err?.code || 'none'),
				err?.detail || err?.message || err,
			);
		}
		// serverError rather than a hardcoded 500: it coerces an outage or a full
		// branch to 503 + Retry-After with a single deduped ops alert, so a Neon
		// blip degrades quietly instead of alerting once per polling tab.
		return serverError(res, 500, 'db_error', err);
	}

	return json(res, 200, { window, rows });
});
