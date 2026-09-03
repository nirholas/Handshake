import { describe, it, expect } from 'vitest';

import {
	forgeRequestHash,
	coalesceInFlight,
	registerInFlight,
	acquireBlockingSlot,
	providerSubmitAllowed,
	reserveProviderRateSlot,
	dailyPaidAllowed,
	circuitState,
	circuitRecordFailure,
	circuitRecordSuccess,
	SCALE_LIMITS,
} from '../api/_lib/forge-scale.js';

// forge-scale provides the /forge pipeline's scaling throttles. Tests run with no
// Upstash Redis configured (the unit-test env), which is exactly the FAIL-OPEN
// contract these primitives promise: every gate must degrade to allow/no-op so
// generation keeps working when the limiter store is absent. We also lock the
// request-fingerprint semantics that in-flight coalescing depends on.

describe('forgeRequestHash', () => {
	it('is deterministic for identical inputs', () => {
		const a = forgeRequestHash({ path: 'image', tier: 'standard', backend: 'trellis', prompt: 'a red car' });
		const b = forgeRequestHash({ path: 'image', tier: 'standard', backend: 'trellis', prompt: 'a red car' });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{32}$/);
	});

	it('normalizes prompt whitespace and case', () => {
		const a = forgeRequestHash({ path: 'image', tier: 'standard', backend: 'trellis', prompt: 'A Red Car' });
		const b = forgeRequestHash({ path: 'image', tier: 'standard', backend: 'trellis', prompt: '  a red car  ' });
		expect(a).toBe(b);
	});

	it('is order-independent across the multi-view image set', () => {
		const front = 'https://x/front.png';
		const back = 'https://x/back.png';
		const a = forgeRequestHash({ path: 'image', tier: 'high', backend: 'meshy', images: [front, back] });
		const b = forgeRequestHash({ path: 'image', tier: 'high', backend: 'meshy', images: [back, front] });
		expect(a).toBe(b);
	});

	it('distinguishes tier, backend, path, prompt, and images', () => {
		const base = { path: 'image', tier: 'standard', backend: 'trellis', prompt: 'cat' };
		const h = forgeRequestHash(base);
		expect(forgeRequestHash({ ...base, tier: 'high' })).not.toBe(h);
		expect(forgeRequestHash({ ...base, backend: 'meshy' })).not.toBe(h);
		expect(forgeRequestHash({ ...base, path: 'geometry' })).not.toBe(h);
		expect(forgeRequestHash({ ...base, prompt: 'dog' })).not.toBe(h);
		expect(forgeRequestHash({ ...base, images: ['https://x/a.png'] })).not.toBe(h);
	});

	it('accepts a tier object or a tier id interchangeably', () => {
		const a = forgeRequestHash({ path: 'image', tier: { id: 'standard' }, backend: 'trellis', prompt: 'cat' });
		const b = forgeRequestHash({ path: 'image', tier: 'standard', backend: 'trellis', prompt: 'cat' });
		expect(a).toBe(b);
	});

	// Two submits of one prompt at different seeds are two different models, so
	// they must never coalesce onto one job. This is what makes `seed` usable at
	// all, and it is what Refine depends on to replay a job one tier up.
	it('distinguishes every output-affecting option', () => {
		const base = { path: 'image', tier: 'standard', backend: 'trellis', prompt: 'cat' };
		const h = forgeRequestHash(base);
		expect(forgeRequestHash({ ...base, options: { seed: 1 } })).not.toBe(h);
		expect(forgeRequestHash({ ...base, options: { seed: 1 } })).not.toBe(
			forgeRequestHash({ ...base, options: { seed: 2 } }),
		);
		expect(forgeRequestHash({ ...base, options: { outputFormat: 'glb-draco' } })).not.toBe(h);
		expect(forgeRequestHash({ ...base, options: { textureSize: 2048 } })).not.toBe(h);
		expect(forgeRequestHash({ ...base, options: { targetPolycount: 50_000 } })).not.toBe(h);
	});

	// Adding the options to the basis must not invalidate the fingerprint for the
	// callers that never send any: an absent options bag, an empty one, and one
	// holding only the defaults all describe the same generation.
	it('keeps the key stable for callers that send no options', () => {
		const base = { path: 'image', tier: 'standard', backend: 'trellis', prompt: 'cat' };
		const h = forgeRequestHash(base);
		expect(forgeRequestHash({ ...base, options: {} })).toBe(h);
		expect(forgeRequestHash({ ...base, options: null })).toBe(h);
		expect(
			forgeRequestHash({
				...base,
				options: { seed: null, outputFormat: 'glb', textureSize: null, targetPolycount: null },
			}),
		).toBe(h);
	});
});

describe('fail-open behavior without Redis', () => {
	it('coalesceInFlight returns null (always a miss)', async () => {
		expect(await coalesceInFlight('deadbeef')).toBeNull();
	});

	it('registerInFlight is a no-op that never throws', async () => {
		await expect(registerInFlight('deadbeef', 'job-123')).resolves.toBeUndefined();
	});

	it('acquireBlockingSlot grants an unbounded, releasable slot', async () => {
		const slot = await acquireBlockingSlot('hf', { max: 1, ttlMs: 1000 });
		expect(slot.ok).toBe(true);
		// A second acquire still succeeds (no shared store to count against).
		const slot2 = await acquireBlockingSlot('hf', { max: 1, ttlMs: 1000 });
		expect(slot2.ok).toBe(true);
		await expect(slot.release()).resolves.toBeUndefined();
		await expect(slot.release()).resolves.toBeUndefined(); // idempotent
	});

	it('providerSubmitAllowed allows', async () => {
		expect(await providerSubmitAllowed('replicate', { limit: 1, windowS: 10 })).toBe(true);
	});

	it('reserveProviderRateSlot grants an immediate, zero-wait slot', async () => {
		// No Redis → no shared bucket to pace against, so the gate must never queue or
		// reject: every caller proceeds instantly (a paced lane beats a blocked one).
		const a = await reserveProviderRateSlot('replicate', { ratePerMin: 6, burst: 1, maxWaitMs: 15_000 });
		expect(a).toEqual({ ok: true, waitMs: 0 });
		// A second back-to-back reserve also clears — there is no store to count against.
		const b = await reserveProviderRateSlot('replicate', { ratePerMin: 6, burst: 1, maxWaitMs: 15_000 });
		expect(b).toEqual({ ok: true, waitMs: 0 });
	});

	it('dailyPaidAllowed allows and reports the limit', async () => {
		const r = await dailyPaidAllowed('client-abc', { limit: 60 });
		expect(r.ok).toBe(true);
		expect(r.limit).toBe(60);
	});

	it('dailyPaidAllowed no-ops on an empty identity', async () => {
		expect((await dailyPaidAllowed('', { limit: 60 })).ok).toBe(true);
	});
});

describe('shared circuit breaker (in-memory fallback)', () => {
	it('opens after the threshold and resets on success', async () => {
		// Without Redis the breaker uses a per-instance map keyed by name — exercise
		// the full open/close cycle on a name unique to this test.
		const name = 'test-breaker';
		expect((await circuitState(name)).open).toBe(false);
		await circuitRecordFailure(name, { threshold: 3, baseMs: 60_000 });
		await circuitRecordFailure(name, { threshold: 3, baseMs: 60_000 });
		expect((await circuitState(name)).open).toBe(false); // 2 < threshold
		await circuitRecordFailure(name, { threshold: 3, baseMs: 60_000 });
		const open = await circuitState(name);
		expect(open.open).toBe(true);
		expect(open.failures).toBe(3);
		await circuitRecordSuccess(name);
		expect((await circuitState(name)).open).toBe(false);
	});

	it('caps the open window so a long outage cannot silence a cron for hours', async () => {
		// failures only reset on a success, so an uncapped (failures × baseMs) window
		// grows without bound: the every-minute seed crons would back off past the
		// point where they still look alive. The clamp keeps the retry cadence
		// bounded no matter how long the provider stays down.
		const name = 'test-breaker-cap';
		const baseMs = 10 * 60_000;
		const maxMs = 60 * 60_000;
		for (let i = 0; i < 40; i++) {
			await circuitRecordFailure(name, { threshold: 3, baseMs, maxMs });
		}
		const state = await circuitState(name);
		expect(state.failures).toBe(40);
		expect(state.open).toBe(true);
		// 40 × 10min would be 400 minutes without the clamp.
		expect(state.openUntil - Date.now()).toBeLessThanOrEqual(maxMs);
		expect(state.openUntil - Date.now()).toBeGreaterThan(maxMs - 60_000);
		await circuitRecordSuccess(name);
		expect((await circuitState(name)).open).toBe(false);
	});

	it('defaults the cap when a caller passes only threshold and baseMs', async () => {
		const name = 'test-breaker-default-cap';
		for (let i = 0; i < 40; i++) {
			await circuitRecordFailure(name, { threshold: 3, baseMs: 10 * 60_000 });
		}
		const state = await circuitState(name);
		expect(state.open).toBe(true);
		expect(state.openUntil - Date.now()).toBeLessThanOrEqual(60 * 60_000);
	});
});

describe('SCALE_LIMITS', () => {
	it('exposes sane positive defaults', () => {
		expect(SCALE_LIMITS.hfConcurrent).toBeGreaterThan(0);
		expect(SCALE_LIMITS.hfSlotTtlMs).toBeGreaterThanOrEqual(300_000);
		expect(SCALE_LIMITS.replicateSubmitLimit).toBeGreaterThan(0);
		expect(SCALE_LIMITS.replicateSubmitWindowS).toBeGreaterThan(0);
		// The text→image queue paces to Replicate's reduced-rate ceiling: 6/min, burst 1.
		expect(SCALE_LIMITS.replicateRatePerMin).toBe(6);
		expect(SCALE_LIMITS.replicateRateBurst).toBe(1);
		expect(SCALE_LIMITS.replicateQueueMaxMs).toBeGreaterThan(0);
	});
});
