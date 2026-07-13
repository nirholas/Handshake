// Cross-version message compatibility for every room.
//
// Colyseus's default behavior for a message type with no registered handler is
// to close the connection with WS_CLOSE_WITH_ERROR (4002). During a rolling
// deploy the static frontend and this game server are never updated in the
// same instant, so a newer client speaking one new message type ("profileReq")
// to an older room build would get its whole session killed — and, worse, the
// pre-2026-07-13 client misread that 4002 as a play-pass eviction and bounced
// the player to a "session expired" sign-in gate (the /play kick-loop bug).
//
// Registering a wildcard handler replaces that kill-the-connection fallback:
// unknown message types are logged (rate-limited per session) and ignored, so
// a version-skewed client degrades to a missing feature instead of a dead
// session. Real handlers registered via onMessage(type, …) always win — the
// wildcard only sees types nothing else claimed.

/**
 * Install a tolerant fallback for unregistered message types on a room.
 * Call once in onCreate, after (or before — order is irrelevant, the wildcard
 * is only consulted when no named handler matches) the room's onMessage set.
 *
 * @param {import('@colyseus/core').Room} room
 * @param {string} label room name used in the log line, e.g. 'walk_world'
 */
export function installUnknownMessageGuard(room, label) {
	const seen = new Map(); // sessionId → Set of already-logged unknown types
	room.onMessage('*', (client, type) => {
		const key = client.sessionId;
		let types = seen.get(key);
		if (!types) {
			// Bound the ledger for rooms that outlive thousands of sessions (StageRoom
			// never auto-disposes) — losing dedup history is fine, leaking memory isn't.
			if (seen.size >= 500) seen.clear();
			types = new Set();
			seen.set(key, types);
		}
		// Log each unknown type once per session — enough to spot a skewed or
		// misbehaving client in the logs without letting it flood them.
		if (types.size < 16 && !types.has(String(type))) {
			types.add(String(type));
			console.warn(`[${label}] ignoring unknown message type "${String(type).slice(0, 64)}" from ${key} (client build ahead of or behind this server)`);
		}
	});
}

// Close code for an active play-pass eviction (pass expired without a refresh
// or the wallet fell below the token floor). Deliberately NOT 4002 — that is
// Colyseus's own WS_CLOSE_WITH_ERROR and overloading it made real server
// errors look like session expiry. The client keys on the close REASON
// ('play_pass_required'), so this code is informational; it just has to stay
// clear of Colyseus's reserved codes (4000, 4002, 4201, 4202).
export const PLAY_PASS_EVICT_CODE = 4402;
