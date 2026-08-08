// Walk-room registry, the in-process lookup that lets the internal
// /internal/announce webhook (called by an operator during a live event, signed
// with the shared secret) reach every live walk_world room on this instance and
// broadcast an announcement to the players in it.
//
// Mirrors stage-registry.js, with one difference: walk_world rooms are matched
// with filterBy(['coin','tier']) and can also shard past maxClients, so more
// than one live room can exist per coin. A Set of live rooms (filtered by coin
// at broadcast time) is therefore the right shape, not a Map keyed by coin.
// Under horizontal scaling (Redis driver) an announce only reaches the rooms
// hosted on the instance that received the webhook; the caller fans out to
// every instance or accepts partial delivery, nothing here breaks.

const _rooms = new Set(); // live WalkRoom instances on this process

export function registerWalkRoom(room) {
	if (room) _rooms.add(room);
}

export function unregisterWalkRoom(room) {
	_rooms.delete(room);
}

// Live walk rooms, optionally narrowed to one coin's world(s). An empty coin
// matches every room, which is what a platform-wide event announcement wants.
export function liveWalkRooms(coin = '') {
	const rooms = [..._rooms];
	if (!coin) return rooms;
	return rooms.filter((r) => r?.state?.coin === coin);
}
