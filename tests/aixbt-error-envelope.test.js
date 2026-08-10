/**
 * api/aixbt/_shared.js: the error envelope every /api/aixbt/* handler responds
 * through.
 *
 * The classification here is the difference between an actionable empty state
 * and a dead end, so it is pinned:
 *
 *   - A missing key is a 503 carrying a `setup` hint the UI renders verbatim.
 *   - aixbt REJECTING our key (401/403) is the same class of deployment fault,
 *     not a client-auth failure. Regression guard: it used to relay the raw
 *     401 to a caller of a public, credential-free endpoint, telling them to
 *     authenticate against a door they hold no key to (and with no
 *     WWW-Authenticate header, which RFC 9110 requires of any 401).
 *   - Upstream throttling / outages keep their descriptive code + status.
 *   - Anything genuinely internal is sanitized to a 500 with a support ref.
 */

import { describe, it, expect } from 'vitest';
import { respondAixbtError } from '../api/aixbt/_shared.js';
import { AixbtNotConfiguredError } from '../api/_lib/aixbt.js';

// Minimal ServerResponse stand-in: case-insensitive header store + end capture.
function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; },
		get payload() { return JSON.parse(this.body); },
	};
}

/** The shape api/_lib/aixbt.js throws for a non-2xx upstream response. */
function upstreamError(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

describe('respondAixbtError', () => {
	it('answers a missing key with 503 and the setup hint', () => {
		const res = fakeRes();
		respondAixbtError(res, new AixbtNotConfiguredError());
		expect(res.statusCode).toBe(503);
		expect(res.payload.error).toBe('aixbt_not_configured');
		expect(res.payload.setup).toContain('AIXBT_API_KEY');
	});

	for (const status of [401, 403]) {
		it(`treats an upstream ${status} as a deployment fault, not a client one`, () => {
			const res = fakeRes();
			respondAixbtError(res, upstreamError('aixbt /intel failed: Unauthorized', status, 'aixbt_unauthorized'));
			expect(res.statusCode).toBe(503);
			// The code is preserved so existing clients keep their typed branch.
			expect(res.payload.error).toBe('aixbt_unauthorized');
			expect(res.payload.setup).toContain('AIXBT_API_KEY');
		});
	}

	it('relays upstream throttling with its own status and code', () => {
		const res = fakeRes();
		respondAixbtError(res, upstreamError('aixbt /projects failed: rate limited', 429, 'aixbt_rate_limited'));
		expect(res.statusCode).toBe(429);
		expect(res.payload.error).toBe('aixbt_rate_limited');
		expect(res.payload.error_description).toContain('rate limited');
	});

	it('relays an upstream outage as 504 without sanitizing the reason', () => {
		const res = fakeRes();
		respondAixbtError(res, upstreamError('aixbt unreachable: fetch failed', 504, 'aixbt_upstream_error'));
		expect(res.statusCode).toBe(504);
		expect(res.payload.error).toBe('aixbt_upstream_error');
		expect(res.payload.error_description).toContain('unreachable');
	});

	it('relays an upstream 404 so an unknown project id stays legible', () => {
		const res = fakeRes();
		respondAixbtError(res, upstreamError('aixbt /projects/nope failed: HTTP 404', 404, 'aixbt_upstream_error'));
		expect(res.statusCode).toBe(404);
		expect(res.payload.error).toBe('aixbt_upstream_error');
	});

	it('sanitizes an untyped internal fault to a 500 with a support ref', () => {
		const res = fakeRes();
		respondAixbtError(res, new TypeError('cannot read properties of undefined'));
		expect(res.statusCode).toBe(500);
		expect(res.payload.error).toBe('aixbt_error');
		expect(res.payload.ref).toBeTruthy();
		// The internal message must never reach the client.
		expect(res.body).not.toContain('cannot read properties');
	});

	it('never lets an error response be cached', () => {
		const res = fakeRes();
		res.setHeader('cache-control', 'public, s-maxage=600');
		respondAixbtError(res, new AixbtNotConfiguredError());
		expect(res.getHeader('cache-control')).toBe('no-store');
	});
});
