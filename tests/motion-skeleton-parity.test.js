// The published motion package carries its own copy of the reference skeleton,
// because it runs standalone on npm and cannot import out of `src/`. Both files
// are written by scripts/build-canonical-rest.mjs from one measurement pass.
//
// This test is what makes that copy safe. If the two ever disagree, every clip
// @three-ws/motion emits is authored against a different body than the one the
// site retargets onto, and the symptom downstream is "the animation looks
// slightly wrong" with nothing pointing back here. Re-run the generator to fix
// a failure; do not edit either file by hand.

import { describe, it, expect } from 'vitest';

import * as site from '../src/animation-canonical-rest.js';
import * as pkg from '../packages/motion/src/rig/skeleton-data.js';

const TABLES = ['CANONICAL_REST', 'CANONICAL_REST_WORLD', 'CANONICAL_REST_POSITION', 'CANONICAL_PARENT'];

describe('the motion package and the site share one reference skeleton', () => {
	it('exports the same four tables', () => {
		for (const table of TABLES) {
			expect(site[table], `src/animation-canonical-rest.js is missing ${table}`).toBeTruthy();
			expect(pkg[table], `packages/motion skeleton-data.js is missing ${table}`).toBeTruthy();
		}
	});

	it('covers the same bones', () => {
		for (const table of TABLES) {
			expect(Object.keys(pkg[table]).sort()).toEqual(Object.keys(site[table]).sort());
		}
	});

	it('holds identical values, to the last bit', () => {
		for (const table of TABLES) {
			expect(pkg[table], `${table} drifted; re-run npm run build:canonical-rest`).toEqual(site[table]);
		}
	});
});
