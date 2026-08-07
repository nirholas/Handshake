// Comped platform access: the explicit allowlist of accounts that get every
// $THREE-gated feature without holding, without linking a wallet, and without
// paying per use.
//
// Why this exists: hold-to-access (three-access.js + require-three.js) is the
// platform's monetization lever, but a small set of accounts are deliberately
// exempt: the owner's own accounts, and creators/partners the owner has granted
// lifetime access. Encoding that as data in ONE module keeps the exemption
// auditable in git and revocable in one edit, instead of scattering
// `if (user.id === …)` branches through every gated endpoint.
//
// Where it applies: every enforced gate resolves through requireFeatureAccess
// (api/_lib/require-three.js), so the check lives there and automatically covers
// forge.high (High-quality generation), forge.gameready (Game-Ready GLB/FBX
// export), and any gate added later. The read endpoint GET /api/three/access
// applies it too, so the UI renders unlocked instead of showing a lock the
// server would not actually enforce.
//
// What it grants: the TOP tier level, so a comped account clears every gate
// regardless of that gate's minLevel, plus the top free-lane rate multiplier.
// It never bypasses BYOK (a caller's own vendor key is still their own key) and
// never touches the abuse ceilings that protect real platform spend.
//
// What it costs: nothing on the anonymous path. The lookup is guarded by
// hasSessionCookie(), so a request with no session never issues a query. The
// zero-latency anonymous free lane stays exactly as fast as it was.
//
// Extending it: add the handle to COMPED_ACCOUNTS below, or set the env var
// THREE_COMP_ACCOUNTS to a comma-separated list of handles / emails / user ids.
// Env entries are MERGED with the built-ins, never replace them, so an env typo
// can't silently revoke a comp that was granted in code.
//
// Which identifiers are trusted, and why: `username`, `email`, and `id` are all
// uniquely indexed on the users table, and a username-registered account's handle
// is also the local part of the platform-issued `<handle>@users.three.ws.local`
// address that api/auth/[action].js mints for it. `display_name` is deliberately
// NOT matched: it is user-settable and carries no uniqueness constraint, so
// honoring it would let anyone comp themselves by renaming.

import { TIERS } from './three-tier.js';
import { getSessionUser, hasSessionCookie } from './auth.js';

// Accounts granted full platform access, by handle. Matching is case-insensitive
// and also accepts an email or user id, so an env-supplied entry can be any
// stable identifier the account is known by.
export const COMPED_ACCOUNTS = Object.freeze([
	'nichisarealnigga',
]);

// The email domain the platform issues to username-registered accounts (see
// handleRegister in api/auth/[action].js). Addresses in it are server-minted and
// unique, so their local part is a trustworthy stand-in for the handle on an
// account whose `username` column was never populated.
const PLATFORM_EMAIL_DOMAIN = 'users.three.ws.local';

// The tier a comped account resolves to: the top of the ladder, so it clears
// every gate no matter how high that gate's minLevel is set later.
export const COMP_TIER = TIERS[TIERS.length - 1];

/** The granted tier level (top of the ladder). */
export const COMP_TIER_LEVEL = COMP_TIER.level;

function normalize(value) {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The full set of comped identifiers: the built-in list merged with anything in
 * THREE_COMP_ACCOUNTS. Read per call so an env change takes effect on the next
 * request without a redeploy (the list is tiny; this is a few string ops).
 * @returns {Set<string>} lowercased usernames / emails / user ids
 */
export function compedIdentifiers() {
	const set = new Set(COMPED_ACCOUNTS.map(normalize).filter(Boolean));
	const extra = typeof process !== 'undefined' ? process.env?.THREE_COMP_ACCOUNTS : null;
	if (extra) {
		for (const entry of String(extra).split(',')) {
			const id = normalize(entry);
			if (id) set.add(id);
		}
	}
	return set;
}

/**
 * The identifiers a user account can be matched by: its username, its email, its
 * id, and (when the email is a platform-issued `@users.three.ws.local` address)
 * the handle in that address's local part. Every one of these is unique per
 * account, so none of them can be claimed by a second user.
 * @param {{ id?: string, username?: string, email?: string } | null} user
 * @returns {string[]} lowercased identifiers (empty for a missing user)
 */
export function identifiersForUser(user) {
	if (!user) return [];
	const out = [normalize(user.username), normalize(user.email), normalize(user.id)];
	const email = normalize(user.email);
	const at = email.lastIndexOf('@');
	if (at > 0 && email.slice(at + 1) === PLATFORM_EMAIL_DOMAIN) {
		out.push(email.slice(0, at));
	}
	return out.filter(Boolean);
}

/**
 * Is this resolved session user comped? The grant survives an email or username
 * change as long as the listed identifier still resolves to the account.
 * @param {{ id?: string, username?: string, email?: string } | null} user
 * @returns {boolean}
 */
export function isCompedUser(user) {
	const ids = compedIdentifiers();
	if (ids.size === 0) return false;
	return identifiersForUser(user).some((id) => ids.has(id));
}

/**
 * Resolve the caller's comped status from the request. Never throws: an auth or
 * DB hiccup resolves to "not comped", which just means the normal hold-or-pay
 * gate applies (fail closed on the perk, never fail the request).
 *
 * Anonymous requests short-circuit on the cookie check with zero queries.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} [res]
 * @returns {Promise<{ comped: boolean, user: object|null }>}
 */
export async function resolveCompAccess(req, res) {
	if (!hasSessionCookie(req)) return { comped: false, user: null };
	let user = null;
	try {
		user = await getSessionUser(req, res);
	} catch {
		return { comped: false, user: null };
	}
	return { comped: isCompedUser(user), user };
}
