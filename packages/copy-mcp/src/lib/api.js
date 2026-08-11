// Real HTTP access to the three.ws copy-trading API. No mocks, no fixtures —
// every call is a live request to THREE_WS_BASE. Account-scoped calls attach the
// copier's bearer credential (THREE_WS_API_KEY); the API resolves the copier and
// scopes every read/write to their own subscriptions. Errors are normalized into
// a single shape so tool handlers can surface a clean message + status.

import { THREE_WS_BASE, HTTP_TIMEOUT_MS, USER_AGENT, THREE_WS_API_KEY } from '../config.js';

/**
 * Call a three.ws HTTP endpoint and return its parsed JSON body.
 *
 * @param {string} path  Endpoint path beginning with `/` (e.g. `/api/copy/subscriptions`).
 * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown, auth?: boolean }} [opts]
 *   `auth` defaults to true — the call attaches `Authorization: Bearer <key>` and
 *   throws `missing_credential` when no key is configured. Pass `auth:false` for
 *   the genuinely public endpoints (e.g. a leader's aggregate earnings).
 * @returns {Promise<any>} Parsed JSON response.
 * @throws {Error} with `.code` ('missing_credential' | 'timeout' | 'network_error'
 *   | 'upstream_error'), and on upstream errors `.status` + `.body`.
 */
export async function apiRequest(path, { method = 'GET', query, body, auth = true } = {}) {
	if (auth && !THREE_WS_API_KEY) {
		throw Object.assign(
			new Error(
				'This action is account-scoped. Set THREE_WS_API_KEY to a three.ws API key ' +
					'(sk_live_… / sk_test_…) or OAuth access token — mint one at ' +
					'https://three.ws/settings/api-keys.',
			),
			{ code: 'missing_credential', status: 401 },
		);
	}

	const url = new URL(`${THREE_WS_BASE}${path}`);
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
				...(auth && THREE_WS_API_KEY ? { authorization: `Bearer ${THREE_WS_API_KEY}` } : {}),
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (err?.name === 'AbortError') {
			throw Object.assign(new Error(`three.ws ${path} timed out after ${HTTP_TIMEOUT_MS}ms`), {
				code: 'timeout',
			});
		}
		throw Object.assign(new Error(`three.ws ${path} request failed: ${err?.message || err}`), {
			code: 'network_error',
		});
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
		const message =
			data?.error_description || data?.message || data?.error || `three.ws ${path} returned HTTP ${res.status}`;
		throw Object.assign(new Error(message), { code: 'upstream_error', status: res.status, body: data });
	}
	return data;
}
