// Every autonomous-loop entry that targets a three.ws endpoint must match that
// endpoint's real contract.
//
// The loop pays for its own calls, so a misconfigured entry is not a cosmetic
// bug: it burns loop budget, pollutes the error metrics every monitor reads,
// and leaves the "health" canaries proving nothing about the endpoints they are
// named for. In the 24h before this test the registry was losing 339 calls a
// day to five of our own endpoints:
//   token-intel         405 x109  (canary POSTed a GET-only endpoint)
//   agent-reputation    400 x90   (GET mode needs ?subject=)
//   symbol-availability 400 x71   (batch mode takes `symbols`, not `symbol`)
//   cosmetic-purchase   400 x38   (GET-only, reads ?id= and ?account=)
//   agent-bouncer       404 x31   (unregistered id answered with an error)
//
// This pins the shape of each fixed entry so the same class of drift fails here
// instead of in production telemetry.

import { describe, it, expect } from 'vitest';
import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';

const AUTONOMOUS_REGISTRY = getSelfRegistry();

const byId = (id) => AUTONOMOUS_REGISTRY.find((e) => e.id === id);

describe('autonomous registry entries match endpoint contracts', () => {
	it('health-token-intel calls the GET-only endpoint with GET + a mint', () => {
		const e = byId('health-token-intel');
		expect(e.method).toBe('GET');
		expect(e.body).toBeNull();
		expect(e.path).toMatch(/^\/api\/x402\/token-intel\?mint=[1-9A-HJ-NP-Za-km-z]{32,44}$/);
	});

	it('health-agent-reputation supplies the required subject', () => {
		const e = byId('health-agent-reputation');
		expect(e.method).toBe('GET');
		expect(e.path).toMatch(/^\/api\/x402\/agent-reputation\?subject=.+/);
	});

	it('health-symbol-avail sends the batch field the endpoint reads', () => {
		const e = byId('health-symbol-avail');
		expect(e.method).toBe('POST');
		expect(Array.isArray(e.body.symbols)).toBe(true);
		expect(e.body.symbols.length).toBeGreaterThan(0);
		expect(e.body.symbol).toBeUndefined();
	});

	it('cosmetic-purchase-test uses the GET query contract', () => {
		const e = byId('cosmetic-purchase-test');
		expect(e.method).toBe('GET');
		expect(e.body).toBeNull();
		expect(e.path).toMatch(/[?&]id=/);
		expect(e.path).toMatch(/[?&]account=/);
	});

	it('no three.ws entry sends a body on a GET', () => {
		const offenders = AUTONOMOUS_REGISTRY.filter(
			(e) => e.method === 'GET' && e.body != null && String(e.path || '').startsWith('/api/'),
		).map((e) => e.id);
		expect(offenders).toEqual([]);
	});

	it('every three.ws entry declares an explicit method', () => {
		const missing = AUTONOMOUS_REGISTRY.filter(
			(e) => String(e.path || '').startsWith('/api/') && !['GET', 'POST'].includes(e.method),
		).map((e) => e.id);
		expect(missing).toEqual([]);
	});
});
