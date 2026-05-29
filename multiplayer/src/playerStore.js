// Cross-realm player persistence.
//
// Colyseus rooms are independent, but a player's inventory, gold, skills, bank,
// and cosmetics must travel between realms (and survive a disconnect/reconnect
// within a session). This module is a process-wide store keyed by a stable
// playerId — the wallet address once authenticated, otherwise a guest id the
// client persists in localStorage.
//
// Single-process only. When the multiplayer server scales horizontally, swap
// this Map for Redis (the get/save interface stays identical).

const store = new Map(); // playerId -> SavedState

const TTL_MS = 1000 * 60 * 60 * 6; // forget idle guests after 6h to bound memory

/**
 * @typedef {object} SavedState
 * @property {string} name
 * @property {number} color
 * @property {number} gold
 * @property {{item:string,qty:number}[]} inv
 * @property {{item:string,qty:number}[]} hotbar
 * @property {{item:string,qty:number}[]} bank
 * @property {number} activeSlot
 * @property {{woodcutting:number,mining:number,fishing:number,cooking:number,combat:number}} xp
 * @property {string} cosmetic
 * @property {number} savedAt
 */

export function loadPlayer(playerId) {
	const s = store.get(playerId);
	if (!s) return null;
	if (Date.now() - s.savedAt > TTL_MS) { store.delete(playerId); return null; }
	return s;
}

export function savePlayer(playerId, state) {
	store.set(playerId, { ...state, savedAt: Date.now() });
}

export function hasPlayer(playerId) {
	return store.has(playerId);
}

// Periodic sweep so abandoned guest records don't accumulate forever.
setInterval(() => {
	const now = Date.now();
	for (const [id, s] of store) if (now - s.savedAt > TTL_MS) store.delete(id);
}, 1000 * 60 * 30).unref?.();
