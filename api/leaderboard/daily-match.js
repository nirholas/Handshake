// GET /api/leaderboard/daily-match: the agents' Daily Match board.
//
// Ranks public agents by REAL output shipped since 00:00 UTC today. Every
// column is a COUNT/SUM over an existing activity table: never a synthetic
// engagement number:
//   · actions: agent_actions rows today (on-chain/skill events, the same
//                 signal the /agents-live wall ranks by)
//   · launches: pump_agent_mints rows today (coins actually minted)
//   · trades: closed sniper positions (agent_sniper_positions) + pump
//                 trades on the agent's own coins (pump_agent_trades) today
//   · sales: skill_purchases confirmed today (someone paid this agent)
//   · pnl_lamports: realized sniper P&L today (signed; shown, not scored,
//                 so the board rewards shipping output, not luck)
//
// score = actions + 5·trades + 15·sales + 25·launches. Weights order the
// board by economic effort (a launch > a sale > a trade > a generic action);
// they are display ranking only: no payout hangs off this number. The board
// is computed live from the daily window (no rollup cron; the same pattern
// as /api/leaderboard/unified) and resets naturally at UTC midnight.
//
// Also returns yesterday's winner (same aggregate, previous UTC day) and a
// short live feed of today's most recent output for the ticker. The feed
// unions the SAME four sources the board scores (actions, launches, sniper
// and pump trades, confirmed skill sales), so a board with ranked agents can
// never sit next to an empty ticker: reading only agent_actions used to leave
// an agent that shipped a launch, a trade or a sale ranked but invisible.
//
// Format adopted from Bowyer's Arena (bowyer.app/arena): they run this daily
// output-match format on top of three.ws avatars; adopted here with credit.

import { cors, method, json, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

export const maxDuration = 10;

const PLACEHOLDER_NAMES = ['My First Agent', 'Agent', 'Avatar', 'My Avatar', 'Untitled Agent', 'New Agent'];

const WEIGHTS = { actions: 1, trades: 5, sales: 15, launches: 25 };

/**
 * One aggregated standings query for a UTC-day window. Everything joins
 * through agent_identities so only real, public, non-placeholder agents rank.
 */
async function standingsRows(dayOffset = 0, limit = 50) {
	return sql`
		with bounds as (
			select
				date_trunc('day', now() at time zone 'utc') - make_interval(days => ${dayOffset}) as day_start,
				date_trunc('day', now() at time zone 'utc') - make_interval(days => ${dayOffset - 1}) as day_end
		),
		actions as (
			select a.agent_id, count(*)::int as n
			from agent_actions a, bounds b
			where a.created_at >= b.day_start and a.created_at < b.day_end
			group by a.agent_id
		),
		launches as (
			select m.agent_id, count(*)::int as n
			from pump_agent_mints m, bounds b
			where m.created_at >= b.day_start and m.created_at < b.day_end
			group by m.agent_id
		),
		sniper as (
			select p.agent_id, count(*)::int as n,
			       coalesce(sum(p.realized_pnl_lamports), 0)::bigint as pnl
			from agent_sniper_positions p, bounds b
			where p.closed_at is not null
			  and p.closed_at >= b.day_start and p.closed_at < b.day_end
			group by p.agent_id
		),
		pump_trades as (
			select m.agent_id, count(*)::int as n
			from pump_agent_trades t
			join pump_agent_mints m on m.id = t.mint_id, bounds b
			where t.created_at >= b.day_start and t.created_at < b.day_end
			group by m.agent_id
		),
		sales as (
			select s.agent_id, count(*)::int as n
			from skill_purchases s, bounds b
			where s.status = 'confirmed'
			  and s.confirmed_at >= b.day_start and s.confirmed_at < b.day_end
			group by s.agent_id
		)
		select
			i.id as agent_id,
			i.name,
			i.avatar_url,
			i.profile_image_url,
			coalesce(a.n, 0) as actions,
			coalesce(l.n, 0) as launches,
			coalesce(sn.n, 0) + coalesce(pt.n, 0) as trades,
			coalesce(s.n, 0) as sales,
			coalesce(sn.pnl, 0) as pnl_lamports,
			(coalesce(a.n, 0) * ${WEIGHTS.actions}
				+ (coalesce(sn.n, 0) + coalesce(pt.n, 0)) * ${WEIGHTS.trades}
				+ coalesce(s.n, 0) * ${WEIGHTS.sales}
				+ coalesce(l.n, 0) * ${WEIGHTS.launches}) as score
		from agent_identities i
		left join actions a on a.agent_id = i.id
		left join launches l on l.agent_id = i.id
		left join sniper sn on sn.agent_id = i.id
		left join pump_trades pt on pt.agent_id = i.id
		left join sales s on s.agent_id = i.id
		where i.deleted_at is null
		  and i.is_public = true
		  and not (i.name = any(${PLACEHOLDER_NAMES}))
		  and (coalesce(a.n, 0) + coalesce(l.n, 0) + coalesce(sn.n, 0) + coalesce(pt.n, 0) + coalesce(s.n, 0)) > 0
		order by score desc, actions desc, i.id
		limit ${limit}
	`;
}

function mapRow(r, rank) {
	return {
		rank,
		agent_id: r.agent_id,
		name: r.name,
		avatar_url: r.profile_image_url || r.avatar_url || null,
		actions: Number(r.actions),
		launches: Number(r.launches),
		trades: Number(r.trades),
		sales: Number(r.sales),
		pnl_lamports: String(r.pnl_lamports),
		score: Number(r.score),
	};
}

export default wrap(async (req, res) => {
	// Public, anonymous, CDN-cached board (docs/api-reference.md): allow any
	// origin, matching its sibling /api/leaderboard/unified. Without this the
	// default policy sends no allow-origin header at all, so every cross-origin
	// fetch of the documented public endpoint fails its preflight.
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);

	const [today, yesterdayTop, recent] = await Promise.all([
		standingsRows(0, limit),
		standingsRows(1, 1),
		sql`
			with bounds as (
				select date_trunc('day', now() at time zone 'utc') as day_start
			),
			events as (
				select a.agent_id, a.type, a.source_skill, a.created_at
				from agent_actions a, bounds b
				where a.created_at >= b.day_start
				union all
				select m.agent_id, 'launch', m.symbol, m.created_at
				from pump_agent_mints m, bounds b
				where m.created_at >= b.day_start
				union all
				select p.agent_id, 'trade', p.symbol, p.closed_at
				from agent_sniper_positions p, bounds b
				where p.closed_at is not null and p.closed_at >= b.day_start
				union all
				select m.agent_id, t.direction, m.symbol, t.created_at
				from pump_agent_trades t
				join pump_agent_mints m on m.id = t.mint_id, bounds b
				where t.created_at >= b.day_start
				union all
				select s.agent_id, 'sale', s.skill, s.confirmed_at
				from skill_purchases s, bounds b
				where s.status = 'confirmed' and s.confirmed_at >= b.day_start
			)
			select e.type, e.source_skill, e.created_at, i.id as agent_id, i.name
			from events e
			join agent_identities i on i.id = e.agent_id
			where i.deleted_at is null and i.is_public = true
			  and not (i.name = any(${PLACEHOLDER_NAMES}))
			order by e.created_at desc
			limit 12
		`,
	]);

	const now = new Date();
	const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const dayEnd = new Date(dayStart.getTime() + 86_400_000);

	res.setHeader('cache-control', 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');
	return json(res, 200, {
		data: {
			day_start: dayStart.toISOString(),
			resets_at: dayEnd.toISOString(),
			weights: WEIGHTS,
			standings: today.map((r, i) => mapRow(r, i + 1)),
			yesterday_winner: yesterdayTop.length ? mapRow(yesterdayTop[0], 1) : null,
			recent: recent.map((r) => ({
				agent_id: r.agent_id,
				name: r.name,
				type: r.type,
				source_skill: r.source_skill || null,
				at: r.created_at,
			})),
		},
	});
});
