import { describe, it, expect } from 'vitest';
import { milestoneNote, MILESTONES } from '../src/forge-milestones.js';

describe('milestoneNote', () => {
	it('returns a note exactly on each milestone count', () => {
		for (const m of MILESTONES) {
			expect(milestoneNote(m.at)).toBe(m.note);
		}
	});

	it('returns null for non-milestone counts (most forges get nothing)', () => {
		for (const n of [1, 2, 4, 5, 9, 11, 24, 26, 99, 101, 500]) {
			expect(milestoneNote(n)).toBeNull();
		}
	});

	it('rewards the 3rd forge (past first-try curiosity)', () => {
		expect(milestoneNote(3)).toMatch(/3 models/);
	});

	it('is safe for invalid input', () => {
		for (const bad of [0, -1, 1.5, NaN, null, undefined, '3']) {
			expect(milestoneNote(bad)).toBeNull();
		}
	});

	it('milestones are ascending and unique', () => {
		const ats = MILESTONES.map((m) => m.at);
		expect(ats).toEqual([...ats].sort((a, b) => a - b));
		expect(new Set(ats).size).toBe(ats.length);
	});
});
