// Friends store — the durable social graph, direct-message history, and mute
// list. Every function takes the authenticated account id (a users.id UUID) as
// its first argument and is responsible for keeping the graph consistent in both
// directions. Presence (online / current realm) is volatile and lives in Redis;
// see presence-store.js. The API endpoints in api/friends/* are thin wrappers
// around these queries.

import { sql } from './db.js';

// Columns safe to expose for any account other than the caller. Never leak
// email, wallet, plan, or admin flags through the social graph.
const PUBLIC_USER_COLS = sql`u.id, u.display_name, u.username, u.avatar_url`;

function toProfile(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.display_name || row.username || 'Anonymous',
		username: row.username || null,
		avatarUrl: row.avatar_url || null,
	};
}

// ── search ───────────────────────────────────────────────────────────────────
// Find accounts by display name or username, excluding the caller and anyone
// they've already muted. The caller's existing relationship to each hit is
// annotated so the UI can render "Add" vs "Pending" vs "Friends" inline.
export async function searchUsers(meId, q, limit = 12) {
	const term = String(q || '').trim();
	if (term.length < 2) return [];
	const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
	const rows = await sql`
		select ${PUBLIC_USER_COLS}
		from users u
		where u.deleted_at is null
		  and u.id <> ${meId}
		  and (u.display_name ilike ${like} or u.username ilike ${like})
		order by
			(lower(u.username) = lower(${term}) or lower(u.display_name) = lower(${term})) desc,
			length(coalesce(u.username, u.display_name)) asc
		limit ${Math.min(Math.max(limit, 1), 25)}
	`;
	if (!rows.length) return [];

	const ids = rows.map((r) => r.id);
	const rels = await sql`
		select requester_id, addressee_id, status from friendships
		where (requester_id = ${meId} and addressee_id = any(${ids}))
		   or (addressee_id = ${meId} and requester_id = any(${ids}))
	`;
	const relFor = new Map();
	for (const r of rels) {
		const other = r.requester_id === meId ? r.addressee_id : r.requester_id;
		if (r.status === 'accepted') relFor.set(other, 'friends');
		else relFor.set(other, r.requester_id === meId ? 'outgoing' : 'incoming');
	}

	return rows.map((r) => ({ ...toProfile(r), relationship: relFor.get(r.id) || 'none' }));
}

// ── requests ───────────────────────────────────────────────────────────────
// Send a friend request. Returns { status } where status is:
//   'requested' — a fresh pending invite was created
//   'accepted'  — the other account had already invited us, so this auto-accepts
//   'exists'    — an identical pending/accepted relationship already existed
// Guards self-add, unknown targets, and duplicate requests in either direction.
export async function sendRequest(meId, toId) {
	if (toId === meId) {
		throw Object.assign(new Error('You cannot add yourself.'), { status: 400, code: 'self_add' });
	}
	const [target] = await sql`select id from users where id = ${toId} and deleted_at is null`;
	if (!target) throw Object.assign(new Error('User not found.'), { status: 404, code: 'not_found' });

	// Look at the relationship from either direction first.
	const [existing] = await sql`
		select id, requester_id, addressee_id, status from friendships
		where (requester_id = ${meId} and addressee_id = ${toId})
		   or (requester_id = ${toId} and addressee_id = ${meId})
		limit 1
	`;
	if (existing) {
		if (existing.status === 'accepted') return { status: 'exists', relationship: 'friends' };
		// Pending. If they invited us, accepting their invite is the right move.
		if (existing.requester_id === toId) {
			await sql`update friendships set status = 'accepted', responded_at = now() where id = ${existing.id}`;
			return { status: 'accepted', relationship: 'friends', friendshipId: existing.id };
		}
		return { status: 'exists', relationship: 'outgoing', friendshipId: existing.id };
	}

	const [row] = await sql`
		insert into friendships (requester_id, addressee_id, status)
		values (${meId}, ${toId}, 'pending')
		returning id
	`;
	return { status: 'requested', relationship: 'outgoing', friendshipId: row.id };
}

// Accept a pending request addressed to me. Returns the now-friend's profile.
export async function acceptRequest(meId, otherId) {
	const [row] = await sql`
		update friendships set status = 'accepted', responded_at = now()
		where requester_id = ${otherId} and addressee_id = ${meId} and status = 'pending'
		returning id
	`;
	if (!row) throw Object.assign(new Error('No pending request from that user.'), { status: 404, code: 'no_request' });
	const [u] = await sql`select ${PUBLIC_USER_COLS} from users u where u.id = ${otherId}`;
	return { friendshipId: row.id, friend: toProfile(u) };
}

// Decline a pending incoming request — deletes it so a future request is clean.
export async function declineRequest(meId, otherId) {
	const rows = await sql`
		delete from friendships
		where requester_id = ${otherId} and addressee_id = ${meId} and status = 'pending'
		returning id
	`;
	if (!rows.length) throw Object.assign(new Error('No pending request from that user.'), { status: 404, code: 'no_request' });
	return { ok: true };
}

// Remove an accepted friend OR cancel a pending outgoing request — both are a
// row delete keyed to the unordered pair.
export async function removeFriend(meId, otherId) {
	await sql`
		delete from friendships
		where (requester_id = ${meId} and addressee_id = ${otherId})
		   or (requester_id = ${otherId} and addressee_id = ${meId})
	`;
	return { ok: true };
}

export async function areFriends(meId, otherId) {
	const [row] = await sql`
		select 1 from friendships
		where status = 'accepted'
		  and ((requester_id = ${meId} and addressee_id = ${otherId})
		    or (requester_id = ${otherId} and addressee_id = ${meId}))
		limit 1
	`;
	return !!row;
}

// ── graph listing ─────────────────────────────────────────────────────────
// One round-trip view of the caller's whole graph: accepted friends, incoming
// pending requests, and outgoing pending requests. Unread DM counts per friend
// are folded in so the UI can badge threads without a second call. Presence is
// merged at the endpoint layer (it lives in Redis, not Postgres).
export async function listGraph(meId) {
	const rows = await sql`
		select f.id as friendship_id, f.status, f.requester_id, f.created_at, f.responded_at,
		       ${PUBLIC_USER_COLS}
		from friendships f
		join users u on u.id = (case when f.requester_id = ${meId} then f.addressee_id else f.requester_id end)
		where (f.requester_id = ${meId} or f.addressee_id = ${meId})
		  and u.deleted_at is null
		order by f.created_at desc
	`;

	const unread = await unreadCounts(meId);

	const friends = [];
	const incoming = [];
	const outgoing = [];
	for (const r of rows) {
		const profile = toProfile(r);
		const entry = { ...profile, friendshipId: r.friendship_id };
		if (r.status === 'accepted') {
			friends.push({ ...entry, since: r.responded_at || r.created_at, unread: unread[r.id] || 0 });
		} else if (r.requester_id === meId) {
			outgoing.push({ ...entry, requestedAt: r.created_at });
		} else {
			incoming.push({ ...entry, requestedAt: r.created_at });
		}
	}
	friends.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
	return { friends, incoming, outgoing };
}

// ── direct messages ──────────────────────────────────────────────────────
// Fetch a thread between me and `otherId`, oldest→newest, capped to `limit`.
// `beforeId` paginates older history (cursor = the oldest id currently shown).
export async function getThread(meId, otherId, { limit = 50, beforeId = null } = {}) {
	const cap = Math.min(Math.max(limit, 1), 100);
	const rows = beforeId
		? await sql`
			select id, sender_id, recipient_id, body, created_at, read_at
			from direct_messages
			where ((sender_id = ${meId} and recipient_id = ${otherId})
			    or (sender_id = ${otherId} and recipient_id = ${meId}))
			  and created_at < (select created_at from direct_messages where id = ${beforeId})
			order by created_at desc
			limit ${cap}
		`
		: await sql`
			select id, sender_id, recipient_id, body, created_at, read_at
			from direct_messages
			where (sender_id = ${meId} and recipient_id = ${otherId})
			   or (sender_id = ${otherId} and recipient_id = ${meId})
			order by created_at desc
			limit ${cap}
		`;
	return rows.reverse().map((m) => ({
		id: m.id,
		from: m.sender_id,
		to: m.recipient_id,
		body: m.body,
		ts: m.created_at,
		mine: m.sender_id === meId,
		read: !!m.read_at,
	}));
}

// Persist a DM. Returns the stored row, or null when the recipient has muted the
// sender (the message is silently dropped — never stored, never delivered). The
// caller is responsible for confirming `meId` and `toId` are friends first.
export async function sendDM(meId, toId, body) {
	if (await isMutedBy(toId, meId)) return null; // recipient muted me → suppress
	const [row] = await sql`
		insert into direct_messages (sender_id, recipient_id, body)
		values (${meId}, ${toId}, ${body})
		returning id, sender_id, recipient_id, body, created_at
	`;
	return {
		id: row.id,
		from: row.sender_id,
		to: row.recipient_id,
		body: row.body,
		ts: row.created_at,
	};
}

// Mark every message from `otherId` to me as read. Returns count cleared.
export async function markThreadRead(meId, otherId) {
	const rows = await sql`
		update direct_messages set read_at = now()
		where recipient_id = ${meId} and sender_id = ${otherId} and read_at is null
		returning id
	`;
	return rows.length;
}

// Per-sender unread counts for the caller → { senderId: count }.
export async function unreadCounts(meId) {
	const rows = await sql`
		select sender_id, count(*)::int as n
		from direct_messages
		where recipient_id = ${meId} and read_at is null
		group by sender_id
	`;
	const out = {};
	for (const r of rows) out[r.sender_id] = r.n;
	return out;
}

// ── mutes (Task 14) ──────────────────────────────────────────────────────
// Does `muterId` mute `mutedId`? Used to suppress inbound DMs from the muted
// account. Reads are hot (one per DM send) so keep the query trivial.
export async function isMutedBy(muterId, mutedId) {
	const [row] = await sql`
		select 1 from user_mutes where muter_id = ${muterId} and muted_id = ${mutedId} limit 1
	`;
	return !!row;
}

export async function muteUser(meId, targetId) {
	if (targetId === meId) {
		throw Object.assign(new Error('You cannot mute yourself.'), { status: 400, code: 'self_mute' });
	}
	await sql`
		insert into user_mutes (muter_id, muted_id) values (${meId}, ${targetId})
		on conflict (muter_id, muted_id) do nothing
	`;
	return { ok: true };
}

export async function unmuteUser(meId, targetId) {
	await sql`delete from user_mutes where muter_id = ${meId} and muted_id = ${targetId}`;
	return { ok: true };
}

export async function listMutes(meId) {
	const rows = await sql`select muted_id from user_mutes where muter_id = ${meId}`;
	return rows.map((r) => r.muted_id);
}
