// Client for /api/knock/*.
//
// Two audiences, one file. The owner-side calls go through apiFetch (session
// cookie, CSRF on writes, redirect on an expired session, src/api.js). The
// public calls (a door, the directory, sending a free knock, reading a receipt)
// use plain fetch on purpose: the door page has to work for a visitor with no
// account, and pulling the auth layer in would make an anonymous read look like
// a signed-out error.

import { apiFetch } from '../api.js';

async function unwrap(res) {
	const text = await res.text();
	let data = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = null;
		}
	}
	if (!res.ok) {
		const err = new Error(data?.error_description || data?.message || `request failed (${res.status})`);
		err.status = res.status;
		err.code = data?.error || data?.code || null;
		err.data = data;
		throw err;
	}
	return data;
}

// `allowAnonymous` matters more here than it looks. /knock is a public page
// with a private half: a signed-out visitor must see the directory, not be
// bounced to /login by apiFetch's session guard the moment the owner-side read
// comes back 401. Reads therefore tolerate anonymity and surface the 401 to the
// caller, which renders the sign-in card. Writes keep the redirect, because
// saving a door while signed out really does mean "go sign in".
async function authed(path, { method = 'GET', body = null, allowAnonymous = false } = {}) {
	return unwrap(
		await apiFetch(path, {
			method,
			allowAnonymous,
			...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
		}),
	);
}

async function open(path, { method = 'GET', body = null } = {}) {
	return unwrap(
		await fetch(path, {
			method,
			...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
		}),
	);
}

export const knockApi = {
	// Public
	door: (handle) => open(`/api/knock/door?handle=${encodeURIComponent(handle)}`),
	directory: (limit = 60) => open(`/api/knock/directory?limit=${limit}`),
	send: (body) => open('/api/knock/send', { method: 'POST', body }),
	// The escrowed lane. Called only AFTER the sender's own wallet has parked
	// the payment on-chain: this endpoint reads that escrow and delivers, it
	// never takes money, so calling it without one simply answers 402.
	escrowed: (body) => open('/api/knock/escrowed', { method: 'POST', body }),
	receipt: (url) => open(url.replace(/^https?:\/\/[^/]+/, '')),
	// Copy one escrow's on-chain state into the row that caches it. Open to
	// anybody because it can only ever write what the program already recorded.
	syncEscrow: (knock) => open('/api/knock/escrow-sync', { method: 'POST', body: { knock } }),

	// Owner
	settings: () => authed('/api/knock/settings', { allowAnonymous: true }),
	saveSettings: (patch) => authed('/api/knock/settings', { method: 'PATCH', body: patch }),
	inbox: ({ limit = 30, before = null, status = null } = {}) => {
		const params = new URLSearchParams({ limit: String(limit) });
		if (before) params.set('before', before);
		if (status) params.set('status', status);
		return authed(`/api/knock/inbox?${params.toString()}`, { allowAnonymous: true });
	},
	actOn: (id, patch) => authed(`/api/knock/inbox/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
};
