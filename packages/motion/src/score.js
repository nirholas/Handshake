// The Motion Score: the wire format between whatever decided what should happen
// and the solver that makes a body do it.
//
// A score is a list of beats. A beat is a body at one instant plus how long it
// takes to get there and how long it stays. Everything in it is anatomy and
// timing, nothing is a bone name or a quaternion, which is what lets a language
// model author one, a person edit one by hand, and a diff of two of them be
// readable.
//
// Validation is deliberately forgiving in one direction and strict in the
// other. Anything a caller can reasonably mean is accepted and normalized
// (a bare string where an object is allowed, degrees out of range, beats out of
// order); anything ambiguous is an error with the path that caused it, because
// a score that half-parses produces a body that half-moves, and that is worse
// than a rejection.

import {
	EASES,
	EFFORTS,
	ELBOW_POLES,
	EXPRESSIONS,
	GAZES,
	HAND_SHAPES,
	POSTURES,
	STANCES,
} from './vocabulary.js';
import { ANCHOR_NAMES, DIRECTIONS } from './rig/anchors.js';
import { PLANT_TILT } from './rig/ik.js';

/** The score format version this build reads and writes. */
export const MOTION_SCORE_VERSION = 1;

/** Hard bounds, so a malformed score cannot ask for an hour-long clip. */
export const LIMITS = Object.freeze({
	maxBeats: 64,
	maxDuration: 60,
	maxBeatSeconds: 12,
	minBeatSeconds: 0.02,
	maxNameLength: 120,
	maxOffset: 1.2,
	maxAngle: 180,
});

const SIDES = ['left', 'right'];
const PLANTS = Object.keys(PLANT_TILT);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class ScoreError extends Error {
	constructor(path, message) {
		super(`${path}: ${message}`);
		this.path = path;
		this.name = 'ScoreError';
	}
}

/**
 * Validate and normalize a score. Returns the normalized score, or throws a
 * ScoreError naming the exact path that failed.
 *
 * Normalizing means: every beat carries an absolute `at`, an `in`, a `hold` and
 * a resolved `effort`; every shorthand is expanded to its object form; every
 * angle and offset is inside its limit. After this, the solver never has to ask
 * whether a field is present.
 *
 * @param {object} input
 * @returns {object} the normalized score
 */
export function normalizeScore(input) {
	if (!input || typeof input !== 'object') throw new ScoreError('score', 'must be an object');
	const version = input.version ?? MOTION_SCORE_VERSION;
	if (version !== MOTION_SCORE_VERSION) {
		throw new ScoreError('score.version', `unsupported version ${version}, this build reads ${MOTION_SCORE_VERSION}`);
	}
	const name = typeof input.name === 'string' && input.name.trim()
		? input.name.trim().slice(0, LIMITS.maxName ?? LIMITS.maxNameLength)
		: 'motion';
	const beatsIn = Array.isArray(input.beats) ? input.beats : null;
	if (!beatsIn || !beatsIn.length) throw new ScoreError('score.beats', 'must be a non-empty array');
	if (beatsIn.length > LIMITS.maxBeats) {
		throw new ScoreError('score.beats', `at most ${LIMITS.maxBeats} beats, got ${beatsIn.length}`);
	}

	const defaultEffort = resolveEffort(input.effort, 'score.effort') ?? { ...EFFORTS.neutral };
	let clock = 0;
	const beats = beatsIn.map((raw, i) => {
		const path = `score.beats[${i}]`;
		if (!raw || typeof raw !== 'object') throw new ScoreError(path, 'must be an object');
		const effort = resolveEffort(raw.effort, `${path}.effort`) ?? defaultEffort;
		// A sudden beat is quicker than a sustained one by default, so timing
		// follows effort unless the beat states its own.
		const travel = num(raw.in)
			? clamp(raw.in, LIMITS.minBeatSeconds, LIMITS.maxBeatSeconds)
			: (i === 0 ? 0 : defaultTravel(effort));
		const hold = num(raw.hold) ? clamp(raw.hold, 0, LIMITS.maxBeatSeconds) : 0;
		const at = num(raw.at) ? Math.max(clock, raw.at) : clock + travel;
		clock = at + hold;
		if (clock > LIMITS.maxDuration) {
			throw new ScoreError(path, `score runs past the ${LIMITS.maxDuration}s limit`);
		}
		return {
			at,
			in: travel,
			hold,
			ease: pickEase(raw.ease, effort, path),
			effort,
			posture: pickPosture(raw.posture, path),
			root: normalizeRoot(raw.root, path),
			torso: normalizeTorso(raw.torso, path),
			gaze: normalizeGaze(raw.gaze, path),
			arms: normalizeArms(raw.arms, path),
			legs: normalizeLegs(raw.legs, path),
			face: normalizeFace(raw.face, path),
			label: typeof raw.label === 'string' ? raw.label.slice(0, LIMITS.maxNameLength) : null,
		};
	});

	return {
		version: MOTION_SCORE_VERSION,
		name,
		seed: typeof input.seed === 'string' && input.seed ? input.seed : name,
		loop: input.loop === true,
		effort: defaultEffort,
		beats,
		duration: beats[beats.length - 1].at + beats[beats.length - 1].hold,
	};
}

/**
 * Validate without throwing. Returns `{ ok, score, error }`, which is what an
 * HTTP handler and an LLM repair loop both actually want.
 * @param {object} input
 */
export function validateScore(input) {
	try {
		return { ok: true, score: normalizeScore(input), error: null };
	} catch (err) {
		return { ok: false, score: null, error: { path: err.path ?? 'score', message: err.message } };
	}
}

// A sudden effort covers ground fast. The curve is deliberately not linear in
// `time`: the interesting range for a gesture is the middle.
function defaultTravel(effort) {
	return 0.9 - 0.62 * effort.time ** 0.8;
}

function resolveEffort(spec, path) {
	if (spec == null) return null;
	if (typeof spec === 'string') {
		const preset = EFFORTS[spec];
		if (!preset) throw new ScoreError(path, `unknown effort "${spec}"`);
		return { ...preset };
	}
	if (typeof spec !== 'object') throw new ScoreError(path, 'must be a name or an object');
	const base = spec.preset ? EFFORTS[spec.preset] : EFFORTS.neutral;
	if (spec.preset && !base) throw new ScoreError(`${path}.preset`, `unknown effort "${spec.preset}"`);
	return {
		weight: clamp(num(spec.weight) ? spec.weight : base.weight, 0, 1),
		time: clamp(num(spec.time) ? spec.time : base.time, 0, 1),
		flow: clamp(num(spec.flow) ? spec.flow : base.flow, 0, 1),
	};
}

// With no ease named, effort picks one: sudden and bound snaps, sudden and free
// overshoots, sustained settles.
function pickEase(spec, effort, path) {
	if (spec == null) {
		if (effort.time > 0.75) return effort.flow > 0.6 ? 'overshoot' : 'snap';
		if (effort.time < 0.25) return 'settle';
		return 'smooth';
	}
	if (typeof spec !== 'string' || !EASES[spec]) {
		throw new ScoreError(`${path}.ease`, `unknown ease "${spec}"`);
	}
	return spec;
}

function pickPosture(spec, path) {
	if (spec == null) return null;
	if (typeof spec !== 'string' || !POSTURES[spec]) {
		throw new ScoreError(`${path}.posture`, `unknown posture "${spec}"`);
	}
	return spec;
}

function normalizeRoot(spec, path) {
	if (spec == null) return {};
	if (typeof spec !== 'object') throw new ScoreError(`${path}.root`, 'must be an object');
	const out = {};
	if (spec.height != null) out.height = boundedNumber(spec.height, 0.28, 1.15, `${path}.root.height`);
	if (spec.forward != null) out.forward = offset(spec.forward, `${path}.root.forward`);
	if (spec.side != null) out.side = offset(spec.side, `${path}.root.side`);
	if (spec.rise != null) out.rise = offset(spec.rise, `${path}.root.rise`);
	if (spec.turn != null) out.turn = angle(spec.turn, `${path}.root.turn`);
	return out;
}

function normalizeTorso(spec, path) {
	if (spec == null) return {};
	if (typeof spec !== 'object') throw new ScoreError(`${path}.torso`, 'must be an object');
	const out = {};
	for (const key of ['lean', 'twist', 'sideBend']) {
		if (spec[key] != null) out[key] = angle(spec[key], `${path}.torso.${key}`);
	}
	return out;
}

function normalizeGaze(spec, path) {
	if (spec == null) return null;
	if (typeof spec === 'string') {
		if (!GAZES[spec]) throw new ScoreError(`${path}.gaze`, `unknown gaze "${spec}"`);
		return { preset: spec };
	}
	if (typeof spec !== 'object') throw new ScoreError(`${path}.gaze`, 'must be a name or an object');
	const out = {};
	if (spec.preset != null) {
		if (!GAZES[spec.preset]) throw new ScoreError(`${path}.gaze.preset`, `unknown gaze "${spec.preset}"`);
		out.preset = spec.preset;
	}
	for (const key of ['yaw', 'pitch', 'roll']) {
		if (spec[key] != null) out[key] = angle(spec[key], `${path}.gaze.${key}`);
	}
	return out;
}

function normalizeArms(spec, path) {
	if (spec == null) return {};
	if (typeof spec !== 'object') throw new ScoreError(`${path}.arms`, 'must be an object');
	const out = {};
	for (const side of SIDES) {
		if (spec[side] == null) continue;
		out[side] = normalizeArm(spec[side], `${path}.arms.${side}`);
	}
	return out;
}

function normalizeArm(spec, path) {
	if (typeof spec === 'string') return { at: anchorName(spec, path) };
	if (typeof spec !== 'object') throw new ScoreError(path, 'must be an anchor name or an object');
	const out = {};
	if (spec.at != null) {
		if (Array.isArray(spec.at)) {
			if (spec.at.length !== 3 || !spec.at.every(num)) {
				throw new ScoreError(`${path}.at`, 'an explicit point must be three finite numbers');
			}
			out.at = [...spec.at];
		} else {
			out.at = anchorName(spec.at, `${path}.at`);
		}
	}
	for (const key of ['out', 'up', 'forward']) {
		if (spec[key] != null) out[key] = offset(spec[key], `${path}.${key}`);
	}
	if (spec.palm != null) out.palm = directionName(spec.palm, `${path}.palm`);
	if (spec.point != null) out.point = directionName(spec.point, `${path}.point`);
	if (spec.elbow != null) {
		if (typeof spec.elbow !== 'string' || !ELBOW_POLES[spec.elbow]) {
			throw new ScoreError(`${path}.elbow`, `unknown elbow "${spec.elbow}"`);
		}
		out.elbow = spec.elbow;
	}
	if (spec.hand != null) out.hand = normalizeHand(spec.hand, `${path}.hand`);
	return out;
}

function normalizeHand(spec, path) {
	if (typeof spec === 'string') {
		if (!HAND_SHAPES[spec]) throw new ScoreError(path, `unknown hand shape "${spec}"`);
		return { shape: spec };
	}
	if (typeof spec !== 'object') throw new ScoreError(path, 'must be a shape name or an object');
	const out = {};
	if (spec.shape != null) {
		if (!HAND_SHAPES[spec.shape]) throw new ScoreError(`${path}.shape`, `unknown hand shape "${spec.shape}"`);
		out.shape = spec.shape;
	}
	for (const key of ['curl', 'thumb']) {
		if (spec[key] != null) out[key] = boundedNumber(spec[key], 0, 1, `${path}.${key}`);
	}
	if (spec.spread != null) out.spread = boundedNumber(spec.spread, -1, 1, `${path}.spread`);
	return out;
}

function normalizeLegs(spec, path) {
	if (spec == null) return {};
	if (typeof spec === 'string') return { stance: stanceName(spec, `${path}.legs`) };
	if (typeof spec !== 'object') throw new ScoreError(`${path}.legs`, 'must be a stance name or an object');
	const out = {};
	if (spec.stance != null) out.stance = stanceName(spec.stance, `${path}.legs.stance`);
	for (const side of SIDES) {
		if (spec[side] == null) continue;
		out[side] = normalizeFoot(spec[side], `${path}.legs.${side}`);
	}
	return out;
}

function normalizeFoot(spec, path) {
	if (typeof spec !== 'object' || spec === null) throw new ScoreError(path, 'must be an object');
	const out = {};
	for (const key of ['out', 'forward', 'lift']) {
		if (spec[key] != null) out[key] = offset(spec[key], `${path}.${key}`);
	}
	if (spec.heading != null) out.heading = angle(spec.heading, `${path}.heading`);
	if (spec.plant != null) {
		if (typeof spec.plant !== 'string' || !PLANTS.includes(spec.plant)) {
			throw new ScoreError(`${path}.plant`, `unknown plant "${spec.plant}", expected one of ${PLANTS.join(', ')}`);
		}
		out.plant = spec.plant;
	}
	return out;
}

function normalizeFace(spec, path) {
	if (spec == null) return null;
	if (typeof spec === 'string') {
		if (!EXPRESSIONS[spec]) throw new ScoreError(`${path}.face`, `unknown expression "${spec}"`);
		return { [spec]: 1 };
	}
	if (typeof spec !== 'object') throw new ScoreError(`${path}.face`, 'must be an expression name or an object');
	const out = {};
	for (const [key, value] of Object.entries(spec)) {
		if (!num(value)) throw new ScoreError(`${path}.face.${key}`, 'must be a number');
		out[key] = clamp(value, 0, 1);
	}
	return out;
}

function anchorName(value, path) {
	if (typeof value !== 'string' || !ANCHOR_NAMES.includes(value)) {
		throw new ScoreError(path, `unknown anchor "${value}"`);
	}
	return value;
}

function directionName(value, path) {
	if (typeof value !== 'string' || !DIRECTIONS[value]) {
		throw new ScoreError(path, `unknown direction "${value}"`);
	}
	return value;
}

function stanceName(value, path) {
	if (typeof value !== 'string' || !STANCES[value]) {
		throw new ScoreError(path, `unknown stance "${value}"`);
	}
	return value;
}

function boundedNumber(value, lo, hi, path) {
	if (!num(value)) throw new ScoreError(path, 'must be a finite number');
	return clamp(value, lo, hi);
}

function offset(value, path) {
	return boundedNumber(value, -LIMITS.maxOffset, LIMITS.maxOffset, path);
}

function angle(value, path) {
	return boundedNumber(value, -LIMITS.maxAngle, LIMITS.maxAngle, path);
}

/**
 * The JSON Schema for a score, for tool-calling and for editors. Generated from
 * the same vocabulary the solver reads, so the enums a model is offered can
 * never drift from the ones the solver accepts.
 * @returns {object}
 */
export function scoreSchema() {
	const offsetProp = (description) => ({ type: 'number', minimum: -LIMITS.maxOffset, maximum: LIMITS.maxOffset, description });
	const angleProp = (description) => ({ type: 'number', minimum: -LIMITS.maxAngle, maximum: LIMITS.maxAngle, description });
	const armProp = {
		type: 'object',
		additionalProperties: false,
		properties: {
			at: { type: 'string', enum: [...ANCHOR_NAMES], description: 'anatomical place the wrist goes' },
			out: offsetProp('metres away from the midline, on this hand\'s side'),
			up: offsetProp('metres above the anchor'),
			forward: offsetProp('metres in front of the anchor'),
			palm: { type: 'string', enum: Object.keys(DIRECTIONS), description: 'where the palm faces' },
			point: { type: 'string', enum: Object.keys(DIRECTIONS), description: 'where the fingers point' },
			elbow: { type: 'string', enum: Object.keys(ELBOW_POLES), description: 'where the elbow is pushed' },
			hand: { type: 'string', enum: Object.keys(HAND_SHAPES), description: 'hand shape' },
		},
	};
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		title: 'Motion Score',
		type: 'object',
		required: ['beats'],
		additionalProperties: false,
		properties: {
			version: { const: MOTION_SCORE_VERSION },
			name: { type: 'string', maxLength: LIMITS.maxNameLength },
			seed: { type: 'string', description: 'stable seed; the same seed and score always compile to the same clip' },
			loop: { type: 'boolean', description: 'true when the last beat should flow back into the first' },
			effort: { type: 'string', enum: Object.keys(EFFORTS), description: 'default performance quality for every beat' },
			beats: {
				type: 'array',
				minItems: 1,
				maxItems: LIMITS.maxBeats,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						label: { type: 'string', description: 'what this beat is, for a human reading the score' },
						in: { type: 'number', minimum: LIMITS.minBeatSeconds, maximum: LIMITS.maxBeatSeconds, description: 'seconds to travel into this beat' },
						hold: { type: 'number', minimum: 0, maximum: LIMITS.maxBeatSeconds, description: 'seconds to stay here once arrived' },
						ease: { type: 'string', enum: Object.keys(EASES) },
						effort: { type: 'string', enum: Object.keys(EFFORTS) },
						posture: { type: 'string', enum: Object.keys(POSTURES), description: 'whole-body shape this beat starts from' },
						root: {
							type: 'object',
							additionalProperties: false,
							properties: {
								height: { type: 'number', minimum: 0.28, maximum: 1.15, description: 'hip height as a fraction of standing' },
								forward: offsetProp('metres the body travels forward'),
								side: offsetProp('metres the body travels to its left'),
								rise: offsetProp('metres the whole body leaves the floor'),
								turn: angleProp('degrees the body turns toward its left'),
							},
						},
						torso: {
							type: 'object',
							additionalProperties: false,
							properties: {
								lean: angleProp('degrees forward, negative leans back'),
								twist: angleProp('degrees toward the body\'s left'),
								sideBend: angleProp('degrees leaning left, negative right'),
							},
						},
						gaze: { type: 'string', enum: Object.keys(GAZES) },
						arms: {
							type: 'object',
							additionalProperties: false,
							properties: { left: armProp, right: armProp },
						},
						legs: {
							type: 'object',
							additionalProperties: false,
							properties: {
								stance: { type: 'string', enum: Object.keys(STANCES) },
								left: { type: 'object', additionalProperties: false, properties: footSchema(offsetProp, angleProp) },
								right: { type: 'object', additionalProperties: false, properties: footSchema(offsetProp, angleProp) },
							},
						},
						face: { type: 'string', enum: Object.keys(EXPRESSIONS) },
					},
				},
			},
		},
	};
}

function footSchema(offsetProp, angleProp) {
	return {
		out: offsetProp('metres from the midline'),
		forward: offsetProp('metres in front of the hips'),
		lift: offsetProp('metres the ankle is raised off the floor'),
		heading: angleProp('degrees the foot turns toward the body\'s left'),
		plant: { type: 'string', enum: PLANTS, description: 'how the foot meets the floor' },
	};
}

/**
 * A one-line human summary of a score: how long it runs, how many beats, and
 * what it does. Used by the CLI, the API response, and anything logging one.
 * @param {object} score a normalized score
 * @returns {string}
 */
export function describeScore(score) {
	const beats = score.beats.length;
	const labels = score.beats.map((b) => b.label || b.posture).filter(Boolean);
	const shape = labels.length ? `: ${[...new Set(labels)].slice(0, 6).join(' > ')}` : '';
	return `${score.name}, ${score.duration.toFixed(2)}s, ${beats} beat${beats === 1 ? '' : 's'}${score.loop ? ', looping' : ''}${shape}`;
}
