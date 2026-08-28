// Typed-ish client for /api/companion/*.
//
// apiFetch (src/api.js) already carries the session cookie, mints the CSRF
// token for writes, retries idempotent reads, and redirects on an expired
// session, so everything here is a thin shape on top of it. Errors surface as
// Error objects carrying the server's `code` and human message, because every
// caller on the page renders that message to the user rather than a generic
// "something went wrong".

import { apiFetch } from '../api.js';

async function request(path, { method = 'GET', body = null, allowAnonymous = false } = {}) {
	const res = await apiFetch(path, {
		method,
		allowAnonymous,
		...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
	});
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
		// The platform's error envelope is { error: <machine code>,
		// error_description: <sentence for a human> } (api/_lib/http.js). Reading
		// `error` as the message is how a user ends up looking at
		// "source_disconnected" instead of being told what to do about it.
		const err = new Error(data?.error_description || data?.message || `request failed (${res.status})`);
		err.status = res.status;
		err.code = data?.error || data?.code || null;
		throw err;
	}
	return data;
}

export const companionApi = {
	settings: () => request('/api/companion/settings'),
	updateSettings: (patch) => request('/api/companion/settings', { method: 'PATCH', body: patch }),
	rotateToken: () => request('/api/companion/settings', { method: 'POST', body: { rotate_token: true } }),

	sources: () => request('/api/companion/sources'),
	connect: (body) => request('/api/companion/sources', { method: 'POST', body }),
	updateSource: (id, patch) => request(`/api/companion/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
	disconnect: (id) => request(`/api/companion/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
	pollSource: (id) => request(`/api/companion/sources/${encodeURIComponent(id)}`, { method: 'POST' }),
	pollAll: () => request('/api/companion/poll', { method: 'POST' }),

	contacts: () => request('/api/companion/contacts'),
	saveContact: (body) => request('/api/companion/contacts', { method: 'POST', body }),
	deleteContact: (id) => request(`/api/companion/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

	events: ({ limit = 30, before = null, loudOnly = false, threshold = 0 } = {}) => {
		const params = new URLSearchParams({ limit: String(limit) });
		if (before) params.set('before', before);
		if (loudOnly) params.set('min_importance', String(threshold));
		return request(`/api/companion/events?${params.toString()}`);
	},
	reply: (id, text) => request(`/api/companion/events/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { text } }),
	markEvent: (id, patch) => request(`/api/companion/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

	avatars: () => request('/api/avatars?limit=100'),
};
