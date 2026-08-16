/**
 * The X OAuth scope sets, and the guards that hold each lane to its own set.
 * ------------------------------------------------------------------------
 * Two very different things are called "connecting X" on this platform:
 *
 *   posting  : the agent writes to the owner's timeline (api/_lib/x-post.js,
 *              api/share/x.js, the agent editor's Social tab). Needs write.
 *   seeding  : the owner's public posts are read once and distilled into agent
 *              memory (api/agents/[id]/memory-seed-x.js). Needs read only.
 *
 * Asking for one authorization that covers both means an owner who only wants
 * their agent to sound like them has to hand over permission to post as them
 * first. The consent screen then promises "seeding only uses the read
 * permissions", which is true of the seeder and beside the point for the grant
 * the owner just signed. So the connect endpoint takes a scope set by name, the
 * seeding card asks for the read-only one, and each lane checks the connection
 * it is about to use actually carries the scopes it needs.
 *
 * `offline.access` is in both sets because it is what returns a refresh token;
 * without it a connection dies at the first token expiry and every lane starts
 * failing an hour after it was set up.
 */

/** Scope sets a connect request may ask for, by name. */
export const X_SCOPE_SETS = Object.freeze({
	/** Everything the platform's X surfaces use: read, post, and attach media. */
	full: Object.freeze(['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access']),
	/** Memory seeding's set: the profile and the timeline, nothing that writes. */
	read: Object.freeze(['tweet.read', 'users.read', 'offline.access']),
});

/** The default when a connect request names no set. */
export const X_DEFAULT_SCOPE_SET = 'full';

/** Reading the profile and recent posts: what the seeder calls. */
export const X_SEED_REQUIRED_SCOPES = Object.freeze(['tweet.read', 'users.read']);

/** Writing a post: what publishTweet calls. */
export const X_POST_REQUIRED_SCOPES = Object.freeze(['tweet.write']);

/**
 * Resolve a scope-set name from untrusted input (a query param) to the set
 * itself. An unknown or missing name resolves to the full set, so a typo can
 * never silently narrow what a posting surface asks for.
 *
 * @param {unknown} name
 * @returns {{name: string, scopes: readonly string[], value: string}}
 */
export function resolveScopeSet(name) {
	const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
	const resolved = Object.prototype.hasOwnProperty.call(X_SCOPE_SETS, key)
		? key
		: X_DEFAULT_SCOPE_SET;
	const scopes = X_SCOPE_SETS[resolved];
	return { name: resolved, scopes, value: scopes.join(' ') };
}

/**
 * The scopes X actually granted a connection, from the space-separated string
 * stored on social_connections.scopes.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseScopes(raw) {
	if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string' && s).map((s) => s.trim());
	return String(raw ?? '')
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Which of `required` a connection is missing.
 *
 * An empty granted list means "not recorded", not "granted nothing": every
 * connection made before the callback started storing scopes has one. Those are
 * reported as missing nothing, so a legacy connection keeps working and the
 * guard only ever refuses a connection whose recorded scopes really are too
 * narrow.
 *
 * @param {unknown} granted raw scopes column, or an array
 * @param {readonly string[]} required
 * @returns {string[]}
 */
export function missingScopes(granted, required) {
	const have = new Set(parseScopes(granted));
	if (!have.size) return [];
	return (required || []).filter((s) => !have.has(s));
}

/**
 * True when a connection's recorded scopes cover `required` (or are unrecorded).
 *
 * @param {unknown} granted
 * @param {readonly string[]} required
 */
export function hasScopes(granted, required) {
	return missingScopes(granted, required).length === 0;
}

/**
 * True when a connection is known to be read-only: its scopes are recorded and
 * do not include the write scope. Drives the UI copy that tells an owner why a
 * read-only connection cannot post, and which reconnect to offer.
 *
 * @param {unknown} granted
 */
export function isReadOnlyConnection(granted) {
	const have = parseScopes(granted);
	if (!have.length) return false;
	return !have.includes('tweet.write');
}
