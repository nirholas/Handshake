// The connection store: where a user's homes live, and the only module that
// ever touches a home's credential.
//
// Everything here takes and returns plain objects. No HTTP, no `res`, no Home
// Assistant. The runtime (api/_lib/home/runtime.js) and the endpoints
// (api/home/*) sit above it, and neither of them is allowed to write SQL
// against these tables or to read a credential column.
//
// Two invariants this module enforces so its callers cannot get them wrong:
//
//   1. A connection row is NEVER returned with `access_token_enc` on it. The
//      safe projection is built in SQL (SAFE_COLUMNS below), so a new caller
//      cannot accidentally spread a credential into a response body.
//   2. Ownership is a `where user_id = $1` inside every query, never a check in
//      JavaScript after the row is already in hand. A miss and a
//      wrong-owner both return null, so the store never leaks the existence of
//      another user's home.
//
// `getDecryptedToken` is the single exception to (1), which is exactly why it is
// its own export with its own name: every call site that can hold a plaintext
// key to someone's front door is one grep away.

import { createHash } from 'node:crypto';

import { normalizeBaseUrl } from '../../../packages/home-bridge/src/url.js';
import { logAudit } from '../audit.js';
import { sql } from '../db.js';
import { withDbRetry } from '../db-retry.js';
import { decryptSecret, encryptSecret } from '../secret-box.js';
import { scrubSecrets } from '../scrub-secrets.js';
import { safeError } from './log-safe.js';

/** Statuses the schema's check constraint accepts. */
export const HOME_STATUS = Object.freeze({
	PENDING: 'pending',
	CONNECTED: 'connected',
	UNREACHABLE: 'unreachable',
	AUTH_FAILED: 'auth_failed',
	REVOKED: 'revoked',
});

const VALID_STATUSES = new Set(Object.values(HOME_STATUS));
const VALID_TRANSPORTS = new Set(['direct', 'relay']);
const LABEL_MAX = 120;
const DETAIL_MAX = 500;

// Every column a caller may see. `access_token_enc` is absent on purpose and
// must stay absent: this list is the mechanical guarantee behind invariant (1).
const SAFE_COLUMNS = sql`
	id, user_id, label, base_url, token_fingerprint, transport, relay_id,
	capabilities, status, status_detail, last_ok_at, last_error_at,
	created_at, updated_at, revoked_at
`;

// The same projection, qualified, for the reads that join home_members.
//
// Those reads answer "may this caller see this home" through membership rather
// than through `user_id` equality, and a join makes the bare list ambiguous:
// home_members carries a user_id of its own. `c.user_id` stays on the row and
// keeps meaning what it always meant, the account that connected the house,
// which is why order 12 could add membership beside this column instead of
// rewriting it.
const SAFE_COLUMNS_C = sql`
	c.id, c.user_id, c.label, c.base_url, c.token_fingerprint, c.transport, c.relay_id,
	c.capabilities, c.status, c.status_detail, c.last_ok_at, c.last_error_at,
	c.created_at, c.updated_at, c.revoked_at
`;

/** sha256 of the token, hex. Never reversible, only comparable. */
export function fingerprintToken(token) {
	return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Record that a user connected a house, or refresh the record they already had.
 *
 * The URL is normalized before it is written, because the unique index is over
 * the normalized form: "https://home.example.com/" and "home.example.com" are
 * the same house and must collide, not stack up as two live rows.
 *
 * Re-connecting the same house is an update, not a duplicate: a token rotation
 * lands as new ciphertext and a new fingerprint on the SAME row, so the grants
 * and the action log that reference it survive the rotation.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.label what the user calls this home
 * @param {string} input.baseUrl as typed; normalized before write
 * @param {string} input.token a Home Assistant long-lived access token
 * @param {'direct'|'relay'} [input.transport]
 * @param {string|null} [input.relayId]
 * @param {object} [input.capabilities] measured at connect, never assumed
 * @param {string} [input.status]
 * @param {string|null} [input.statusDetail]
 * @returns {Promise<object>} the credential-free row
 */
export async function createConnection({
	userId,
	label,
	baseUrl,
	token,
	transport = 'direct',
	relayId = null,
	capabilities = {},
	status = HOME_STATUS.PENDING,
	statusDetail = null,
}) {
	if (!userId) throw new Error('createConnection: userId is required');
	if (!token) throw new Error('createConnection: a Home Assistant access token is required');
	if (!VALID_TRANSPORTS.has(transport)) throw new Error(`createConnection: unknown transport "${transport}"`);
	if (!VALID_STATUSES.has(status)) throw new Error(`createConnection: unknown status "${status}"`);

	const { http } = normalizeBaseUrl(baseUrl);
	const cleanLabel = normalizeLabel(label) || hostOf(http);
	const enc = await encryptSecret(String(token));
	const fingerprint = fingerprintToken(token);

	const rows = await sql`
		insert into home_connections
			(user_id, label, base_url, access_token_enc, token_fingerprint,
			 transport, relay_id, capabilities, status, status_detail)
		values
			(${userId}, ${cleanLabel}, ${http}, ${enc}, ${fingerprint},
			 ${transport}, ${relayId}, ${JSON.stringify(capabilities)}::jsonb, ${status}, ${truncate(statusDetail, DETAIL_MAX)})
		on conflict (user_id, base_url) where revoked_at is null
		do update set
			label             = excluded.label,
			access_token_enc  = excluded.access_token_enc,
			token_fingerprint = excluded.token_fingerprint,
			transport         = excluded.transport,
			relay_id          = excluded.relay_id,
			capabilities      = excluded.capabilities,
			status            = excluded.status,
			status_detail     = excluded.status_detail,
			updated_at        = now()
		returning ${SAFE_COLUMNS}
	`;
	return rows[0];
}

/**
 * One user's live homes, newest first, with no credential on any of them.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function listConnections(userId) {
	if (!userId) return [];
	return sql`
		select ${SAFE_COLUMNS_C}, m.role, m.entity_scope
		from home_connections c
		join home_members m on m.home_id = c.id and m.user_id = ${userId}
		where c.revoked_at is null
		order by c.created_at desc
	`;
}

/**
 * One home, ownership-checked in SQL.
 *
 * Returns null both when the id does not exist and when the caller is not in
 * its household, so a caller cannot distinguish the two and turn this into an
 * oracle for "does this home id exist". The endpoint layer maps null to 404,
 * never 403.
 *
 * Entitlement is MEMBERSHIP, not ownership: the join against home_members is
 * what lets a partner, a house sitter or a colleague reach a home somebody else
 * connected. There is deliberately no `or c.user_id = ${userId}` beside it. Such
 * a branch would look like belt and braces and would in fact be the bypass, and
 * it is unnecessary: the migration's trigger gives every connection an owner row
 * the moment it is inserted, so the account that connected a house is always in
 * its household.
 *
 * The returned row carries `role` and `entity_scope`, because every caller that
 * needs the home also needs to know what this member may do with it, and a
 * second round trip to find out is a second place to forget.
 *
 * @param {string} id
 * @param {string} userId
 * @param {{ includeRevoked?: boolean }} [options]
 * @returns {Promise<object|null>} the credential-free row plus `role` and `entity_scope`
 */
export async function getConnection(id, userId, { includeRevoked = false } = {}) {
	if (!id || !userId || !isUuid(id)) return null;
	const rows = includeRevoked
		? await sql`
			select ${SAFE_COLUMNS_C}, m.role, m.entity_scope
			from home_connections c
			join home_members m on m.home_id = c.id and m.user_id = ${userId}
			where c.id = ${id}
		`
		: await sql`
			select ${SAFE_COLUMNS_C}, m.role, m.entity_scope
			from home_connections c
			join home_members m on m.home_id = c.id and m.user_id = ${userId}
			where c.id = ${id} and c.revoked_at is null
		`;
	return rows[0] || null;
}

/**
 * The ONLY function that returns a plaintext home credential.
 *
 * Its own export, its own name, so `grep -rn getDecryptedToken api/` is a
 * complete list of the places a key to someone's house can be held in memory.
 * It writes nothing and logs nothing: not the token, not a prefix of it, not its
 * length. A revoked home has an empty ciphertext and returns null rather than
 * throwing, because "this home was disconnected" is an ordinary state the caller
 * has to render, not an exception.
 *
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<{ token: string, baseUrl: string, transport: string, relayId: string|null, fingerprint: string }|null>}
 */
export async function getDecryptedToken(id, userId) {
	if (!id || !userId || !isUuid(id)) return null;
	const rows = await sql`
		select c.access_token_enc, c.base_url, c.transport, c.relay_id, c.token_fingerprint
		from home_connections c
		join home_members m on m.home_id = c.id and m.user_id = ${userId}
		where c.id = ${id} and c.revoked_at is null
	`;
	const row = rows[0];
	if (!row || !row.access_token_enc) return null;
	return {
		token: await decryptSecret(row.access_token_enc),
		baseUrl: row.base_url,
		transport: row.transport,
		relayId: row.relay_id,
		fingerprint: row.token_fingerprint,
	};
}

/**
 * Record the outcome of a handshake against the house.
 *
 * Called by the runtime on every connect attempt, so the connect UI can explain
 * a broken home without opening a socket of its own. `capabilities` is merged
 * rather than replaced: a failed MCP probe must not erase the WebSocket
 * capabilities a successful one measured a minute earlier.
 *
 * Ownership is not checked here on purpose: the caller has already proved it by
 * holding the id, and the runtime reaches this from a background reconnect where
 * no user is present. It is not reachable from an endpoint without a prior
 * ownership-checked read.
 *
 * @param {string} id
 * @param {{ status: string, statusDetail?: string|null, capabilities?: object|null }} update
 * @returns {Promise<object|null>} the credential-free row
 */
export async function recordHandshake(id, { status, statusDetail = null, capabilities = null } = {}) {
	if (!id || !isUuid(id)) return null;
	if (!VALID_STATUSES.has(status)) throw new Error(`recordHandshake: unknown status "${status}"`);
	const ok = status === HOME_STATUS.CONNECTED;
	const rows = await sql`
		update home_connections set
			status        = ${status},
			status_detail = ${truncate(statusDetail, DETAIL_MAX)},
			capabilities  = case when ${capabilities === null}::boolean then capabilities
			                     else capabilities || ${JSON.stringify(capabilities || {})}::jsonb end,
			last_ok_at    = case when ${ok}::boolean then now() else last_ok_at end,
			last_error_at = case when ${ok}::boolean then last_error_at else now() end,
			updated_at    = now()
		where id = ${id} and revoked_at is null
		returning ${SAFE_COLUMNS}
	`;
	return rows[0] || null;
}

/**
 * Disconnect a home: soft delete the row, destroy the credential.
 *
 * The row survives so the action log keeps its lineage (an operator must still
 * be able to answer "what did my agent do in my house last Tuesday" about a
 * house they have since removed). The ciphertext does not survive: it is
 * overwritten with '' in the same statement, so a database dump taken after a
 * revoke cannot be replayed against the user's front door.
 *
 * Idempotent: revoking twice succeeds twice, and the second call reports
 * `alreadyRevoked` rather than pretending it did the work again.
 *
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<{ revoked: boolean, alreadyRevoked: boolean, home: object|null }>}
 */
export async function revokeConnection(id, userId) {
	if (!id || !userId || !isUuid(id)) return { revoked: false, alreadyRevoked: false, home: null };

	const rows = await sql`
		update home_connections set
			revoked_at       = now(),
			access_token_enc = '',
			status           = ${HOME_STATUS.REVOKED},
			status_detail    = 'Disconnected by the owner.',
			updated_at       = now()
		where id = ${id} and user_id = ${userId} and revoked_at is null
		returning ${SAFE_COLUMNS}
	`;

	if (rows[0]) {
		// The platform audit trail lives in a different table, with a different
		// (365 day) window and a different set of readers, and its rows outlive
		// the account that made them (audit_log.user_id is set null on deletion,
		// not removed). So it gets the correlation key and nothing else: never the
		// base URL, which is the address of somebody's building, and never the
		// label, which is a name a person chose ("Mum's flat"). The home id is
		// enough to join back to the row while it exists, and meaningless after.
		logAudit({
			userId,
			action: 'revoke_home_connection',
			resourceId: id,
			meta: { transport: rows[0].transport, status: rows[0].status },
		});
		return { revoked: true, alreadyRevoked: false, home: rows[0] };
	}

	// Either it was already revoked, or it is not this user's. Distinguish those
	// for the caller (one is a 200, the other a 404) without a second read that
	// could leak existence: the ownership filter is still in the query.
	const existing = await getConnection(id, userId, { includeRevoked: true });
	return { revoked: false, alreadyRevoked: Boolean(existing), home: existing };
}

/**
 * Grant the agent a standing allowance for ONE entity in one home.
 *
 * Per entity and per home, never per domain: letting the agent open the office
 * door is not letting it open the front door. Re-granting refreshes the expiry
 * on the existing row so a user extending "just for tonight" does not
 * accumulate rows.
 *
 * @param {{ homeId: string, entityId: string, grantedBy: string, expiresAt?: Date|string|null }} input
 * @returns {Promise<object>}
 */
export async function grantEntity({ homeId, entityId, grantedBy, expiresAt = null }) {
	if (!homeId || !isUuid(homeId)) throw new Error('grantEntity: homeId is required');
	if (!grantedBy) throw new Error('grantEntity: grantedBy is required');
	const entity = normalizeEntityId(entityId);
	const rows = await sql`
		insert into home_entity_grants (home_id, entity_id, granted_by, expires_at)
		values (${homeId}, ${entity}, ${grantedBy}, ${expiresAt ? new Date(expiresAt) : null})
		on conflict (home_id, entity_id) do update set
			granted_by = excluded.granted_by,
			expires_at = excluded.expires_at,
			created_at = now()
		returning id, home_id, entity_id, granted_by, expires_at, created_at
	`;
	return rows[0];
}

/**
 * Withdraw a standing allowance. Idempotent.
 * @param {{ homeId: string, entityId: string }} input
 * @returns {Promise<boolean>} true when a grant was actually removed
 */
export async function revokeGrant({ homeId, entityId }) {
	if (!homeId || !isUuid(homeId)) return false;
	const rows = await sql`
		delete from home_entity_grants
		where home_id = ${homeId} and entity_id = ${normalizeEntityId(entityId)}
		returning id
	`;
	return rows.length > 0;
}

/**
 * The live allowances for a home.
 *
 * Expiry is filtered in SQL, not in JavaScript: an expired grant that reaches a
 * caller is an entity the gate would wave through, and "the caller remembered to
 * check the date" is not a security boundary.
 *
 * @param {string} homeId
 * @returns {Promise<object[]>}
 */
export async function listGrants(homeId) {
	if (!homeId || !isUuid(homeId)) return [];
	return sql`
		select id, home_id, entity_id, granted_by, expires_at, created_at
		from home_entity_grants
		where home_id = ${homeId}
		  and (expires_at is null or expires_at > now())
		order by entity_id asc
	`;
}

/**
 * The set of entity ids the gate may wave through for this home, ready to hand
 * to `createAllowList` in the bridge.
 * @param {string} homeId
 * @returns {Promise<string[]>}
 */
export async function listAllowedEntities(homeId) {
	const grants = await listGrants(homeId);
	return grants.map((g) => g.entity_id);
}

/**
 * Record a write the platform performed against a house.
 *
 * Fire and forget, mirroring api/_lib/audit.js: it never throws and never blocks
 * a response, because a logging failure must not be able to stop a light from
 * turning on. Use `logHomeActionNow` where the row IS the deliverable.
 *
 * @param {object} entry see logHomeActionNow
 */
export function logHomeAction(entry) {
	queueMicrotask(() => {
		logHomeActionNow(entry);
	});
}

/**
 * The same write, awaitable, resolving true when the row landed.
 *
 * @param {object} entry
 * @param {string} entry.homeId
 * @param {string|null} [entry.userId] null when an agent principal acted with no account
 * @param {'user'|'agent'|'voice'|'mcp'|'automation'} entry.actor
 * @param {'websocket'|'mcp'} entry.channel
 * @param {string} entry.action `light.turn_on`, or the MCP tool name
 * @param {string[]} [entry.entityIds] resolved targets, not the raw argument
 * @param {boolean} [entry.guarded] did the physical-action gate fire
 * @param {string|null} [entry.confirmedBy] who said yes, when it did
 * @param {'security'|'physical'|null} [entry.risk]
 * @param {'ok'|'refused'|'failed'} entry.outcome
 * @param {object|null} [entry.detail] small; no state dumps. Passed through
 *   scrubSecrets() before it lands, so a caller that spreads an options object
 *   carrying a token into it writes '[redacted]' rather than a key to a house.
 * @returns {Promise<boolean>}
 */
export async function logHomeActionNow({
	homeId,
	userId = null,
	actor,
	channel,
	action,
	entityIds = [],
	guarded = false,
	confirmedBy = null,
	risk = null,
	outcome,
	detail = null,
}) {
	try {
		await withDbRetry(
			() => sql`
				insert into home_action_log
					(home_id, user_id, actor, channel, action, entity_ids, guarded, confirmed_by, risk, outcome, detail)
				values
					(${homeId}, ${userId}, ${actor}, ${channel}, ${action},
					 ${entityIds.map(String)}, ${Boolean(guarded)}, ${confirmedBy}, ${risk}, ${outcome},
					 ${detail === null ? null : JSON.stringify(scrubSecrets(detail))}::jsonb)
			`,
			{ timeoutMs: 5_000 },
		);
		return true;
	} catch (err) {
		// Ids and a service name only. `action` is a Home Assistant service or an
		// MCP tool name ('light.turn_on'), never a friendly name, and the entity
		// ids are deliberately absent: correlating a dropped write needs the home
		// and the verb, not the list of things in somebody's bedroom. A driver
		// error can echo a bound parameter, so it goes through safeError() like
		// every other error in the lane: a code, and a message with every host
		// stripped out of it.
		console.warn('[home-store] action log insert dropped', { homeId, action, outcome, ...safeError(err) });
		return false;
	}
}

/**
 * What the agent did in this house, most recent first.
 * @param {string} homeId
 * @param {{ limit?: number, before?: Date|string|null }} [options]
 * @returns {Promise<object[]>}
 */
export async function listHomeActions(homeId, { limit = 50, before = null } = {}) {
	if (!homeId || !isUuid(homeId)) return [];
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	return before
		? sql`
			select id, home_id, user_id, actor, channel, action, entity_ids, guarded,
			       confirmed_by, risk, outcome, detail, created_at
			from home_action_log
			where home_id = ${homeId} and created_at < ${new Date(before)}
			order by created_at desc
			limit ${cap}
		`
		: sql`
			select id, home_id, user_id, actor, channel, action, entity_ids, guarded,
			       confirmed_by, risk, outcome, detail, created_at
			from home_action_log
			where home_id = ${homeId}
			order by created_at desc
			limit ${cap}
		`;
}

function normalizeLabel(label) {
	return typeof label === 'string' ? label.trim().slice(0, LABEL_MAX) : '';
}

function normalizeEntityId(entityId) {
	const id = String(entityId || '').trim().toLowerCase();
	if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id)) {
		throw new Error(`grantEntity: "${entityId}" is not an entity id. Grants are per entity, never per domain.`);
	}
	return id;
}

function truncate(value, max) {
	if (value === null || value === undefined) return null;
	return String(value).slice(0, max);
}

function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return 'Home';
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
	return UUID_RE.test(String(value));
}
