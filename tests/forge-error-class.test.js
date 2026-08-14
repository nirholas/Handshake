// api/_lib/ops/forge-error-class.js: free-text forge failure -> countable class.
//
// The point of the classifier is that a frequency ranking over
// `forge_creations.error` is meaningless without it, because every message
// carries its own ids and durations. So the tests that matter are the collapsing
// ones: two instances of the same failure, worded differently by the lane, must
// land on one class and one grouping key. The rest pins match ordering (a lost
// task must not read as a generic 404) and the honest 'other' fallback.

import { describe, it, expect } from 'vitest';
import {
	classifyForgeError,
	normalizeForgeError,
	FORGE_ERROR_CLASS_IDS,
} from '../api/_lib/ops/forge-error-class.js';

const idOf = (s) => classifyForgeError(s).id;

describe('classifyForgeError', () => {
	it('collapses the same failure worded with different specifics', () => {
		const a = classifyForgeError('generation timed out after 41 minutes');
		const b = classifyForgeError('generation timed out after 63 minutes');
		expect(a.id).toBe('timeout');
		expect(b.id).toBe(a.id);
		expect(b.normalized).toBe(a.normalized);
	});

	it('collapses messages that differ only by an embedded id or url', () => {
		const a = classifyForgeError('task not found: 7f3a2b19c4d5e6f708192a3b4c5d6e7f');
		const b = classifyForgeError('task not found: 0011223344556677889900aabbccddee');
		expect(a.id).toBe('lost_task');
		expect(a.normalized).toBe(b.normalized);
		expect(normalizeForgeError('fetch failed for https://api.example.com/v1/x'))
			.toBe(normalizeForgeError('fetch failed for https://api.example.com/v1/y'));
	});

	it('reads a lost task as lost_task, not as a generic not-found', () => {
		expect(idOf('task not found')).toBe('lost_task');
		expect(idOf('prediction not found for id 8ac1f0d2b3e4')).toBe('lost_task');
		expect(idOf('upstream returned 404 for the asset')).toBe('not_found_4xx');
	});

	it('classifies the transport and vendor failures forge actually records', () => {
		expect(idOf('upstream returned 502 Bad Gateway')).toBe('upstream_5xx');
		expect(idOf('service unavailable')).toBe('upstream_5xx');
		expect(idOf('429 Too Many Requests')).toBe('rate_limited');
		expect(idOf('quota exceeded for this model')).toBe('rate_limited');
		expect(idOf('401 unauthorized: invalid api key')).toBe('unauthorized');
		expect(idOf('payment required: insufficient credit')).toBe('payment_required');
		expect(idOf('socket hang up')).toBe('network');
		expect(idOf('ECONNRESET while streaming the result')).toBe('network');
		expect(idOf('CUDA out of memory')).toBe('out_of_memory');
		expect(idOf('request aborted')).toBe('aborted');
		expect(idOf('deadline exceeded')).toBe('timeout');
	});

	it('classifies the pipeline-side failures', () => {
		expect(idOf('invalid image: cannot decode image')).toBe('bad_input_image');
		expect(idOf('invalid glb: empty mesh')).toBe('bad_output_mesh');
		expect(idOf('blocked by the safety filter')).toBe('content_filtered');
		expect(idOf('upload failed to bucket three-ws-assets')).toBe('storage');
	});

	it('keeps the say-nothing messages as their own class', () => {
		expect(idOf('generation failed')).toBe('generic_failure');
		expect(idOf('unknown error')).toBe('generic_failure');
	});

	it('falls back to other rather than force-fitting an unknown message', () => {
		const c = classifyForgeError('the renderer produced a scene with no camera');
		expect(c.id).toBe('other');
		expect(c.label).toContain('renderer');
		expect(c.normalized).toBe('the renderer produced a scene with no camera');
	});

	it('reports an absent error as none', () => {
		for (const empty of [null, undefined, '', '   ']) {
			expect(classifyForgeError(empty).id).toBe('none');
		}
	});

	it('exposes every class id in match order, with no duplicates', () => {
		expect(FORGE_ERROR_CLASS_IDS[0]).toBe('timeout');
		expect(FORGE_ERROR_CLASS_IDS).toContain('lost_task');
		expect(new Set(FORGE_ERROR_CLASS_IDS).size).toBe(FORGE_ERROR_CLASS_IDS.length);
	});
});

describe('normalizeForgeError', () => {
	it('strips counts and durations so occurrences share one grouping key', () => {
		expect(normalizeForgeError('mesh is 1234 bytes')).toBe(normalizeForgeError('mesh is 91 bytes'));
		expect(normalizeForgeError('gave up after 3 retries')).toBe(normalizeForgeError('gave up after 9 retries'));
	});

	it('is empty for an absent message', () => {
		expect(normalizeForgeError(null)).toBe('');
		expect(normalizeForgeError('  ')).toBe('');
	});
});
