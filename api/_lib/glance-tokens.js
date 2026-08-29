/**
 * Glance widget tokens.
 * ---------------------
 * The credential a native widget carries. A session cookie cannot do this
 * job: Android's WorkManager fetches the card from an OS process with no
 * cookie jar, and a widget stays on a phone long after every session that
 * minted it has expired. So the owner mints a token on /glance, the app
 * stores it, and the widget presents it on every read.
 *
 * Scope is the whole design: a token reads its owner's glance card and
 * nothing else. It is never accepted by any other endpoint, which is why it
 * lives in its own table with its own prefix rather than in the OAuth or API
 * key stores.
 *
 *   plaintext = "glw_" + 32 url-safe characters   (shown once, at creation)
 *   prefix    = the first 10 characters           (what the revoke list shows)
 *   hash      = hex(sha256(plaintext))            (the only thing stored)
 */

import { sql } from './db.js';
import { randomToken, sha256 } from './crypto.js';

export const GLANCE_TOKEN_PREFIX = 'glw_';
export const GLANCE_TOKEN_PLATFORMS = new Set(['android', 'macos', 'ios', 'other']);
// Enough for every device a person owns, small enough that a script cannot
// fill the table through one account.
export const GLANCE_TOKEN_MAX_ACTIVE = 12;
const TOKEN_RE = /^glw_[A-Za-z0-9_-]{32}$/;
// `last_used_at` is for the owner's revoke list ("last seen 2h ago"), so a
// write per read would be waste: it moves at most once per five minutes.
const LAST_USED_STEP_MS = 5 * 60 * 1000;

/** @param {unknown} value */
export function looksLikeGlanceToken(value) {
	return typeof value === 'string' && TOKEN_RE.test(value);
}

/** Deterministic plaintext shape, so the tests can pin it without a database. */
export function mintPlaintext() {
	return GLANCE_TOKEN_PREFIX + randomToken(24);
}

export function prefixOf(plaintext) {
	return plaintext.slice(0, 10);
}

function rowView(row) {
	return {
		id: row.id,
		prefix: row.token_prefix,
		label: row.label,
		platform: row.platform,
		agentId: row.agent_id || null,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at || null,
	};
}

/**
 * Mint a token for a signed-in owner. Returns the plaintext exactly once.
 * @param {{ userId: string, label?: string, platform?: string, agentId?: string|null }} input
 */
export async function createGlanceToken({ userId, label, platform, agentId = null }) {
	const [{ active }] = await sql`
		SELECT count(*)::int AS active
		FROM glance_widget_tokens
		WHERE user_id = ${userId} AND revoked_at IS NULL
	`;
	if (active >= GLANCE_TOKEN_MAX_ACTIVE) {
		const err = new Error(`you already have ${GLANCE_TOKEN_MAX_ACTIVE} linked widgets; revoke one first`);
		err.code = 'too_many_tokens';
		err.status = 409;
		throw err;
	}

	const plaintext = mintPlaintext();
	const hash = await sha256(plaintext);
	const cleanLabel = String(label || '').trim().slice(0, 60) || 'Home screen widget';
	const cleanPlatform = GLANCE_TOKEN_PLATFORMS.has(platform) ? platform : 'other';

	const [row] = await sql`
		INSERT INTO glance_widget_tokens (user_id, token_hash, token_prefix, label, platform, agent_id)
		VALUES (${userId}, ${hash}, ${prefixOf(plaintext)}, ${cleanLabel}, ${cleanPlatform}, ${agentId})
		RETURNING id, token_prefix, label, platform, agent_id, created_at, last_used_at
	`;
	return { ...rowView(row), token: plaintext };
}

/**
 * Resolve a presented token to its owner. Returns null for anything that is
 * not a live token: wrong shape, unknown, or revoked. The caller renders the
 * "link again" card for null; it never learns which of those it was, and
 * neither does the network.
 *
 * @param {unknown} plaintext
 * @returns {Promise<null | { id: string, userId: string, agentId: string|null }>}
 */
export async function resolveGlanceToken(plaintext) {
	if (!looksLikeGlanceToken(plaintext)) return null;
	const hash = await sha256(plaintext);
	const [row] = await sql`
		SELECT id, user_id, agent_id, last_used_at
		FROM glance_widget_tokens
		WHERE token_hash = ${hash} AND revoked_at IS NULL
		LIMIT 1
	`;
	if (!row) return null;

	const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
	if (Date.now() - lastUsed > LAST_USED_STEP_MS) {
		// Best effort: the read must not wait on, or fail with, a bookkeeping write.
		sql`UPDATE glance_widget_tokens SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {});
	}
	return { id: row.id, userId: row.user_id, agentId: row.agent_id || null };
}

/** The owner's live tokens, newest first, for the revoke list on /glance. */
export async function listGlanceTokens(userId) {
	const rows = await sql`
		SELECT id, token_prefix, label, platform, agent_id, created_at, last_used_at
		FROM glance_widget_tokens
		WHERE user_id = ${userId} AND revoked_at IS NULL
		ORDER BY created_at DESC
	`;
	return rows.map(rowView);
}

/**
 * Revoke one of the owner's tokens. Returns false when the id is not theirs
 * or is already revoked, which the endpoint reports as 404 in both cases:
 * revocation is idempotent and never confirms another account's ids.
 */
export async function revokeGlanceToken({ userId, tokenId }) {
	const rows = await sql`
		UPDATE glance_widget_tokens
		SET revoked_at = now()
		WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL
		RETURNING id
	`;
	return rows.length > 0;
}

/**
 * Point an existing token at a different owned agent (or back to "first
 * owned" with null). The widget picks the change up on its next refresh.
 */
export async function pinGlanceToken({ userId, tokenId, agentId }) {
	const rows = await sql`
		UPDATE glance_widget_tokens
		SET agent_id = ${agentId}
		WHERE id = ${tokenId} AND user_id = ${userId} AND revoked_at IS NULL
		RETURNING id
	`;
	return rows.length > 0;
}
