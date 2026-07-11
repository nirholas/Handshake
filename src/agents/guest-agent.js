// Ephemeral "your agent" for signed-out visitors — the identity behind the
// first-five-seconds companion. Every visitor gets a named agent immediately;
// signing up "claims" it (the /create-agent wizard prefills from this draft
// and POSTs the real agent). This is the agent-identity sibling of
// src/guest-avatar.js, which stages a GLB the same way for the create flow.
//
// A draft is a tiny localStorage record — no wallet, no DB row, no network.
// The name is provisional: server-side uniqueness is per-account and only
// checked at claim time (POST /api/agents returns 409 on collision, and the
// wizard already handles renames).

import { randomAgentName } from '../shared/agent-names.js';

const KEY = '3dagent:guest-agent';

// Companion roster ids (walk-sdk/src/roster.js) that are light enough to be a
// first-visit default — small embedded-rig GLBs, no retarget cost.
const STARTER_AVATARS = ['robot', 'fox', 'guide', 'cz'];

// The walk companion reads its avatar choice from this legacy key
// (walk-sdk/src/config.js); we seed it so the corner agent renders the same
// body the draft records, but never clobber a choice the visitor already made.
const WALK_AVATAR_KEY = 'walk:companion:avatar';

function read() {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const rec = JSON.parse(raw);
		if (!rec || typeof rec !== 'object' || !rec.id || !rec.name) return null;
		return rec;
	} catch {
		return null;
	}
}

function write(rec) {
	try {
		localStorage.setItem(KEY, JSON.stringify(rec));
	} catch {
		/* storage unavailable (private mode) — the caller keeps the in-memory copy */
	}
	return rec;
}

/** The current guest-agent draft, or null. Synchronous and cheap. */
export function peekGuestAgent() {
	return read();
}

/**
 * Return the guest-agent draft, minting one on first call: a random two-word
 * name plus a light companion avatar. Idempotent — subsequent calls return the
 * stored record.
 * @returns {{ id: string, name: string, avatarId: string, createdAt: number }}
 */
export function ensureGuestAgent() {
	const existing = read();
	if (existing) return existing;
	const rec = {
		id: cryptoRandomId(),
		name: randomAgentName(),
		avatarId: STARTER_AVATARS[Math.floor(Math.random() * STARTER_AVATARS.length)],
		createdAt: Date.now(),
	};
	write(rec);
	try {
		if (!localStorage.getItem(WALK_AVATAR_KEY)) {
			localStorage.setItem(WALK_AVATAR_KEY, rec.avatarId);
		}
	} catch {
		/* companion falls back to its own default */
	}
	return rec;
}

/** Merge a patch into the draft (e.g. a rename). No-op when nothing is staged. */
export function updateGuestAgent(patch) {
	const rec = read();
	if (!rec || !patch) return rec;
	return write({ ...rec, ...patch });
}

/** Drop the draft — called after the wizard creates the real agent. */
export function clearGuestAgent() {
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* ignore */
	}
}

function cryptoRandomId() {
	const bytes = new Uint8Array(8);
	(globalThis.crypto || window.crypto).getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
