/**
 * <three-ws-viewer> load-lifecycle helpers: unit tests.
 *
 * The published SDK viewer can't render in Node (no WebGL), so its overlay logic
 * is split into pure helpers (avatar-sdk/src/viewer-state.js) that ARE testable.
 */

import { describe, it, expect } from 'vitest';
import { loadPercent, progressLabel, nextViewerState } from '../avatar-sdk/src/viewer-state.js';

describe('loadPercent', () => {
	it('returns a whole-number percent when total is known', () => {
		expect(loadPercent(0, 100)).toBe(0);
		expect(loadPercent(50, 100)).toBe(50);
		expect(loadPercent(100, 100)).toBe(100);
		expect(loadPercent(33, 99)).toBe(33);
	});

	it('returns null when total is unknown (non-computable stream)', () => {
		expect(loadPercent(1234, 0)).toBeNull();
		expect(loadPercent(1234, undefined)).toBeNull();
		expect(loadPercent(1234, NaN)).toBeNull();
	});

	it('clamps out-of-range inputs into 0..100', () => {
		expect(loadPercent(-5, 100)).toBe(0);
		expect(loadPercent(200, 100)).toBe(100);
	});
});

describe('progressLabel', () => {
	it('shows a percent when known and a plain word when not', () => {
		expect(progressLabel(0)).toBe('0%');
		expect(progressLabel(72)).toBe('72%');
		expect(progressLabel(null)).toBe('Loading');
	});
});

describe('nextViewerState', () => {
	it('is empty with no src, regardless of other flags', () => {
		expect(nextViewerState({ hasSrc: false })).toBe('empty');
		expect(nextViewerState({ hasSrc: false, loading: true, error: true })).toBe('empty');
	});

	it('prioritizes error over loading', () => {
		expect(nextViewerState({ hasSrc: true, loading: true, error: true })).toBe('error');
		expect(nextViewerState({ hasSrc: true, error: true })).toBe('error');
	});

	it('is loading while a src is in flight', () => {
		expect(nextViewerState({ hasSrc: true, loading: true })).toBe('loading');
	});

	it('is ready once a src has loaded with no error', () => {
		expect(nextViewerState({ hasSrc: true })).toBe('ready');
	});
});
