// /api/x402/rate-limit-probe: which endpoints the paid capacity probe will aim at.
//
// The probe makes the SERVER issue an unauthenticated POST to `origin + endpoint`
// to read the target's 402 challenge price. Left open to any /api/ path, a paying
// caller could point that self-request at an arbitrary internal route. The handler
// now admits only the prefixes the autonomous registry actually meters, which is
// also the set of routes that answer a 402 at all.
//
// The companion assertion here is the one that keeps the allowlist honest: every
// real HTTP path in getSelfRegistry() must still be probeable, so the guard can
// never quietly shrink the product.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/x402-paid-endpoint.js', () => ({ paidEndpoint: (cfg) => cfg }));
vi.mock('../api/_lib/x402-spec.js', () => ({ buildBazaarSchema: () => ({}) }));
vi.mock('../api/_lib/x402/bazaar-helpers.js', () => ({ withService: (x) => x }));
vi.mock('../api/_lib/x402/access-control.js', () => ({ installAccessControl: () => ({}) }));
vi.mock('../api/_lib/redis.js', () => ({ getRedis: () => null }));

const probeModule = await import('../api/x402/rate-limit-probe.js');
const spec = probeModule.default;
const { getSelfRegistry } = await import('../api/_lib/x402/autonomous-registry.js');

// The pattern agents pre-validate against, straight from the published schema.
const ADVERTISED = new RegExp(probeModule.INPUT_SCHEMA.properties.endpoint.pattern);

function call(body) {
	return spec.handler({
		req: { method: 'POST', headers: { 'content-type': 'application/json' }, body },
		res: {},
		requirement: null,
		payer: null,
	});
}

let fetchSpy;
beforeEach(() => {
	fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404, json: async () => ({}) });
});

describe('rate-limit-probe target gating', () => {
	it('rejects an absolute URL', async () => {
		await expect(call({ endpoint: 'https://evil.example/x' })).rejects.toMatchObject({
			status: 400,
			code: 'invalid_endpoint',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects an /api/ route that is not metered', async () => {
		await expect(call({ endpoint: '/api/creations' })).rejects.toMatchObject({
			status: 400,
			code: 'endpoint_not_metered',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects a traversal that would climb out of the metered prefix', async () => {
		await expect(call({ endpoint: '/api/x402/../creations' })).rejects.toMatchObject({
			status: 400,
			code: 'endpoint_not_metered',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects a prefix look-alike', async () => {
		await expect(call({ endpoint: '/api/x402evil' })).rejects.toMatchObject({
			status: 400,
			code: 'endpoint_not_metered',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('probes a metered route and reports capacity from the live price', async () => {
		fetchSpy.mockResolvedValue({
			status: 402,
			json: async () => ({ accepts: [{ amount: '10000' }, { amount: '250000' }] }),
		});
		const out = await call({ endpoint: '/api/x402/crypto-intel' });
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(out.endpoint).toBe('/api/x402/crypto-intel');
		expect(out.price_atomic).toBe(10_000); // cheapest accept wins
		expect(out.limit).toBe(Math.floor(out.daily_cap_atomic / 10_000));
		expect(out.remaining_calls).toBe(Math.floor(out.remaining_capacity_atomic / 10_000));
		expect(out.cooldown_active).toBe(false);
	});

	it('still admits every HTTP path the autonomous registry meters', async () => {
		const paths = [
			...new Set(
				getSelfRegistry()
					.map((e) => e.path)
					.filter((p) => typeof p === 'string' && p.startsWith('/api/') && !p.startsWith('/api/_')),
			),
		];
		expect(paths.length).toBeGreaterThan(20);
		for (const path of paths) {
			await expect(call({ endpoint: path })).resolves.toBeTruthy();
		}
	});

	it('advertises exactly what it admits', () => {
		for (const path of ['/api/x402/crypto-intel', '/api/x402-pay?balance=1', '/api/mcp', '/api/ibm-mcp']) {
			expect(ADVERTISED.test(path), path).toBe(true);
		}
		for (const path of ['/api/creations', '/api/x402evil', '/api/mcpevil']) {
			expect(ADVERTISED.test(path), path).toBe(false);
		}
	});
});
