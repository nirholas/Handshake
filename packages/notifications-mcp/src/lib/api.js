// Real HTTP access to the three.ws notifications API. No mocks, no fixtures: every
// call is a live, authenticated request to THREE_WS_BASE. The agent's Bearer
// credential is attached here (single HTTP client, single auth path); errors are
// normalized into one shape so tool handlers can surface a clean message +
// status to the MCP client.

import { THREE_WS_BASE, HTTP_TIMEOUT_MS, USER_AGENT, THREE_WS_API_KEY } from '../config.js';

// Thrown before any request when the server has no credential. Every notification
// route is account-scoped, so a missing key is a config error, not an upstream 401.
export class MissingCredentialError extends Error {
	constructor() {
		super(
			'No three.ws credential configured. Set THREE_WS_API_KEY to a three.ws API key ' +
				'(sk_live_… / sk_test_…) or OAuth access token for the account owner. Every notification ' +
				'endpoint is account-scoped and rejects unauthenticated requests.',
		);
		this.code = 'missing_credential';
		this.status = 401;
	}
}

/**
 * Call a three.ws notifications endpoint and return its parsed JSON body. The
 * Authorization: Bearer header is added here from THREE_WS_API_KEY. Bearer auth
 * is exempt from CSRF server-side, so writes work without a CSRF token.
 *
 * @param {string} path  Endpoint path beginning with `/` (e.g. `/api/notifications`).
 * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown }} [opts]
 * @returns {Promise<any>} Parsed JSON response.
 * @throws {MissingCredentialError} when no credential is configured.
 * @throws {Error} with `.code` ('timeout' | 'network_error' | 'upstream_error'),
 *   and on upstream errors `.status` + `.body`.
 */
export async function apiRequest(path, { method = 'GET', query, body } = {}) {
	if (!THREE_WS_API_KEY) throw new MissingCredentialError();

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
				// Capital-B "Bearer " — the server's CSRF guard exempts requests on
				// this exact prefix, so authenticated writes need no CSRF token.
				authorization: `Bearer ${THREE_WS_API_KEY}`,
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
		const message = data?.message || data?.error || `three.ws ${path} returned HTTP ${res.status}`;
		throw Object.assign(new Error(message), { code: 'upstream_error', status: res.status, body: data });
	}
	return data;
}
