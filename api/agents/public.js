/**
 * Public agent index — browsable directory of all public agents.
 *
 *   GET /api/agents/public
 *       ?q=<search>          full-text search on name + description
 *       &skill=<slug>        filter by skill slug
 *       &sort=newest|popular|name|live  (default: popular)
 *       &limit=24            max 48
 *       &before=<iso>        cursor (created_at <) for pagination  (newest|popular|name)
 *       &offset=<n>          offset pagination                     (live)
 *       &network=mainnet     only show on-chain agents on this network
 *
 * Returns { agents, count, has_more, generated_at }. Each agent has the
 * public-safe fields: id, name, description, skills, avatar_thumbnail_url,
 * home_url, is_registered, chat_count, created_at, onchain summary.
 *
 * The `live` sort powers the /agents-live "watch them work" wall: it ranks
 * agents by their MOST RECENT real on-chain/skill action (the same
 * `agent_actions` each card renders as a live terminal), so the wall leads with
 * agents that are genuinely doing something instead of a flood of freshly-created
 * placeholder agents. It also suppresses zero-signal placeholders — an agent left
 * on the onboarding default name with no activity, no chats and no on-chain
 * identity adds nothing to a live wall — and returns `last_action_at` /
 * `action_count` so the card can badge recency. First page (`offset=0`) also
 * carries `total` (the wall's addressable size) and `active_total` (agents with
 * any activity) for the header stats.
 *
 * Public, IP rate-limited, 30-second CDN cache.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { thumbnailUrl } from '../_lib/r2.js';

const SORTS = new Set(['newest', 'popular', 'name', 'live']);

// Onboarding / auto-generated default names. An agent still wearing one of these,
// with no activity, no chats and no on-chain identity, is a never-used placeholder
// — kept out of the live wall (it's still reachable via search and /agents).
const PLACEHOLDER_NAMES = ['My First Agent', 'Agent', 'Avatar', 'My Avatar', 'Untitled Agent', 'New Agent'];

function mapAgent(r) {
	const meta   = r.meta || {};
	const onchain = meta.onchain || null;
	const thumbPub = r.avatar_visibility === 'public' || r.avatar_visibility === 'unlisted';
	const thumbnail = r.avatar_thumbnail_key && thumbPub ? thumbnailUrl(r.avatar_thumbnail_key) : null;

	return {
		id:                r.id,
		name:              r.name,
		description:       r.description || null,
		skills:            r.skills || [],
		avatar_thumbnail:  thumbnail,
		home_url:          r.home_url || `/agent/${r.id}`,
		chat_count:        Number(r.chat_count) || 0,
		is_registered:     !!(onchain || meta.sol_mint_address || r.erc8004_agent_id || meta.erc8004_agent_id),
		onchain:           onchain ? { network: onchain.network, asset: onchain.sol_asset || null } : null,
		// On-chain ERC-8004 identity (public registry ids) so the agent-commerce
		// discovery tool can read each candidate's reputation without a second
		// round-trip. Falls back to the legacy meta field for older records.
		erc8004_agent_id:  r.erc8004_agent_id != null ? String(r.erc8004_agent_id) : (meta.erc8004_agent_id != null ? String(meta.erc8004_agent_id) : null),
		chain_id:          r.chain_id ?? null,
		created_at:        r.created_at,
		// Present only on the `live` sort — powers the card's recency badge.
		last_action_at:    r.last_action_at ?? null,
		action_count:      r.action_count != null ? Number(r.action_count) : undefined,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const q      = (p.get('q') || '').trim().slice(0, 100);
	const skill  = (p.get('skill') || '').trim().toLowerCase();
	const sort   = SORTS.has(p.get('sort')) ? p.get('sort') : 'popular';
	const limit  = Math.min(48, Math.max(1, Number(p.get('limit') || 24)));
	const before = p.get('before') || null;
	const offset = Math.max(0, Math.min(5000, Number(p.get('offset') || 0) | 0));
	const onchainOnly = p.get('onchain') === '1' || p.get('onchain') === 'true';

	// ── live sort: activity-first, placeholder-suppressed, offset-paginated ──────
	if (sort === 'live') {
		const rows = await sql`
			select
				i.id, i.name, i.description, i.skills, i.home_url,
				i.created_at, i.meta, i.erc8004_agent_id, i.chain_id,
				a.thumbnail_key  as avatar_thumbnail_key,
				a.visibility     as avatar_visibility,
				ac.last_action_at,
				coalesce(ac.action_count, 0) as action_count,
				coalesce(ch.chat_count, 0)   as chat_count
			from agent_identities i
			left join avatars a on a.id = i.avatar_id and a.deleted_at is null
			left join lateral (
				select max(created_at) as last_action_at, count(*)::int as action_count
				from agent_actions aa where aa.agent_id = i.id
			) ac on true
			left join lateral (
				select count(*)::int as chat_count
				from usage_events ue where ue.agent_id = i.id and ue.kind = 'llm'
			) ch on true
			where i.deleted_at is null
			  and i.is_public = true
			  and (${!q} or (
			        to_tsvector('english', coalesce(i.name,'') || ' ' || coalesce(i.description,''))
			        @@ plainto_tsquery('english', ${q})
			      ))
			  and (${!skill} or i.skills @> ${[skill]}::text[])
			  and (${!onchainOnly} or (
			        i.meta->'onchain' is not null
			        or i.meta->>'sol_mint_address' is not null
			      ))
			  and (
			        ac.last_action_at is not null
			        or ch.chat_count > 0
			        or i.erc8004_agent_id is not null
			        or i.meta->'onchain' is not null
			        or i.meta->>'sol_mint_address' is not null
			        or (
			              coalesce(i.name,'') <> ''
			              and not (i.name = any(${PLACEHOLDER_NAMES}))
			              and i.name not like 'Selfie avatar%'
			           )
			      )
			order by ac.last_action_at desc nulls last, i.created_at desc
			limit ${limit + 1} offset ${offset}
		`.catch(() => []);

		const hasMore = rows.length > limit;
		const agents  = rows.slice(0, limit).map(mapAgent);

		// First page only: cheap platform-pulse counts for the header stats. Kept off
		// the paginated hot path so scrolling never re-runs the aggregate.
		let total = null;
		let activeTotal = null;
		if (offset === 0) {
			const [t] = await sql`
				select
					count(*)::int as total,
					count(*) filter (where exists (
						select 1 from agent_actions aa where aa.agent_id = i.id
					))::int as active_total
				from agent_identities i
				where i.deleted_at is null and i.is_public = true
				  and (
				        exists (select 1 from agent_actions aa where aa.agent_id = i.id)
				        or exists (select 1 from usage_events ue where ue.agent_id = i.id and ue.kind = 'llm')
				        or i.erc8004_agent_id is not null
				        or i.meta->'onchain' is not null
				        or i.meta->>'sol_mint_address' is not null
				        or (
				              coalesce(i.name,'') <> ''
				              and not (i.name = any(${PLACEHOLDER_NAMES}))
				              and i.name not like 'Selfie avatar%'
				           )
				      )
			`.catch(() => [{}]);
			total = t?.total ?? null;
			activeTotal = t?.active_total ?? null;
		}

		return json(res, 200, {
			agents,
			count:        agents.length,
			has_more:     hasMore,
			next_offset:  hasMore ? offset + limit : null,
			total,
			active_total: activeTotal,
			generated_at: new Date().toISOString(),
		}, { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' });
	}

	// ── newest | popular | name: keyset pagination on created_at ─────────────────
	const rows = await sql`
		select
			i.id,
			i.name,
			i.description,
			i.skills,
			i.home_url,
			coalesce((
				select count(*)::int from usage_events ue
				where ue.agent_id = i.id and ue.kind = 'llm'
			), 0) as chat_count,
			i.created_at,
			i.meta,
			i.erc8004_agent_id,
			i.chain_id,
			a.thumbnail_key  as avatar_thumbnail_key,
			a.visibility     as avatar_visibility
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.deleted_at is null
		  and i.is_public = true
		  and (${!q} or (
		        to_tsvector('english', coalesce(i.name,'') || ' ' || coalesce(i.description,''))
		        @@ plainto_tsquery('english', ${q})
		      ))
		  and (${!skill} or i.skills @> ${[skill]}::text[])
		  and (${!before}::boolean or i.created_at < ${before}::timestamptz)
		  and (${!onchainOnly} or (
		        i.meta->'onchain' is not null
		        or i.meta->>'sol_mint_address' is not null
		      ))
		order by
			${sort === 'newest' ? sql`i.created_at desc` :
			  sort === 'name'   ? sql`i.name asc` :
			                      sql`chat_count desc nulls last, i.created_at desc`}
		limit ${limit + 1}
	`.catch(() => []);

	const hasMore = rows.length > limit;
	const agents  = rows.slice(0, limit).map(mapAgent);

	return json(res, 200, {
		agents,
		count:        agents.length,
		has_more:     hasMore,
		next_cursor:  hasMore ? agents[agents.length - 1].created_at : null,
		generated_at: new Date().toISOString(),
	}, { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' });
});
