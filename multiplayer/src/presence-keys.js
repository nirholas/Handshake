// Shared presence keys for the multi-server account registry (Task 23).
//
// Both GameRoom (writer) and index.js (the /presence + /servers HTTP readers)
// reference these, so they live in one place to stay in lock-step. The store is
// the Colyseus `presence` instance — a process-local map in single-instance
// mode, or Redis when REDIS_URI is set — so the same keys work whether the host
// runs one process or many.

// Hash of currently-online accounts: field = account id (playerId), value =
// JSON { server, realm, name, sid, ts }. Lets a friends panel (or /presence)
// resolve which server+realm any account is on without joining its room.
export const PRESENCE_HASH = 'kg:presence';

// Pub/sub channel a room subscribes to per online account, so a fresh login of
// the same account anywhere on the cluster can evict the stale session and
// enforce one active session per account (the Task 16 integrity rule).
export function evictChannel(playerId) {
	return `kg:evict:${playerId}`;
}

// Pub/sub channel a room subscribes to per online account so a marketplace sale
// settled in another realm/room can deliver the seller's gold proceeds to their
// live session immediately (Task 20). The nudge just triggers a drain of the
// durable payout queue, so delivery is exactly-once whether the seller is online
// (nudge) or claims them on next join.
export function payoutChannel(playerId) {
	return `kg:payout:${playerId}`;
}

// Close code the server uses when it disconnects a session because the same
// account logged in elsewhere. The client routes on this to show a "signed in
// on another server" screen instead of silently reconnecting into a fight with
// the new session.
export const TAKEOVER_CLOSE_CODE = 4001;
