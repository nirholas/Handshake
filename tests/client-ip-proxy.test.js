// clientIp() — the key every per-IP rate limiter on the platform is bucketed by.
//
// Getting this wrong has two opposite failure modes, and the platform has shipped
// both:
//
//   · Trusting req.socket.remoteAddress behind a load balancer collapses every
//     visitor into ONE bucket. That was live after the Vercel→Cloud Run migration
//     (x-vercel-forwarded-for is never set on GCP), which is why /api/irl/privacy
//     answered 429 to its first caller and nobody could delete their own pins.
//
//   · Trusting the LEFTMOST X-Forwarded-For entry lets a caller mint a fresh bucket
//     per request by sending a random header, so the limits stop limiting.
//
// Google's external ALB appends `<real-client-ip>, <lb-ip>`. The real client is the
// second entry from the right. This file fences that, in both directions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const REAL_CLIENT = '203.0.113.7';   // TEST-NET-3, the "real" caller
const LB = '35.191.0.1';             // the hop Google appends
const SPOOF = '198.51.100.99';       // TEST-NET-2, caller-supplied garbage

function req(headers = {}, socketAddr = '169.254.1.1') {
	return { headers, socket: { remoteAddress: socketAddr } };
}

// clientIp reads TRUSTED_PROXY_HOPS once at module load, so each hop-count case
// needs a fresh module registry.
async function loadWithHops(hops) {
	vi.resetModules();
	if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
	else process.env.TRUSTED_PROXY_HOPS = String(hops);
	return (await import('../api/_lib/rate-limit.js')).clientIp;
}

const ORIGINAL = process.env.TRUSTED_PROXY_HOPS;
beforeEach(() => { vi.resetModules(); });
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.TRUSTED_PROXY_HOPS;
	else process.env.TRUSTED_PROXY_HOPS = ORIGINAL;
});

describe('clientIp behind Google’s load balancer (default: 1 trusted hop)', () => {
	it('takes the entry before the load balancer, not the socket peer', async () => {
		const clientIp = await loadWithHops(undefined);
		expect(clientIp(req({ 'x-forwarded-for': `${REAL_CLIENT}, ${LB}` }))).toBe(REAL_CLIENT);
	});

	it('ignores caller-supplied entries to the LEFT of the real client', async () => {
		const clientIp = await loadWithHops(undefined);
		const forged = `${SPOOF}, 10.0.0.1, ${REAL_CLIENT}, ${LB}`;
		expect(clientIp(req({ 'x-forwarded-for': forged }))).toBe(REAL_CLIENT);
	});

	// The whole point: two different callers must land in two different buckets,
	// and one caller must not be able to escape their own bucket by spoofing.
	it('distinct callers key distinctly; a spoofer cannot mint a fresh bucket', async () => {
		const clientIp = await loadWithHops(undefined);
		const a = clientIp(req({ 'x-forwarded-for': `203.0.113.1, ${LB}` }));
		const b = clientIp(req({ 'x-forwarded-for': `203.0.113.2, ${LB}` }));
		expect(a).not.toBe(b);

		const spoof1 = clientIp(req({ 'x-forwarded-for': `1.1.1.1, ${REAL_CLIENT}, ${LB}` }));
		const spoof2 = clientIp(req({ 'x-forwarded-for': `2.2.2.2, ${REAL_CLIENT}, ${LB}` }));
		expect(spoof1).toBe(REAL_CLIENT);
		expect(spoof2).toBe(REAL_CLIENT);
	});

	it('never returns the load balancer address (the global-bucket bug)', async () => {
		const clientIp = await loadWithHops(undefined);
		for (const xff of [`${REAL_CLIENT}, ${LB}`, `${SPOOF}, ${REAL_CLIENT}, ${LB}`]) {
			const ip = clientIp(req({ 'x-forwarded-for': xff }, LB));
			expect(ip).not.toBe(LB);
			expect(ip).not.toBe('169.254.1.1');
		}
	});

	it('a single-entry chain degrades to that entry, never a negative index', async () => {
		const clientIp = await loadWithHops(undefined);
		expect(clientIp(req({ 'x-forwarded-for': REAL_CLIENT }))).toBe(REAL_CLIENT);
	});

	it('tolerates padding, empty segments and a trailing comma', async () => {
		const clientIp = await loadWithHops(undefined);
		expect(clientIp(req({ 'x-forwarded-for': `  ${REAL_CLIENT} , , ${LB} ,` }))).toBe(REAL_CLIENT);
	});
});

describe('clientIp with no load balancer (TRUSTED_PROXY_HOPS=0)', () => {
	it('takes the rightmost entry, which is the client Cloud Run observed', async () => {
		const clientIp = await loadWithHops(0);
		expect(clientIp(req({ 'x-forwarded-for': `${SPOOF}, ${REAL_CLIENT}` }))).toBe(REAL_CLIENT);
	});
});

describe('clientIp without any proxy header', () => {
	it('falls back to the socket — in local dev and tests the socket IS the client', async () => {
		const clientIp = await loadWithHops(undefined);
		expect(clientIp(req({}, '127.0.0.1'))).toBe('127.0.0.1');
	});

	it('returns a stable sentinel when there is nothing to key on', async () => {
		const clientIp = await loadWithHops(undefined);
		expect(clientIp({ headers: {}, socket: {} })).toBe('0.0.0.0');
	});

	// x-vercel-forwarded-for and x-real-ip are settable by any caller on GCP, where
	// nothing strips them. Honouring either would hand a sweeper a fresh bucket per
	// request, so neither may influence the key.
	it('ignores caller-settable x-vercel-forwarded-for and x-real-ip', async () => {
		const clientIp = await loadWithHops(undefined);
		expect(clientIp(req({ 'x-vercel-forwarded-for': SPOOF }, '127.0.0.1'))).toBe('127.0.0.1');
		expect(clientIp(req({ 'x-real-ip': SPOOF }, '127.0.0.1'))).toBe('127.0.0.1');
		expect(clientIp(req({ 'x-vercel-forwarded-for': SPOOF, 'x-forwarded-for': `${REAL_CLIENT}, ${LB}` }))).toBe(REAL_CLIENT);
	});
});
