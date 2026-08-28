// Live HTTP against the three.ws Knock API. No fixtures, no mocks.
//
// Two modes on one client. Public calls go out unauthenticated, because a door
// is public. Owner calls attach the Bearer credential and fail early with a
// clear config error when there is none, rather than surfacing a bare upstream
// 401 the agent cannot act on.

import { HTTP_TIMEOUT_MS, THREE_WS_API_KEY, THREE_WS_BASE, USER_AGENT } from '../config.js';

export class MissingCredentialError extends Error {
	constructor() {
		super(
			'No three.ws credential configured. Set THREE_WS_API_KEY to an API key (sk_live_… / sk_test_…) ' +
				'or OAuth access token for the account whose door you are managing. Reading a door, browsing ' +
				'the directory, knocking, and reading a receipt all work without one.',
		);
		this.code = 'missing_credential';
		this.status = 401;
	}
}

export async function apiRequest(path, { method = 'GET', query, body, auth = false } = {}) {
	if (auth && !THREE_WS_API_KEY) throw new MissingCredentialError();

	const url = path.startsWith('http') ? new URL(path) : new URL(`${THREE_WS_BASE}${path}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null || value === '') continue;
			url.searchParams.set(key, String(value));
		}
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: {
				accept: 'application/json',
				'user-agent': USER_AGENT,
				// Capital-B "Bearer " so the server's CSRF guard exempts the write.
				...(auth ? { authorization: `Bearer ${THREE_WS_API_KEY}` } : {}),
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (err?.name === 'AbortError') {
			throw Object.assign(new Error(`three.ws ${path} timed out after ${HTTP_TIMEOUT_MS}ms`), { code: 'timeout' });
		}
		throw Object.assign(new Error(`three.ws ${path} request failed: ${err?.message || err}`), { code: 'network_error' });
	}
	clearTimeout(timer);

	const text = await res.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}
	if (!res.ok) {
		throw Object.assign(new Error(data?.error_description || data?.message || `three.ws ${path} returned ${res.status}`), {
			code: data?.error || 'upstream_error',
			status: res.status,
			body: data,
		});
	}
	return data;
}
