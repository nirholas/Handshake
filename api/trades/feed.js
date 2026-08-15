/**
 * Public trade activity feed — notable closed positions from all agents.
 *
 *   GET /api/trades/feed?network=mainnet&window=24h&min_pnl_pct=20&limit=40&cursor=<iso>&mint=<base58>
 *
 * Returns the most recent closed positions where the agent turned a meaningful
 * profit — sorted newest-exit first. No auth required; this is the platform's
 * top-of-funnel virality surface.
 *
 * Each item carries:
 *   id, mint, symbol, name, image_uri
 *   agent_id, agent_name, agent_image           — trader identity
 *   entry_sol, exit_sol, realized_pnl_sol, realized_pnl_pct, multiple
 *   hold_seconds, exit_reason, buy_sig, sell_sig
 *   oracle_score, oracle_tier, oracle_category  — conviction context if scored
 *   copier_count                                — how many subscriptions fire on this agent
 *   closed_at
 *
 * `realized_pnl_sol`, `realized_pnl_pct`, and `multiple` are POSITION-level and
 * cumulative across every sell leg. `entry_sol` and `exit_sol` are the position's
 * remaining cost basis and its final leg's proceeds: on a position that took
 * initials first (workers/agent-sniper/executor.js rewrites the basis and books
 * only the closing leg's proceeds), those two do not reconstruct the return, so
 * `multiple` is derived from the cumulative pct rather than exit/entry.
 *
 * Public, IP rate-limited, 30-second CDN cache.
 */

import { cors, json, method, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isoTimestamp } from '../_lib/validate.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const WINDOWS  = new Set(['1h', '6h', '24h', '7d', '30d', 'all']);
const MINT_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const WINDOW_INTERVAL = {
	'1h':  '1 hour',
	'6h':  '6 hours',
	'24h': '24 hours',
	'7d':  '7 days',
	'30d': '30 days',
};

const LAMPORTS = 1e9;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p       = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';
	const window  = WINDOWS.has(p.get('window'))   ? p.get('window')  : '24h';
	const limit   = Math.min(80, Math.max(1, Number(p.get('limit')) || 40));

	// `Number(x) || 10` silently rewrote an explicit min_pnl_pct=0 to 10, since 0 is
	// falsy. The oracle coin drawer asks for 0 to show every trade on a coin, so it
	// only ever saw the winners above 10%. Parse the number first, then default.
	const pnlRaw  = p.get('min_pnl_pct');
	const pnlNum  = pnlRaw == null || pnlRaw.trim() === '' ? NaN : Number(pnlRaw);
	const minPnl  = Number.isFinite(pnlNum) ? Math.max(0, pnlNum) : 10;   // % profit threshold

	// A malformed cursor is a client fault: validate it here rather than letting the
	// `::timestamptz` cast reject inside the query and surface as an opaque 5xx.
	const cursorRaw = p.get('cursor');
	const cursor    = cursorRaw ? isoTimestamp(cursorRaw) : null;        // ISO timestamp for pagination
	if (cursorRaw && !cursor) {
		return error(res, 400, 'validation_error', 'cursor must be an ISO 8601 timestamp');
	}

	// Filter to one coin (oracle drawer). Silently dropping an unparseable mint would
	// answer a coin-scoped request with the whole platform feed, which reads as
	// "these are that coin's trades". Say it is invalid instead.
	const mintRaw = (p.get('mint') || '').trim();
	if (mintRaw && !MINT_RE.test(mintRaw)) {
		return error(res, 400, 'validation_error', 'mint must be a valid base58 mint address');
	}
	const mintFilter = mintRaw || null;

	const interval = WINDOW_INTERVAL[window] || null;

	// When filtering by mint, ignore the time window (show all trades on that coin)
	const windowCond = interval && !mintFilter
		? sql`and pos.closed_at > now() - ${interval}::interval`
		: sql``;

	const cursorCond = cursor
		? sql`and pos.closed_at < ${cursor}::timestamptz`
		: sql``;

	const mintCond = mintFilter ? sql`and pos.mint = ${mintFilter}` : sql``;

	const rows = await sql`
		select
			pos.id,
			pos.mint,
			pos.symbol,
			pos.name,
			pos.network,
			pos.status,
			pos.exit_reason,
			pos.realized_pnl_lamports,
			pos.realized_pnl_pct,
			pos.entry_quote_lamports,
			pos.exit_quote_lamports,
			pos.buy_sig,
			pos.sell_sig,
			pos.opened_at,
			pos.closed_at,
			extract(epoch from (pos.closed_at - pos.opened_at))::int as hold_seconds,

			-- agent identity
			ai.id     as agent_id,
			ai.name   as agent_name,
			ai.avatar_url          as agent_avatar,
			ai.profile_image_url   as agent_image,

			-- oracle conviction context (may be null if coin wasn't scored)
			oc.score          as oracle_score,
			oc.tier           as oracle_tier,
			oc.category       as oracle_category,
			oc.image_uri,

			-- copier count for this agent
			(
				select count(*)
				from copy_subscriptions cs
				where cs.leader_agent_id = pos.agent_id
				  and cs.network         = pos.network
				  and cs.status          = 'active'
			) as copier_count

		from agent_sniper_positions pos
		join agent_identities ai on ai.id = pos.agent_id and ai.deleted_at is null

		-- left join oracle conviction so coins that weren't scored still appear
		left join oracle_conviction oc
			on oc.mint    = pos.mint
			and oc.network = pos.network

		where pos.network = ${network}
		  and pos.status  = 'closed'
		  and pos.closed_at is not null
		  and pos.realized_pnl_pct >= ${minPnl}
		  ${windowCond}
		  ${cursorCond}
		  ${mintCond}

		-- id breaks ties so two exits sharing a closed_at can't reorder between
		-- pages; closed_at alone left the cursor walking a nondeterministic order.
		order by pos.closed_at desc, pos.id desc
		limit ${limit}
	`;

	const items = rows.map((r) => {
		const entrySol   = r.entry_quote_lamports != null ? Number(r.entry_quote_lamports) / LAMPORTS : null;
		const exitSol    = r.exit_quote_lamports  != null ? Number(r.exit_quote_lamports)  / LAMPORTS : null;
		const pnlSol     = r.realized_pnl_lamports != null ? Number(r.realized_pnl_lamports) / LAMPORTS : null;
		const pnlPct     = r.realized_pnl_pct != null ? Number(r.realized_pnl_pct) : null;
		// exit/entry describes only the final sell leg once a position took initials,
		// so it rendered "0.56× +88%" side by side on the feed. The cumulative pct is
		// the position's whole return, and 1 + pct/100 is that return as a multiple.
		const multiple   = pnlPct != null && Number.isFinite(pnlPct) ? 1 + pnlPct / 100 : null;

		return {
			id:              r.id,
			mint:            r.mint,
			symbol:          r.symbol || null,
			name:            r.name   || null,
			image_uri:       r.image_uri || null,
			network:         r.network,
			exit_reason:     r.exit_reason || null,

			agent_id:        r.agent_id,
			agent_name:      r.agent_name || null,
			agent_image:     r.agent_image || r.agent_avatar || null,
			copier_count:    Number(r.copier_count || 0),

			entry_sol:       entrySol,
			exit_sol:        exitSol,
			realized_pnl_sol:  pnlSol,
			realized_pnl_pct:  pnlPct,
			multiple:        multiple != null ? Math.round(multiple * 100) / 100 : null,
			hold_seconds:    r.hold_seconds || null,

			oracle_score:    r.oracle_score    != null ? Number(r.oracle_score)   : null,
			oracle_tier:     r.oracle_tier     || null,
			oracle_category: r.oracle_category || null,

			buy_sig:   r.buy_sig  || null,
			sell_sig:  r.sell_sig || null,
			opened_at: r.opened_at  ? new Date(r.opened_at).toISOString()  : null,
			closed_at: r.closed_at  ? new Date(r.closed_at).toISOString()  : null,
		};
	});

	const nextCursor = items.length === limit ? items[items.length - 1].closed_at : null;

	const cacheAge = mintFilter ? 60 : 30;
	return json(res, 200, {
		network,
		window: mintFilter ? 'all' : window,
		min_pnl_pct: minPnl,
		mint: mintFilter || null,
		count: items.length,
		items,
		next_cursor: nextCursor,
		generated_at: new Date().toISOString(),
	}, { 'Cache-Control': `public, max-age=${cacheAge}, stale-while-revalidate=120` });
});
