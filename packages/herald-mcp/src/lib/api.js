// Real HTTP access to the three.ws herald rail. No mocks, no fixtures: every
// call is a live, authenticated request to THREE_WS_BASE. The Bearer credential
// is attached here (single HTTP client, single auth path) and errors are
// normalized into one shape so tool handlers surface a clean message + status.

import { THREE_WS_BASE, HTTP_TIMEOUT_MS, USER_AGENT, THREE_WS_API_KEY } from '../config.js';

// Thrown before any request when the server has no credential. The rail is
// account-scoped, so a missing key is a config error, not an upstream 401.
export class MissingCredentialError extends Error {
	constructor() {
		super(
			'No three.ws credential configured. Set THREE_WS_API_KEY to a three.ws API key ' +
				'(sk_live_… / sk_test_…) carrying the herald:announce scope, or an OAuth access token ' +
				'for the same account. Create one at https://three.ws/dashboard/developers.',
		);
		this.code = 'missing_credential';
		this.status = 401;
	}
}

/**
 * Call a three.ws endpoint and return its parsed JSON body.
 *
 * @param {string} path Endpoint path beginning with `/`.
 * @param {{ method?: string, body?: unknown }} [opts]
 * @returns {Promise<any>}
 * @throws {MissingCredentialError} when no credential is configured.
 * @throws {Error} with `.code` ('timeout' | 'network_error' | 'upstream_error'),
 *   and on upstream errors `.status` + `.body`.
 */
export async function apiRequest(path, { method = 'GET', body } = {}) {
	if (!THREE_WS_API_KEY) throw new MissingCredentialError();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(`${THREE_WS_BASE}${path}`, {
			method,
			headers: {
				accept: 'application/json',
				'user-agent': USER_AGENT,
				// Capital-B "Bearer ": the server's CSRF guard exempts requests on
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
		const message =
			data?.error_description || data?.message || data?.error || `three.ws ${path} returned HTTP ${res.status}`;
		throw Object.assign(new Error(message), { code: 'upstream_error', status: res.status, body: data });
	}
	return data;
}
