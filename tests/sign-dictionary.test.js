/**
 * Lexical sign dictionary — unit tests.
 *
 * Signs are authored as places in signing space, so they can be checked the same
 * way a signer would check them: replay the compiled clip through forward
 * kinematics and assert where the hands actually are. Model space is +Z forward
 * (the way the avatar faces), +Y up, −X the right side of the body.
 */

import { describe, expect, it } from 'vitest';

import {
	SIGNABLE_WORDS,
	SIGNS,
	buildSignClip,
	lookupSign,
	signGloss,
	signLookup,
} from '../src/sign-dictionary.js';
import { ANCHORS, Pose } from '../src/sign-rig.js';
import { compileUtterance } from '../src/sign-speech.js';

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

/** The pose while the sign's final phase is held, before it settles. */
function peakPose(clip) {
	return poseAtTime(clip, clip.duration - 0.4);
}

const WORDS = Object.keys(SIGNS);

describe('vocabulary', () => {
	it('every sign has a plain-language gloss', () => {
		for (const word of WORDS) {
			expect(SIGNS[word].gloss, word).toBeTruthy();
			expect(signGloss(word), word).toBe(SIGNS[word].gloss);
		}
	});

	it('resolves aliases to real signs', () => {
		expect(lookupSign('hi').name).toBe('HELLO');
		expect(lookupSign('THANKS').name).toBe('THANK');
		expect(lookupSign('everyone').name).toBe('YALL');
		expect(lookupSign('zzzz')).toBeNull();
	});

	it('lists every signable word, aliases included', () => {
		expect(SIGNABLE_WORDS).toContain('HAPPY');
		expect(SIGNABLE_WORDS).toContain('HI');
		expect(SIGNABLE_WORDS.length).toBeGreaterThan(WORDS.length);
		for (const word of SIGNABLE_WORDS) expect(lookupSign(word), word).toBeTruthy();
	});
});

describe('compiled clips', () => {
	it('every sign compiles to a valid, monotonic, unit-quaternion clip', () => {
		for (const word of WORDS) {
			const clip = buildSignClip(word);
			expect(clip, word).toBeTruthy();
			expect(clip.duration, word).toBeGreaterThan(0.5);
			for (const track of clip.tracks) {
				expect(track.type, `${word}:${track.name}`).toBe('quaternion');
				expect(track.values.length).toBe(track.times.length * 4);
				for (let i = 1; i < track.times.length; i++) {
					expect(track.times[i], `${word}:${track.name}`).toBeGreaterThan(track.times[i - 1]);
				}
				for (let i = 0; i < track.values.length; i += 4) {
					expect(Math.hypot(...track.values.slice(i, i + 4))).toBeCloseTo(1, 6);
				}
			}
		}
	});

	it('never drives the root, so the avatar cannot sink through the floor', () => {
		for (const word of WORDS) {
			const names = buildSignClip(word).tracks.map((t) => t.name);
			expect(names.some((n) => n.startsWith('Hips')), word).toBe(false);
			expect(names.every((n) => n.endsWith('.quaternion')), word).toBe(true);
		}
	});

	it('is deterministic', () => {
		expect(buildSignClip('HAPPY')).toEqual(buildSignClip('HAPPY'));
	});

	it('returns null for a word with no sign', () => {
		expect(buildSignClip('QWERTY')).toBeNull();
	});

	it('rate scales the tempo without changing the shape', () => {
		const normal = buildSignClip('HELLO');
		const fast = buildSignClip('HELLO', { rate: 2 });
		expect(fast.duration).toBeLessThan(normal.duration);
		expect(fast.tracks.length).toBe(normal.tracks.length);
	});
});

describe('where the hands actually go', () => {
	it('keeps every hand in front of the body for the whole sign', () => {
		for (const word of WORDS) {
			const clip = buildSignClip(word);
			for (let t = 0.35; t < clip.duration - 0.35; t += 0.12) {
				const pose = poseAtTime(clip, t);
				for (const side of ['Left', 'Right']) {
					const hand = pose.worldPos(`${side}Hand`);
					// −0.05 allows a hand resting beside the hip; the failure this
					// guards is a hand swung round BEHIND the torso.
					expect(hand[2], `${word} ${side} @${t.toFixed(2)}`).toBeGreaterThan(-0.06);
				}
			}
		}
	});

	it('never lifts an elbow above its own shoulder', () => {
		for (const word of WORDS) {
			const clip = buildSignClip(word);
			for (let t = 0; t <= clip.duration; t += 0.15) {
				const pose = poseAtTime(clip, t);
				for (const side of ['Left', 'Right']) {
					const elbow = pose.worldPos(`${side}ForeArm`)[1];
					const shoulder = pose.worldPos(`${side}Arm`)[1];
					expect(elbow, `${word} ${side} @${t.toFixed(2)}`).toBeLessThan(shoulder + 0.02);
				}
			}
		}
	});

	it('starts and ends every sign with the arms at rest', () => {
		for (const word of WORDS) {
			const clip = buildSignClip(word);
			for (const t of [0, clip.duration]) {
				const pose = poseAtTime(clip, t);
				for (const side of ['Left', 'Right']) {
					expect(pose.worldPos(`${side}Hand`)[1], `${word} ${side}`).toBeLessThan(ANCHORS.belly[1]);
				}
			}
		}
	});

	it('signs the two-handed ones with BOTH hands, symmetrically', () => {
		for (const word of ['HAPPY', 'WANT', 'MORE', 'MEET', 'WHAT', 'FINISH']) {
			const pose = peakPose(buildSignClip(word));
			const r = pose.worldPos('RightHand');
			const l = pose.worldPos('LeftHand');
			expect(r[1], `${word} right`).toBeGreaterThan(ANCHORS.belly[1]);
			expect(l[1], `${word} left`).toBeGreaterThan(ANCHORS.belly[1]);
			expect(Math.abs(r[1] - l[1]), `${word} height`).toBeLessThan(0.05);
			expect(r[0]).toBeLessThan(0);
			expect(l[0]).toBeGreaterThan(0);
		}
	});

	it('places the signs that are defined by their location', () => {
		const at = (word) => peakPose(buildSignClip(word)).worldPos('RightHand');
		// KNOW and THINK are head signs; HAPPY and LOVE are chest signs.
		expect(at('KNOW')[1]).toBeGreaterThan(ANCHORS.chin[1]);
		expect(at('THINK')[1]).toBeGreaterThan(ANCHORS.chin[1]);
		expect(at('HAPPY')[1]).toBeLessThan(ANCHORS.chin[1]);
		expect(at('HAPPY')[1]).toBeGreaterThan(ANCHORS.belly[1]);
		// LOVE crosses the arms, so the right hand ends up on the LEFT of centre.
		expect(at('LOVE')[0]).toBeGreaterThan(0);
	});

	it('HAPPY brushes upward, the way the sign moves', () => {
		const clip = buildSignClip('HAPPY');
		const low = poseAtTime(clip, 0.62).worldPos('RightHand')[1];
		const high = poseAtTime(clip, 0.9).worldPos('RightHand')[1];
		expect(high).toBeGreaterThan(low);
	});

	it('YALL sweeps across the group', () => {
		const clip = buildSignClip('YALL');
		const start = poseAtTime(clip, 0.62).worldPos('RightHand')[0];
		const end = peakPose(clip).worldPos('RightHand')[0];
		expect(end).toBeLessThan(start - 0.15); // travels outward, to −X
	});

	it('FALL stands the legs on the palm, then tips them over', () => {
		const clip = buildSignClip('FALL');
		const standing = poseAtTime(clip, 0.7);
		const fallen = peakPose(clip);
		// Fingers point down while standing, then swing away from down.
		expect(standing.worldDir('RightHand')[1]).toBeLessThan(-0.6);
		expect(fallen.worldDir('RightHand')[1]).toBeGreaterThan(standing.worldDir('RightHand')[1] + 0.5);
	});
});

describe('signLookup', () => {
	it('feeds compileUtterance so known words sign and the rest spell', () => {
		const out = compileUtterance('hello brixton happy', { signs: signLookup() });
		expect(out.signed).toEqual(['HELLO', 'HAPPY']);
		expect(out.spelled).toEqual(['BRIXTON']);
		expect(out.clip.duration).toBeGreaterThan(0);
		for (const track of out.clip.tracks) {
			for (let i = 1; i < track.times.length; i++) {
				expect(track.times[i], track.name).toBeGreaterThan(track.times[i - 1]);
			}
		}
	});

	it('caches so a repeated word is compiled once', () => {
		const lookup = signLookup();
		expect(lookup('HAPPY')).toBe(lookup('HAPPY'));
	});
});
