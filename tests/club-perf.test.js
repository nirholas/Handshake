// Tests for the /club performance profile detector + frame watchdog.
//
// detectProfile() reads `navigator` capability signals; we pass a stubbed
// env so it's testable in Node (vitest runs under `environment: 'node'`).
// The watchdog is pure math — feed it dt frames and assert it downgrades
// after sustained slow frames and never auto-upgrades.

import { describe, it, expect, vi } from 'vitest';
import {
	detectProfile,
	PROFILES,
	nextLowerTier,
	nextHigherTier,
	createFrameWatchdog,
} from '../src/club-perf.js';

function envFor({ ua = 'Mozilla/5.0', mem, cores, coarse = false } = {}) {
	return {
		navigator: {
			userAgent: ua,
			deviceMemory: mem,
			hardwareConcurrency: cores,
		},
		window: {
			matchMedia: (q) => ({ matches: q.includes('coarse') ? !!coarse : false }),
		},
	};
}

describe('detectProfile', () => {
	it('returns high for a beefy desktop', () => {
		expect(
			detectProfile(envFor({
				ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
				mem: 16,
				cores: 12,
			})),
		).toBe('high');
	});

	it('returns low for a memory-starved Android', () => {
		expect(
			detectProfile(envFor({
				ua: 'Mozilla/5.0 (Linux; Android 11) Mobile',
				mem: 2,
				cores: 8,
			})),
		).toBe('low');
	});

	it('returns low for a low-core mobile', () => {
		expect(
			detectProfile(envFor({
				ua: 'Mozilla/5.0 (Linux; Android 10) Mobile',
				mem: 6,
				cores: 2,
			})),
		).toBe('low');
	});

	it('returns medium for an iPhone (mem/cores undefined, coarse pointer)', () => {
		// Safari hides deviceMemory + hardwareConcurrency; the iPhone falls
		// through to the coarse-pointer branch → medium.
		expect(
			detectProfile(envFor({
				ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile',
				mem: undefined,
				cores: undefined,
				coarse: true,
			})),
		).toBe('medium');
	});

	it('returns medium for a desktop with coarse pointer (touch laptop)', () => {
		expect(
			detectProfile(envFor({
				ua: 'Mozilla/5.0 (Windows NT 10.0)',
				mem: 8,
				cores: 8,
				coarse: true,
			})),
		).toBe('high');
		// ^ A touch-Windows laptop with 8GB + 8 cores is "high" because the
		// UA isn't mobile. The coarse-pointer rule only kicks in for
		// non-desktop + non-low-spec.
	});

	it('returns medium when capability signals are missing entirely', () => {
		expect(detectProfile({ navigator: {}, window: { matchMedia: () => ({ matches: false }) } })).toBe('high');
		// Missing signals default to "plenty" (8) — without UA mobile match
		// we treat it as a desktop and pick high. Mobile UA with no signal
		// also defaults to plenty → falls through to medium.
		expect(
			detectProfile(envFor({
				ua: 'Mozilla/5.0 (Linux; Android 10) Mobile',
				mem: undefined,
				cores: undefined,
				coarse: false,
			})),
		).toBe('medium');
	});
});

describe('PROFILES', () => {
	it('PROFILES.low disables bloom, shadows, cube cam, mirror ball, cones', () => {
		const low = PROFILES.low;
		expect(low.bloom).toBe(false);
		expect(low.shadows).toBe(false);
		expect(low.cubeCam).toBe(false);
		expect(low.mirrorBall).toBe(false);
		expect(low.volumetricCones).toBe(false);
		expect(low.chromaticAberration).toBe(false);
		expect(low.shadowMapSize).toBe(0);
	});

	it('PROFILES.high enables all feature flags', () => {
		const high = PROFILES.high;
		expect(high.bloom).toBe(true);
		expect(high.shadows).toBe(true);
		expect(high.cubeCam).toBe(true);
		expect(high.mirrorBall).toBe(true);
		expect(high.volumetricCones).toBe(true);
		expect(high.chromaticAberration).toBe(true);
	});

	it('PROFILES.medium keeps mirror ball + bloom but drops cube cam', () => {
		const med = PROFILES.medium;
		expect(med.bloom).toBe(true);
		expect(med.mirrorBall).toBe(true);
		expect(med.cubeCam).toBe(false);
		expect(med.chromaticAberration).toBe(false);
	});

	it('crowd instance counts step down monotonically across tiers', () => {
		expect(PROFILES.high.crowdInstances).toBeGreaterThan(PROFILES.medium.crowdInstances);
		expect(PROFILES.medium.crowdInstances).toBeGreaterThan(PROFILES.low.crowdInstances);
	});

	it('every tier tags itself with `tier`', () => {
		expect(PROFILES.high.tier).toBe('high');
		expect(PROFILES.medium.tier).toBe('medium');
		expect(PROFILES.low.tier).toBe('low');
	});
});

describe('nextLowerTier', () => {
	it('walks high → medium → low and floors at low', () => {
		expect(nextLowerTier('high')).toBe('medium');
		expect(nextLowerTier('medium')).toBe('low');
		expect(nextLowerTier('low')).toBe('low');
	});

	it('returns low for unknown input (safe fallback)', () => {
		expect(nextLowerTier('ultra')).toBe('low');
	});
});

describe('nextHigherTier', () => {
	it('walks low → medium → high and ceils at high', () => {
		expect(nextHigherTier('low')).toBe('medium');
		expect(nextHigherTier('medium')).toBe('high');
		expect(nextHigherTier('high')).toBe('high');
	});

	it('returns low for unknown input (safe fallback)', () => {
		expect(nextHigherTier('ultra')).toBe('low');
	});
});

describe('createFrameWatchdog', () => {
	it('downgrades after sustained slow frames', () => {
		const onDowngrade = vi.fn();
		const wd = createFrameWatchdog({
			initialTier: 'high',
			holdSec: 2.0,
			emaAlpha: 1.0, // make EMA == latest dt for deterministic test
			onDowngrade,
		});
		// Pump 3 seconds of slow frames (33 fps == 30ms per frame, but our
		// slow threshold is 1/28s ≈ 35.7ms). Feed 40ms frames.
		const slowDt = 0.040;
		const frameCount = Math.ceil(3.0 / slowDt);
		for (let i = 0; i < frameCount; i++) wd.tick(slowDt);
		expect(onDowngrade).toHaveBeenCalledTimes(1);
		expect(onDowngrade).toHaveBeenCalledWith('medium');
		expect(wd.tier).toBe('medium');
	});

	it('does not downgrade if slow frames are not sustained', () => {
		const onDowngrade = vi.fn();
		const wd = createFrameWatchdog({
			initialTier: 'high',
			holdSec: 2.0,
			emaAlpha: 1.0,
			onDowngrade,
		});
		// One blip of slow frames (~1s) then back to normal.
		for (let i = 0; i < 25; i++) wd.tick(0.040);  // ~1s slow
		for (let i = 0; i < 120; i++) wd.tick(1 / 60); // 2s normal
		expect(onDowngrade).not.toHaveBeenCalled();
		expect(wd.tier).toBe('high');
	});

	it('never climbs above the tier it booted into', () => {
		const up = [];
		const wd = createFrameWatchdog({
			initialTier: 'medium',
			holdSec: 2.0,
			recoverSec: 6.0,
			emaAlpha: 1.0,
			onDowngrade: () => {},
			onUpgrade: (t) => up.push(t),
		});
		// Run 20 seconds of fast 60fps frames — maxTier defaults to the boot
		// tier (medium), so it must never climb to high.
		for (let i = 0; i < 1200; i++) wd.tick(1 / 60);
		expect(up).toEqual([]);
		expect(wd.tier).toBe('medium');
	});

	it('recovers one tier after a sustained-fast window, then caps at the boot tier', () => {
		const down = [];
		const up = [];
		const wd = createFrameWatchdog({
			initialTier: 'high',
			holdSec: 2.0,
			recoverSec: 6.0,
			emaAlpha: 1.0,
			onDowngrade: (t) => down.push(t),
			onUpgrade: (t) => up.push(t),
		});
		// A slow burst drops high → medium.
		for (let i = 0; i < 75; i++) wd.tick(0.040); // ~3s slow
		expect(down).toEqual(['medium']);
		expect(wd.tier).toBe('medium');
		// Sustained fast frames (60fps) climb it back to high — and no further,
		// since high is the boot ceiling.
		for (let i = 0; i < 1200; i++) wd.tick(1 / 60); // ~20s fast
		expect(up).toEqual(['high']);
		expect(wd.tier).toBe('high');
	});

	it('does not recover on a brief fast blip inside a slow stretch (hysteresis)', () => {
		const up = [];
		const wd = createFrameWatchdog({
			initialTier: 'high',
			holdSec: 2.0,
			recoverSec: 6.0,
			emaAlpha: 1.0,
			onDowngrade: () => {},
			onUpgrade: (t) => up.push(t),
		});
		for (let i = 0; i < 75; i++) wd.tick(0.040);   // drop to medium
		// 3s of fast frames — shorter than the 6s recovery window — must NOT
		// upgrade. The fast accumulator resets the moment slow frames return.
		for (let i = 0; i < 180; i++) wd.tick(1 / 60); // ~3s fast
		for (let i = 0; i < 25; i++) wd.tick(0.040);   // ~1s slow (not sustained)
		expect(up).toEqual([]);
		expect(wd.tier).toBe('medium');
	});

	it('floors at low after two downgrades', () => {
		const calls = [];
		const wd = createFrameWatchdog({
			initialTier: 'high',
			holdSec: 1.0,
			emaAlpha: 1.0,
			onDowngrade: (t) => calls.push(t),
		});
		// Slow frames for ~5 seconds — long enough to walk high→medium→low
		// and then sit at low (no further calls).
		for (let i = 0; i < 200; i++) wd.tick(0.080);
		expect(calls[0]).toBe('medium');
		expect(calls[1]).toBe('low');
		expect(wd.tier).toBe('low');
		// No further downgrade calls past low.
		const before = calls.length;
		for (let i = 0; i < 200; i++) wd.tick(0.080);
		expect(calls.length).toBe(before);
	});

	it('ignores non-finite dt values without throwing', () => {
		const wd = createFrameWatchdog({
			initialTier: 'high',
			onDowngrade: () => {},
		});
		expect(() => wd.tick(NaN)).not.toThrow();
		expect(() => wd.tick(-1)).not.toThrow();
		expect(() => wd.tick(0)).not.toThrow();
		expect(wd.tier).toBe('high');
	});
});
