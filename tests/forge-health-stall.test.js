/**
 * Forge stall detection, unit test.
 *
 * The success-rate sensor can only judge generations that got far enough to
 * write a forge_creations row. On 2026-09-07 object storage rejected the
 * reference-image upload, which happens BEFORE that row exists, so the forge
 * produced zero rows for nearly five hours while healthz kept reporting
 * "89% success (118/133 finished)" off the rows from before the outage. Silence
 * now has to prove it is innocent: quiet is fine on a quiet lane, and an outage
 * on a busy one.
 */

import { describe, it, expect } from 'vitest';
import { classifyForgeStall } from '../api/_lib/ops/forge-health-sensor.js';

const MIN = 60_000;

describe('classifyForgeStall', () => {
	it('flags a busy forge that has started nothing for hours', () => {
		const v = classifyForgeStall({ lastCreatedAgeMs: 289 * MIN, hourlyRate: 12 });
		expect(v.stalled).toBe(true);
		expect(v.ageMinutes).toBe(289);
		expect(v.detail).toMatch(/no generation has STARTED in 289m/);
		expect(v.hint).toMatch(/object_storage/);
	});

	it('does not flag a genuinely quiet lane', () => {
		expect(classifyForgeStall({ lastCreatedAgeMs: 300 * MIN, hourlyRate: 1 }).stalled).toBe(false);
	});

	it('does not flag a busy forge that is still starting jobs', () => {
		expect(classifyForgeStall({ lastCreatedAgeMs: 4 * MIN, hourlyRate: 50 }).stalled).toBe(false);
	});

	it('tolerates a gap shorter than the stall window', () => {
		expect(classifyForgeStall({ lastCreatedAgeMs: 30 * MIN, hourlyRate: 20 }).stalled).toBe(false);
	});

	it('says nothing when the table is empty', () => {
		const v = classifyForgeStall({ lastCreatedAgeMs: null, hourlyRate: 0 });
		expect(v.stalled).toBe(false);
		expect(v.ageMinutes).toBe(null);
	});
});
