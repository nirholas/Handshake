// Text to score, without a model.
//
// The generation path this package is built for runs a language model against
// `scoreSchema()`: that is what handles "she sits down heavily, thinks for a
// moment, then looks up". This module is the other lane, and it is a real one,
// not a stub. It reads a prompt for the things a motion is actually made of
// (an action, a body part, a direction, a manner, a repeat count) and composes
// beats from the same vocabulary the model authors against.
//
// It exists for three reasons, in order of how often they bite:
//
//   1. Latency. A known action ("wave", "nod", "shrug") is a keystroke, not a
//      round trip, and a UI that previews as you type needs the keystroke.
//   2. Determinism. The same prompt gives the same clip forever, which is what
//      makes a motion cacheable and a regression reproducible.
//   3. Availability. When no model is reachable the feature still works, at
//      lower expressiveness, instead of returning an error to somebody who
//      typed "wave".
//
// Anything it cannot recognize it says so about, and the caller decides whether
// to fall through to the model or surface the miss.

import { EFFORTS } from './vocabulary.js';

// Both hands resting on the thighs: the shape a body makes sitting down or
// bracing on its legs, reused by every posture that needs it.
const HANDS_ON_THIGHS = Object.freeze({
	left: { at: 'thigh', forward: 0.04, palm: 'down', hand: 'relaxed', elbow: 'down' },
	right: { at: 'thigh', forward: 0.04, palm: 'down', hand: 'relaxed', elbow: 'down' },
});

/**
 * Actions this lane can build without a model. Each is a function of the
 * parsed modifiers, returning beats.
 */
const ACTIONS = {
	wave: ({ side, repeats, effort }) => {
		const other = side === 'left' ? 'right' : 'left';
		const up = { at: 'overhead', up: -0.08, out: 0.04, palm: 'forward', hand: 'open', elbow: 'out' };
		const beats = [
			{ label: 'ready', posture: 'easy', arms: { [side]: { at: 'side', hand: 'relaxed' }, [other]: { at: 'side', hand: 'relaxed' } }, in: 0.25, effort },
			{ label: 'hand up', posture: 'easy', arms: { [side]: up }, gaze: 'forward', face: 'smile', in: 0.36, hold: 0.06, effort },
		];
		for (let i = 0; i < repeats; i++) {
			beats.push({ label: 'out', posture: 'easy', arms: { [side]: { ...up, out: 0.2, up: -0.02 } }, face: 'smile', in: 0.22, effort });
			beats.push({ label: 'back', posture: 'easy', arms: { [side]: { ...up, out: -0.04, up: -0.1 } }, face: 'smile', in: 0.22, effort });
		}
		beats.push({ label: 'lower', posture: 'easy', arms: { [side]: { at: 'side', hand: 'relaxed' } }, in: 0.5, hold: 0.2, effort });
		return beats;
	},

	nod: ({ repeats, effort }) => {
		const beats = [{ label: 'level', posture: 'easy', gaze: 'forward', in: 0.2, effort }];
		for (let i = 0; i < repeats; i++) {
			beats.push({ label: 'down', posture: 'easy', gaze: { pitch: -17 }, torso: { lean: 3 }, in: 0.22, effort });
			beats.push({ label: 'up', posture: 'easy', gaze: { pitch: 4 }, in: 0.24, effort });
		}
		beats.push({ label: 'settle', posture: 'easy', gaze: 'forward', in: 0.28, hold: 0.2, effort });
		return beats;
	},

	shake: ({ repeats, effort }) => {
		const beats = [{ label: 'level', posture: 'easy', gaze: 'forward', in: 0.2, effort }];
		for (let i = 0; i < repeats; i++) {
			beats.push({ label: 'left', posture: 'easy', gaze: { yaw: 26 }, in: 0.24, effort });
			beats.push({ label: 'right', posture: 'easy', gaze: { yaw: -26 }, in: 0.24, effort });
		}
		beats.push({ label: 'centre', posture: 'easy', gaze: 'forward', face: 'doubt', in: 0.26, hold: 0.2, effort });
		return beats;
	},

	shrug: ({ effort }) => [
		{ label: 'neutral', posture: 'easy', arms: { left: { at: 'side', hand: 'relaxed' }, right: { at: 'side', hand: 'relaxed' } }, in: 0.22, effort },
		{
			label: 'up',
			posture: 'easy',
			torso: { lean: -3 },
			gaze: { pitch: 6 },
			face: 'doubt',
			arms: {
				left: { at: 'wide', up: -0.16, forward: 0.14, palm: 'up', hand: 'open', elbow: 'down' },
				right: { at: 'wide', up: -0.16, forward: 0.14, palm: 'up', hand: 'open', elbow: 'down' },
			},
			in: 0.34,
			hold: 0.45,
			effort,
		},
		{ label: 'drop', posture: 'easy', arms: { left: { at: 'side', hand: 'relaxed' }, right: { at: 'side', hand: 'relaxed' } }, in: 0.42, hold: 0.15, effort },
	],

	point: ({ side, direction, effort }) => {
		// Pointing down means aiming an arm at the floor, not putting a wrist on
		// it: the target stays inside the arm's reach and the finger does the rest.
		const at = direction === 'up' ? 'overhead' : 'front';
		return [
			{ label: 'ready', posture: 'easy', in: 0.2, effort },
			{
				label: 'point',
				posture: direction === 'down' ? 'lean_in' : 'easy',
				arms: { [side]: { at, up: direction === 'down' ? -0.3 : 0, forward: direction === 'forward' ? 0.12 : 0.04, palm: 'down', point: direction === 'up' ? 'up' : direction === 'down' ? 'down' : 'forward', hand: 'point', elbow: 'down' } },
				gaze: direction === 'down' ? 'down' : direction === 'up' ? 'up' : 'forward',
				in: 0.3,
				hold: 0.6,
				effort,
			},
			{ label: 'lower', posture: 'easy', arms: { [side]: { at: 'side', hand: 'relaxed' } }, in: 0.45, hold: 0.15, effort },
		];
	},

	clap: ({ repeats, effort }) => {
		const apart = {
			left: { at: 'front', out: 0.16, forward: -0.06, palm: 'in', hand: 'flat', elbow: 'down' },
			right: { at: 'front', out: 0.16, forward: -0.06, palm: 'in', hand: 'flat', elbow: 'down' },
		};
		const together = {
			left: { at: 'front', out: -0.01, forward: 0.02, palm: 'in', hand: 'flat', elbow: 'down' },
			right: { at: 'front', out: -0.01, forward: 0.02, palm: 'in', hand: 'flat', elbow: 'down' },
		};
		const beats = [{ label: 'ready', posture: 'easy', arms: apart, face: 'smile', in: 0.3, effort }];
		for (let i = 0; i < repeats; i++) {
			beats.push({ label: 'clap', posture: 'easy', arms: together, face: 'grin', in: 0.14, ease: 'in', effort });
			beats.push({ label: 'open', posture: 'easy', arms: apart, face: 'smile', in: 0.18, effort });
		}
		beats.push({ label: 'rest', posture: 'easy', arms: { left: { at: 'side', hand: 'relaxed' }, right: { at: 'side', hand: 'relaxed' } }, in: 0.45, hold: 0.15, effort });
		return beats;
	},

	bow: ({ effort }) => [
		{ label: 'stand', posture: 'proud', gaze: 'forward', in: 0.28, effort },
		{ label: 'bow', posture: 'bow', gaze: 'down', arms: { left: { at: 'side', forward: 0.05, hand: 'flat' }, right: { at: 'side', forward: 0.05, hand: 'flat' } }, in: 0.6, hold: 0.5, effort },
		{ label: 'rise', posture: 'proud', gaze: 'forward', in: 0.7, hold: 0.2, effort },
	],

	sit: ({ effort }) => [
		{ label: 'stand', posture: 'easy', in: 0.25, effort },
		{ label: 'lower', posture: 'crouch', gaze: 'down', in: 0.55, effort },
		{ label: 'seated', posture: 'sit', torso: { lean: 18 }, gaze: 'forward', arms: { left: HANDS_ON_THIGHS.left, right: HANDS_ON_THIGHS.right }, in: 0.5, hold: 0.9, effort },
	],

	stand_up: ({ effort }) => [
		{ label: 'seated', posture: 'sit', torso: { lean: 18 }, arms: { left: HANDS_ON_THIGHS.left, right: HANDS_ON_THIGHS.right }, in: 0.25, effort },
		{ label: 'lean out', posture: 'sit', torso: { lean: 26 }, gaze: 'down', in: 0.4, effort },
		{ label: 'rise', posture: 'crouch', in: 0.45, effort },
		{ label: 'stand', posture: 'easy', gaze: 'forward', in: 0.5, hold: 0.3, effort },
	],

	crouch: ({ effort }) => [
		{ label: 'stand', posture: 'easy', in: 0.25, effort },
		{ label: 'down', posture: 'crouch', torso: { lean: 30 }, gaze: 'down', arms: { left: HANDS_ON_THIGHS.left, right: HANDS_ON_THIGHS.right }, in: 0.55, hold: 0.7, effort },
		{ label: 'up', posture: 'easy', gaze: 'forward', in: 0.6, hold: 0.2, effort },
	],

	jump: ({ effort }) => [
		{ label: 'stand', posture: 'easy', in: 0.2, effort },
		{ label: 'load', posture: 'crouch', arms: { left: { at: 'behind', hand: 'relaxed' }, right: { at: 'behind', hand: 'relaxed' } }, in: 0.3, effort },
		{ label: 'launch', posture: 'tiptoe', root: { rise: 0.18 }, arms: { left: { at: 'overhead', hand: 'open' }, right: { at: 'overhead', hand: 'open' } }, gaze: 'up', in: 0.22, ease: 'in', effort },
		{ label: 'land', posture: 'crouch', in: 0.24, ease: 'out', effort },
		{ label: 'recover', posture: 'easy', in: 0.4, hold: 0.2, effort },
	],

	walk: ({ repeats, effort }) => {
		const beats = [{ label: 'stand', posture: 'easy', in: 0.25, effort }];
		let travelled = 0;
		for (let i = 0; i < Math.max(2, repeats * 2); i++) {
			const leading = i % 2 === 0 ? 'left' : 'right';
			travelled += 0.34;
			beats.push({
				label: `${leading} step`,
				posture: 'stand',
				root: { forward: travelled, height: 0.985 },
				legs: { stance: leading === 'left' ? 'split' : 'split_right' },
				torso: { twist: leading === 'left' ? -6 : 6 },
				arms: {
					left: { at: 'side', forward: leading === 'left' ? -0.12 : 0.12, hand: 'relaxed' },
					right: { at: 'side', forward: leading === 'left' ? 0.12 : -0.12, hand: 'relaxed' },
				},
				in: 0.42,
				effort,
			});
		}
		beats.push({ label: 'stop', posture: 'easy', root: { forward: travelled + 0.16 }, in: 0.4, hold: 0.25, effort });
		return beats;
	},

	turn: ({ direction, effort }) => {
		const degrees = direction === 'right' ? -90 : 90;
		return [
			{ label: 'facing', posture: 'easy', in: 0.25, effort },
			{ label: 'look', posture: 'easy', gaze: direction === 'right' ? 'right' : 'left', in: 0.3, effort },
			{ label: 'turn', posture: 'easy', root: { turn: degrees }, gaze: 'forward', in: 0.55, hold: 0.3, effort },
		];
	},

	think: ({ side, effort }) => [
		{ label: 'still', posture: 'easy', in: 0.3, effort },
		{
			label: 'hand to chin',
			posture: 'easy',
			arms: { [side]: { at: 'chin', forward: 0.02, up: -0.03, palm: 'in', hand: 'loose', elbow: 'down' } },
			gaze: 'aside',
			face: 'focused',
			torso: { lean: 4 },
			in: 0.5,
			hold: 1.1,
			effort,
		},
		{ label: 'release', posture: 'easy', arms: { [side]: { at: 'side', hand: 'relaxed' } }, gaze: 'forward', in: 0.5, hold: 0.2, effort },
	],

	celebrate: ({ effort }) => [
		{ label: 'ready', posture: 'ready', in: 0.22, effort },
		{
			label: 'arms up',
			posture: 'tiptoe',
			arms: { left: { at: 'overhead', out: 0.12, hand: 'fist' }, right: { at: 'overhead', out: 0.12, hand: 'fist' } },
			gaze: 'up',
			face: 'grin',
			torso: { lean: -8 },
			in: 0.26,
			hold: 0.55,
			effort,
		},
		{ label: 'down', posture: 'easy', arms: { left: { at: 'side', hand: 'relaxed' }, right: { at: 'side', hand: 'relaxed' } }, face: 'smile', in: 0.5, hold: 0.2, effort },
	],

	reach: ({ side, direction, effort }) => [
		{ label: 'ready', posture: 'easy', in: 0.22, effort },
		{
			label: 'reach',
			posture: direction === 'down' ? 'crouch' : 'lean_in',
			arms: { [side]: { at: direction === 'up' ? 'overhead' : 'front', up: direction === 'down' ? -0.3 : 0, forward: 0.1, palm: direction === 'down' ? 'down' : 'up', hand: 'open', elbow: 'down' } },
			gaze: direction === 'down' ? 'down' : direction === 'up' ? 'up' : 'forward',
			in: 0.5,
			hold: 0.4,
			effort,
		},
		{ label: 'return', posture: 'easy', arms: { [side]: { at: 'side', hand: 'relaxed' } }, gaze: 'forward', in: 0.5, hold: 0.15, effort },
	],

	breathe: ({ effort }) => [
		{ label: 'in', posture: 'easy', torso: { lean: -4 }, gaze: { pitch: 6 }, in: 1.1, hold: 0.35, effort },
		{ label: 'out', posture: 'slump', torso: { lean: 6 }, gaze: { pitch: -4 }, in: 1.4, hold: 0.5, effort },
		{ label: 'settle', posture: 'easy', gaze: 'forward', in: 0.9, hold: 0.4, effort },
	],

	idle: ({ effort }) => [
		{ label: 'settled', posture: 'easy', arms: { left: { at: 'side', hand: 'relaxed' }, right: { at: 'side', hand: 'relaxed' } }, in: 0.5, hold: 1.2, effort },
		{ label: 'weight shift', posture: 'easy', root: { side: 0.035 }, torso: { sideBend: -3 }, in: 1.6, hold: 1.1, effort },
		{ label: 'glance', posture: 'easy', root: { side: 0.035 }, gaze: 'aside', in: 0.8, hold: 0.7, effort },
		{ label: 'back', posture: 'easy', gaze: 'forward', in: 1.5, hold: 1.0, effort },
	],
};

/** Every action this lane can compose without a model. */
export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS).sort());

// What a prompt can call each action. Longest phrases first, so "stand up" wins
// over "stand" and "shake head" over "shake".
const SYNONYMS = Object.freeze([
	['stand up', 'stand_up'], ['get up', 'stand_up'], ['stand back up', 'stand_up'], ['rise', 'stand_up'],
	['shake head', 'shake'], ['say no', 'shake'], ['disagree', 'shake'], ['refuse', 'shake'],
	['nod', 'nod'], ['agree', 'nod'], ['say yes', 'nod'],
	['wave', 'wave'], ['greet', 'wave'], ['say hi', 'wave'], ['say hello', 'wave'], ['hello', 'wave'], ['goodbye', 'wave'], ['bye', 'wave'],
	['shrug', 'shrug'], ['dunno', 'shrug'], ["don't know", 'shrug'], ['no idea', 'shrug'],
	['applaud', 'clap'], ['clap', 'clap'],
	['point', 'point'], ['indicate', 'point'], ['gesture at', 'point'],
	['take a bow', 'bow'], ['bow', 'bow'],
	['sit down', 'sit'], ['sit', 'sit'], ['take a seat', 'sit'],
	['crouch', 'crouch'], ['duck', 'crouch'], ['squat', 'crouch'], ['kneel down', 'crouch'],
	['jump', 'jump'], ['leap', 'jump'], ['hop', 'jump'],
	['walk', 'walk'], ['step forward', 'walk'], ['stroll', 'walk'], ['pace', 'walk'],
	['turn around', 'turn'], ['turn', 'turn'], ['spin', 'turn'],
	['think', 'think'], ['ponder', 'think'], ['consider', 'think'], ['wonder', 'think'],
	['celebrate', 'celebrate'], ['cheer', 'celebrate'], ['victory', 'celebrate'], ['win', 'celebrate'],
	['reach', 'reach'], ['grab', 'reach'], ['pick up', 'reach'], ['take', 'reach'],
	['breathe', 'breathe'], ['sigh', 'breathe'], ['catch breath', 'breathe'],
	['idle', 'idle'], ['stand still', 'idle'], ['wait', 'idle'], ['do nothing', 'idle'],
]);

// Manner words, mapped to the effort presets they mean.
const MANNERS = Object.freeze([
	['excited', 'playful'], ['excitedly', 'playful'], ['playful', 'playful'], ['cheerful', 'playful'],
	['gently', 'gentle'], ['gentle', 'gentle'], ['softly', 'gentle'], ['slowly', 'sustained'], ['slow', 'sustained'],
	['calmly', 'sustained'], ['calm', 'sustained'], ['relaxed', 'sustained'],
	['sharply', 'sharp'], ['sharp', 'sharp'], ['quickly', 'sharp'], ['quick', 'sharp'], ['fast', 'sharp'], ['suddenly', 'sharp'], ['snap', 'sharp'],
	['heavily', 'heavy'], ['heavy', 'heavy'], ['hard', 'heavy'], ['forcefully', 'heavy'],
	['lightly', 'light'], ['light', 'light'], ['delicately', 'light'],
	['carefully', 'precise'], ['precisely', 'precise'], ['deliberately', 'precise'], ['carefully', 'precise'],
	['urgently', 'urgent'], ['frantically', 'urgent'], ['desperately', 'urgent'],
	['wearily', 'weary'], ['tired', 'weary'], ['exhausted', 'weary'], ['sadly', 'weary'], ['reluctantly', 'weary'],
]);

const NUMBER_WORDS = Object.freeze({ once: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, several: 3, a: 1, one: 1 });

/**
 * Read a prompt into a score, with no model involved.
 *
 * @param {string} prompt
 * @param {{ name?: string, loop?: boolean, effort?: string }} [opts]
 * @returns {{ score: object|null, matched: string|null, reason: string|null }}
 *   `score` is a raw score, ready for `normalizeScore`. `matched` names the
 *   action recognized. `reason` explains a miss, for a caller deciding whether
 *   to escalate to a model.
 */
export function composeScore(prompt, opts = {}) {
	const text = String(prompt ?? '').toLowerCase().trim();
	if (!text) return { score: null, matched: null, reason: 'empty prompt' };

	const match = SYNONYMS.find(([phrase]) => text.includes(phrase));
	if (!match) {
		return {
			score: null,
			matched: null,
			reason: `no known action in "${prompt}"; this lane covers ${ACTION_NAMES.join(', ')}`,
		};
	}
	const action = match[1];

	const side = /\bleft\b/.test(text) && !/\bturn(s|ing)? left\b/.test(text) ? 'left' : 'right';
	const direction = /\b(down|downward|floor|ground)\b/.test(text)
		? 'down'
		: /\b(up|upward|sky|ceiling)\b/.test(text)
			? 'up'
			: /\bleft\b/.test(text)
				? 'left'
				: /\bright\b/.test(text)
					? 'right'
					: 'forward';

	const manner = MANNERS.find(([word]) => new RegExp(`\\b${word}\\b`).test(text));
	const effort = opts.effort && EFFORTS[opts.effort] ? opts.effort : (manner ? manner[1] : 'neutral');

	const repeats = readRepeats(text);

	const beats = ACTIONS[action]({ side, direction, effort, repeats });
	return {
		score: {
			version: 1,
			name: opts.name || prompt.trim().slice(0, 120),
			seed: `${action}:${side}:${direction}:${effort}:${repeats}:${opts.loop ? 'loop' : 'once'}`,
			loop: opts.loop === true,
			effort,
			beats,
		},
		matched: action,
		reason: null,
	};
}

function readRepeats(text) {
	const digits = text.match(/\b(\d{1,2})\s*(times|x)\b/);
	if (digits) return Math.min(6, Math.max(1, Number(digits[1])));
	for (const [word, value] of Object.entries(NUMBER_WORDS)) {
		if (new RegExp(`\\b${word}\\s+times\\b`).test(text)) return Math.min(6, value);
	}
	if (/\btwice\b/.test(text)) return 2;
	if (/\brepeatedly\b|\bover and over\b|\bseveral\b/.test(text)) return 3;
	return 2;
}
