// Shared helpers for the signal-marketplace endpoints (api/signals/*).
//
// Auth model: every write is owner-authenticated (session cookie or bearer) and
// scoped to an agent the caller owns. Reads of the public directory are open;
// reads of a paid stream require entitlement (publisher or active subscriber).

import { error } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';

export const NETWORKS = new Set(['mainnet', 'devnet']);
export const normNetwork = (n) => (n === 'devnet' ? 'devnet' : 'mainnet');

/** Resolve the calling user (session or bearer). Writes 401 + returns null on miss. */
export async function requireUser(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	return { userId: session?.id ?? bearer.userId, viaSession: !!session };
}

/**
 * Load an agent the caller owns. Writes the error response and returns
 * { error:true } on any failure; returns { row, meta } on success.
 */
export async function loadOwnedAgent(req, res, userId, agentId) {
	if (!agentId || typeof agentId !== 'string') { error(res, 400, 'invalid_agent', 'agent_id required'); return { error: true }; }
	const [row] = await sql`
		SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
	`.catch(() => []);
	if (!row) { error(res, 404, 'not_found', 'agent not found'); return { error: true }; }
	if (row.user_id !== userId) { error(res, 403, 'forbidden', 'not your agent'); return { error: true }; }
	return { row, meta: { ...(row.meta || {}) } };
}

/**
 * Parse a `bigserial` row id (signal_feeds.id, signal_subscriptions.id).
 * Returns a positive safe integer, or null when the input is not one.
 *
 * Handing a non-numeric id straight to Postgres turns a caller typo into an
 * `invalid input syntax for type bigint` 500 with a Sentry alert behind it,
 * when the honest answer is a 400. Every endpoint that reads an id off the
 * query string or a JSON body runs it through here first.
 */
export function parseRowId(value) {
	if (value == null || typeof value === 'boolean' || Array.isArray(value)) return null;
	const raw = String(value).trim();
	if (!/^\d+$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Kebab slug from arbitrary text, bounded. */
export function slugify(text, max = 40) {
	return String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)+/g, '')
		.slice(0, max) || 'feed';
}

/** A stable, collision-resistant feed slug from the agent name + id. */
export function feedSlug(name, agentId, network) {
	const base = slugify(name);
	const tail = String(agentId).replace(/-/g, '').slice(0, 8);
	return network === 'devnet' ? `${base}-${tail}-dev` : `${base}-${tail}`;
}
