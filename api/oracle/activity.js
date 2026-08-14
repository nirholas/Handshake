/**
 * Oracle: global action activity feed.
 *
 *   GET /api/oracle/activity
 *       ?network=mainnet     default: mainnet
 *       &limit=50            max 100
 *       &mode=live|simulate  default: all
 *       &tier=prime|strong|lean|watch|avoid  default: all
 *       &outcome=win|loss|flat|open          default: all
 *       &agent_id=<uuid>     filter to one agent
 *       &before=<iso>        pagination cursor (acted_at <)
 *
 * Public, IP rate-limited, 15-second CDN cache. Returns actions from
 * oracle_watch_actions joined to agent_identities so the feed shows real
 * agent names and avatars: the "trading floor" view of all autonomous
 * agents acting on conviction in real time.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid, isoTimestamp } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const TIERS    = new Set(['prime', 'strong', 'lean', 'watch', 'avoid']);
const MODES    = new Set(['live', 'simulate']);
const OUTCOMES = new Set(['win', 'loss', 'flat', 'open']);
function shapeRow(r) {
	return {
		id: r.id,
		agent_id: r.agent_id,
		agent_name: r.agent_name || 'Agent',
		agent_image: r.agent_image || r.agent_avatar || null,
		network: r.network,
		mint: r.mint,
		symbol: r.symbol,
		conviction: r.conviction != null ? Number(r.conviction) : null,
		tier: r.tier,
		mode: r.mode,
		size_sol: r.size_sol != null ? Number(r.size_sol) : null,
		status: r.status,
		outcome: r.outcome || 'open',
		peak_multiple: r.peak_multiple != null ? Number(r.peak_multiple) : null,
		realized_pnl_sol: r.realized_pnl_sol != null ? Number(r.realized_pnl_sol) : null,
		entry_mc_usd: r.entry_mc_usd != null ? Number(r.entry_mc_usd) : null,
		reason: r.reason || null,
		tx_signature: r.tx_signature || null,
		acted_at: r.acted_at,
		settled_at: r.settled_at,
		// convenience links
		pump_url: `https://pump.fun/coin/${r.mint}`,
		agent_url: `/agents/${r.agent_id}`,
		tx_url: r.tx_signature ? `https://solscan.io/tx/${r.tx_signature}` : null,
	};
}

export default wrap(async (req, res) => {
	// `origins: '*'` like every other public oracle read (feed, batch, categories,
	// backtest): this is an unauthenticated, credential-free feed, and the default
	// allowlist would otherwise block the same third-party dashboards that can
	// already read /api/oracle/feed.
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network  = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const limit    = Math.max(1, Math.min(100, parseInt(params.get('limit'), 10) || 50));
	const mode     = MODES.has(params.get('mode'))       ? params.get('mode')     : null;
	const tier     = TIERS.has(params.get('tier'))       ? params.get('tier')     : null;
	const outcome  = OUTCOMES.has(params.get('outcome')) ? params.get('outcome')  : null;
	const agentId  = isUuid(params.get('agent_id') || '') ? params.get('agent_id') : null;
	// A malformed cursor is a client fault, so answer 400 rather than letting the
	// `::timestamptz` cast reject inside the query and surface as an opaque 500.
	const beforeRaw = params.get('before');
	const before    = beforeRaw ? isoTimestamp(beforeRaw) : null;
	if (beforeRaw && !before) {
		return error(res, 400, 'validation_error', 'before must be an ISO 8601 timestamp');
	}

	const rows = await sql`
		select
			a.id, a.agent_id, a.network, a.mint, a.symbol,
			a.conviction, a.tier, a.mode, a.size_sol, a.status,
			a.outcome, a.peak_multiple, a.realized_pnl_sol,
			a.entry_mc_usd, a.reason, a.tx_signature,
			a.acted_at, a.settled_at,
			ai.name        as agent_name,
			ai.avatar_url  as agent_avatar,
			ai.profile_image_url as agent_image
		from oracle_watch_actions a
		left join agent_identities ai on ai.id = a.agent_id and ai.deleted_at is null
		where a.network = ${network}
		  and (${mode}::text  is null or a.mode    = ${mode})
		  and (${tier}::text  is null or a.tier    = ${tier})
		  and (${outcome}::text is null
		       or (${outcome} = 'open'  and (a.outcome is null or a.outcome = 'open'))
		       or (${outcome} <> 'open' and a.outcome = ${outcome}))
		  and (${agentId}::uuid is null or a.agent_id = ${agentId}::uuid)
		  and (${before}::timestamptz is null or a.acted_at < ${before}::timestamptz)
		order by a.acted_at desc
		limit ${limit}
	`.catch((e) => {
		throw new Error(`activity query failed: ${e.message}`);
	});

	const items = rows.map(shapeRow);

	// Summary counts for the header KPIs. `.then(r => r[0])` already unwraps the
	// single aggregate row, so assign it directly. Array-destructuring a plain
	// row object (or the null/undefined the catch/empty-result yields) throws
	// "(intermediate value) is not iterable" and 500s the endpoint.
	const summary = await sql`
		select
			count(*)                                             as total,
			count(*) filter (where mode = 'live')               as live_count,
			count(*) filter (where outcome = 'win')             as wins,
			count(*) filter (where outcome = 'loss')            as losses,
			coalesce(sum(realized_pnl_sol) filter (where realized_pnl_sol is not null), 0) as total_pnl_sol,
			count(distinct agent_id)                            as agent_count
		from oracle_watch_actions
		where network = ${network}
		  and acted_at > now() - interval '7 days'
	`.then((r) => r[0]).catch(() => null);

	return json(res, 200, {
		network,
		items,
		next_before: items.length === limit ? items[items.length - 1]?.acted_at : null,
		summary: summary ? {
			total:       Number(summary.total)       || 0,
			live_count:  Number(summary.live_count)  || 0,
			wins:        Number(summary.wins)        || 0,
			losses:      Number(summary.losses)      || 0,
			total_pnl_sol: Number(summary.total_pnl_sol) || 0,
			agent_count: Number(summary.agent_count) || 0,
		} : null,
	}, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
