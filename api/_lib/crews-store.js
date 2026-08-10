// Crews store — the durable crew (clan) graph for the /play world (W09). Every
// function takes the authenticated account id (a users.id UUID) as its first
// argument and keeps the roster + invites consistent. Presence (which member is
// online / where) is volatile and lives in Redis (presence-store.js); only the
// crew identity, roster, and pending invites live here.
//
// Mirrors the shape of friends-store.js so the two social systems read alike: a
// lazily-built public-columns fragment, a toProfile() projector, and small
// single-purpose queries the api/crews/* endpoints wrap thinly.

import { sql } from './db.js';
import { publicUrl, thumbnailUrl } from './r2.js';

// Columns safe to expose for any account — never leak email, wallet, plan, or
// admin flags through a crew roster. Built lazily so importing this module never
// instantiates the Neon client (endpoints stay cold-start cheap without a DB).
let _publicUserCols;
const publicUserCols = () =>
	(_publicUserCols ??= sql`u.id, u.display_name, u.username, u.avatar_url`);

function toProfile(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.display_name || row.username || 'Anonymous',
		username: row.username || null,
		avatarUrl: row.avatar_url || null,
	};
}

// A crew tag is a short clan badge: 2–6 chars, letters/digits only, upper-cased
// for display. Returns '' for anything that can't be a tag so callers can reject.
export function normalizeTag(raw) {
	const t = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
	return t.length >= 2 && t.length <= 6 ? t : '';
}

// Tags that would collide with a route segment. `/api/crews/:tag` and
// `/crews/:tag` both resolve an exact file or page before the dynamic segment
// (server/index.mjs precedence: exact file > [param].js), so a crew tagged
// SEARCH would be permanently unreachable at its own public URL. Refusing the
// tag at founding time is the only place this can be fixed without breaking an
// existing crew's link later.
const RESERVED_TAGS = new Set(['SEARCH', 'INDEX', 'API', 'ADMIN', 'NEW', 'ME', 'ALL', 'NULL']);

export function isReservedTag(tag) {
	return RESERVED_TAGS.has(String(tag || '').toUpperCase());
}

function normalizeName(raw) {
	return String(raw || '')
		.replace(/[\x00-\x1f\x7f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 32);
}

function err(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

// ── lookups ──────────────────────────────────────────────────────────────────
// The crew an account belongs to, as { id, tag, name, role, memberCount } — or
// null if they're in no crew. This is the hot path the presence-ticket signer
// calls on every sign-in, so it's one round-trip.
export async function getMyCrew(accountId) {
	const [row] = await sql`
		select c.id, c.tag, c.name, c.owner_id, m.role,
		       (select count(*)::int from crew_members cm where cm.crew_id = c.id) as member_count
		from crew_members m
		join crews c on c.id = m.crew_id
		where m.account_id = ${accountId}
		limit 1
	`;
	if (!row) return null;
	return {
		id: row.id,
		tag: row.tag,
		name: row.name,
		role: row.role,
		isOwner: row.owner_id === accountId,
		memberCount: row.member_count,
	};
}

// Just the crew tag for an account — what the presence ticket embeds so the game
// server can stamp a trustworthy tag over the avatar. Returns { tag, name } or null.
export async function crewTagFor(accountId) {
	const [row] = await sql`
		select c.tag, c.name from crew_members m
		join crews c on c.id = m.crew_id
		where m.account_id = ${accountId}
		limit 1
	`;
	return row ? { tag: row.tag, name: row.name } : null;
}

// Batch tag lookup for a set of accounts → { accountId: { tag, name } }. Used to
// annotate rosters / search results with crew membership in one query.
export async function crewTagsFor(accountIds) {
	const ids = [...new Set((accountIds || []).filter(Boolean))];
	if (!ids.length) return {};
	const rows = await sql`
		select m.account_id, c.tag, c.name from crew_members m
		join crews c on c.id = m.crew_id
		where m.account_id = any(${ids})
	`;
	const out = {};
	for (const r of rows) out[r.account_id] = { tag: r.tag, name: r.name };
	return out;
}

// The full roster for a crew, owner first then by join time. Each entry carries
// the public profile + role + the member's standee (their agent's 3D avatar, so
// the Crew HQ room can render the roster in 3D). Presence is merged at the
// endpoint layer (Redis).
export async function listMembers(crewId) {
	const rows = await sql`
		select ${publicUserCols()}, m.role, m.joined_at
		from crew_members m
		join users u on u.id = m.account_id
		where m.crew_id = ${crewId} and u.deleted_at is null
		order by (m.role = 'owner') desc, m.joined_at asc
	`;
	const standees = await standeesFor(rows.map((r) => r.id));
	return rows.map((r) => ({
		...toProfile(r),
		role: r.role,
		joinedAt: r.joined_at,
		standee: standees[r.id] || null,
	}));
}

// The 3D figure that represents each account in the Crew HQ room: their agent
// and, when that agent owns a publicly readable avatar, the GLB the viewer
// loads. One row per account, preferring an agent that actually has a model
// over an older one that does not, so a member with several agents stands as
// the one that can be rendered.
//
// Visibility is enforced here exactly as api/agents.js decorate() enforces it:
// only 'public' / 'unlisted' avatars ever emit a URL, so a private model can
// never leak through a crew roster. An account with no agent, or no renderable
// avatar, resolves to a null modelUrl — the page falls back to the default rig
// and offers to claim one, which is the whole point of showing the gap.
export async function standeesFor(accountIds) {
	const ids = [...new Set((accountIds || []).filter(Boolean))];
	if (!ids.length) return {};
	let rows;
	try {
		rows = await sql`
			select distinct on (i.user_id)
			       i.user_id, i.id as agent_id, i.name as agent_name,
			       a.storage_key, a.thumbnail_key, a.visibility
			from agent_identities i
			left join avatars a on a.id = i.avatar_id and a.deleted_at is null
			where i.user_id = any(${ids}) and i.deleted_at is null
			order by i.user_id,
			         (a.storage_key is not null and a.visibility in ('public', 'unlisted')) desc,
			         i.created_at asc
		`;
	} catch (err) {
		// A roster that renders without standees beats a 500. Any schema drift in
		// the agent tables degrades the room to the default rig, never the page.
		if (isMissingRelation(err)) return {};
		throw err;
	}
	const out = {};
	for (const r of rows) {
		const readable = r.visibility === 'public' || r.visibility === 'unlisted';
		out[r.user_id] = {
			agentId: r.agent_id,
			agentName: r.agent_name || null,
			modelUrl: readable && r.storage_key ? publicUrl(r.storage_key) : null,
			thumbUrl: readable && r.thumbnail_key ? thumbnailUrl(r.thumbnail_key) : null,
		};
	}
	return out;
}

// True when an error is Postgres telling us a table/column isn't there — the
// signal every crews endpoint uses to degrade instead of 500 while a migration
// is still rolling out.
export function isMissingRelation(err) {
	const m = err?.message || '';
	return m.includes('relation') || m.includes('does not exist') || err?.code === '42P01';
}

// Public crew directory: every crew with at least one member, biggest first, so
// a visitor with no crew has somewhere to look before founding their own. Only
// public roster facts (tag, name, size, founding date, a few member faces).
export async function listCrewDirectory(limit = 24) {
	const cap = Math.min(Math.max(Number(limit) || 24, 1), 60);
	const rows = await sql`
		select c.id, c.tag, c.name, c.created_at,
		       count(m.account_id)::int as member_count
		from crews c
		join crew_members m on m.crew_id = c.id
		group by c.id, c.tag, c.name, c.created_at
		order by count(m.account_id) desc, c.created_at asc
		limit ${cap}
	`;
	if (!rows.length) return [];

	const faces = await sql`
		select m.crew_id, u.id, u.display_name, u.username, u.avatar_url
		from crew_members m
		join users u on u.id = m.account_id
		where m.crew_id = any(${rows.map((r) => r.id)}) and u.deleted_at is null
		order by (m.role = 'owner') desc, m.joined_at asc
	`;
	const byCrew = new Map();
	for (const f of faces) {
		const list = byCrew.get(f.crew_id) || [];
		if (list.length < 5) list.push(toProfile(f));
		byCrew.set(f.crew_id, list);
	}
	return rows.map((r) => ({
		tag: r.tag,
		name: r.name,
		createdAt: r.created_at,
		memberCount: r.member_count,
		faces: byCrew.get(r.id) || [],
	}));
}

// Search accounts to invite. Mirrors friends-store.searchUsers but annotates
// what a crew owner actually needs to know before clicking: whether the person
// is already in a crew (and which), and whether this crew already invited them.
// Both make the invite button render its true state instead of failing on click.
export async function searchInvitees(meId, q, limit = 12) {
	const term = String(q || '').trim();
	if (term.length < 2) return [];
	const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
	const rows = await sql`
		select ${publicUserCols()}
		from users u
		where u.deleted_at is null
		  and u.id <> ${meId}
		  and (u.display_name ilike ${like} or u.username ilike ${like})
		order by
			(lower(u.username) = lower(${term}) or lower(u.display_name) = lower(${term})) desc,
			length(coalesce(u.username, u.display_name)) asc
		limit ${Math.min(Math.max(Number(limit) || 12, 1), 25)}
	`;
	if (!rows.length) return [];

	const ids = rows.map((r) => r.id);
	const tags = await crewTagsFor(ids);
	const myCrew = await getMyCrew(meId);
	const invited = myCrew
		? new Set(
				(
					await sql`select invitee_id from crew_invites where crew_id = ${myCrew.id} and invitee_id = any(${ids})`
				).map((r) => r.invitee_id),
			)
		: new Set();

	return rows.map((r) => ({
		...toProfile(r),
		crew: tags[r.id] || null,
		invited: invited.has(r.id),
	}));
}

// Public view of a crew by tag: identity + roster. Returns null if no such tag.
export async function getCrewByTag(tag) {
	const norm = normalizeTag(tag);
	if (!norm) return null;
	const [c] = await sql`
		select id, tag, name, owner_id, created_at from crews where lower(tag) = lower(${norm}) limit 1
	`;
	if (!c) return null;
	return {
		id: c.id,
		tag: c.tag,
		name: c.name,
		createdAt: c.created_at,
		members: await listMembers(c.id),
	};
}

// Pending invites addressed to an account → [{ crewId, tag, name, inviter, createdAt }].
export async function listInvites(accountId) {
	const rows = await sql`
		select i.crew_id, i.created_at, c.tag, c.name,
		       inv.id as inviter_id, inv.display_name as inviter_name, inv.username as inviter_username
		from crew_invites i
		join crews c on c.id = i.crew_id
		join users inv on inv.id = i.inviter_id
		where i.invitee_id = ${accountId}
		order by i.created_at desc
	`;
	return rows.map((r) => ({
		crewId: r.crew_id,
		tag: r.tag,
		name: r.name,
		inviter: { id: r.inviter_id, name: r.inviter_name || r.inviter_username || 'Someone' },
		createdAt: r.created_at,
	}));
}

// ── mutations ────────────────────────────────────────────────────────────────
// Found a new crew. The founder becomes the owner and first member. Guards a
// duplicate tag and an account that's already in a crew (one-crew-per-account).
export async function createCrew(accountId, rawTag, rawName) {
	const tag = normalizeTag(rawTag);
	if (!tag) throw err('Tag must be 2-6 letters or digits.', 400, 'bad_tag');
	if (isReservedTag(tag)) throw err('That tag is reserved.', 409, 'tag_reserved');
	const name = normalizeName(rawName) || tag;
	if (name.length < 2) throw err('Crew name is too short.', 400, 'bad_name');

	if (await getMyCrew(accountId)) {
		throw err('Leave your current crew before founding a new one.', 409, 'already_in_crew');
	}
	const [clash] = await sql`select 1 from crews where lower(tag) = lower(${tag}) limit 1`;
	if (clash) throw err('That tag is taken.', 409, 'tag_taken');

	const [crew] = await sql`
		insert into crews (tag, name, owner_id) values (${tag}, ${name}, ${accountId})
		returning id, tag, name
	`;
	await sql`
		insert into crew_members (crew_id, account_id, role) values (${crew.id}, ${accountId}, 'owner')
	`;
	return { id: crew.id, tag: crew.tag, name: crew.name, role: 'owner', isOwner: true, memberCount: 1 };
}

// Invite an account to my crew. I must be a member; the target must exist, not be
// muted-irrelevant here, not already be in a crew, and not already invited. Returns
// the invitee's public profile so the caller can fire a live toast.
export async function invite(accountId, targetId) {
	if (targetId === accountId) throw err('You cannot invite yourself.', 400, 'self_invite');
	const crew = await getMyCrew(accountId);
	if (!crew) throw err('You are not in a crew.', 400, 'no_crew');

	const [target] = await sql`select ${publicUserCols()} from users u where u.id = ${targetId} and u.deleted_at is null`;
	if (!target) throw err('User not found.', 404, 'not_found');

	const [member] = await sql`select 1 from crew_members where account_id = ${targetId} limit 1`;
	if (member) throw err('They are already in a crew.', 409, 'target_in_crew');

	await sql`
		insert into crew_invites (crew_id, inviter_id, invitee_id) values (${crew.id}, ${accountId}, ${targetId})
		on conflict (crew_id, invitee_id) do nothing
	`;
	return { crew, invitee: toProfile(target) };
}

// Accept an invite to a crew. Validates the invite exists for me and that I'm not
// already in a crew (an invite I accept after joining elsewhere is rejected, then
// cleaned up). Inserts membership and clears every invite I had pending.
export async function acceptInvite(accountId, crewId) {
	const [inv] = await sql`
		select 1 from crew_invites where crew_id = ${crewId} and invitee_id = ${accountId} limit 1
	`;
	if (!inv) throw err('No pending invite from that crew.', 404, 'no_invite');
	if (await getMyCrew(accountId)) {
		await sql`delete from crew_invites where crew_id = ${crewId} and invitee_id = ${accountId}`;
		throw err('Leave your current crew first.', 409, 'already_in_crew');
	}
	const [crew] = await sql`select id, tag, name from crews where id = ${crewId} limit 1`;
	if (!crew) {
		await sql`delete from crew_invites where invitee_id = ${accountId}`;
		throw err('That crew no longer exists.', 404, 'not_found');
	}
	await sql`
		insert into crew_members (crew_id, account_id, role) values (${crewId}, ${accountId}, 'member')
	`;
	// Clear all of my pending invites — I've made my choice.
	await sql`delete from crew_invites where invitee_id = ${accountId}`;
	return { id: crew.id, tag: crew.tag, name: crew.name, role: 'member', isOwner: false };
}

export async function declineInvite(accountId, crewId) {
	await sql`delete from crew_invites where crew_id = ${crewId} and invitee_id = ${accountId}`;
	return { ok: true };
}

// Leave my crew. If I'm the owner, ownership passes to the longest-tenured
// remaining member; if I was the last member, the crew is deleted outright (its
// invites cascade away). Keeps a crew from ever being orphaned with no owner.
export async function leaveCrew(accountId) {
	const crew = await getMyCrew(accountId);
	if (!crew) throw err('You are not in a crew.', 400, 'no_crew');

	await sql`delete from crew_members where crew_id = ${crew.id} and account_id = ${accountId}`;

	const remaining = await sql`
		select account_id from crew_members where crew_id = ${crew.id}
		order by joined_at asc limit 1
	`;
	if (!remaining.length) {
		await sql`delete from crews where id = ${crew.id}`; // cascades members + invites
		return { ok: true, disbanded: true };
	}
	if (crew.isOwner) {
		const heir = remaining[0].account_id;
		await sql`update crews set owner_id = ${heir} where id = ${crew.id}`;
		await sql`update crew_members set role = 'owner' where crew_id = ${crew.id} and account_id = ${heir}`;
	}
	return { ok: true, disbanded: false };
}

// Owner-only: remove another member from the crew. The owner can't kick themselves
// (they leave instead, which hands off ownership).
export async function kickMember(accountId, targetId) {
	const crew = await getMyCrew(accountId);
	if (!crew) throw err('You are not in a crew.', 400, 'no_crew');
	if (!crew.isOwner) throw err('Only the crew owner can remove members.', 403, 'not_owner');
	if (targetId === accountId) throw err('Use leave to step down as owner.', 400, 'self_kick');
	const rows = await sql`
		delete from crew_members where crew_id = ${crew.id} and account_id = ${targetId}
		returning account_id
	`;
	if (!rows.length) throw err('They are not in your crew.', 404, 'not_member');
	return { ok: true };
}
