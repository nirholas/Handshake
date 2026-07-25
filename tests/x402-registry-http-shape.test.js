import { describe, it, expect } from 'vitest';

import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';

// Regression guard for the July 2026 405 wave: the three "Dance Tip Volume"
// entries POSTed a JSON body at /api/x402/dance-tip, a GET-only endpoint that
// reads query params, so every call bounced with http_405 (2,700+ failures in
// 48h) while looking like real volume attempts. Registry entries must match the
// HTTP shape of the endpoint they buy from.

describe('autonomous registry HTTP shape', () => {
	const registry = getSelfRegistry();

	it('dance-tip volume entries are GET with query params in the path', () => {
		const tips = registry.filter((e) => e.id?.startsWith('dance-tip-vol'));
		expect(tips.length).toBeGreaterThanOrEqual(3);
		for (const e of tips) {
			expect(e.method).toBe('GET');
			expect(e.body ?? null).toBeNull();
			expect(e.path).toMatch(/^\/api\/x402\/dance-tip\?dancer=\d&dance=\w+$/);
		}
	});

	it('no fetch-style entry sends a body on a GET', () => {
		// run()-style entries own their whole call and are exempt; plain entries
		// are fetched by the loop with { method, body } verbatim, where a GET with
		// a body is always a shape bug (undefined behavior per fetch spec).
		const offenders = registry
			.filter((e) => typeof e.run !== 'function')
			.filter((e) => (e.method || 'POST') === 'GET' && e.body != null)
			.map((e) => e.id);
		expect(offenders).toEqual([]);
	});
});
