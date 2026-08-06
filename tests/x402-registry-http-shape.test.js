import { describe, it, expect } from 'vitest';

import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';
import { RING_CATALOG } from '../api/_lib/x402/ring-catalog.js';
import { CIRCUIT_BREAKER_PROBE } from '../api/_lib/x402/pipelines/circuit-breaker.js';
import { FEE_VALIDATOR_PROBE } from '../api/_lib/x402/pipelines/fee-calculation-validator.js';

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

	// run()-style pipelines own their whole call sequence, so the registry shape
	// guard above cannot see them. Both of these settle against dance-tip and both
	// POSTed at it, which the paid endpoint answers with a strict 405 once a
	// payment is attached: the circuit breaker reported "solana FAILED" every hour
	// and the fee validator's live settle leg had never once landed.
	it('run()-style dance-tip probes match the catalog HTTP shape', () => {
		const catalogEntry = RING_CATALOG.find((e) => e.slug === 'dance-tip');
		expect(catalogEntry).toBeDefined();
		for (const probe of [CIRCUIT_BREAKER_PROBE, FEE_VALIDATOR_PROBE]) {
			const [path, query] = probe.path.split('?');
			expect(path).toBe(catalogEntry.path);
			expect(probe.method).toBe(catalogEntry.method);
			// A GET endpoint takes its selection as query params, never a body.
			expect(probe).not.toHaveProperty('body');
			expect(new URLSearchParams(query).get('dancer')).toMatch(/^\d+$/);
			expect(new URLSearchParams(query).get('dance')).toBeTruthy();
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
