// Shared presence pub/sub keys for the multi-server account system (Tasks 16/20/23).
//
// These name Colyseus `presence` channels — a process-local emitter in
// single-instance mode, or Redis when REDIS_URI is set — so they work whether the
// host runs one process or many. (Account-level *friends* presence lives in the
// social hub, keyed by verified account id; it is not stored here.)

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
