// Companion persistence: settings, BYOK sources, contacts, and the event feed.
//
// Every function here is user-scoped. The caller has already authenticated; the
// user id is threaded into every statement so one account can never read or
// mutate another's sources, contacts, or messages.

import { randomBytes } from 'node:crypto';
import { sql } from '../db.js';
import { encryptConfig, decryptConfig, redactConfig } from './crypto.js';

export const SOURCE_KINDS = ['telegram', 'calendar', 'email'];

// A bridge token is a bearer for POST /api/companion/ingest, typed by hand into
// an iOS Shortcut or a shell script, so it is URL-safe and copy-pasteable.
export function newIngestToken() {
	return `cmp_${randomBytes(24).toString('base64url')}`;
}

export async function getSettings(userId) {
	const [row] = await sql`
		select user_id, enabled, threshold, quiet_start, quiet_end, timezone,
		       avatar_glb_url, voice, ingest_token, push_enabled, created_at, updated_at
		from companion_settings where user_id = ${userId}
	`;
	if (row) return row;
	// First visit provisions the row (and the bridge token) so the setup page
	// always has something real to render.
	const [created] = await sql`
		insert into companion_settings (user_id, ingest_token)
		values (${userId}, ${newIngestToken()})
		on conflict (user_id) do update set updated_at = now()
		returning user_id, enabled, threshold, quiet_start, quiet_end, timezone,
		          avatar_glb_url, voice, ingest_token, push_enabled, created_at, updated_at
	`;
	return created;
}

export async function updateSettings(userId, patch) {
	await getSettings(userId);
	const [row] = await sql`
		update companion_settings set
			enabled        = coalesce(${patch.enabled ?? null}, enabled),
			threshold      = coalesce(${patch.threshold ?? null}, threshold),
			quiet_start    = ${patch.quiet_start === undefined ? sql`quiet_start` : patch.quiet_start},
			quiet_end      = ${patch.quiet_end === undefined ? sql`quiet_end` : patch.quiet_end},
			timezone       = coalesce(${patch.timezone ?? null}, timezone),
			avatar_glb_url = ${patch.avatar_glb_url === undefined ? sql`avatar_glb_url` : patch.avatar_glb_url},
			voice          = coalesce(${patch.voice ?? null}, voice),
			push_enabled   = coalesce(${patch.push_enabled ?? null}, push_enabled),
			updated_at     = now()
		where user_id = ${userId}
		returning user_id, enabled, threshold, quiet_start, quiet_end, timezone,
		          avatar_glb_url, voice, ingest_token, push_enabled, created_at, updated_at
	`;
	return row;
}

export async function rotateIngestToken(userId) {
	await getSettings(userId);
	const [row] = await sql`
		update companion_settings set ingest_token = ${newIngestToken()}, updated_at = now()
		where user_id = ${userId}
		returning ingest_token
	`;
	return row.ingest_token;
}

export async function userForIngestToken(token) {
	const [row] = await sql`
		select user_id, enabled, threshold, quiet_start, quiet_end, timezone,
		       avatar_glb_url, voice, push_enabled
		from companion_settings where ingest_token = ${token}
	`;
	return row || null;
}

// Sources ------------------------------------------------------------------

export async function listSources(userId) {
	const rows = await sql`
		select id, kind, label, config_encrypted, cursor, enabled, status,
		       last_error, last_polled_at, last_event_at, created_at
		from companion_sources where user_id = ${userId} order by created_at asc
	`;
	return Promise.all(rows.map(async (r) => ({
		id: r.id,
		kind: r.kind,
		label: r.label,
		enabled: r.enabled,
		status: r.status,
		last_error: r.last_error,
		last_polled_at: r.last_polled_at,
		last_event_at: r.last_event_at,
		created_at: r.created_at,
		config: redactConfig(r.kind, await decryptConfig(r.config_encrypted).catch(() => null)),
	})));
}

export async function createSource(userId, { kind, label, config }) {
	const [row] = await sql`
		insert into companion_sources (user_id, kind, label, config_encrypted)
		values (${userId}, ${kind}, ${label}, ${await encryptConfig(config)})
		returning id, kind, label, enabled, status, created_at
	`;
	return row;
}

export async function getSource(userId, id) {
	const [row] = await sql`
		select id, user_id, kind, label, config_encrypted, cursor, enabled, status
		from companion_sources where id = ${id} and user_id = ${userId}
	`;
	if (!row) return null;
	return { ...row, config: await decryptConfig(row.config_encrypted) };
}

export async function updateSource(userId, id, { label, enabled, config }) {
	const encrypted = config ? await encryptConfig(config) : null;
	const [row] = await sql`
		update companion_sources set
			label            = coalesce(${label ?? null}, label),
			enabled          = coalesce(${enabled ?? null}, enabled),
			config_encrypted = coalesce(${encrypted}, config_encrypted),
			status           = ${config ? 'pending' : sql`status`},
			last_error       = ${config ? null : sql`last_error`}
		where id = ${id} and user_id = ${userId}
		returning id, kind, label, enabled, status
	`;
	return row || null;
}

export async function deleteSource(userId, id) {
	const rows = await sql`delete from companion_sources where id = ${id} and user_id = ${userId} returning id`;
	return rows.length > 0;
}

export async function recordSourceResult(id, { status, error = null, cursor = null, sawEvent = false }) {
	await sql`
		update companion_sources set
			status         = ${status},
			last_error     = ${error},
			cursor         = ${cursor ? JSON.stringify(cursor) : sql`cursor`},
			last_polled_at = now(),
			last_event_at  = ${sawEvent ? sql`now()` : sql`last_event_at`}
		where id = ${id}
	`;
}

// Every enabled source across every account, oldest poll first, for the cron.
export async function dueSources(limit) {
	return sql`
		select s.id, s.user_id, s.kind, s.label, s.config_encrypted, s.cursor
		from companion_sources s
		join companion_settings c on c.user_id = s.user_id
		where s.enabled = true and c.enabled = true
		order by s.last_polled_at asc nulls first
		limit ${limit}
	`;
}

// Contacts -----------------------------------------------------------------

// Identities arrive in many shapes across lanes ("@Sarah", "Sarah <s@x.com>",
// "+1 415 555 0100"). Matching is done on this normal form so the same person
// resolves whether they wrote from Telegram, email, or the phone bridge.
export function normalizeIdentifier(raw) {
	const s = String(raw || '').trim().toLowerCase();
	if (!s) return '';
	const angled = s.match(/<([^>]+)>/);
	const value = angled ? angled[1].trim() : s;
	if (value.includes('@') && !value.startsWith('@')) return value;
	if (/^[+\d][\d\s().-]{5,}$/.test(value)) return `+${value.replace(/\D/g, '')}`;
	return value.replace(/^@/, '');
}

export async function listContacts(userId) {
	return sql`
		select id, identifier, display_name, avatar_glb_url, avatar_image_url,
		       voice, priority_boost, created_at
		from companion_contacts where user_id = ${userId} order by display_name asc
	`;
}

export async function upsertContact(userId, contact) {
	const identifier = normalizeIdentifier(contact.identifier);
	const [row] = await sql`
		insert into companion_contacts
			(user_id, identifier, display_name, avatar_glb_url, avatar_image_url, voice, priority_boost)
		values (${userId}, ${identifier}, ${contact.display_name},
		        ${contact.avatar_glb_url ?? null}, ${contact.avatar_image_url ?? null},
		        ${contact.voice ?? null}, ${contact.priority_boost ?? 0})
		on conflict (user_id, lower(identifier)) do update set
			display_name     = excluded.display_name,
			avatar_glb_url   = excluded.avatar_glb_url,
			avatar_image_url = excluded.avatar_image_url,
			voice            = excluded.voice,
			priority_boost   = excluded.priority_boost
		returning id, identifier, display_name, avatar_glb_url, avatar_image_url, voice, priority_boost, created_at
	`;
	return row;
}

export async function deleteContact(userId, id) {
	const rows = await sql`delete from companion_contacts where id = ${id} and user_id = ${userId} returning id`;
	return rows.length > 0;
}

// Resolve the first candidate identity that the user has a contact card for.
export async function matchContact(userId, candidates) {
	const keys = [...new Set(candidates.map(normalizeIdentifier).filter(Boolean))];
	if (!keys.length) return null;
	const rows = await sql`
		select id, identifier, display_name, avatar_glb_url, avatar_image_url, voice, priority_boost
		from companion_contacts
		where user_id = ${userId} and lower(identifier) = any(${keys})
	`;
	if (!rows.length) return null;
	// Preserve caller priority: the lane lists its most specific identity first.
	for (const key of keys) {
		const hit = rows.find((r) => r.identifier.toLowerCase() === key);
		if (hit) return hit;
	}
	return rows[0];
}

// Events -------------------------------------------------------------------

// Returns the stored row, or null when this exact message was already stored
// (a re-poll, a bridge retry). Dedupe is the guarantee that the companion never
// walks on stage twice for the same message.
export async function insertEvent(userId, event) {
	const [row] = await sql`
		insert into companion_events
			(user_id, source_id, source_kind, external_id, contact_id, sender, sender_id,
			 title, body, url, importance, reason, spoken_line, triage_engine, occurs_at, reply_to)
		values (${userId}, ${event.source_id ?? null}, ${event.source_kind}, ${event.external_id},
		        ${event.contact_id ?? null}, ${event.sender ?? null}, ${event.sender_id ?? null},
		        ${event.title}, ${event.body ?? null}, ${event.url ?? null},
		        ${event.importance}, ${event.reason ?? null}, ${event.spoken_line ?? null},
		        ${event.triage_engine ?? 'rules'}, ${event.occurs_at ?? null},
		        ${event.reply_to ? JSON.stringify(event.reply_to) : null})
		on conflict (user_id, source_kind, external_id) do nothing
		returning id, source_kind, external_id, contact_id, sender, sender_id, title, body, url,
		          importance, reason, spoken_line, triage_engine, occurs_at, delivered_at, created_at,
		          (reply_to is not null) as can_reply
	`;
	return row || null;
}

export async function listEvents(userId, { limit = 30, before = null, pendingOnly = false, minImportance = 0 } = {}) {
	const beforeClause = before ? sql`and e.created_at < ${before}` : sql``;
	const pendingClause = pendingOnly ? sql`and e.delivered_at is null and e.dismissed_at is null` : sql``;
	return sql`
		select e.id, e.source_kind, e.sender, e.sender_id, e.title, e.body, e.url,
		       e.importance, e.reason, e.spoken_line, e.triage_engine, e.occurs_at,
		       e.delivered_at, e.dismissed_at, e.created_at,
		       (e.reply_to is not null) as can_reply, e.replied_at, e.reply_text,
		       c.display_name as contact_name, c.avatar_glb_url as contact_avatar_glb_url,
		       c.avatar_image_url as contact_avatar_image_url, c.voice as contact_voice
		from companion_events e
		left join companion_contacts c on c.id = e.contact_id
		where e.user_id = ${userId} and e.importance >= ${minImportance}
		${pendingClause}
		${beforeClause}
		order by e.created_at desc
		limit ${limit}
	`;
}

export async function markEvent(userId, id, { delivered = false, dismissed = false }) {
	const [row] = await sql`
		update companion_events set
			delivered_at = ${delivered ? sql`coalesce(delivered_at, now())` : sql`delivered_at`},
			dismissed_at = ${dismissed ? sql`coalesce(dismissed_at, now())` : sql`dismissed_at`}
		where id = ${id} and user_id = ${userId}
		returning id, delivered_at, dismissed_at
	`;
	return row || null;
}

// One event with everything a reply needs: the lane, the source's decrypted
// credentials, and the routing the lane stored when the message arrived.
export async function getReplyTarget(userId, eventId) {
	const [row] = await sql`
		select e.id, e.source_kind, e.reply_to, e.sender, e.replied_at,
		       s.id as source_id, s.kind as source_kind_actual, s.config_encrypted, s.enabled
		from companion_events e
		left join companion_sources s on s.id = e.source_id
		where e.id = ${eventId} and e.user_id = ${userId}
	`;
	if (!row) return null;
	return {
		...row,
		config: row.config_encrypted ? await decryptConfig(row.config_encrypted) : null,
	};
}

export async function recordReply(userId, eventId, text) {
	const [row] = await sql`
		update companion_events
		set replied_at = now(), reply_text = ${text}
		where id = ${eventId} and user_id = ${userId}
		returning id, replied_at, reply_text
	`;
	return row || null;
}
