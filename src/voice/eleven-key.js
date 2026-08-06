// Client-side store for a user's own ElevenLabs API key (BYOK).
//
// The key lives only in this browser's localStorage and is sent as the
// `x-eleven-key` header on voice requests. The server resolves it per request
// (api/_lib/elevenlabs.js resolveElevenKey) and never stores it: BYOK calls
// run on the user's own ElevenLabs account, bypassing the platform's free
// quota, credit metering, and daily clone cap.

const STORAGE_KEY = 'three_eleven_key_v1';

/** @returns {string|null} the saved key, or null when none is saved. */
export function getElevenKey() {
	try {
		return (localStorage.getItem(STORAGE_KEY) || '').trim() || null;
	} catch {
		return null;
	}
}

/** Save (non-empty) or clear (empty) the key. Returns the stored value. */
export function setElevenKey(key) {
	const k = String(key || '').trim();
	try {
		if (k) localStorage.setItem(STORAGE_KEY, k);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Storage unavailable (private mode): the key just won't persist.
	}
	return k || null;
}

export function clearElevenKey() {
	setElevenKey('');
}

/** Merge the BYOK header into a fetch headers object when a key is saved. */
export function withElevenKey(headers = {}) {
	const key = getElevenKey();
	return key ? { ...headers, 'x-eleven-key': key } : headers;
}

/** "sk_12…89ab" style preview for UI display; never render the full key. */
export function maskElevenKey(key = getElevenKey()) {
	if (!key) return '';
	if (key.length <= 8) return `${key.slice(0, 2)}…`;
	return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
