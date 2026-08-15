// The Forge prompt generator's contract: every prompt it can ever emit is a
// single, isolated subject with a material cue (the shape the TRELLIS lane
// meshes cleanest) regardless of which random path produced it. These tests
// sweep every family with seeded rngs so the assertions cover the grammar
// space, not one lucky draw.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
	FAMILIES,
	generateForgePrompt,
	generateDistinctForgePrompts,
	generateForgeChipSet,
} from '../src/forge-prompt-gen.js';

// Deterministic LCG so failures reproduce exactly.
function lcg(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

// Mirrors the prompt coach's material lexicon (forge-prompt-studio.js): a
// generated prompt must always carry at least one material word so the coach
// grades it well and the lane gets a texture cue.
const MATERIAL_RE =
	/metal|brass|bronze|copper|steel|iron|chrome|aluminium|gold|silver|ceramic|porcelain|glazed|crystal|wood|oak|leather|matte|glossy|polished|brushed|velvet|felt|stone|marble|granite|concrete|knit|enamel|bakelite|terracotta|weathered|patina|clay|obsidian|jade|wool|timber|brick|canvas|stoneware|rattan|cedar|ebony|walnut|driftwood|blackthorn|cloth|linen/;

// Anything that pushes TRELLIS toward a multi-object or scene mesh. The
// " x and y " join is the same heuristic the coach warns on.
const MULTI_SUBJECT_RE = /\b(two|three|four|several|a group of|a pair of|a set of)\b|\w+\s+and\s+\w+/;
const SCENE_RE = /\b(scene|landscape|environment|diorama|room|interior|forest|city|street)\b/;

function assertWellFormed(prompt) {
	expect(typeof prompt).toBe('string');
	expect(prompt.length).toBeGreaterThanOrEqual(20);
	expect(prompt.length).toBeLessThanOrEqual(110);
	expect(prompt).toMatch(/^an? /);
	// Article agreement: "a" never precedes a vowel, "an" never a consonant.
	expect(prompt).not.toMatch(/^a [aeiou]/);
	expect(prompt).not.toMatch(/^an [^aeiou]/);
	expect(prompt).toMatch(MATERIAL_RE);
	expect(prompt).not.toMatch(MULTI_SUBJECT_RE);
	expect(prompt).not.toMatch(SCENE_RE);
	// House style and layout safety: no em/en dashes, no double spaces,
	// no unresolved template artifacts.
	expect(prompt).not.toMatch(/[—–]|\s{2}|undefined|null|\$\{/);
}

describe('forge prompt generator', () => {
	it('every family emits well-formed single-subject prompts across many seeds', () => {
		for (const family of FAMILIES) {
			for (let seed = 1; seed <= 200; seed++) {
				assertWellFormed(family(lcg(seed * 7919)));
			}
		}
	});

	it('is deterministic for a given rng sequence', () => {
		expect(generateForgePrompt(lcg(42))).toBe(generateForgePrompt(lcg(42)));
	});

	it('draws from a genuinely large space', () => {
		// 100 consecutive draws should rarely repeat (weighted family
		// selection keeps small pools from dominating collisions) ...
		const rng = lcg(1);
		const seen = new Set();
		for (let i = 0; i < 100; i++) seen.add(generateForgePrompt(rng));
		expect(seen.size).toBeGreaterThan(80);
		// ... and the total space holds hundreds of distinct prompts.
		const many = generateDistinctForgePrompts(300, new Set(), lcg(2));
		expect(many).toHaveLength(300);
	});

	it('generateDistinctForgePrompts honors count, avoid, and maxLength', () => {
		const rng = lcg(9);
		const avoid = new Set(generateDistinctForgePrompts(5, new Set(), lcg(9)));
		const out = generateDistinctForgePrompts(5, avoid, rng, 64);
		expect(out).toHaveLength(5);
		expect(new Set(out).size).toBe(5);
		for (const p of out) {
			expect(avoid.has(p)).toBe(false);
			expect(p.length).toBeLessThanOrEqual(64);
			assertWellFormed(p);
		}
	});
});

// Pull one chip row's visible labels straight out of pages/forge.html.
function readChipRow(id) {
	const html = readFileSync(new URL('../pages/forge.html', import.meta.url), 'utf8');
	const row = html.slice(html.indexOf(`id="${id}"`));
	const labels = [...row.slice(0, row.indexOf('</div>')).matchAll(/<button class="chip"[^>]*>([^<]+)<\/button>/g)].map(
		(m) => m[1].trim()
	);
	if (!labels.length) throw new Error(`no .chip labels found under #${id} in pages/forge.html`);
	return labels;
}

// The chip rows on /forge wrap, so a replacement set that is wider overall adds
// a line and pushes the page down. generateForgeChipSet exists to make that
// impossible; these lock the budget contract that the CLS fix rests on.
describe('generateForgeChipSet', () => {
	// Read from the page rather than copied here: the labels ARE the reservation.
	// They are written at the 64-character cap on purpose so the row reserves its
	// worst case at first paint, and shortening them is exactly the regression
	// that put a 0.19 layout shift on /forge. Deriving the budget from the real
	// markup makes this suite the alarm for that.
	const STATIC_CHIPS = readChipRow('examples');
	const STARTER_CHIPS = readChipRow('empty-starters');

	// CHIP_MAXLEN in forge-prompt-studio.js. A shipped label shorter than this
	// under-reserves the row, which is the shift; longer than this reserves space
	// the rotation can never use.
	const CHIP_MAXLEN = 64;

	it.each([
		['#examples', STATIC_CHIPS],
		['#empty-starters', STARTER_CHIPS],
	])('%s reserves the row at the generator cap', (_id, labels) => {
		expect(labels.length).toBeGreaterThan(1);
		for (const label of labels) {
			expect(label.length).toBeLessThanOrEqual(CHIP_MAXLEN);
			expect(label.length).toBeGreaterThanOrEqual(CHIP_MAXLEN - 6);
		}
	});

	it.each([
		['#examples', STATIC_CHIPS],
		['#empty-starters', STARTER_CHIPS],
	])('%s: a rotation never returns more characters than it replaces', (_id, labels) => {
		const budget = labels.reduce((n, s) => n + s.length, 0);
		const longest = Math.max(...labels.map((s) => s.length));
		for (let seed = 1; seed <= 300; seed++) {
			const out = generateForgeChipSet(labels, new Set(), lcg(seed * 104729), CHIP_MAXLEN);
			expect(out).toHaveLength(labels.length);
			expect(new Set(out).size).toBe(labels.length);
			expect(out.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(budget);
			for (const p of out) {
				// No single chip may exceed the widest label already in the row,
				// so one long prompt cannot push a short neighbour onto a new line.
				expect(p.length).toBeLessThanOrEqual(longest);
				assertWellFormed(p);
			}
		}
	});

	it('honors avoid so a rotation never echoes what is already on screen', () => {
		const first = generateForgeChipSet(STATIC_CHIPS, new Set(), lcg(5), 64);
		const second = generateForgeChipSet(STATIC_CHIPS, new Set(first), lcg(11), 64);
		for (const p of second) expect(first).not.toContain(p);
	});

	it('still rotates the row when the budget is far too tight to honor', () => {
		// Labels shorter than any generatable prompt: the row must degrade to the
		// shortest candidates rather than freeze on the static copy.
		const out = generateForgeChipSet(['ab', 'cd', 'ef'], new Set(), lcg(3), 64);
		expect(out).toHaveLength(3);
		for (const p of out) assertWellFormed(p);
	});

	it('returns nothing for an empty row', () => {
		expect(generateForgeChipSet([], new Set(), lcg(1), 64)).toEqual([]);
	});
});
