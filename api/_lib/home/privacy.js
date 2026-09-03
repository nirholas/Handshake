// The Home lane's data inventory, and the code that acts on it.
//
// Everything three.ws stores about a person's house is enumerated once, here,
// in INVENTORY. That list is not documentation of the code: it IS the code.
// The privacy endpoint renders it, the export walks it, the deletion walks it,
// and tests/home-privacy.test.js re-derives the set of home_* tables from the
// migration files and fails if one of them is missing from it. A data class
// nobody wrote down is the failure this structure exists to prevent, so adding
// a table to this campaign without adding a row here breaks the build.
//
// The promise this module keeps, and the reason it can keep it
// ----------------------------------------------------------
// **Entity states are never persisted.** Not the room graph, not the entity
// list, not a history of which light was on when. Those live in the bridge
// runtime's memory and die with the instance. A stored record of "the bedroom
// light went on at 23:14" is an occupancy log for a building, and this campaign
// does not create one: read the schema and there is nowhere for it to go. The
// completeness test asserts that too, by checking every persisted home table
// against this list.
//
// Voice audio is stored nowhere, ever. A transcript lives in the conversation
// turn that produced it and is gone with it.
//
// Deletion vs revoke
// ------------------
// `revokeConnection` in store.js is a DISCONNECT: it scrubs the credential and
// keeps the row, so an owner can still answer "what did my agent do in my house
// last Tuesday" about a house they have since unplugged. That is the right
// default and it is not deletion. `deleteHome` here is the other verb: the row
// and everything that points at it go, and nothing is left to read.

import { sql } from '../db.js';
import { withDbRetry } from '../db-retry.js';

/** The 90-day default, stated once so the doc, the UI and the DB agree. */
export const DEFAULT_ACTION_LOG_RETENTION_DAYS = 90;
/** The bounds the schema check constraint enforces. Mirrored, never guessed. */
export const MIN_ACTION_LOG_RETENTION_DAYS = 1;
export const MAX_ACTION_LOG_RETENTION_DAYS = 3650;
/** Past this, an extension has to say why, in at least this many characters. */
export const RETENTION_REASON_MIN_LENGTH = 8;

/**
 * Every durable thing this lane holds, in the words a person would use.
 *
 * `table: null` marks a data class we deliberately do NOT persist. Those rows
 * are the most important entries in the list: they are the promises, and the
 * completeness test proves the schema has nowhere to break them.
 *
 * @type {ReadonlyArray<{
 *   key: string, data: string, table: string|null, why: string,
 *   retention: string, deletedBy: string, sensitive?: boolean
 * }>}
 */
export const INVENTORY = Object.freeze([
	{
		key: 'connection',
		data: 'The address of your home and the label you gave it',
		table: 'home_connections',
		why: 'To reach your Home Assistant at all.',
		retention: 'Until you disconnect the home; the row is deleted when you delete the home.',
		deletedBy: 'Delete this home, or delete your account.',
	},
	{
		key: 'credential',
		data: 'Your Home Assistant access token, encrypted',
		table: 'home_connections',
		why: 'Home Assistant requires it on every connection, so we have to be able to replay it.',
		retention: 'Encrypted at rest (AES-256-GCM) and erased the moment you disconnect the home, before the row itself is deleted.',
		deletedBy: 'Disconnect, delete this home, or delete your account.',
		sensitive: true,
	},
	{
		key: 'capabilities',
		data: 'What your instance turned out to be: its version, how many entities and areas it has, whether it exposes MCP',
		table: 'home_connections',
		why: 'So the connect screen and the agent can tell you what is actually available instead of guessing.',
		retention: 'Until the home is deleted. Counts only, never the entity or area names themselves.',
		deletedBy: 'Delete this home, or delete your account.',
	},
	{
		key: 'entity_names',
		data: 'The names of your rooms, devices and scenes',
		table: null,
		why: 'To draw your home and to understand what you ask for.',
		retention: 'Never stored. They are read live from your Home Assistant and held in memory only for as long as the connection is open.',
		deletedBy: 'Nothing to delete.',
	},
	{
		key: 'entity_states',
		data: 'Whether a light is on, a door is locked, a room is warm',
		table: null,
		why: 'To render your home live and to answer questions about it.',
		retention: 'Never stored. A record of when your lights go on and off is a record of when you are home, and we do not keep one.',
		deletedBy: 'Nothing to delete.',
	},
	{
		key: 'members',
		data: 'Who else you gave access to this home, and what role they have',
		table: 'home_members',
		why: 'So a household or a building can share one home without sharing one login.',
		retention: 'Until the member is removed or the home is deleted.',
		deletedBy: 'Remove the member, delete this home, or delete your account.',
	},
	{
		key: 'invites',
		data: 'The email address of someone you invited, until they accept or it expires',
		table: 'home_invites',
		why: 'To send and to honour an invitation to your home.',
		retention: 'Until accepted, revoked, or expired; deleted with the home. Deleting your account also removes invitations addressed to your email.',
		deletedBy: 'Revoke the invite, delete this home, or delete your account.',
		sensitive: true,
	},
	{
		key: 'grants',
		data: 'The standing permissions you granted: which specific door or alarm the agent may open without asking again',
		table: 'home_entity_grants',
		why: 'You granted them, so that the agent stops asking about the one thing you said yes to.',
		retention: 'Until you revoke the grant, until it expires, or until the home is deleted. A grant is also removed when the person who granted it deletes their account.',
		deletedBy: 'Revoke the grant, delete this home, or delete your account.',
	},
	{
		key: 'action_log',
		data: 'Every action the agent took in your home: what it did, to which entities, whether it had to ask you first, and whether it worked',
		table: 'home_action_log',
		why: 'So you can answer "what did my agent do in my house" without taking our word for it.',
		retention: 'Your choice, 90 days by default. You can shorten it to a single day, or lengthen it if you run a building that has to keep records.',
		deletedBy: 'The daily retention sweep, deleting this home, or deleting your account.',
		sensitive: true,
	},
	{
		key: 'confirmations',
		data: 'A pending request to open something, and the sentence you were shown before you said yes: "Unlock the Front Door"',
		table: 'home_confirmations',
		why: 'So that what a human approves and what actually runs cannot drift apart, and so an operator can prove who approved opening a door.',
		retention: 'The request itself is only valid for seconds. The record of it is kept on the same window as your action log, 90 days by default, and deleted with it. This is the one place a room or device name is written down, and it is the reason that window applies to it.',
		deletedBy: 'The daily retention sweep, deleting this home, or deleting your account.',
		sensitive: true,
	},
	{
		key: 'voice_audio',
		data: 'The sound of your voice',
		table: null,
		why: 'Speech has to be turned into words.',
		retention: 'Never stored. Audio is processed and discarded within the turn that produced it.',
		deletedBy: 'Nothing to delete.',
	},
	{
		key: 'voice_transcript',
		data: 'What you said, as text',
		table: null,
		why: 'The agent has to know what you asked for.',
		retention: 'Never stored by this lane. It lives in the conversation you are having and goes when that conversation does.',
		deletedBy: 'Clear the conversation.',
	},
]);

/** The tables the inventory says exist. The completeness test reads this. */
export const INVENTORY_TABLES = Object.freeze(
	[...new Set(INVENTORY.map((row) => row.table).filter(Boolean))].sort(),
);

/**
 * Tables that hold a user's home data but are NOT reachable from a home_id.
 * Deletion has to sweep them by user, not by cascade, or an identifier survives
 * the account it belonged to.
 */
export const USER_SCOPED_RESIDUE = Object.freeze([
	// The action log's actor columns carry no foreign key on purpose: an actor can
	// be an agent principal with no account behind it. That also means nothing
	// removes a departed user's id from another household's log, so deletion
	// scrubs those columns by hand rather than trusting a cascade that is not
	// there.
	'home_action_log.user_id',
	'home_action_log.confirmed_by',
	// An invitation addressed to an email is addressed to a person, and it lives
	// on somebody else's home, so no cascade from the user reaches it.
	'home_invites.email',
	// The platform audit trail records home disconnects. Its rows outlive the
	// account (user_id is set null, not deleted), so home-scoped rows are removed
	// explicitly here.
	'audit_log',
]);

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Set how long this home keeps its action log.
 *
 * Shortening never needs a justification: keeping less of somebody's data is not
 * the decision that has to be defended. Lengthening past the 90-day default
 * does, because a building that keeps two years of occupancy data will be asked
 * why, and the answer should be on the record before the question arrives. The
 * schema enforces the same rule, so a caller that skips this function cannot
 * skip the rule.
 *
 * @param {object} input
 * @param {string} input.homeId
 * @param {string} input.userId the owner; the update is ownership-filtered in SQL
 * @param {number} input.days
 * @param {string|null} [input.reason] required above the default window
 * @returns {Promise<{ ok: boolean, code?: string, home?: object }>}
 */
export async function setActionLogRetention({ homeId, userId, days, reason = null }) {
	const n = Number.parseInt(String(days), 10);
	if (!Number.isFinite(n) || n < MIN_ACTION_LOG_RETENTION_DAYS || n > MAX_ACTION_LOG_RETENTION_DAYS) {
		return { ok: false, code: 'bad_retention_days' };
	}
	const trimmed = typeof reason === 'string' ? reason.trim() : '';
	if (n > DEFAULT_ACTION_LOG_RETENTION_DAYS && trimmed.length < RETENTION_REASON_MIN_LENGTH) {
		return { ok: false, code: 'reason_required' };
	}
	const storedReason = n > DEFAULT_ACTION_LOG_RETENTION_DAYS ? trimmed.slice(0, 500) : null;

	const rows = await sql`
		update home_connections
		set action_log_retention_days   = ${n},
		    action_log_retention_reason = ${storedReason},
		    action_log_retention_set_by = ${userId},
		    action_log_retention_set_at = now(),
		    updated_at                  = now()
		where id = ${homeId} and user_id = ${userId}
		returning id, action_log_retention_days, action_log_retention_reason, action_log_retention_set_at
	`;
	if (!rows[0]) return { ok: false, code: 'not_found' };

	// Applying the new window immediately is the point. A user who shortens
	// retention to a day expects yesterday's rows to be gone now, not at the next
	// sweep, and telling them "within 24 hours" when we could simply do it is a
	// worse product and a worse promise.
	const purged = await purgeActionLogForHome(homeId, n);
	return { ok: true, home: rows[0], purged };
}

/**
 * Delete this home's action-log rows past a given window.
 *
 * Bounded and idempotent: it deletes only rows older than the window and nothing
 * else, so running it twice is the same as running it once, and running it on a
 * home with a long window is a no-op.
 *
 * @param {string} homeId
 * @param {number} days
 * @returns {Promise<number>} rows deleted
 */
export async function purgeActionLogForHome(homeId, days) {
	const n = Number.parseInt(String(days), 10);
	if (!Number.isFinite(n) || n < MIN_ACTION_LOG_RETENTION_DAYS) return 0;
	const del = await sql`
		delete from home_action_log
		where home_id = ${homeId}
		  and created_at < now() - ${n} * interval '1 day'
		returning id
	`;
	// The confirmation records ride the same window; see purgeExpiredActionLog.
	await sql`
		delete from home_confirmations
		where home_id = ${homeId}
		  and (redeemed_at is not null or expired_at is not null)
		  and created_at < now() - ${n} * interval '1 day'
	`;
	return del.length;
}

/**
 * The sweep, for the retention cron.
 *
 * Every home carries its own window, so this cannot be one DELETE with one
 * cutoff. It joins the log against its home's setting instead, which keeps the
 * whole policy in the database rather than half of it in a cron's environment.
 *
 * Bounded per call so a single tick can never run away: the caller re-runs on
 * its schedule and a backlog drains over a few ticks.
 *
 * @param {{ batch?: number, maxRows?: number }} [options]
 * @returns {Promise<{ deleted: number, batches: number, homes: number }>}
 */
export async function purgeExpiredActionLog({ batch = 5000, maxRows = 100_000 } = {}) {
	let deleted = 0;
	let batches = 0;
	const homes = new Set();
	const maxBatches = Math.max(1, Math.ceil(maxRows / batch));

	for (let i = 0; i < maxBatches; i++) {
		// The cutoff is per row, read from the row's own home. `ctid` keeps the
		// statement bounded without needing a stable ordering over a bigserial that
		// another writer is appending to concurrently.
		const del = await sql`
			delete from home_action_log
			where ctid in (
				select l.ctid
				from home_action_log l
				join home_connections h on h.id = l.home_id
				where l.created_at < now() - h.action_log_retention_days * interval '1 day'
				limit ${batch}
			)
			returning home_id
		`;
		batches += 1;
		deleted += del.length;
		for (const row of del) homes.add(row.home_id);
		if (del.length < batch) break;
	}
	// Retired confirmations ride the same window. They are the other half of the
	// same audit trail (the action log says a door was opened; the confirmation
	// says who was shown what before it was), and the summary sentence frozen on
	// them is the ONE place this lane writes a room or device name down. A
	// pending row is never touched: its own seconds-long TTL retires it, and
	// deleting one out from under a person mid-decision would break the gate.
	const confirmations = await sql`
		delete from home_confirmations
		where ctid in (
			select c.ctid
			from home_confirmations c
			join home_connections h on h.id = c.home_id
			where (c.redeemed_at is not null or c.expired_at is not null)
			  and c.created_at < now() - h.action_log_retention_days * interval '1 day'
			limit ${batch}
		)
		returning id
	`;

	return { deleted, batches, homes: homes.size, confirmations: confirmations.length };
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Everything this lane holds about one person, as plain JSON.
 *
 * Walks the inventory rather than a hand-written list of queries, so a table
 * that gets added to the campaign and to INVENTORY is exported without anybody
 * remembering to come back here. The credential is the single deliberate
 * omission: exporting a decrypted key to someone's front door into a file that
 * lands in a downloads folder would be a worse privacy outcome than not
 * exporting it, so the export carries the fact that a credential exists and its
 * fingerprint, never the key.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function exportHomeData(userId) {
	const homes = await sql`
		select id, label, base_url, token_fingerprint, transport, relay_id, capabilities,
		       status, status_detail, last_ok_at, last_error_at, created_at, updated_at,
		       revoked_at, action_log_retention_days, action_log_retention_reason,
		       action_log_retention_set_at
		from home_connections
		where user_id = ${userId}
		order by created_at
	`;
	const homeIds = homes.map((h) => h.id);

	const [members, invites, grants, actions, confirmations, invitesToMe] = await Promise.all([
		homeIds.length
			? sql`select home_id, user_id, role, entity_scope, invited_by, created_at, updated_at
			      from home_members where home_id = any(${homeIds}) order by home_id, created_at`
			: [],
		homeIds.length
			? sql`select id, home_id, email, role, entity_scope, invited_by, expires_at,
			             accepted_at, accepted_by, revoked_at, created_at
			      from home_invites where home_id = any(${homeIds}) order by home_id, created_at`
			: [],
		homeIds.length
			? sql`select home_id, entity_id, granted_by, expires_at, created_at
			      from home_entity_grants where home_id = any(${homeIds}) order by home_id, entity_id`
			: [],
		homeIds.length
			? sql`select id, home_id, user_id, actor, channel, action, entity_ids, guarded,
			             confirmed_by, risk, outcome, detail, created_at
			      from home_action_log where home_id = any(${homeIds}) order by home_id, created_at`
			: [],
		homeIds.length
			? sql`select id, home_id, user_id, domain, service, service_data, entity_ids, risk,
			             summary, source, expires_at, redeemed_at, redeemed_by, expired_at,
			             outcome, created_at
			      from home_confirmations where home_id = any(${homeIds}) order by home_id, created_at`
			: [],
		// Homes somebody else owns that you are a member of, and invitations
		// addressed to you: both are data about you that a query scoped to homes
		// you own would miss entirely.
		sql`select m.home_id, m.role, m.entity_scope, m.created_at
		    from home_members m where m.user_id = ${userId} order by m.created_at`,
	]);

	return {
		generated_at: new Date().toISOString(),
		notice:
			'This is everything three.ws stores about your connected homes. Your Home Assistant access token is deliberately not included: it is a key to your building and it does not belong in a downloads folder. Room names, device names and device states are absent because we never store them.',
		inventory: INVENTORY,
		homes_you_own: homes,
		memberships: invitesToMe,
		members,
		invites,
		grants,
		action_log: actions,
		confirmations,
	};
}

// ── Deletion ─────────────────────────────────────────────────────────────────

/**
 * Delete one home and everything that points at it.
 *
 * The foreign keys cascade, and this function does not take that on trust: it
 * counts the dependent rows before and after and returns both, so a caller (and
 * a test) can assert the cascade actually fired rather than assuming a schema
 * comment is still true.
 *
 * Ownership is a SQL filter, never a JavaScript check after the fact: a home
 * that is not yours returns `{ deleted: false }` and is indistinguishable from
 * one that does not exist.
 *
 * @param {string} homeId
 * @param {string} userId
 * @returns {Promise<{ deleted: boolean, before: object, after: object }>}
 */
export async function deleteHome(homeId, userId) {
	const owned = await sql`select id from home_connections where id = ${homeId} and user_id = ${userId}`;
	if (!owned[0]) return { deleted: false, before: {}, after: {} };

	const before = await countHomeRows(homeId);

	// audit_log has no home_id column and no cascade: its rows reference the home
	// by resource_id and survive both the home and the account. Remove ours by
	// hand, or "delete my home" leaves the home's address in a table with a
	// 365-day window.
	await sql`delete from audit_log where resource_id = ${homeId} and action like '%home%'`;

	await sql`delete from home_connections where id = ${homeId} and user_id = ${userId}`;

	const after = await countHomeRows(homeId);
	return { deleted: true, before, after };
}

/**
 * Every home row this user has, gone, plus the identifiers of theirs that live
 * in other people's homes.
 *
 * This is the function an account-deletion path calls. The platform does not
 * have one yet (see docs/home-privacy.md), which is exactly why this is a
 * standalone, idempotent export rather than an inline block inside a handler
 * that does not exist: when the platform-wide path lands, it calls this.
 *
 * Idempotent by construction. Every statement is a delete or an update filtered
 * on the user, so a second run finds nothing and changes nothing.
 *
 * @param {string} userId
 * @param {{ email?: string|null }} [options] the account's email, so invitations
 *   addressed to it on other people's homes are removed too
 * @returns {Promise<{ before: object, after: object, homes: number }>}
 */
export async function deleteAllHomeDataForUser(userId, { email = null } = {}) {
	const before = await countUserRows(userId, email);

	const homes = await sql`select id from home_connections where user_id = ${userId}`;
	const homeIds = homes.map((h) => h.id);

	if (homeIds.length) {
		await sql`delete from audit_log where resource_id = any(${homeIds}) and action like '%home%'`;
		// One statement, one cascade: home_members, home_invites,
		// home_entity_grants and home_action_log all hang off this row.
		await sql`delete from home_connections where user_id = ${userId}`;
	}

	// Memberships and grants this user holds on homes they do NOT own. The grant
	// cascade added in 20260903180000 handles grants; membership is its own row.
	await sql`delete from home_members where user_id = ${userId}`;
	await sql`delete from home_entity_grants where granted_by = ${userId}`;
	await sql`delete from home_invites where invited_by = ${userId}`;
	if (email) {
		await sql`delete from home_invites where lower(email) = lower(${email})`;
	}

	// audit_log.user_id is SET NULL on account deletion rather than removed, so a
	// row naming a home this user disconnected would outlive them by the audit
	// table's own 365 day window. Remove the lane's rows for this user outright.
	await sql`delete from audit_log where user_id = ${userId} and action like '%home%'`;

	// A confirmation this user MINTED on another household's home cascades with
	// their account (user_id references users on delete cascade). One they
	// REDEEMED does not: redeemed_by is set null, which keeps the household's
	// record of "somebody approved this" while removing the pointer to who.
	// That is the same trade the action log makes below, and it is deliberate.

	// The action log's actor columns carry no foreign key (an actor can be an
	// agent with no account), so nothing removes a departed user's id from
	// another household's log. Scrub rather than delete: the household that owns
	// those rows is entitled to its own history, and it does not need to keep a
	// pointer to a person who left.
	await sql`update home_action_log set user_id = null where user_id = ${userId}`;
	await sql`update home_action_log set confirmed_by = null where confirmed_by = ${userId}`;

	const after = await countUserRows(userId, email);
	return { before, after, homes: homeIds.length };
}

/**
 * Per-table row counts for one home. The proof behind every deletion claim in
 * docs/home-privacy.md, and the shape a test asserts on.
 *
 * @param {string} homeId
 * @returns {Promise<Record<string, number>>}
 */
export async function countHomeRows(homeId) {
	const [conn, members, invites, grants, actions, confirmations, audit] = await Promise.all([
		sql`select count(*)::int as n from home_connections   where id = ${homeId}`,
		sql`select count(*)::int as n from home_members       where home_id = ${homeId}`,
		sql`select count(*)::int as n from home_invites       where home_id = ${homeId}`,
		sql`select count(*)::int as n from home_entity_grants where home_id = ${homeId}`,
		sql`select count(*)::int as n from home_action_log    where home_id = ${homeId}`,
		sql`select count(*)::int as n from home_confirmations where home_id = ${homeId}`,
		sql`select count(*)::int as n from audit_log where resource_id = ${homeId} and action like '%home%'`,
	]);
	return {
		home_connections: conn[0].n,
		home_members: members[0].n,
		home_invites: invites[0].n,
		home_entity_grants: grants[0].n,
		home_action_log: actions[0].n,
		home_confirmations: confirmations[0].n,
		audit_log: audit[0].n,
	};
}

/**
 * Per-table row counts for everything one account touches, owned or not.
 *
 * @param {string} userId
 * @param {string|null} [email]
 * @returns {Promise<Record<string, number>>}
 */
export async function countUserRows(userId, email = null) {
	const [conn, members, invites, invitesToEmail, grants, actorRows, confirmRows, confirmations, audit] =
		await Promise.all([
			sql`select count(*)::int as n from home_connections where user_id = ${userId}`,
			sql`select count(*)::int as n from home_members where user_id = ${userId}`,
			sql`select count(*)::int as n from home_invites where invited_by = ${userId}`,
			email
				? sql`select count(*)::int as n from home_invites where lower(email) = lower(${email})`
				: Promise.resolve([{ n: 0 }]),
			sql`select count(*)::int as n from home_entity_grants where granted_by = ${userId}`,
			sql`select count(*)::int as n from home_action_log where user_id = ${userId}`,
			sql`select count(*)::int as n from home_action_log where confirmed_by = ${userId}`,
			sql`select count(*)::int as n from home_confirmations where user_id = ${userId} or redeemed_by = ${userId}`,
			sql`select count(*)::int as n from audit_log where action like '%home%' and user_id = ${userId}`,
		]);
	return {
		home_connections: conn[0].n,
		home_members: members[0].n,
		home_invites_sent: invites[0].n,
		home_invites_to_email: invitesToEmail[0].n,
		home_entity_grants: grants[0].n,
		home_action_log_actor: actorRows[0].n,
		home_action_log_confirmed_by: confirmRows[0].n,
		home_confirmations: confirmations[0].n,
		audit_log: audit[0].n,
	};
}

/**
 * The plain-language summary the privacy screen renders: what we hold about you
 * right now, in numbers, next to the inventory that explains each one.
 *
 * @param {string} userId
 * @param {string|null} [email]
 * @returns {Promise<object>}
 */
export async function summarizeHomeData(userId, email = null) {
	const [counts, homes] = await Promise.all([
		countUserRows(userId, email),
		withDbRetry(
			() => sql`
				select id, label, status, created_at, revoked_at,
				       action_log_retention_days, action_log_retention_reason
				from home_connections
				where user_id = ${userId}
				order by created_at
			`,
			{ timeoutMs: 5_000 },
		),
	]);
	return {
		inventory: INVENTORY,
		counts,
		homes,
		retention: {
			default_days: DEFAULT_ACTION_LOG_RETENTION_DAYS,
			min_days: MIN_ACTION_LOG_RETENTION_DAYS,
			max_days: MAX_ACTION_LOG_RETENTION_DAYS,
			reason_required_above_days: DEFAULT_ACTION_LOG_RETENTION_DAYS,
		},
	};
}
