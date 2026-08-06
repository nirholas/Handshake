// The /irl coordinate-read budget, asserted against the REAL rate-limit module.
//
// Two properties the H7 threat model (docs/irl/THREAT-MODEL.md) states as fact, and
// which nothing else in the suite fences:
//
//   · The three reads that reveal where another user placed something (pins nearby,
//     drops nearby, world-lines nearby) draw on their OWN 60/min/IP bucket. They used
//     to ride the shared `publicIp` ceiling, which was raised 60 -> 240 for unrelated
//     page-load fan-out; that quietly cut the documented cost of a grid sweep by 4x.
//     A dedicated bucket is what keeps the published sweep-cost numbers honest.
//
//   · A limiter that cannot decide DENIES on those reads. Everywhere else on the
//     platform a blind limiter fails open, because a DB cap or an ownership check
//     still bounds the request. An unmetered location read has no such backstop.
//
// This file imports the real limiter (no vi.mock) so a change to either number or to
// the degradation policy fails here rather than only drifting the doc.

import { describe, it, expect, vi } from 'vitest';
import { limits, limitFailClosedRead } from '../../api/_lib/rate-limit.js';

describe('irlNearbyIp, the dedicated /irl coordinate-read bucket', () => {
	it('allows a legitimate viewer\'s poll rate and denies a scripted sweep within the minute', async () => {
		// A real viewer polls nearby every ~10 s (~6/min). A sweeper spends the whole
		// budget in seconds. Use a unique key so a parallel test can't drain this one.
		const ip = `198.51.100.${Math.floor(process.pid % 200) + 1}-nearby`;
		const verdicts = [];
		for (let i = 0; i < 61; i++) verdicts.push(await limits.irlNearbyIp(ip));

		expect(verdicts[0].success).toBe(true);
		expect(verdicts[5].success).toBe(true);   // 6/min viewer poll is nowhere near the cap
		expect(verdicts[59].success).toBe(true);  // 60th call still inside the window
		expect(verdicts[60].success).toBe(false); // 61st is the sweep, denied
	});

	it('is a separate bucket from the generic public read ceiling', async () => {
		// Draining the /irl budget must not touch the page-load budget, and vice
		// versa: they exist for different reasons and are tuned independently.
		const ip = `198.51.100.${Math.floor(process.pid % 200) + 1}-isolated`;
		for (let i = 0; i < 61; i++) await limits.irlNearbyIp(ip);
		expect((await limits.irlNearbyIp(ip)).success).toBe(false);
		expect((await limits.publicIp(ip)).success).toBe(true);
	});
});

describe('limitFailClosedRead: degradation policy for location reads', () => {
	it('passes the limiter verdict through untouched when the limiter works', async () => {
		const allow = await limitFailClosedRead('test', async () => ({ success: true, reset: 1 }));
		expect(allow).toEqual({ success: true, reset: 1 });
		const deny = await limitFailClosedRead('test', async () => ({ success: false, reset: 2 }));
		expect(deny.success).toBe(false);
	});

	it('DENIES with a retryable reason when the limiter throws, never an unmetered read', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const v = await limitFailClosedRead('irlNearbyIp-throwing', async () => {
			throw new Error('redis: max requests limit exceeded');
		});
		expect(v.success).toBe(false);
		expect(v.reason).toBe('rate_limiter_unavailable');
		expect(v.reset).toBeGreaterThan(Date.now());  // retryable, not a permanent block
		warn.mockRestore();
	});

	it('logs a degraded limiter once per cooldown, not once per request', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const boom = async () => { throw new Error('limiter down'); };
		for (let i = 0; i < 5; i++) await limitFailClosedRead('irlNearbyIp-flooding', boom);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});
