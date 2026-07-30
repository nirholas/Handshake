// @three-ws/sign-language: published-surface tests.
// ====================================================
// The engine's deep coverage lives in the monorepo suite (tests/sign-rig,
// sign-clip, sign-dictionary, fingerspelling, sign-speech, sign-goldens,
// sign-linguistics). This file guards the PACKAGE: that dist/ exposes the
// documented surface, that the documented behaviors actually hold through the
// bundle, and that the bundle really is dependency-free.
//
//   node --test test/*.test.mjs      (build first; prepublishOnly does)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sign from '../dist/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('dist exposes the documented surface', () => {
	for (const name of [
		// speak
		'SignSpeaker', 'compileUtterance', 'estimateDuration', 'utteranceWords', 'CHAT_TIMING',
		// spell
		'LETTER_SHAPES', 'DEFAULT_TIMING', 'buildFingerspellingClip', 'letterPose', 'normalizeWord',
		// lexicon
		'SIGNS', 'SIGNABLE_WORDS', 'DEFAULT_SIGN_TIMING', 'buildSignClip', 'lookupSign', 'signGloss', 'signLookup',
		// author
		'HANDSHAPES', 'HANDSHAPE_NAMES', 'applyHandshape', 'handshapeLocals',
		'SIGNING_BONES', 'FACE_MARKERS', 'SignTimeline', 'direction', 'faceWeights',
		'mirrorPhase', 'neutralPose', 'place', 'poseHand', 'posePhase', 'restingPose',
		// kinematics
		'ANCHORS', 'FINGERS', 'FINGER_JOINTS', 'Pose', 'anchorPoint', 'boneAxis', 'boneLength',
		'fingerBones', 'fingerTip', 'handPartOffset', 'handPoint', 'hasBone', 'parentOf',
		'restLocal', 'restPos', 'restWorld', 'signPoint', 'solveArm', 'wristPosition',
	]) {
		assert.ok(name in sign, `missing export: ${name}`);
	}
});

test('the bundle has no runtime dependencies', () => {
	const code = readFileSync(resolve(here, '../dist/index.mjs'), 'utf8');
	const imports = [...code.matchAll(/^\s*import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
	assert.deepEqual(imports, [], `dist should import nothing, got: ${imports.join(', ')}`);
});

test('a sentence signs the words it knows and spells the rest', () => {
	const { clip, signed, spelled, words } = sign.compileUtterance('happy to meet you', {
		signs: sign.signLookup({ dominant: 'Right' }),
	});
	assert.deepEqual(words, ['HAPPY', 'TO', 'MEET', 'YOU']);
	assert.deepEqual(signed, ['HAPPY', 'MEET', 'YOU']);
	assert.deepEqual(spelled, ['TO']);
	assert.ok(clip.duration > 0);
	assert.ok(clip.tracks.length > 0);
});

test('an utterance is one continuous clip, not a list of clips', () => {
	const { clip } = sign.compileUtterance('hello world', { signs: sign.signLookup() });
	// Every track spans the whole utterance: no bone is left undriven mid-way,
	// which is what makes words flow instead of snapping between segments.
	for (const track of clip.tracks) {
		assert.ok(track.times.length >= 2, `${track.name} has too few keys`);
		assert.ok(track.times[track.times.length - 1] <= clip.duration + 1e-6);
		for (let i = 1; i < track.times.length; i++) {
			assert.ok(track.times[i] >= track.times[i - 1], `${track.name} times must not go backwards`);
		}
	}
});

test('signing never moves the avatar: rotation and face lanes only', () => {
	const { clip } = sign.compileUtterance('i love you', { signs: sign.signLookup() });
	for (const track of clip.tracks) {
		assert.ok(!track.name.endsWith('.position'), `${track.name} would translate the rig`);
		assert.ok(!track.name.endsWith('.scale'), `${track.name} would scale the rig`);
		// Bones rotate; the face carries grammar on blendshape lanes.
		if (track.type === 'number') assert.match(track.name, /morphTargetInfluences/);
		else assert.equal(track.type, 'quaternion');
	}
	assert.ok(clip.tracks.some((t) => t.type === 'quaternion'), 'an utterance must drive bones');
});

test('the left-dominant signer is a mirror, not the same clip', () => {
	const right = sign.compileUtterance('hello', { signs: sign.signLookup({ dominant: 'Right' }), dominant: 'Right' });
	const left = sign.compileUtterance('hello', { signs: sign.signLookup({ dominant: 'Left' }), dominant: 'Left' });
	const arm = (r, name) => r.clip.tracks.find((t) => t.name === name);
	for (const name of ['RightArm.quaternion', 'LeftArm.quaternion']) {
		const a = arm(right, name);
		const b = arm(left, name);
		assert.ok(a && b, `both signers should drive ${name}`);
		assert.notDeepEqual(a.values, b.values, `${name} must differ between dominant hands`);
	}
	// Fingerspelling mirrors too, not just the lexical signs.
	const spelledRight = sign.buildFingerspellingClip('ZQ', { dominant: 'Right' });
	const spelledLeft = sign.buildFingerspellingClip('ZQ', { dominant: 'Left' });
	const pick = (c, n) => c.tracks.find((t) => t.name === n);
	assert.notDeepEqual(pick(spelledRight, 'RightArm.quaternion')?.values, pick(spelledLeft, 'RightArm.quaternion')?.values);
});

test('text with no signable characters is refused, not silently empty', () => {
	assert.throws(() => sign.compileUtterance('!!! ???', { signs: sign.signLookup() }), /signable/i);
});

test('a long utterance is capped rather than run forever', () => {
	const { truncated, clip } = sign.compileUtterance('abcdefghij klmnopqrst uvwxyz abcdefghij klmnopqrst', {
		signs: sign.signLookup(),
		maxSeconds: 6,
	});
	assert.equal(truncated, true);
	// The cap bounds the utterance; the closing settle that lowers the hands is
	// added on top of it, so the contract is maxSeconds + one tail.
	const ceiling = 6 + sign.CHAT_TIMING.tailSeconds;
	assert.ok(clip.duration <= ceiling, `duration ${clip.duration} exceeded ${ceiling}`);
});

test('fingerspelling covers the manual alphabet and the digits', () => {
	for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
		assert.ok(sign.LETTER_SHAPES[ch], `no handshape for ${ch}`);
	}
	const clip = sign.buildFingerspellingClip('HELLO');
	assert.ok(clip.duration > 0);
	assert.ok(clip.tracks.length > 0);
	assert.match(clip.name, /hello/i);
});

test('normalizeWord keeps letters, digits and word breaks; drops the rest', () => {
	assert.equal(sign.normalizeWord('Hello, world!'), 'HELLO WORLD');
	assert.equal(sign.normalizeWord('three.ws'), 'THREEWS');
	assert.equal(sign.normalizeWord('42'), '42');
	assert.equal(sign.normalizeWord('...'), '');
});

test('every lexicon entry is a described sign, not a bare pose', () => {
	const words = Object.keys(sign.SIGNS);
	assert.ok(words.length >= 30, `expected a real vocabulary, got ${words.length}`);
	for (const word of words) {
		const entry = sign.SIGNS[word];
		assert.equal(typeof entry.gloss, 'string');
		assert.ok(entry.gloss.length > 10, `${word} needs a human description`);
		assert.ok(Array.isArray(entry.phases) && entry.phases.length, `${word} has no phases`);
		assert.equal(sign.signGloss(word), entry.gloss);
	}
});

test('everyday spellings resolve to their sign', () => {
	assert.equal(sign.lookupSign('hi')?.name, 'HELLO');
	assert.equal(sign.lookupSign('thanks')?.name, 'THANK');
	assert.equal(sign.lookupSign('everyone')?.name, 'YALL');
	assert.equal(sign.lookupSign('zzzz'), null);
	assert.ok(sign.SIGNABLE_WORDS.length > Object.keys(sign.SIGNS).length);
});

test('handshapes include the named shapes with no letter', () => {
	for (const name of ['CLAW', 'FLAT_O', 'BENT_B', 'OPEN_8', 'ILY']) {
		assert.ok(sign.HANDSHAPES[name], `missing handshape ${name}`);
	}
});

test('the face carries grammar', () => {
	for (const marker of ['question', 'wh', 'negate', 'topic']) {
		assert.ok(sign.FACE_MARKERS[marker], `missing non-manual marker ${marker}`);
	}
	const weights = sign.faceWeights('wh');
	assert.ok(weights && Object.keys(weights).length, 'a marker must resolve to blendshape weights');
});

test('SignSpeaker drives a manager and refuses to run without one', () => {
	assert.throws(() => new sign.SignSpeaker({}), /manager/i);
	const played = [];
	const manager = {
		injectClip: (name, clip) => played.push({ name, duration: clip.duration }),
		playOnce: (name) => played.push({ played: name }),
	};
	const speaker = new sign.SignSpeaker({ manager });
	assert.equal(speaker.dominant, 'Right');
	assert.equal(speaker.speaking, false);
	speaker.cancel();
});
