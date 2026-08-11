/**
 * garment-forge's Python mirror must equal the JS taxonomy it was copied from.
 *
 * Two gates decide whether a garment is usable, and they run in different
 * languages on different machines:
 *
 *   PUBLISH  workers/garment-forge/{canonical_bones,garment_glb}.py, in the
 *            worker container, decides which slots exist, which regions a
 *            manifest may occlude, and what coverage is acceptable.
 *   WEAR     src/garment-taxonomy.js + src/glb-canonicalize.js, in the
 *            browser, decides the same things for attachGarment().
 *
 * The Python side is a hand-copied mirror with no import to keep it honest, so
 * a slot added, a region renamed, or a threshold nudged on the JS side leaves
 * the worker silently publishing manifests the runtime then refuses (or worse,
 * accepts while occluding the wrong body regions). Nothing catches that until
 * a catalog piece renders wrong on someone's avatar.
 *
 * This test is the missing link: it parses the Python literals as text (the
 * worker image has no Node, and the repo has no Python at test time, so text
 * is the only shared ground) and asserts value-for-value equality.
 *
 * When this fails, fix the PYTHON side: the JS files are the sources of truth
 * named in canonical_bones.py's own docstring.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { CANONICAL_BONES } from '../src/glb-canonicalize.js';
import {
	GARMENT_SLOTS,
	BODY_REGIONS,
	REGION_BONES,
	SLOT_OCCLUDABLE,
	MIN_BIND_COVERAGE,
} from '../src/garment-taxonomy.js';
import { GARMENT_SPEC_URI } from '../src/garment-catalog.js';

const pySource = (name) => readFileSync(
	new URL(`../workers/garment-forge/${name}`, import.meta.url), 'utf8');

const BONES_PY = pySource('canonical_bones.py');
const GLB_PY = pySource('garment_glb.py');

/** Python source with `#` comments removed, so literals spanning commented
 *  lines (SLOT_OCCLUDABLE carries a paragraph mid-dict) parse cleanly. String
 *  literals here never contain `#`, so a naive strip is exact. */
function uncommented(source) {
	return source.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n');
}

/** Body of `NAME = (...)` or `NAME = {...}`, brackets included. */
function literalOf(source, name, open, close) {
	const start = uncommented(source).indexOf(`\n${name} = ${open}`);
	expect(start, `${name} not found in the Python mirror`).toBeGreaterThan(-1);
	const text = uncommented(source).slice(start);
	let depth = 0;
	for (let i = text.indexOf(open); i < text.length; i += 1) {
		if (text[i] === open) depth += 1;
		else if (text[i] === close) {
			depth -= 1;
			if (depth === 0) return text.slice(text.indexOf(open), i + 1);
		}
	}
	throw new Error(`unterminated ${name} literal in the Python mirror`);
}

/** Strings of a flat Python tuple, in order. */
function pyTuple(source, name) {
	return [...literalOf(source, name, '(', ')').matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** Python `{"key": ("a", "b"), ...}` as a plain object of string arrays. */
function pyDictOfTuples(source, name) {
	const body = literalOf(source, name, '{', '}');
	const out = {};
	for (const entry of body.matchAll(/"([^"]+)"\s*:\s*\(([^)]*)\)/g)) {
		out[entry[1]] = [...entry[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
	}
	return out;
}

/** Bare `NAME = <number>` assignment. */
function pyNumber(source, name) {
	const match = uncommented(source).match(new RegExp(`\\n${name} = (-?[0-9.]+)`));
	expect(match, `${name} not found in the Python mirror`).not.toBeNull();
	return Number(match[1]);
}

/** Bare `NAME = "<string>"` assignment. */
function pyString(source, name) {
	const match = uncommented(source).match(new RegExp(`\\n${name} = "([^"]*)"`));
	expect(match, `${name} not found in the Python mirror`).not.toBeNull();
	return match[1];
}

describe('garment-forge Python mirror matches the JS taxonomy', () => {
	it('mirrors CANONICAL_BONES in the same order', () => {
		expect(pyTuple(BONES_PY, 'CANONICAL_BONES')).toEqual([...CANONICAL_BONES]);
	});

	it('mirrors GARMENT_SLOTS in the same order', () => {
		expect(pyTuple(BONES_PY, 'GARMENT_SLOTS')).toEqual([...GARMENT_SLOTS]);
	});

	it('mirrors BODY_REGIONS in the same order', () => {
		expect(pyTuple(BONES_PY, 'BODY_REGIONS')).toEqual([...BODY_REGIONS]);
	});

	it('mirrors REGION_BONES region for region', () => {
		const py = pyDictOfTuples(BONES_PY, 'REGION_BONES');
		expect(Object.keys(py)).toEqual(Object.keys(REGION_BONES));
		for (const region of Object.keys(REGION_BONES)) {
			expect(py[region], `REGION_BONES.${region}`).toEqual([...REGION_BONES[region]]);
		}
	});

	it('mirrors SLOT_OCCLUDABLE slot for slot', () => {
		// The publish gate and the wear gate disagreeing here is the dangerous
		// case: the forge would stamp an `occludes` the closet then applies to
		// a different set of regions, deleting body parts under the garment.
		const py = pyDictOfTuples(GLB_PY, 'SLOT_OCCLUDABLE');
		expect(Object.keys(py).sort()).toEqual(Object.keys(SLOT_OCCLUDABLE).sort());
		for (const slot of Object.keys(SLOT_OCCLUDABLE)) {
			expect(py[slot], `SLOT_OCCLUDABLE.${slot}`).toEqual([...SLOT_OCCLUDABLE[slot]]);
		}
	});

	it('mirrors MIN_BIND_COVERAGE, the number both gates compare against', () => {
		expect(pyNumber(BONES_PY, 'MIN_BIND_COVERAGE')).toBe(MIN_BIND_COVERAGE);
	});

	it('stamps the spec URI the catalog consumer validates against', () => {
		expect(pyString(GLB_PY, 'SPEC_URI')).toBe(GARMENT_SPEC_URI);
	});

	it('declares every slot it can occlude for, and only real regions', () => {
		const py = pyDictOfTuples(GLB_PY, 'SLOT_OCCLUDABLE');
		for (const slot of pyTuple(BONES_PY, 'GARMENT_SLOTS')) {
			expect(py[slot], `no SLOT_OCCLUDABLE entry for slot ${slot}`).toBeDefined();
		}
		const regions = new Set(pyTuple(BONES_PY, 'BODY_REGIONS'));
		for (const [slot, allowed] of Object.entries(py)) {
			for (const region of allowed) {
				expect(regions.has(region), `${slot} may occlude unknown region ${region}`).toBe(true);
			}
		}
	});
});
