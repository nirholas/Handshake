// The score format, the compiler, and the model-free lane.
//
// The contract these protect: a score either compiles to a clip a mixer can
// play, or it is rejected with the path that was wrong. There is no third
// outcome where it half-compiles, because a half-compiled motion is a body that
// half-moves and nothing downstream can tell that from a bad prompt.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	ACTION_NAMES,
	ANCHOR_NAMES,
	EFFORT_NAMES,
	EXPRESSION_NAMES,
	GAZE_NAMES,
	HAND_SHAPE_NAMES,
	LIMITS,
	MOTION_BONES,
	MOTION_SCORE_VERSION,
	POSTURE_NAMES,
	STANCE_NAMES,
	compileScore,
	composeScore,
	describeScore,
	motionCapabilities,
	motionFromText,
	normalizeScore,
	restClip,
	scoreSchema,
	stableUuid,
	validateScore,
} from '../src/index.js';

const STAND = { beats: [{ posture: 'stand' }] };

describe('score validation', () => {
	it('fills in everything the solver would otherwise have to guess', () => {
		const score = normalizeScore({ name: 'test', beats: [{ posture: 'crouch' }, { posture: 'stand' }] });
		assert.equal(score.version, MOTION_SCORE_VERSION);
		assert.equal(score.seed, 'test');
		assert.equal(score.loop, false);
		for (const beat of score.beats) {
			assert.equal(typeof beat.at, 'number');
			assert.equal(typeof beat.in, 'number');
			assert.equal(typeof beat.hold, 'number');
			assert.ok(beat.ease, 'an ease was chosen');
			assert.ok(beat.effort && typeof beat.effort.time === 'number', 'an effort was resolved');
		}
		assert.ok(score.beats[1].at > score.beats[0].at, 'the clock advanced');
		assert.equal(score.duration, score.beats[1].at + score.beats[1].hold);
	});

	it('runs the clock forward monotonically even when a beat asks to go back', () => {
		const score = normalizeScore({ beats: [{ at: 2, posture: 'stand' }, { at: 0.5, posture: 'crouch' }] });
		assert.ok(score.beats[1].at >= score.beats[0].at, 'time did not run backwards');
	});

	it('lets effort pick the timing and the easing when a beat says neither', () => {
		const sudden = normalizeScore({ effort: 'sharp', beats: [{ posture: 'stand' }, { posture: 'ready' }] });
		const slow = normalizeScore({ effort: 'sustained', beats: [{ posture: 'stand' }, { posture: 'ready' }] });
		assert.ok(sudden.beats[1].in < slow.beats[1].in, 'a sharp beat travels faster than a sustained one');
		assert.equal(slow.beats[1].ease, 'settle');
		assert.ok(['snap', 'overshoot'].includes(sudden.beats[1].ease));
	});

	it('accepts every word in its own vocabulary', () => {
		for (const posture of POSTURE_NAMES) normalizeScore({ beats: [{ posture }] });
		for (const stance of STANCE_NAMES) normalizeScore({ beats: [{ legs: { stance } }] });
		for (const gaze of GAZE_NAMES) normalizeScore({ beats: [{ gaze }] });
		for (const face of EXPRESSION_NAMES) normalizeScore({ beats: [{ face }] });
		for (const effort of EFFORT_NAMES) normalizeScore({ beats: [{ effort }] });
		for (const hand of HAND_SHAPE_NAMES) normalizeScore({ beats: [{ arms: { right: { at: 'front', hand } } }] });
		for (const at of ANCHOR_NAMES) normalizeScore({ beats: [{ arms: { right: { at } } }] });
	});

	it('names the exact path that was wrong', () => {
		const cases = [
			[{ beats: [] }, 'score.beats'],
			[{ beats: [{ posture: 'levitate' }] }, 'score.beats[0].posture'],
			[{ beats: [{ arms: { right: { at: 'elbow' } } }] }, 'score.beats[0].arms.right.at'],
			[{ beats: [{ legs: { stance: 'moonwalk' } }] }, 'score.beats[0].legs.stance'],
			[{ beats: [{ gaze: 'sideways' }] }, 'score.beats[0].gaze'],
			[{ beats: [{ ease: 'bouncy' }] }, 'score.beats[0].ease'],
			[{ beats: [{ effort: 'sassy' }] }, 'score.beats[0].effort'],
			[{ beats: [{ face: 'smug' }] }, 'score.beats[0].face'],
			[{ beats: [{ legs: { left: { plant: 'hover' } } }] }, 'score.beats[0].legs.left.plant'],
			[{ version: 99, beats: [{}] }, 'score.version'],
		];
		for (const [input, path] of cases) {
			const result = validateScore(input);
			assert.equal(result.ok, false, `${JSON.stringify(input)} should be rejected`);
			assert.equal(result.error.path, path);
		}
	});

	it('clamps a value that is merely out of range rather than rejecting it', () => {
		const score = normalizeScore({
			beats: [{ root: { height: 9, turn: 900 }, torso: { lean: -400 }, arms: { right: { at: 'front', out: 40 } } }],
		});
		const beat = score.beats[0];
		assert.ok(beat.root.height <= 1.15);
		assert.equal(beat.root.turn, LIMITS.maxAngle);
		assert.equal(beat.torso.lean, -LIMITS.maxAngle);
		assert.equal(beat.arms.right.out, LIMITS.maxOffset);
	});

	it('refuses a score longer than the limit rather than emitting an hour of keys', () => {
		const beats = Array.from({ length: 40 }, () => ({ posture: 'stand', hold: 5 }));
		assert.equal(validateScore({ beats }).ok, false);
		assert.equal(validateScore({ beats: Array.from({ length: LIMITS.maxBeats + 1 }, () => ({})) }).ok, false);
	});

	it('takes a shorthand anywhere an object is allowed', () => {
		const score = normalizeScore({
			beats: [{ arms: { right: 'chin' }, legs: 'wide', gaze: 'up', face: 'smile' }],
		});
		assert.deepEqual(score.beats[0].arms.right, { at: 'chin' });
		assert.equal(score.beats[0].legs.stance, 'wide');
		assert.deepEqual(score.beats[0].gaze, { preset: 'up' });
		assert.deepEqual(score.beats[0].face, { smile: 1 });
	});

	it('describes itself in one readable line', () => {
		const score = normalizeScore({ name: 'greeting', beats: [{ label: 'raise' }, { label: 'wave' }] });
		const line = describeScore(score);
		assert.match(line, /greeting/);
		assert.match(line, /2 beats/);
		assert.match(line, /raise > wave/);
	});
});

describe('the schema offered to a model', () => {
	it('offers exactly the words the solver accepts', () => {
		const schema = scoreSchema();
		const beat = schema.properties.beats.items.properties;
		assert.deepEqual(beat.posture.enum, [...POSTURE_NAMES]);
		assert.deepEqual(beat.gaze.enum, [...GAZE_NAMES]);
		assert.deepEqual(beat.face.enum, [...EXPRESSION_NAMES]);
		assert.deepEqual(beat.legs.properties.stance.enum, [...STANCE_NAMES]);
		assert.deepEqual(beat.arms.properties.right.properties.at.enum, [...ANCHOR_NAMES]);
		assert.deepEqual(beat.arms.properties.right.properties.hand.enum, [...HAND_SHAPE_NAMES]);
	});

	it('closes every object, so a hallucinated field is a validation error and not silence', () => {
		const schema = scoreSchema();
		const closed = (node) => {
			if (!node || typeof node !== 'object') return;
			if (node.type === 'object') assert.equal(node.additionalProperties, false);
			for (const child of Object.values(node.properties ?? {})) closed(child);
			if (node.items) closed(node.items);
		};
		closed(schema);
	});

	it('publishes its capabilities in one object', () => {
		const caps = motionCapabilities();
		assert.equal(caps.version, MOTION_SCORE_VERSION);
		assert.ok(caps.schema.properties.beats);
		assert.deepEqual(caps.actions, [...ACTION_NAMES]);
	});
});

describe('compiling to a clip', () => {
	it('emits a document a three.js mixer can parse', () => {
		const { clip } = compileScore({ name: 'stand', beats: [{ posture: 'stand' }, { posture: 'crouch' }] });
		assert.equal(typeof clip.name, 'string');
		assert.equal(clip.blendMode, 2500);
		assert.match(clip.uuid, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
		assert.ok(clip.duration > 0);
		for (const track of clip.tracks) {
			const stride = track.type === 'quaternion' ? 4 : track.type === 'vector' ? 3 : 1;
			assert.equal(track.values.length, track.times.length * stride, `${track.name} stride`);
			assert.ok(track.times.length >= 2, `${track.name} has keys`);
			assert.ok(track.values.every(Number.isFinite), `${track.name} is finite`);
			for (let i = 1; i < track.times.length; i++) {
				assert.ok(track.times[i] > track.times[i - 1], `${track.name} times increase`);
			}
		}
	});

	it('normalizes every quaternion it emits', () => {
		const { clip } = compileScore({ beats: [{ posture: 'squat', arms: { right: { at: 'overhead' } } }] });
		for (const track of clip.tracks) {
			if (track.type !== 'quaternion') continue;
			for (let i = 0; i < track.values.length; i += 4) {
				const len = Math.hypot(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3]);
				assert.ok(Math.abs(len - 1) < 1e-6, `${track.name} key ${i / 4} has length ${len}`);
			}
		}
	});

	it('always drives the full body, so two clips can be crossfaded', () => {
		const { clip } = compileScore({ beats: [{ gaze: 'up' }] });
		const driven = new Set(clip.tracks.filter((t) => t.type === 'quaternion').map((t) => t.name.split('.')[0]));
		for (const bone of MOTION_BONES) assert.ok(driven.has(bone), `${bone} is driven`);
	});

	it('emits root motion only when the body actually travels', () => {
		const still = compileScore({ beats: [{ posture: 'stand' }, { gaze: 'left' }] });
		assert.ok(!still.clip.tracks.some((t) => t.name === 'Hips.position'), 'a gesture in place has no root track');

		const walking = compileScore({ beats: [{ posture: 'stand' }, { root: { forward: 0.8 } }] });
		const track = walking.clip.tracks.find((t) => t.name === 'Hips.position');
		assert.ok(track, 'travel emits a root track');
		const startZ = track.values[2];
		const endZ = track.values[track.values.length - 1];
		assert.ok(Math.abs(endZ - startZ) > 0.5, `the body moved: ${startZ} to ${endZ}`);
	});

	it('leaves the root track out when asked for a clip that plays in place', () => {
		const { clip } = compileScore({ beats: [{ posture: 'stand' }, { root: { forward: 0.8 } }] }, { rootMotion: false });
		assert.ok(!clip.tracks.some((t) => t.name === 'Hips.position'));
	});

	it('drives an expression to zero after the beat that used it', () => {
		const { clip } = compileScore({
			beats: [{ face: 'neutral' }, { face: 'grin', hold: 0.3 }, { face: 'neutral', hold: 0.3 }],
		});
		const smile = clip.tracks.find((t) => t.name.includes('mouthSmileLeft'));
		assert.ok(smile, 'the smile lane exists');
		assert.ok(Math.max(...smile.values) > 0.5, 'it opened');
		assert.ok(smile.values[smile.values.length - 1] < 0.05, 'and it closed again');
	});

	it('closes a looping score back into its first beat', () => {
		const open = compileScore({ beats: [{ posture: 'stand' }, { posture: 'ready', hold: 0.2 }] });
		const looped = compileScore({ loop: true, beats: [{ posture: 'stand' }, { posture: 'ready', hold: 0.2 }] });
		assert.ok(looped.clip.duration > open.clip.duration, 'the return trip is in the clip');
		const track = (clip, name) => clip.tracks.find((t) => t.name === name);
		const first = track(looped.clip, 'LeftUpLeg.quaternion');
		const startKey = first.values.slice(0, 4);
		const endKey = first.values.slice(-4);
		for (let i = 0; i < 4; i++) {
			assert.ok(Math.abs(startKey[i] - endKey[i]) < 0.02, 'the loop lands back where it started');
		}
	});

	it('is deterministic: the same score is the same bytes, forever', () => {
		const score = { name: 'nod', beats: [{ gaze: 'forward' }, { gaze: 'down', hold: 0.2 }, { gaze: 'forward' }] };
		assert.equal(JSON.stringify(compileScore(score).clip), JSON.stringify(compileScore(score).clip));
		assert.notEqual(
			compileScore({ ...score, seed: 'a' }).clip.uuid,
			compileScore({ ...score, seed: 'b' }).clip.uuid,
		);
		assert.equal(stableUuid('x'), stableUuid('x'));
		assert.notEqual(stableUuid('x'), stableUuid('y'));
	});

	it('breathes by default and holds perfectly still when told not to', () => {
		const alive = compileScore(STAND, { idle: true }).clip;
		const still = compileScore(STAND, { idle: false }).clip;
		const spread = (clip) => {
			const track = clip.tracks.find((t) => t.name === 'Spine1.quaternion');
			const xs = track.values.filter((_, i) => i % 4 === 0);
			return Math.max(...xs) - Math.min(...xs);
		};
		assert.ok(spread(alive) > 0, 'a standing body is never perfectly still');
		assert.equal(spread(still), 0, 'unless it is asked to be');
	});

	it('gives a rest clip for a body doing nothing', () => {
		const clip = restClip('rest');
		assert.equal(clip.name, 'rest');
		assert.ok(clip.tracks.length > 0);
	});
});

describe('the model-free lane', () => {
	it('recognizes every action it advertises, and says so when it does not', () => {
		for (const action of ACTION_NAMES) {
			const { matched } = composeScore(action.replace('_', ' '));
			assert.ok(matched, `"${action}" is recognized`);
		}
		const miss = composeScore('perform an interpretive dance about quarterly earnings');
		assert.equal(miss.score, null);
		assert.match(miss.reason, /no known action/);
		assert.match(miss.reason, /wave/, 'the miss says what it does know');
	});

	it('compiles every action it knows into a playable clip with nothing unreachable', () => {
		for (const action of ACTION_NAMES) {
			const result = motionFromText(action.replace('_', ' '));
			assert.ok(result.clip.duration > 0.4, `${action} has a duration`);
			assert.ok(result.clip.tracks.length > 10, `${action} drives a body`);
			assert.deepEqual(result.warnings, [], `${action} solves without warnings`);
		}
	});

	it('reads manner, side, direction, and repetition out of the prompt', () => {
		assert.ok(
			motionFromText('wave quickly').clip.duration < motionFromText('wave slowly').clip.duration,
			'a quick wave is shorter than a slow one',
		);
		assert.ok(
			motionFromText('clap 4 times').clip.duration > motionFromText('clap once').clip.duration,
			'more claps take longer',
		);
		const left = composeScore('wave with your left hand').score;
		assert.ok(left.beats.some((b) => b.arms?.left?.at === 'overhead'), 'the left hand did the waving');
		const right = composeScore('wave').score;
		assert.ok(right.beats.some((b) => b.arms?.right?.at === 'overhead'), 'the right hand is the default');
	});

	it('throws something a caller can act on when it does not know the words', () => {
		assert.throws(
			() => motionFromText('reticulate splines'),
			(err) => err.code === 'unrecognized_motion' && /reticulate/.test(err.message),
		);
	});

	it('is stable: the same prompt is the same clip', () => {
		const a = motionFromText('sit down heavily');
		const b = motionFromText('sit down heavily');
		assert.equal(JSON.stringify(a.clip), JSON.stringify(b.clip));
	});
});

describe('the body it produces', () => {
	it('keeps the feet on the floor through a crouch', () => {
		const { clip } = compileScore({
			beats: [{ posture: 'stand' }, { posture: 'squat', hold: 0.3 }, { posture: 'stand' }],
		}, { idle: false });
		const root = clip.tracks.find((t) => t.name === 'Hips.position');
		const heights = root.values.filter((_, i) => i % 3 === 1);
		assert.ok(Math.min(...heights) < Math.max(...heights) - 0.2, 'the hips travelled down and back up');
		assert.ok(Math.min(...heights) > 0.3, 'and never went through the floor');
	});

	it('does not fall over: a standing beat keeps its weight over its feet', async () => {
		const { solveBeat } = await import('../src/solve.js');
		const { balanceError } = await import('../src/rig/ik.js');
		for (const posture of POSTURE_NAMES) {
			const score = normalizeScore({ beats: [{ posture }] });
			const { pose } = solveBeat(score.beats[0]);
			const error = balanceError(pose);
			// Seated and kneeling shapes are held up by something other than the
			// feet, so they are allowed to sit outside their own footprint.
			const supported = ['sit', 'slouch', 'kneel'].includes(posture);
			assert.ok(supported || error < 0.05, `${posture} balance error ${error.toFixed(3)}`);
		}
	});
});
