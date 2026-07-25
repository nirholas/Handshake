#!/usr/bin/env node
/**
 * build-sign-goldens.mjs — snapshot where every sign puts the hands.
 *
 * A sign is a shape in space, so the honest regression test is positional: at
 * fixed moments through each clip, where are the wrists, the fingertips, the
 * elbows? This writes those positions to tests/fixtures/sign-poses.json, and
 * tests/sign-goldens.test.js compares against them.
 *
 * That catches the class of change no assertion anticipates: a tweak to the IK
 * pole, the anchor table, or a handshape that quietly moves twenty signs. The
 * threshold is in centimetres, so intentional retuning shows up as a readable
 * diff rather than a wall of noise.
 *
 * Re-run after an intended change and review the diff:
 *   node scripts/build-sign-goldens.mjs
 *
 * Reads:  src/sign-dictionary.js, src/fingerspelling.js
 * Writes: tests/fixtures/sign-poses.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFingerspellingClip } from '../src/fingerspelling.js';
import { SIGNS, buildSignClip } from '../src/sign-dictionary.js';
import { Pose, handPoint } from '../src/sign-rig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/sign-poses.json');

/** Fractions of a clip's duration to sample. Skips the very ends (both rest). */
export const SAMPLES = [0.25, 0.45, 0.65, 0.85];

/** Points that describe a sign: where each hand is, and what it points with. */
function measure(pose) {
	const out = {};
	for (const side of ['Left', 'Right']) {
		out[`${side.toLowerCase()}Wrist`] = pose.worldPos(`${side}Hand`);
		out[`${side.toLowerCase()}Elbow`] = pose.worldPos(`${side}ForeArm`);
		out[`${side.toLowerCase()}Tips`] = handPoint(pose, side, 'fingertips');
	}
	return out;
}

function poseAtTime(clip, time) {
	const pose = new Pose();
	for (const track of clip.tracks) {
		if (track.type !== 'quaternion') continue;
		let i = 0;
		while (i + 1 < track.times.length && track.times[i + 1] <= time) i++;
		pose.setLocal(track.name.split('.')[0], track.values.slice(i * 4, i * 4 + 4));
	}
	return pose;
}

const round = (v) => v.map((n) => Math.round(n * 10000) / 10000);

/** Golden entries for one clip: one measurement per sample point. */
export function sampleClip(clip) {
	return SAMPLES.map((u) => {
		const points = measure(poseAtTime(clip, clip.duration * u));
		return Object.fromEntries(Object.entries(points).map(([k, v]) => [k, round(v)]));
	});
}

export function buildGoldens() {
	const signs = {};
	for (const word of Object.keys(SIGNS).sort()) signs[word] = sampleClip(buildSignClip(word));
	// A handful of letters stand in for the alphabet: one fist, one flat hand,
	// one that points, one traced, and the two lowered letters.
	const spelling = {};
	for (const letter of ['A', 'B', 'D', 'J', 'P', 'Q', 'Z']) {
		spelling[letter] = sampleClip(buildFingerspellingClip(letter));
	}
	return { signs, spelling };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const goldens = buildGoldens();
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, `${JSON.stringify(goldens, null, '\t')}\n`);
	const count = Object.keys(goldens.signs).length + Object.keys(goldens.spelling).length;
	console.log(`wrote ${path.relative(ROOT, OUT)} — ${count} clips × ${SAMPLES.length} samples`);
}
