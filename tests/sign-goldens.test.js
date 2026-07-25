/**
 * Positional goldens for the signing lane.
 *
 * The other sign tests assert properties ("in front of the body", "the elbow
 * hangs", "the fingertips touch the palm"). This one asserts the actual shape:
 * where every sign puts both wrists, elbows, and fingertips at four moments
 * through its clip, against a recorded snapshot.
 *
 * It exists because the failure mode here is silent and wide. A change to the IK
 * pole, an anchor, or a shared handshape moves every sign that uses it, and no
 * property assertion notices a sign drifting five centimetres off. The tolerance
 * is deliberately loose enough to ignore floating-point noise and tight enough
 * that a real change has to be acknowledged:
 *
 *   node scripts/build-sign-goldens.mjs   # re-record, then review the diff
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildGoldens } from '../scripts/build-sign-goldens.mjs';

const FIXTURE = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'fixtures/sign-poses.json',
);

// 8 mm. Below a fingertip's width, so a sign cannot drift visibly without this
// failing, and well above any floating-point wobble.
const TOLERANCE = 0.008;

const recorded = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const current = buildGoldens();

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('recorded sign poses', () => {
	for (const group of ['signs', 'spelling']) {
		it(`${group}: covers the same clips as the snapshot`, () => {
			expect(Object.keys(current[group]).sort()).toEqual(Object.keys(recorded[group]).sort());
		});

		it(`${group}: every hand lands where it was recorded`, () => {
			const drifted = [];
			for (const [word, samples] of Object.entries(recorded[group])) {
				const now = current[group][word];
				if (!now) continue;
				samples.forEach((sample, i) => {
					for (const [point, value] of Object.entries(sample)) {
						const moved = distance(value, now[i][point]);
						if (moved > TOLERANCE) {
							drifted.push(`${word} sample ${i} ${point}: moved ${(moved * 100).toFixed(1)}cm`);
						}
					}
				});
			}
			expect(
				drifted,
				`${drifted.length} point(s) moved. If intended, re-record with:\n` +
					`  node scripts/build-sign-goldens.mjs\n\n  ${drifted.slice(0, 12).join('\n  ')}`,
			).toEqual([]);
		});
	}
});
