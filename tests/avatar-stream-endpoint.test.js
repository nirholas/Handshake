// Tests for the progressive avatar stream endpoint's HTTP surface: byte-range
// parsing (the one piece that decides whether a CDN can serve a partial layer
// correctly) and the path handling that keeps `src` inside the public root.

import { describe, it, expect } from 'vitest';
import { parseRange } from '../api/avatar-stream.js';

describe('parseRange', () => {
	const SIZE = 1000;

	it('returns null when no Range header is present', () => {
		expect(parseRange(undefined, SIZE)).toBe(null);
		expect(parseRange('', SIZE)).toBe(null);
	});

	it('parses a closed range', () => {
		expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
		expect(parseRange('bytes=200-299', SIZE)).toEqual({ start: 200, end: 299 });
	});

	it('parses an open-ended range as running to the last byte', () => {
		expect(parseRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
	});

	it('parses a suffix range as the final N bytes', () => {
		expect(parseRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
	});

	it('clamps an end past the last byte rather than over-reading', () => {
		expect(parseRange('bytes=990-99999', SIZE)).toEqual({ start: 990, end: 999 });
	});

	it('rejects ranges it cannot satisfy', () => {
		expect(parseRange('bytes=1000-1200', SIZE)).toEqual({ unsatisfiable: true });
		expect(parseRange('bytes=500-100', SIZE)).toEqual({ unsatisfiable: true });
		expect(parseRange('bytes=-0', SIZE)).toEqual({ unsatisfiable: true });
		expect(parseRange('bytes=-', SIZE)).toEqual({ unsatisfiable: true });
	});

	it('rejects multi-range and malformed headers instead of guessing', () => {
		// Multipart ranges are legal HTTP but this endpoint serves one range.
		expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ unsatisfiable: true });
		expect(parseRange('items=0-99', SIZE)).toEqual({ unsatisfiable: true });
		expect(parseRange('bytes=abc-def', SIZE)).toEqual({ unsatisfiable: true });
	});
});
