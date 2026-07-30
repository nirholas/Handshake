// The compare feature's one piece of judgement: deciding when an A/B is worth
// offering. The rule is strict on purpose. Two runs of one prompt on one engine
// is a re-roll, not an engine comparison, and offering it as one would make the
// side-by-side dishonest. These tests pin that boundary.
import { describe, it, expect } from 'vitest';
import { findComparablePrompts } from '../src/forge-compare.js';

const row = (over = {}) => ({
	id: Math.random().toString(36).slice(2),
	prompt: 'a knight in armor',
	glb_url: 'https://example.test/model.glb',
	backend: 'trellis_selfhost',
	...over,
});

describe('findComparablePrompts', () => {
	it('finds one prompt generated on two different engines', () => {
		const found = findComparablePrompts([row(), row({ backend: 'hunyuan3d' })]);
		expect(found).toHaveLength(1);
		expect(found[0].rows).toHaveLength(2);
	});

	it('ignores case and surrounding whitespace when grouping', () => {
		const found = findComparablePrompts([
			row({ prompt: '  A Knight In Armor ' }),
			row({ prompt: 'a knight in armor', backend: 'triposg' }),
		]);
		expect(found).toHaveLength(1);
	});

	it('treats collapsed inner whitespace as the same prompt', () => {
		const found = findComparablePrompts([
			row({ prompt: 'a knight   in armor' }),
			row({ prompt: 'a knight in armor', backend: 'triposg' }),
		]);
		expect(found).toHaveLength(1);
	});

	it('does not offer a re-roll: same prompt, same engine, twice', () => {
		expect(findComparablePrompts([row(), row()])).toEqual([]);
	});

	it('does not group two different prompts', () => {
		expect(
			findComparablePrompts([row(), row({ prompt: 'a red sports car', backend: 'hunyuan3d' })]),
		).toEqual([]);
	});

	it('skips rows with no model to show', () => {
		expect(
			findComparablePrompts([row({ glb_url: null }), row({ backend: 'hunyuan3d' })]),
		).toEqual([]);
	});

	it('skips rows with a missing or empty prompt', () => {
		expect(
			findComparablePrompts([
				row({ prompt: '' }),
				row({ prompt: undefined, backend: 'hunyuan3d' }),
			]),
		).toEqual([]);
	});

	it('does not count a missing backend as a distinct engine', () => {
		expect(findComparablePrompts([row({ backend: null }), row({ backend: null })])).toEqual([]);
	});

	it('handles an empty gallery', () => {
		expect(findComparablePrompts([])).toEqual([]);
	});

	it('reports every comparable prompt, not just the first', () => {
		const found = findComparablePrompts([
			row(),
			row({ backend: 'hunyuan3d' }),
			row({ prompt: 'a red sports car' }),
			row({ prompt: 'a red sports car', backend: 'triposg' }),
		]);
		expect(found).toHaveLength(2);
	});
});
