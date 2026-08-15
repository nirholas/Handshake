/**
 * api/_lib/aixbt.js `mapAixbtFailure`: the single classifier both aixbt doors
 * answer failures through.
 *
 * Two surfaces read the same upstream: /api/aixbt/* (via respondAixbtError) and
 * /api/v1/market/{intel,projects} (via the gateway's fail()). They disagreed in
 * production: the v1 doors relayed aixbt's raw 401 to callers of a public,
 * credential-free endpoint, so an agent read "your credentials were rejected"
 * when the truth was "this deployment's upstream key is expired". The
 * classification now lives in one place; these cases pin it.
 */

import { describe, it, expect } from 'vitest';
import { mapAixbtFailure, AixbtNotConfiguredError, AIXBT_SETUP_HINT } from '../api/_lib/aixbt.js';

/** The shape api/_lib/aixbt.js throws for a non-2xx upstream response. */
function upstreamError(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

describe('mapAixbtFailure', () => {
	it('classifies a missing key as a 503 carrying the setup hint', () => {
		const mapped = mapAixbtFailure(new AixbtNotConfiguredError());
		expect(mapped.status).toBe(503);
		expect(mapped.code).toBe('aixbt_not_configured');
		expect(mapped.setup).toBe(AIXBT_SETUP_HINT);
	});

	for (const status of [401, 403]) {
		it(`turns an upstream ${status} into a 503 deployment fault, not a client one`, () => {
			const mapped = mapAixbtFailure(
				upstreamError('aixbt /intel failed: Unauthorized', status, 'aixbt_unauthorized'),
			);
			expect(mapped.status).toBe(503);
			// The typed code survives so existing clients keep their branch.
			expect(mapped.code).toBe('aixbt_unauthorized');
			expect(mapped.setup).toBe(AIXBT_SETUP_HINT);
			// The raw upstream wording never reaches the caller: it describes a
			// credential the caller does not hold.
			expect(mapped.message).not.toMatch(/Unauthorized/);
			expect(mapped.message).toMatch(/deployment key/);
		});
	}

	it('keeps upstream throttling on its own status and code', () => {
		const mapped = mapAixbtFailure(
			upstreamError('aixbt /projects failed: rate limited', 429, 'aixbt_rate_limited'),
		);
		expect(mapped).toMatchObject({ status: 429, code: 'aixbt_rate_limited' });
		expect(mapped.setup).toBeUndefined();
	});

	it('keeps an upstream outage legible instead of collapsing it to a 500', () => {
		const mapped = mapAixbtFailure(upstreamError('aixbt unreachable: fetch failed', 504, 'aixbt_upstream_error'));
		expect(mapped).toMatchObject({ status: 504, code: 'aixbt_upstream_error' });
		expect(mapped.message).toMatch(/unreachable/);
	});

	it('keeps an upstream 404 so an unknown project id stays legible', () => {
		const mapped = mapAixbtFailure(upstreamError('aixbt /projects/nope failed: HTTP 404', 404, 'aixbt_upstream_error'));
		expect(mapped).toMatchObject({ status: 404, code: 'aixbt_upstream_error' });
	});

	it('refuses to classify an internal fault, so the caller sanitizes it', () => {
		expect(mapAixbtFailure(new TypeError('cannot read properties of undefined'))).toBeNull();
	});

	it('refuses to classify an untyped 500 from upstream', () => {
		// No code, 5xx status: nothing here is safe to echo, so it falls through
		// to the caller's sanitized branch.
		expect(mapAixbtFailure(upstreamError('boom', 500))).toBeNull();
	});
});
