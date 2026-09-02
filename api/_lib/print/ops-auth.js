// @ts-check
// The authorization gate for the Materialize operator console.
//
// Why this is not api/_lib/ops-auth.js: that gate is deliberately OPEN in
// development when no OPS_SECRET is configured, which is correct for a
// read-only health board on a developer's laptop. These endpoints are not that.
// They read shipping addresses (the first real PII this platform stores), they
// move orders through a state machine, and they mark refunds. So this gate
// FAILS CLOSED everywhere, dev included: no credential, no access.
//
// Three doors, strongest first:
//
//   1. A signed-in platform admin. The requireAdmin model (wallet in
//      ADMIN_ADDRESSES, the built-in owner address, or is_admin in the DB).
//      Carries a real user id, which is what makes an operator transition
//      attributable on the timeline.
//   2. A signed-in user on the operator allowlist: PRINT_OPERATORS, a comma
//      separated list of user ids or wallet addresses. This exists so
//      fulfillment can be staffed without handing out platform admin, which is
//      a much larger privilege than "may mark a job shipped".
//   3. `x-ops-secret` (or Authorization: Bearer) matching OPS_SECRET, the same
//      dedicated ops credential the health boards use and deliberately never
//      CRON_SECRET. This door has no user identity, so its actions land on the
//      timeline as `ops-secret` rather than as a person: use it for scripts,
//      not for daily operations.
//
// The page is never the boundary. Every endpoint calls requireOperator().

import { constantTimeEquals } from '../crypto.js';
import { getSessionUser } from '../auth.js';
import { isAdminUser } from '../admin.js';
import { error } from '../http.js';

/** Entries of PRINT_OPERATORS, trimmed. User ids or wallet addresses. */
function operatorAllowlist() {
	return (process.env.PRINT_OPERATORS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

// Wallet addresses are compared case-insensitively for EVM hex (checksum casing
// varies per wallet and identifies the same account) and literally otherwise,
// because Solana base58 IS case sensitive and folding it widens the match.
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** @param {string} entry @param {string} candidate */
function identityMatches(entry, candidate) {
	if (!entry || !candidate) return false;
	if (EVM_ADDRESS_RE.test(entry) && EVM_ADDRESS_RE.test(candidate)) {
		return entry.toLowerCase() === candidate.toLowerCase();
	}
	return entry === candidate;
}

/**
 * True when this signed-in user is a fulfillment operator by allowlist.
 * @param {{ id?: string, wallet_address?: string }} user
 */
export function isAllowlistedOperator(user) {
	if (!user) return false;
	const list = operatorAllowlist();
	if (list.length === 0) return false;
	return list.some((entry) => identityMatches(entry, String(user.id || '')) || identityMatches(entry, String(user.wallet_address || '')));
}

/**
 * Resolve the operator decision without writing a response.
 * @param {{ headers?: Record<string, string|undefined> }} req
 * @returns {Promise<{ ok: boolean, actor: string, actorId: string|null, via: string }>}
 */
export async function authorizeOperator(req) {
	try {
		const user = await getSessionUser(req);
		if (user) {
			if (await isAdminUser(user)) {
				return { ok: true, actor: user.wallet_address || `user:${user.id}`, actorId: user.id, via: 'admin' };
			}
			if (isAllowlistedOperator(user)) {
				return { ok: true, actor: user.wallet_address || `user:${user.id}`, actorId: user.id, via: 'allowlist' };
			}
		}
	} catch {
		/* no or invalid session — fall through to the secret door */
	}

	const secret = process.env.OPS_SECRET;
	if (secret) {
		const auth = req.headers?.['authorization'];
		const presented =
			req.headers?.['x-ops-secret'] ||
			(typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '');
		if (presented && constantTimeEquals(String(presented), secret)) {
			return { ok: true, actor: 'ops-secret', actorId: null, via: 'ops-secret' };
		}
	}

	// Fails closed, including in development. Fulfillment reads PII.
	return { ok: false, actor: '', actorId: null, via: '' };
}

/**
 * The call every operator endpoint starts with. Writes the 401/403 itself and
 * returns null, so a handler that forgets to check the return value cannot
 * accidentally serve data: it will throw on the null instead.
 *
 * @param {any} req
 * @param {any} res
 * @returns {Promise<{ actor: string, actorId: string|null, via: string }|null>}
 */
export async function requireOperator(req, res) {
	const verdict = await authorizeOperator(req);
	if (verdict.ok) return { actor: verdict.actor, actorId: verdict.actorId, via: verdict.via };
	error(
		res,
		403,
		'forbidden',
		'fulfillment operator access required: sign in as a platform admin or an allowlisted operator',
	);
	return null;
}
