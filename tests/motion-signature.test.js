// Motion signatures are measured, not authored, so these tests check two very
// different things:
//
//   1. The analyser does the arithmetic it claims, on synthetic clips whose
//      answer is known by construction.
//   2. The shipped index (public/animations/signatures.json) still agrees with
//      the clips on disk, and the hand-maintained tables elsewhere in the repo
//      still agree with what the motion actually does. That second half is the
//      point of the whole exercise: a claim like "shrug overlays locomotion"
//      stops being a comment someone has to remember to update.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	analyzeClip,
	describe as describeSignature,
	distance,
	energyBand,
	leadRegion,
	regionOf,
	similarTo,
	slotFit,
	DEFAULT_OVERLAY_SLOTS,
	REGIONS,
	SIGNATURE_VERSION,
} from '../src/runtime/motion-signature.js';
import { SLOTS, DEFAULT_ANIMATION_MAP } from '../src/runtime/animation-slots.js';
import { GESTURES, GESTURE_NAMES } from '../src/animation-state-machine.js';
import { buildIndex } from '../scripts/build-motion-signatures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = JSON.parse(
	fs.readFileSync(path.join(ROOT, 'public/animations/signatures.json'), 'utf8'),
);

/* ── synthetic clips, where the right answer is known ──────────────────── */

const IDENTITY = [0, 0, 0, 1];

/** A quaternion rotating `angle` radians about X. */
function quatX(angle) {
	return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
}

/**
 * Build a clip whose named bones each sweep through the given per-frame angles.
 * @param {{duration:number, bones:Object, hips?:number[][]}} spec
 */
function makeClip({ duration, bones, hips }) {
	const frameCount = Object.values(bones)[0].length;
	const times = Array.from({ length: frameCount }, (_, i) => (i * duration) / (frameCount - 1));
	const tracks = Object.entries(bones).map(([bone, angles]) => ({
		name: `${bone}.quaternion`,
		times,
		values: angles.flatMap((a) => (a === 0 ? IDENTITY : quatX(a))),
		type: 'quaternion',
	}));
	if (hips) {
		tracks.push({ name: 'Hips.position', times, values: hips.flat(), type: 'vector' });
	}
	return { name: 'synthetic', duration, tracks };
}

/** Every canonical bone held at rest, so unrelated regions read as zero. */
function still(frameCount) {
	return Array.from({ length: frameCount }, () => 0);
}

describe('regionOf', () => {
	it('maps the canonical skeleton onto the five regions', () => {
		expect(regionOf('Hips')).toBe('root');
		expect(regionOf('Spine2')).toBe('torso');
		expect(regionOf('Head')).toBe('head');
		expect(regionOf('LeftForeArm')).toBe('arms');
		expect(regionOf('RightToeBase')).toBe('legs');
	});

	it('excludes finger bones', () => {
		// Only some exports carry finger tracks. Counting them would score two
		// clips with identical body motion differently on export settings alone.
		expect(regionOf('LeftHandIndex2')).toBeNull();
		expect(regionOf('RightHandThumb1')).toBeNull();
		expect(regionOf('LeftHand')).toBe('arms');
	});
});

describe('analyzeClip', () => {
	it('attributes motion to the region that moved', () => {
		const sig = analyzeClip(
			makeClip({
				duration: 1,
				bones: { Head: [0, 0.5, 0], Neck: still(3), LeftArm: still(3), LeftUpLeg: still(3) },
			}),
		);
		expect(sig.lead).toBe('head');
		expect(sig.regions.head).toBeCloseTo(1, 5);
		expect(sig.regions.legs).toBe(0);
		expect(REGIONS.reduce((sum, r) => sum + sig.regions[r], 0)).toBeCloseTo(1, 5);
	});

	it('scores a faster sweep as more energetic', () => {
		const slow = analyzeClip(makeClip({ duration: 4, bones: { LeftArm: [0, 1, 0] } }));
		const fast = analyzeClip(makeClip({ duration: 1, bones: { LeftArm: [0, 1, 0] } }));
		expect(fast.energy).toBeGreaterThan(slow.energy);
		expect(energyBand(fast)).not.toBe(energyBand(slow));
	});

	it('flags a single-frame export as a held pose', () => {
		const sig = analyzeClip({
			name: 'pose',
			duration: 0.04,
			tracks: [{ name: 'Head.quaternion', times: [0], values: IDENTITY, type: 'quaternion' }],
		});
		expect(sig.static).toBe(true);
		expect(sig.frames).toBe(1);
		expect(describeSignature(sig)).toMatch(/single held pose/i);
	});

	it('measures root travel and reports a drifting clip as unanchored', () => {
		const frames = 11;
		const hips = Array.from({ length: frames }, (_, i) => [i * 0.05, 0.94, 0]);
		const sig = analyzeClip(
			makeClip({ duration: 1, bones: { LeftUpLeg: Array.from({ length: frames }, (_, i) => (i % 2) * 0.3) }, hips }),
		);
		expect(sig.travel).toBeCloseTo(0.5, 2);
		expect(sig.anchored).toBe(false);
	});

	it('treats a clip that returns to its start as anchored', () => {
		const frames = 11;
		const hips = Array.from({ length: frames }, (_, i) => [Math.sin((i / (frames - 1)) * Math.PI * 2) * 0.1, 0.94, 0]);
		const sig = analyzeClip(makeClip({ duration: 1, bones: { LeftUpLeg: still(frames) }, hips }));
		expect(sig.travel).toBeLessThan(0.01);
		expect(sig.anchored).toBe(true);
	});

	it('detects the period of a repeating motion', () => {
		// Four seconds at 30fps, one full cycle per second: a 60 BPM beat.
		const frames = 121;
		const angles = Array.from({ length: frames }, (_, i) => 0.6 * Math.sin((i / 30) * Math.PI * 2));
		const sig = analyzeClip(makeClip({ duration: 4, bones: { LeftArm: angles } }));
		// The energy envelope of a sine peaks twice per cycle, so the measured
		// beat is the half-cycle: what a listener would tap along to.
		expect([60, 120]).toContain(sig.tempo);
		expect(sig.beat).toBeGreaterThan(0.3);
	});

	it('reports no beat for a one-shot', () => {
		const frames = 61;
		const angles = Array.from({ length: frames }, (_, i) => (i < 30 ? i / 30 : (60 - i) / 30));
		const sig = analyzeClip(makeClip({ duration: 2, bones: { LeftArm: angles } }));
		expect(sig.tempo).toBe(0);
	});

	it('measures the loop seam between the last frame and the first', () => {
		const closed = analyzeClip(makeClip({ duration: 1, bones: { LeftArm: [0, 0.8, 0] } }));
		expect(closed.seam).toBeCloseTo(0, 5);
		expect(closed.loopClean).toBe(true);

		const open = analyzeClip(makeClip({ duration: 1, bones: { LeftArm: [0, 0.4, 0.8] } }));
		expect(open.seam).toBeGreaterThan(0.2);
		expect(open.loopClean).toBe(false);
	});

	it('scores a one-sided motion as unbalanced and a mirrored one as balanced', () => {
		const oneSided = analyzeClip(
			makeClip({ duration: 1, bones: { LeftArm: [0, 0.8, 0], RightArm: still(3) } }),
		);
		expect(oneSided.balance).toBeCloseTo(0, 5);

		const mirrored = analyzeClip(
			makeClip({ duration: 1, bones: { LeftArm: [0, 0.8, 0], RightArm: [0, 0.8, 0] } }),
		);
		expect(mirrored.balance).toBeCloseTo(1, 5);
	});

	it('marks an upper-body clip as overlay-safe and a leg-led one as not', () => {
		const upper = analyzeClip(
			makeClip({ duration: 1, bones: { LeftArm: [0, 0.9, 0], Head: [0, 0.4, 0], LeftUpLeg: still(3) } }),
		);
		expect(upper.overlay).toBe(true);

		const lower = analyzeClip(
			makeClip({ duration: 1, bones: { LeftUpLeg: [0, 0.9, 0], LeftLeg: [0, 0.7, 0], LeftArm: still(3) } }),
		);
		expect(lower.overlay).toBe(false);
	});
});

describe('distance and similarTo', () => {
	it('scores a clip as identical to itself and further from a different shape', () => {
		const arms = analyzeClip(makeClip({ duration: 1, bones: { LeftArm: [0, 0.8, 0] } }));
		const alsoArms = analyzeClip(makeClip({ duration: 1, bones: { RightArm: [0, 0.8, 0] } }));
		const legs = analyzeClip(makeClip({ duration: 1, bones: { LeftUpLeg: [0, 0.8, 0] } }));
		expect(distance(arms, arms)).toBe(0);
		expect(distance(arms, alsoArms)).toBeLessThan(distance(arms, legs));
	});

	it('never returns the query clip among its own neighbours', () => {
		const matches = similarTo('wave', INDEX.clips, 5);
		expect(matches.length).toBe(5);
		expect(matches.map((m) => m.clip)).not.toContain('wave');
		// Sorted nearest-first.
		for (let i = 1; i < matches.length; i++) {
			expect(matches[i].distance).toBeGreaterThanOrEqual(matches[i - 1].distance);
		}
	});

	it('returns nothing for a clip that is not in the index', () => {
		expect(similarTo('not-a-clip', INDEX.clips)).toEqual([]);
	});
});

describe('leadRegion', () => {
	it('picks the largest share', () => {
		expect(leadRegion({ head: 0.1, arms: 0.2, torso: 0.05, root: 0.05, legs: 0.6 })).toBe('legs');
	});
});

describe('slotFit', () => {
	const upperGesture = analyzeClip(
		makeClip({ duration: 1, bones: { LeftArm: [0, 0.9, 0], Head: [0, 0.3, 0] } }),
	);

	it('accepts an upper-body clip for an overlay slot', () => {
		expect(slotFit('wave', upperGesture).level).toBe('ok');
	});

	it('rejects a leg-led clip for an overlay slot, and says why', () => {
		const legs = analyzeClip(
			makeClip({ duration: 1, bones: { LeftUpLeg: [0, 0.9, 0], LeftLeg: [0, 0.8, 0] } }),
		);
		const fit = slotFit('shrug', legs);
		expect(fit.level).toBe('warn');
		expect(fit.message).toMatch(/below the waist/);
	});

	it('rejects a clip with an open seam for a looping slot', () => {
		const open = analyzeClip(makeClip({ duration: 1, bones: { LeftArm: [0, 0.4, 0.9] } }));
		expect(slotFit('idle', open).level).toBe('warn');
	});

	it('rejects a held pose for any slot', () => {
		const pose = analyzeClip({
			name: 'pose',
			duration: 0.04,
			tracks: [{ name: 'Head.quaternion', times: [0], values: IDENTITY, type: 'quaternion' }],
		});
		expect(slotFit('celebrate', pose).message).toMatch(/held pose/i);
	});

	it('warns about a drifting clip even in a slot with no other constraint', () => {
		const frames = 11;
		const drift = analyzeClip(
			makeClip({
				duration: 1,
				bones: { LeftArm: Array.from({ length: frames }, (_, i) => (i % 2) * 0.4) },
				hips: Array.from({ length: frames }, (_, i) => [i * 0.06, 0.94, 0]),
			}),
		);
		const fit = slotFit('celebrate', drift);
		expect(fit.level).toBe('warn');
		expect(fit.message).toMatch(/slides/);
	});

	it('returns null when there is no signature to judge', () => {
		expect(slotFit('wave', null)).toBeNull();
	});
});

/* ── the shipped index, held to the clips on disk ──────────────────────── */

describe('signatures.json', () => {
	it('is current: re-measuring every clip reproduces the shipped index', () => {
		// The index is a build artifact. If a clip is rebaked and this is not
		// regenerated, every fingerprint on /gestures describes the old motion.
		const fresh = buildIndex();
		expect(fresh.version).toBe(SIGNATURE_VERSION);
		expect(fresh).toEqual(INDEX);
	});

	it('covers every clip in the manifest', () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(ROOT, 'public/animations/manifest.json'), 'utf8'),
		);
		for (const entry of manifest) {
			expect(INDEX.clips[entry.name], `no signature for ${entry.name}`).toBeTruthy();
		}
	});

	it('gives every slot default a measured signature', () => {
		for (const slot of SLOTS) {
			expect(INDEX.clips[DEFAULT_ANIMATION_MAP[slot]], `slot ${slot}`).toBeTruthy();
		}
	});
});

/* ── the hand-maintained tables, held to the measurements ──────────────── */

describe('the walk gesture table agrees with the motion', () => {
	it('lists the same overlay slots the fit rules assume', () => {
		// DEFAULT_OVERLAY_SLOTS drives every "this will not survive the strip"
		// warning. It is a copy of the `upper` layer in the state machine, so it
		// has to be checked against the original rather than trusted.
		const upperClips = new Set(
			GESTURE_NAMES.filter((n) => GESTURES[n].layer === 'upper').map((n) => GESTURES[n].clip),
		);
		for (const slot of DEFAULT_OVERLAY_SLOTS) {
			const clip = DEFAULT_ANIMATION_MAP[slot];
			expect(clip, `overlay slot ${slot} has no default clip`).toBeTruthy();
			// Every overlay slot's default clip is one the walk layer also plays
			// as an upper-body overlay, or is the sign-language agree clip.
			expect(
				upperClips.has(clip) || slot === 'sign',
				`${slot} → ${clip} is not played on the upper layer anywhere`,
			).toBe(true);
		}
	});

	it('does not put a clip on the upper layer that has nothing above the waist', () => {
		// _buildOverlayClip strips hips/legs/feet before blending. A clip whose
		// motion is mostly below the waist becomes a near no-op on that layer.
		for (const name of GESTURE_NAMES) {
			const def = GESTURES[name];
			if (def.layer !== 'upper') continue;
			const sig = INDEX.clips[def.clip];
			expect(sig, `${name} → ${def.clip} has no signature`).toBeTruthy();
			expect(
				sig.upperShare,
				`${name} plays ${def.clip} on the upper layer, but only ${Math.round(sig.upperShare * 100)}% of it is above the waist`,
			).toBeGreaterThan(0.4);
		}
	});

	it('never puts a held pose in the gesture table', () => {
		for (const name of GESTURE_NAMES) {
			const sig = INDEX.clips[GESTURES[name].clip];
			expect(sig?.static, `${name} plays a single-frame clip`).toBe(false);
		}
	});
});

describe('the slot defaults are playable', () => {
	it('never resolves a slot to a held pose', () => {
		// Four clips in the library are single-frame exports. A slot pointed at
		// one of them freezes the avatar instead of animating it.
		for (const slot of SLOTS) {
			const clip = DEFAULT_ANIMATION_MAP[slot];
			expect(INDEX.clips[clip].static, `${slot} → ${clip} is a held pose`).toBe(false);
		}
	});

	it('never resolves a looping slot to a clip with an open seam', () => {
		for (const slot of ['idle', 'fidget', 'patience']) {
			const clip = DEFAULT_ANIMATION_MAP[slot];
			const fit = slotFit(slot, INDEX.clips[clip]);
			expect(fit.level, `${slot} → ${clip}: ${fit.message}`).toBe('ok');
		}
	});
});
