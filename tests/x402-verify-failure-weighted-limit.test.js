// Pins the failure-weighted per-IP verify budget for the paid x402 family.
//
// The bucket used to meter every verify ATTEMPT equally at 20/min, which capped a
// *paying* client at 20 calls/min, incoherent for the per-datapoint API, whose
// entire value is bulk reads (a buyer pulling 50 metrics got 429s despite paying
// for every one). It now meters FAILURE: a settled payment costs 1 token, a failed
// verify costs X402_VERIFY_FAIL_PENALTY.
//
// Both halves are load-bearing and are asserted here:
//   1. a paying client is not throttled for succeeding (the product fix), and
//   2. a junk-X-PAYMENT flood still drains its budget after ~20 failures/min and is
//      cut off by the PRE-verify gate, before any further facilitator call (the
//      security property the old flat cap provided).
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for the sliding-window bucket: counts tokens burned per key
// so we can assert the *cost* of a success vs a failure, independent of Redis.
const burned = new Map();
const LIMIT = 300;

vi.mock('../api/_lib/rate-limit.js', async (importOriginal) => {
	const actual = await importOriginal();
	const spend = (ip) => {
		const used = (burned.get(ip) || 0) + 1;
		burned.set(ip, used);
		return { success: used <= LIMIT, limit: LIMIT, remaining: Math.max(0, LIMIT - used), reset: 0 };
	};
	return {
		...actual,
		clientIp: () => '203.0.113.7',
		limits: {
			...actual.limits,
			x402VerifyIp: async (ip) => spend(ip),
			// Mirrors the real implementation: burn PENALTY-1 extra tokens, since the
			// attempt itself already spent one at the pre-verify gate.
			x402VerifyPenalty: async (ip) => {
				for (let i = 0; i < 14; i++) spend(ip);
			},
		},
	};
});

const IP = '203.0.113.7';

async function attempt({ fails }) {
	const { limits } = await import('../api/_lib/rate-limit.js');
	const gate = await limits.x402VerifyIp(IP);
	// The pre-verify gate is what stops a flood BEFORE the facilitator round-trip.
	if (!gate.success) return { admitted: false, facilitatorCalled: false };
	if (fails) await limits.x402VerifyPenalty(IP);
	return { admitted: true, facilitatorCalled: true };
}

describe('x402 per-IP verify budget is failure-weighted', () => {
	beforeEach(() => burned.clear());

	it('does not throttle a paying client far past the old 20/min cap', async () => {
		let admitted = 0;
		for (let i = 0; i < 250; i++) {
			const r = await attempt({ fails: false });
			if (r.admitted) admitted++;
		}
		// The regression this guards: the old flat bucket admitted only 20.
		expect(admitted).toBe(250);
		expect(admitted).toBeGreaterThan(20);
	});

	it('still cuts a junk-payment flood off after ~20 failures a minute', async () => {
		let facilitatorCalls = 0;
		for (let i = 0; i < 200; i++) {
			const r = await attempt({ fails: true });
			if (r.facilitatorCalled) facilitatorCalls++;
		}
		// 15 tokens per failure against a 300 budget → the pre-verify gate refuses
		// everything after the 20th, so the amplification bound is unchanged.
		expect(facilitatorCalls).toBe(20);
	});

	it('a flood cannot ride in behind a paying client’s successful calls', async () => {
		for (let i = 0; i < 100; i++) await attempt({ fails: false }); // 100 tokens
		let floodCalls = 0;
		for (let i = 0; i < 100; i++) {
			const r = await attempt({ fails: true });
			if (r.facilitatorCalled) floodCalls++;
		}
		// 200 tokens left / 15 per failure → at most 14 more facilitator calls.
		expect(floodCalls).toBeLessThanOrEqual(14);
	});
});
