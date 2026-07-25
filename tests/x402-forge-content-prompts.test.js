import { describe, it, expect } from 'vitest';

import { nextForgeProp } from '../api/_lib/x402/pipelines/forge-content.js';

// The prop generator must look random (varied categories and prompts hour to
// hour) while staying strictly deterministic within an hour: the paid forge
// endpoint's idempotency guard relies on two same-hour runs requesting the
// SAME prop, and the /forged gallery relies on the walk not looping through a
// handful of prompts.

describe('nextForgeProp', () => {
	const HOUR_MS = 3_600_000;

	it('is stable within an hour and changes across hours', () => {
		const base = 500_000 * HOUR_MS;
		const a = nextForgeProp(base);
		const b = nextForgeProp(base + HOUR_MS - 1);
		expect(b).toEqual(a);
		const c = nextForgeProp(base + HOUR_MS);
		expect(c.prompt).not.toBe(a.prompt);
	});

	it('covers a wide, category-balanced prompt space', () => {
		const prompts = new Set();
		const perCategory = new Map();
		for (let h = 0; h < 400; h++) {
			const { category, prompt } = nextForgeProp(h * HOUR_MS);
			expect(typeof category).toBe('string');
			expect(prompt).toMatch(/3D prop$/);
			prompts.add(prompt);
			perCategory.set(category, (perCategory.get(category) || 0) + 1);
		}
		// ≥90% unique over 400 draws proves the walk is combinatorial, not a
		// short cycle; ≥6 categories proves no family starves.
		expect(prompts.size).toBeGreaterThan(360);
		expect(perCategory.size).toBeGreaterThanOrEqual(6);
	});
});
