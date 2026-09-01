// Agent Spotlight store: the community showcase's persistence + ranking.
//
// The invariant this module exists to hold: a showcase entry stores the PITCH
// and nothing else. Every fact about the agent itself (name, description,
// skills, avatar, on-chain identity, builder) is read live off
// agent_identities/avatars/users on each query, so an entry can never show a
// stale name or a deleted avatar. See the migration
// 20260901160000_agent_showcase.sql for the same reasoning at the schema level.

import { sql } from './db.js';
import { env } from './env.js';
import { publicUrlOrNull, thumbnailUrl } from './r2.js';

export const CATEGORIES = [
	{ slug: 'trading', label: 'Trading & markets' },
	{ slug: 'research', label: 'Research & intel' },
	{ slug: 'creative', label: 'Creative' },
	{ slug: 'productivity', label: 'Productivity' },
	{ slug: 'developer', label: 'Developer tools' },
	{ slug: 'social', label: 'Social' },
	{ slug: 'gaming', label: 'Gaming & worlds' },
	{ slug: 'commerce', label: 'Commerce & payments' },
	{ slug: 'education', label: 'Education' },
	{ slug: 'other', label: 'Everything else' },
];

const CATEGORY_SLUGS = new Set(CATEGORIES.map((c) => c.slug));

export const SORTS = new Set(['trending', 'new', 'top']);

export function isCategory(slug) {
	return CATEGORY_SLUGS.has(String(slug || '').toLowerCase());
}

// The showcase needs a database. Every read path checks this first so a
// deployment without one answers 503 with a reason instead of throwing.
export function showcaseConfigured() {
	return Boolean(env.DATABASE_URL);
}

/* ── ranking ──────────────────────────────────────────────────────────────── */

// Decay: score = (votes + 1) / (age_days + 1)^1.2.
//
// Two deliberate choices, both about the fact that this is a low-volume curated
// board and not a firehose.
//
// The +1 in the numerator is what makes it a showcase rather than a popularity
// contest: an entry published minutes ago with no votes yet still scores 1.0 and
// lands on the first page, so new work is seen at all instead of waiting behind
// whatever was already popular.
//
// The clock runs in DAYS, not hours. The hour-scaled decay every ranked feed
// copies from Hacker News assumes enough vote volume that a good post
// accumulates score faster than it loses it within a day; at this surface's
// volume the same curve puts a 24-hour-old entry at ~2% of a fresh one, which
// collapses "trending" into "newest" and buries genuinely popular work overnight.
// On this curve a week-old entry with twenty upvotes still outranks a brand-new
// one, and a month-old entry finally rotates off the front. That is the behaviour
// a showcase wants: durable good work near the top, always room for the newest.
export const GRAVITY = 1.2;

export function trendingScore({ voteCount = 0, createdAt, now = Date.now() } = {}) {
	const ms = now - new Date(createdAt).getTime();
	const ageDays = Number.isFinite(ms) ? Math.max(0, ms) / 86_400_000 : 0;
	return (Number(voteCount) + 1) / Math.pow(ageDays + 1, GRAVITY);
}

/* ── shaping ──────────────────────────────────────────────────────────────── */

// An avatar is renderable in a public page only when the avatar row itself is
// public or unlisted. A private avatar yields no thumbnail and no GLB, and the
// card falls back to its generated monogram rather than a broken image.
function avatarUrls(row) {
	const visible = row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted';
	if (!visible) return { thumbnail: null, glb: null };
	return {
		thumbnail: row.avatar_thumbnail_key ? thumbnailUrl(row.avatar_thumbnail_key) : null,
		glb: row.avatar_storage_key ? publicUrlOrNull(row.avatar_storage_key) : null,
	};
}

function builderOf(row) {
	const name = row.builder_display_name || row.builder_username || null;
	if (!name) return null;
	return {
		name,
		username: row.builder_username || null,
		profile_url: row.builder_username ? `/u/${row.builder_username}` : null,
	};
}

export function mapEntry(row, { now = Date.now() } = {}) {
	const meta = row.agent_meta || {};
	const onchain = meta.onchain || null;
	const { thumbnail, glb } = avatarUrls(row);
	const voteCount = Number(row.vote_count) || 0;

	return {
		id: row.id,
		title: row.title,
		tagline: row.tagline,
		story: row.story || null,
		demo_url: row.demo_url || null,
		category: row.category,
		tags: row.tags || [],
		source: row.source,
		featured: Boolean(row.featured_at),
		vote_count: voteCount,
		voted_by_me: Boolean(row.voted_by_me),
		trending_score: Number(trendingScore({ voteCount, createdAt: row.created_at, now }).toFixed(6)),
		view_count: Number(row.view_count) || 0,
		created_at: row.created_at,
		agent: {
			id: row.agent_id,
			name: row.agent_name,
			description: row.agent_description || null,
			skills: row.agent_skills || [],
			url: `/agents/${row.agent_id}`,
			profile_url: `/agents/${row.agent_id}/profile`,
			thumbnail,
			glb_url: glb,
			chat_count: Number(row.chat_count) || 0,
			action_count: Number(row.action_count) || 0,
			is_registered: Boolean(
				onchain || meta.sol_mint_address || row.erc8004_agent_id || meta.erc8004_agent_id,
			),
			onchain: onchain ? { network: onchain.network || null, asset: onchain.sol_asset || null } : null,
			created_at: row.agent_created_at,
		},
		builder: builderOf(row),
		editable_by_me: Boolean(row.editable_by_me),
	};
}

/* ── reads ────────────────────────────────────────────────────────────────── */

// One SELECT list, used by every read, so `list` and `get` can never disagree
// about which fields a card carries. Interpolated as a fragment via sql`` is not
// available here (the driver has no fragment type), so the shape lives in the
// two queries below and this comment is the contract they both honour.

export async function listEntries({
	sort = 'trending',
	category = null,
	tag = null,
	q = null,
	limit = 24,
	offset = 0,
	viewerId = null,
	featuredOnly = false,
} = {}) {
	const rows = await sql`
		select
			s.id, s.title, s.tagline, s.story, s.demo_url, s.category, s.tags,
			s.source, s.featured_at, s.view_count, s.created_at, s.submitted_by,
			i.id            as agent_id,
			i.name          as agent_name,
			i.description   as agent_description,
			i.skills        as agent_skills,
			i.meta          as agent_meta,
			i.erc8004_agent_id,
			i.created_at    as agent_created_at,
			a.thumbnail_key as avatar_thumbnail_key,
			a.storage_key   as avatar_storage_key,
			a.visibility    as avatar_visibility,
			u.display_name  as builder_display_name,
			u.username      as builder_username,
			coalesce(v.n, 0)  as vote_count,
			coalesce(ch.n, 0) as chat_count,
			coalesce(ac.n, 0) as action_count,
			${viewerId ? sql`(mv.user_id is not null)` : sql`false`} as voted_by_me,
			${viewerId ? sql`(s.submitted_by = ${viewerId} or i.user_id = ${viewerId})` : sql`false`} as editable_by_me
		from agent_showcase s
		join agent_identities i on i.id = s.agent_id and i.deleted_at is null and i.is_public = true
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		left join users   u on u.id = i.user_id    and u.deleted_at is null
		left join lateral (
			select count(*)::int n from agent_showcase_votes sv where sv.entry_id = s.id
		) v on true
		left join lateral (
			select count(*)::int n from usage_events ue where ue.agent_id = i.id and ue.kind = 'llm'
		) ch on true
		left join lateral (
			select count(*)::int n from agent_actions aa where aa.agent_id = i.id
		) ac on true
		${
			viewerId
				? sql`left join agent_showcase_votes mv on mv.entry_id = s.id and mv.user_id = ${viewerId}`
				: sql``
		}
		where s.deleted_at is null
		  and s.status = 'published'
		  and (${!featuredOnly} or s.featured_at is not null)
		  and (${!category} or s.category = ${category})
		  and (${!tag} or s.tags @> array[${tag ?? ''}]::text[])
		  and (${!q} or (
		        to_tsvector('english',
		          coalesce(s.title,'') || ' ' || coalesce(s.tagline,'') || ' ' ||
		          coalesce(s.story,'') || ' ' || coalesce(i.name,'') || ' ' ||
		          coalesce(i.description,'')
		        ) @@ plainto_tsquery('english', ${q ?? ''})
		        or s.title  ilike ${'%' + (q ?? '') + '%'}
		        or i.name   ilike ${'%' + (q ?? '') + '%'}
		      ))
		order by
			case when ${sort}::text = 'top'      then coalesce(v.n, 0) end desc nulls last,
			case when ${sort}::text = 'trending'
			     then (coalesce(v.n, 0) + 1)::numeric
			          / power(extract(epoch from (now() - s.created_at))::numeric / 86400.0 + 1, ${GRAVITY}::numeric)
			end desc nulls last,
			s.created_at desc
		limit ${limit} offset ${offset}
	`;
	const now = Date.now();
	return rows.map((r) => mapEntry(r, { now }));
}

export async function countEntries({ category = null, tag = null, q = null } = {}) {
	const [row] = await sql`
		select count(*)::int as n
		from agent_showcase s
		join agent_identities i on i.id = s.agent_id and i.deleted_at is null and i.is_public = true
		where s.deleted_at is null
		  and s.status = 'published'
		  and (${!category} or s.category = ${category})
		  and (${!tag} or s.tags @> array[${tag ?? ''}]::text[])
		  and (${!q} or (
		        to_tsvector('english',
		          coalesce(s.title,'') || ' ' || coalesce(s.tagline,'') || ' ' ||
		          coalesce(s.story,'') || ' ' || coalesce(i.name,'') || ' ' ||
		          coalesce(i.description,'')
		        ) @@ plainto_tsquery('english', ${q ?? ''})
		        or s.title ilike ${'%' + (q ?? '') + '%'}
		        or i.name  ilike ${'%' + (q ?? '') + '%'}
		      ))
	`;
	return row?.n ?? 0;
}

export async function getEntry(id, { viewerId = null } = {}) {
	const rows = await sql`
		select
			s.id, s.title, s.tagline, s.story, s.demo_url, s.category, s.tags,
			s.source, s.featured_at, s.view_count, s.created_at, s.submitted_by,
			i.id            as agent_id,
			i.name          as agent_name,
			i.description   as agent_description,
			i.skills        as agent_skills,
			i.meta          as agent_meta,
			i.erc8004_agent_id,
			i.created_at    as agent_created_at,
			a.thumbnail_key as avatar_thumbnail_key,
			a.storage_key   as avatar_storage_key,
			a.visibility    as avatar_visibility,
			u.display_name  as builder_display_name,
			u.username      as builder_username,
			coalesce(v.n, 0)  as vote_count,
			coalesce(ch.n, 0) as chat_count,
			coalesce(ac.n, 0) as action_count,
			${viewerId ? sql`(mv.user_id is not null)` : sql`false`} as voted_by_me,
			${viewerId ? sql`(s.submitted_by = ${viewerId} or i.user_id = ${viewerId})` : sql`false`} as editable_by_me
		from agent_showcase s
		join agent_identities i on i.id = s.agent_id and i.deleted_at is null and i.is_public = true
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		left join users   u on u.id = i.user_id    and u.deleted_at is null
		left join lateral (
			select count(*)::int n from agent_showcase_votes sv where sv.entry_id = s.id
		) v on true
		left join lateral (
			select count(*)::int n from usage_events ue where ue.agent_id = i.id and ue.kind = 'llm'
		) ch on true
		left join lateral (
			select count(*)::int n from agent_actions aa where aa.agent_id = i.id
		) ac on true
		${
			viewerId
				? sql`left join agent_showcase_votes mv on mv.entry_id = s.id and mv.user_id = ${viewerId}`
				: sql``
		}
		where s.id = ${id} and s.deleted_at is null and s.status = 'published'
		limit 1
	`;
	return rows[0] ? mapEntry(rows[0]) : null;
}

// Per-category counts for the filter rail. A category with nothing in it is
// still returned (at zero) so the rail's shape does not jump around as entries
// land, and so an empty category can render its own "be the first" state.
export async function categoryCounts() {
	const rows = await sql`
		select s.category, count(*)::int as n
		from agent_showcase s
		join agent_identities i on i.id = s.agent_id and i.deleted_at is null and i.is_public = true
		where s.deleted_at is null and s.status = 'published'
		group by s.category
	`;
	const counts = new Map(rows.map((r) => [r.category, r.n]));
	return CATEGORIES.map((c) => ({ ...c, count: counts.get(c.slug) || 0 }));
}

// Headline numbers for the hero. Three separate aggregates in one round trip:
// how much work is on the wall, how many people voted it up, and how many
// distinct builders are represented; the last one is the number that says
// "community" rather than "one person posted forty agents".
export async function showcaseTotals() {
	const [row] = await sql`
		select
			count(*)::int                                as entries,
			count(distinct i.user_id)::int               as builders,
			coalesce(sum(v.n), 0)::int                   as votes
		from agent_showcase s
		join agent_identities i on i.id = s.agent_id and i.deleted_at is null and i.is_public = true
		left join lateral (
			select count(*)::int n from agent_showcase_votes sv where sv.entry_id = s.id
		) v on true
		where s.deleted_at is null and s.status = 'published'
	`;
	return {
		entries: row?.entries ?? 0,
		builders: row?.builders ?? 0,
		votes: row?.votes ?? 0,
	};
}

// The agents this user could submit: their own, public, not already showcased.
export async function eligibleAgents(userId) {
	return await sql`
		select i.id, i.name, i.description, i.skills,
		       a.thumbnail_key, a.visibility
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.user_id = ${userId}
		  and i.deleted_at is null
		  and i.is_public = true
		  and not exists (
		      select 1 from agent_showcase s
		      where s.agent_id = i.id and s.deleted_at is null
		  )
		order by i.created_at desc
		limit 100
	`.then((rows) =>
		rows.map((r) => ({
			id: r.id,
			name: r.name,
			description: r.description || null,
			skills: r.skills || [],
			thumbnail:
				r.thumbnail_key && (r.visibility === 'public' || r.visibility === 'unlisted')
					? thumbnailUrl(r.thumbnail_key)
					: null,
		})),
	);
}

/* ── writes ───────────────────────────────────────────────────────────────── */

// Insert, or update the caller's existing entry for that agent. Re-submitting is
// an edit rather than a duplicate: the unique index makes that the only correct
// outcome, and a builder polishing their pitch should not have to find a
// separate edit screen to do it.
export async function upsertEntry({
	agentId,
	userId,
	title,
	tagline,
	story = null,
	demoUrl = null,
	category,
	tags = [],
}) {
	const [row] = await sql`
		insert into agent_showcase
			(agent_id, submitted_by, source, title, tagline, story, demo_url, category, tags)
		values
			(${agentId}, ${userId}, 'community', ${title}, ${tagline}, ${story}, ${demoUrl},
			 ${category}, ${tags}::text[])
		on conflict (agent_id) where deleted_at is null
		do update set
			title      = excluded.title,
			tagline    = excluded.tagline,
			story      = excluded.story,
			demo_url   = excluded.demo_url,
			category   = excluded.category,
			tags       = excluded.tags,
			-- A curated write-up that the builder later claims becomes theirs.
			source     = 'community',
			submitted_by = excluded.submitted_by,
			updated_at = now()
		returning id
	`;
	return row?.id || null;
}

export async function ownsAgent(agentId, userId) {
	const [row] = await sql`
		select 1 from agent_identities
		where id = ${agentId} and user_id = ${userId} and deleted_at is null
		limit 1
	`;
	return Boolean(row);
}

export async function agentIsPublic(agentId) {
	const [row] = await sql`
		select is_public from agent_identities where id = ${agentId} and deleted_at is null limit 1
	`;
	return row ? Boolean(row.is_public) : null;
}

// Toggle. Returns the entry's post-toggle state so the button can settle on a
// server-confirmed count instead of an optimistic guess that drifts.
export async function toggleVote(entryId, userId) {
	const removed = await sql`
		delete from agent_showcase_votes
		where entry_id = ${entryId} and user_id = ${userId}
		returning entry_id
	`;
	if (!removed.length) {
		await sql`
			insert into agent_showcase_votes (entry_id, user_id)
			values (${entryId}, ${userId})
			on conflict do nothing
		`;
	}
	const [row] = await sql`
		select count(*)::int as n from agent_showcase_votes where entry_id = ${entryId}
	`;
	return { voted: removed.length === 0, vote_count: row?.n ?? 0 };
}

export async function entryExists(entryId) {
	const [row] = await sql`
		select 1 from agent_showcase
		where id = ${entryId} and deleted_at is null and status = 'published'
		limit 1
	`;
	return Boolean(row);
}

export async function softDeleteEntry(entryId, userId) {
	const rows = await sql`
		update agent_showcase s
		set deleted_at = now()
		from agent_identities i
		where s.id = ${entryId}
		  and s.deleted_at is null
		  and i.id = s.agent_id
		  and (s.submitted_by = ${userId} or i.user_id = ${userId})
		returning s.id
	`;
	return rows.length > 0;
}

// Best-effort view counter. A failure here must never break the page it counts,
// so the caller fires it without awaiting the result.
export async function bumpViews(entryId) {
	try {
		await sql`update agent_showcase set view_count = view_count + 1 where id = ${entryId}`;
	} catch {
		/* a lost view is not worth a 500 on a read */
	}
}
