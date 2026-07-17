import { describe, it, expect } from 'vitest';
import { classifyForgeBuckets } from '../../api/_lib/ops/forge-health-sensor.js';

// The generation success-rate sensor — the outcome signal that would have caught
// the 2026-07 image→3D failure burst (~48%) that every liveness probe missed.
// Bucket shapes are the real forge_creations aggregation (status, backend, path,
// first `:`-token of error).

describe('classifyForgeBuckets — verdict from real outcome shapes', () => {
	it('reads the 502-wave burst (~52% success, image/trellis) as DOWN and names where', () => {
		const v = classifyForgeBuckets([
			{ status: 'done', backend: 'nvidia', path: 'image', reason: 'none', n: 60 },
			{ status: 'failed', backend: 'trellis_selfhost', path: 'image', reason: 'task not found on gcp service', n: 50 },
			{ status: 'failed', backend: 'nvidia', path: 'image', reason: 'NVCF request not found or expired', n: 5 },
			{ status: 'running', backend: 'nvidia', path: 'image', reason: 'none', n: 3 }, // not an outcome
		]);
		expect(v.status).toBe('down'); // 60 / 115 = 52%
		expect(v.done).toBe(60);
		expect(v.failed).toBe(55);
		expect(v.rate).toBeCloseTo(0.52, 2);
		expect(v.worstBackend).toEqual({ backend: 'trellis_selfhost', failed: 50 });
		expect(v.worstPath).toEqual({ path: 'image', failed: 55 });
		expect(v.topReason.reason).toBe('task not found on gcp service');
		expect(v.detail).toMatch(/image path/);
		expect(v.hint).toMatch(/forge-selfhost-recovery/);
	});

	it('a 77% day reads DEGRADED', () => {
		const v = classifyForgeBuckets([
			{ status: 'done', backend: 'nvidia', path: 'image', reason: 'none', n: 131 },
			{ status: 'failed', backend: 'trellis_selfhost', path: 'image', reason: 'internal error', n: 39 },
		]);
		expect(v.status).toBe('degraded'); // 131/170 = 77%
		expect(v.rate).toBeCloseTo(0.77, 2);
	});

	it('a healthy window reads OK (running/queued excluded from the rate)', () => {
		const v = classifyForgeBuckets([
			{ status: 'done', backend: 'nvidia', path: 'image', reason: 'none', n: 29 },
			{ status: 'failed', backend: 'nvidia', path: 'image', reason: 'internal error', n: 1 },
			{ status: 'running', backend: 'nvidia', path: 'image', reason: 'none', n: 4 },
			{ status: 'queued', backend: 'trellis_selfhost', path: 'image', reason: 'none', n: 2 },
		]);
		expect(v.status).toBe('ok'); // 29/30 = 97%
		expect(v.attempts).toBe(30);
		expect(v.rate).toBeCloseTo(0.967, 2);
	});

	it('too few finished generations reads UNKNOWN and never pages', () => {
		const v = classifyForgeBuckets([
			{ status: 'done', backend: 'nvidia', path: 'text', reason: 'none', n: 8 },
			{ status: 'failed', backend: 'nvidia', path: 'text', reason: 'x', n: 2 },
		]);
		expect(v.status).toBe('unknown');
		expect(v.rate).toBeNull();
		expect(v.detail).toMatch(/too few to judge/);
	});

	it('empty / malformed input is UNKNOWN, never a throw', () => {
		expect(classifyForgeBuckets([]).status).toBe('unknown');
		expect(classifyForgeBuckets(null).status).toBe('unknown');
		expect(classifyForgeBuckets(undefined).status).toBe('unknown');
	});

	it('boundary: exactly 85% is OK, just under is DEGRADED; 60% is DEGRADED, under is DOWN', () => {
		const ok = classifyForgeBuckets([
			{ status: 'done', path: 'image', backend: 'nvidia', reason: 'none', n: 85 },
			{ status: 'failed', path: 'image', backend: 'nvidia', reason: 'x', n: 15 },
		]);
		expect(ok.status).toBe('ok');
		const degraded = classifyForgeBuckets([
			{ status: 'done', path: 'image', backend: 'nvidia', reason: 'none', n: 84 },
			{ status: 'failed', path: 'image', backend: 'nvidia', reason: 'x', n: 16 },
		]);
		expect(degraded.status).toBe('degraded');
		const stillDegraded = classifyForgeBuckets([
			{ status: 'done', path: 'image', backend: 'nvidia', reason: 'none', n: 60 },
			{ status: 'failed', path: 'image', backend: 'nvidia', reason: 'x', n: 40 },
		]);
		expect(stillDegraded.status).toBe('degraded'); // exactly 60%
		const down = classifyForgeBuckets([
			{ status: 'done', path: 'image', backend: 'nvidia', reason: 'none', n: 59 },
			{ status: 'failed', path: 'image', backend: 'nvidia', reason: 'x', n: 41 },
		]);
		expect(down.status).toBe('down');
	});
});
