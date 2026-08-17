// Agent choreography: a named, timed sequence of gesture slots.
//
// A gesture on its own is a single beat. A routine is a performance: wave, then
// nod, then present the thing you just made. Every surface that can play one
// gesture can play a routine, so this module is the one place the shape, the
// timing and the wire format live:
//
//   • the /choreograph studio composes and previews routines
//   • PUT /api/agents/:id/animations persists them at meta.choreographies
//   • the public agent manifest ships them to embeds
//   • AgentAvatar.playChoreography() and <agent-3d>.playRoutine() play them
//
// Deliberately dependency-free (no Three.js, no DOM, no fetch) for the same
// reason animation-slots.js is: the API imports it to validate what it stores,
// so the browser and the server can never disagree about what a routine is.
// Playback side effects are delivered through callbacks the caller supplies.

import { SLOTS, DEFAULT_ANIMATION_MAP, resolveSlot } from './animation-slots.js';

/** Hard bounds. The API enforces these too, by importing them from here. */
export const MAX_STEPS = 24;
export const MAX_ROUTINES = 12;
export const MAX_NAME_LENGTH = 40;
/** A hold shorter than this is a flicker, not a gesture. */
export const MIN_HOLD = 0.2;
export const MAX_HOLD = 20;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 3;
/** Used when a step omits its hold, and by the studio when adding a step. */
export const DEFAULT_HOLD = 1.6;

const SLOT_SET = new Set(SLOTS);
const CLIP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Round to 2dp so encode/decode round-trips exactly and JSON stays readable. */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * URL/id-safe slug for a routine name. Falls back to `routine` for names made
 * entirely of punctuation, so every routine is addressable by id.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
	const slug = String(name || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_NAME_LENGTH);
	return slug || 'routine';
}

/**
 * Coerce one step into the canonical shape, or throw with a reason a user can
 * act on. `clip` is optional: absent means "whatever this slot resolves to for
 * the agent playing it", which is what keeps a shared routine looking right on
 * an agent that has remapped its own gestures.
 *
 * @param {{slot:string, clip?:string|null, hold?:number, speed?:number}} input
 * @returns {{slot:string, clip:string|null, hold:number, speed:number}}
 */
export function normalizeStep(input) {
	if (!input || typeof input !== 'object') throw new Error('step must be an object');
	const slot = String(input.slot || '').trim();
	if (!SLOT_SET.has(slot)) throw new Error(`unknown gesture slot "${slot}"`);

	let clip = input.clip == null ? null : String(input.clip).trim();
	if (clip === '') clip = null;
	if (clip && !CLIP_RE.test(clip)) throw new Error(`invalid clip name "${clip}"`);
	if (clip && clip.length > 60) throw new Error(`clip name "${clip}" is too long`);
	// A clip equal to the platform default carries no information and would
	// pin the step to today's mapping; drop it so the slot stays the contract.
	if (clip && clip === DEFAULT_ANIMATION_MAP[slot]) clip = null;

	const holdRaw = input.hold == null ? DEFAULT_HOLD : Number(input.hold);
	if (!Number.isFinite(holdRaw)) throw new Error('hold must be a number');
	const speedRaw = input.speed == null ? 1 : Number(input.speed);
	if (!Number.isFinite(speedRaw)) throw new Error('speed must be a number');

	return {
		slot,
		clip,
		hold: round2(clamp(holdRaw, MIN_HOLD, MAX_HOLD)),
		speed: round2(clamp(speedRaw, MIN_SPEED, MAX_SPEED)),
	};
}

/**
 * Coerce a whole routine, or throw. The returned object is exactly what gets
 * stored, encoded and played: no other shape is valid anywhere downstream.
 *
 * @param {{id?:string, name?:string, steps:Array, loop?:boolean}} input
 * @returns {{id:string, name:string, steps:Array<{slot:string,clip:string|null,hold:number,speed:number}>, loop:boolean}}
 */
export function normalizeRoutine(input) {
	if (!input || typeof input !== 'object') throw new Error('routine must be an object');
	const steps = Array.isArray(input.steps) ? input.steps : [];
	if (!steps.length) throw new Error('a routine needs at least one step');
	if (steps.length > MAX_STEPS) throw new Error(`a routine can hold at most ${MAX_STEPS} steps`);

	const name = String(input.name ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'Routine';
	const id = slugify(input.id || name);
	return {
		id,
		name,
		steps: steps.map(normalizeStep),
		loop: input.loop === true,
	};
}

/**
 * Normalize a list of routines and reject duplicate ids, which would make
 * `playRoutine('welcome')` ambiguous.
 * @param {Array} input
 */
export function normalizeRoutines(input) {
	const list = Array.isArray(input) ? input : [];
	if (list.length > MAX_ROUTINES) throw new Error(`at most ${MAX_ROUTINES} routines`);
	const out = list.map(normalizeRoutine);
	const seen = new Set();
	for (const r of out) {
		if (seen.has(r.id)) throw new Error(`two routines share the id "${r.id}"`);
		seen.add(r.id);
	}
	return out;
}

/**
 * Wall-clock length of a routine in seconds. Speed scales a step's hold: a
 * gesture played at 2x occupies half the time on the timeline, which is what
 * makes the studio's playhead agree with what the eye sees.
 * @param {{steps:Array<{hold:number,speed:number}>}} routine
 */
export function routineDuration(routine) {
	return round2(
		(routine?.steps || []).reduce((sum, s) => sum + s.hold / (s.speed || 1), 0),
	);
}

/**
 * Start time of each step, in seconds. Index-aligned with `routine.steps`.
 * @param {{steps:Array<{hold:number,speed:number}>}} routine
 * @returns {number[]}
 */
export function stepOffsets(routine) {
	const offsets = [];
	let t = 0;
	for (const s of routine?.steps || []) {
		offsets.push(round2(t));
		t += s.hold / (s.speed || 1);
	}
	return offsets;
}

/**
 * Which step is on screen at time `t`. Returns null for an empty routine or a
 * time past the end. The final step owns the closing instant so a playhead
 * parked at the very end still highlights something.
 *
 * @param {{steps:Array}} routine
 * @param {number} t seconds
 * @returns {{index:number, step:object, start:number, end:number}|null}
 */
export function stepAtTime(routine, t) {
	const steps = routine?.steps || [];
	if (!steps.length) return null;
	const time = Math.max(0, Number(t) || 0);
	let start = 0;
	for (let i = 0; i < steps.length; i++) {
		const span = steps[i].hold / (steps[i].speed || 1);
		const end = start + span;
		if (time < end || i === steps.length - 1) {
			if (time > end && i === steps.length - 1) return null;
			return { index: i, step: steps[i], start: round2(start), end: round2(end) };
		}
		start = end;
	}
	return null;
}

/**
 * The clip a step actually plays on a given agent: an explicit per-step clip
 * wins, then the agent's own slot override, then the platform default.
 * @param {{slot:string, clip?:string|null}} step
 * @param {Object|null} [overrideMap] agent's meta.edits.animations
 */
export function resolveStepClip(step, overrideMap) {
	return step?.clip || resolveSlot(step?.slot, overrideMap);
}

/* ── wire format ───────────────────────────────────────────────────────────
 *
 * Routines travel in URLs (share a routine without an account) so the encoding
 * is compact and legible rather than base64: a person can read a shared link
 * and see what it will do before clicking it.
 *
 *   Name|wave:1.6,nod:1,present:2.2*0.8,dance:3@rumba
 *
 * step := slot ':' hold [ '*' speed ] [ '@' clip ]
 */

/** @param {{slot:string,clip:string|null,hold:number,speed:number}} step */
function encodeStep(step) {
	let out = `${step.slot}:${step.hold}`;
	if (step.speed !== 1) out += `*${step.speed}`;
	if (step.clip) out += `@${step.clip}`;
	return out;
}

function decodeStep(text) {
	const raw = String(text || '').trim();
	if (!raw) throw new Error('empty step');
	let rest = raw;
	let clip = null;
	const at = rest.indexOf('@');
	if (at >= 0) {
		clip = rest.slice(at + 1);
		rest = rest.slice(0, at);
	}
	let speed = 1;
	const star = rest.indexOf('*');
	if (star >= 0) {
		speed = Number(rest.slice(star + 1));
		rest = rest.slice(0, star);
	}
	const colon = rest.indexOf(':');
	const slot = colon >= 0 ? rest.slice(0, colon) : rest;
	const hold = colon >= 0 ? Number(rest.slice(colon + 1)) : DEFAULT_HOLD;
	return normalizeStep({ slot, clip, hold, speed });
}

/**
 * Compact, URL-safe text for a routine. The name is percent-encoded so it can
 * carry spaces and punctuation without colliding with the separators.
 * @param {{name:string, steps:Array, loop?:boolean}} routine
 */
export function encodeRoutine(routine) {
	const r = normalizeRoutine(routine);
	const steps = r.steps.map(encodeStep).join(',');
	// `encodeURIComponent` leaves `~` alone, which would let a routine actually
	// named "Encore~loop" encode to the same text as a looping "Encore" and come
	// back decoded as the wrong routine. Escape it so the marker is unambiguous.
	const name = encodeURIComponent(r.name).replace(/~/g, '%7E');
	return `${name}${r.loop ? '~loop' : ''}|${steps}`;
}

/**
 * Parse what `encodeRoutine` produced. Throws on anything malformed rather
 * than silently dropping steps: a half-decoded routine is worse than an error
 * the page can show.
 * @param {string} text
 */
export function decodeRoutine(text) {
	const raw = String(text || '').trim();
	if (!raw) throw new Error('nothing to decode');
	const bar = raw.indexOf('|');
	// A bare step list (no name) is accepted: it is what a hand-written link
	// looks like, and the name is cosmetic.
	let namePart = bar >= 0 ? raw.slice(0, bar) : '';
	const stepsPart = bar >= 0 ? raw.slice(bar + 1) : raw;
	let loop = false;
	if (namePart.endsWith('~loop')) {
		loop = true;
		namePart = namePart.slice(0, -5);
	}
	let name = 'Routine';
	try {
		name = decodeURIComponent(namePart) || 'Routine';
	} catch {
		name = namePart || 'Routine';
	}
	const steps = stepsPart
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map(decodeStep);
	return normalizeRoutine({ name, steps, loop });
}

/* ── starting points ───────────────────────────────────────────────────── */

/**
 * Routines the studio offers as a first move. Every one is a real sequence of
 * shipped slots, chosen because it reads as a recognisable performance rather
 * than a list of gestures: an empty timeline is the hardest screen to start on.
 */
export const PRESET_ROUTINES = Object.freeze([
	{
		id: 'welcome',
		name: 'Welcome',
		blurb: 'The greeting an agent plays the first time someone lands on it.',
		steps: [
			{ slot: 'wave', hold: 2 },
			{ slot: 'nod', hold: 1.2 },
			{ slot: 'idle', hold: 1.6 },
		],
	},
	{
		id: 'pitch',
		name: 'The pitch',
		blurb: 'Think, point at the thing, then show it off. Demo body language.',
		steps: [
			{ slot: 'think', hold: 2.4 },
			{ slot: 'point', hold: 1.4 },
			{ slot: 'present', hold: 2.6 },
			{ slot: 'idle', hold: 1.2 },
		],
	},
	{
		id: 'shipped',
		name: 'Shipped it',
		blurb: 'A win: sign, celebrate, dance. What a settled payment should look like.',
		steps: [
			{ slot: 'sign', hold: 1.6 },
			{ slot: 'celebrate', hold: 2 },
			{ slot: 'dance', hold: 3.2 },
		],
	},
	{
		id: 'bad-news',
		name: 'Bad news',
		blurb: 'The honest version: inspect, concern, shrug. Failures deserve a face too.',
		steps: [
			{ slot: 'inspect', hold: 2 },
			{ slot: 'concern', hold: 2.2 },
			{ slot: 'shrug', hold: 1.6 },
		],
	},
	{
		id: 'waiting',
		name: 'Long wait',
		blurb: 'For work that takes a while. Loops without looking frozen.',
		loop: true,
		steps: [
			{ slot: 'patience', hold: 3 },
			{ slot: 'fidget', hold: 2.4 },
			{ slot: 'curiosity', hold: 2 },
		],
	},
]);

/* ── playback ──────────────────────────────────────────────────────────── */

/**
 * Timing engine for a routine. Deliberately has no clock of its own: the caller
 * advances it with `update(dt)` from whatever loop it already runs (rAF in the
 * studio, a frame hook on the avatar). That keeps playback exact under a paused
 * tab, a scrubbed playhead and a unit test with synthetic deltas alike.
 *
 * Callbacks:
 *   onStep(step, index, routine) — a new step became current (also on seek)
 *   onTick(time, duration)       — every update while playing
 *   onEnd()                      — the routine finished (never fires when looping)
 */
export class RoutinePlayer {
	/**
	 * @param {object} routine normalized routine
	 * @param {{onStep?:Function, onTick?:Function, onEnd?:Function, loop?:boolean}} [handlers]
	 */
	constructor(routine, handlers = {}) {
		this.routine = normalizeRoutine(routine);
		this.duration = routineDuration(this.routine);
		this.loop = handlers.loop ?? this.routine.loop;
		this._onStep = handlers.onStep || null;
		this._onTick = handlers.onTick || null;
		this._onEnd = handlers.onEnd || null;
		this._time = 0;
		this._index = -1;
		this._playing = false;
	}

	get time() {
		return round2(this._time);
	}
	get index() {
		return this._index;
	}
	get playing() {
		return this._playing;
	}

	/** Start (or restart) from the top. Fires the first step immediately. */
	start() {
		this._time = 0;
		this._index = -1;
		this._playing = true;
		this._syncStep();
		return this;
	}

	pause() {
		this._playing = false;
		return this;
	}

	resume() {
		if (this._index >= 0) this._playing = true;
		return this;
	}

	stop() {
		this._playing = false;
		this._time = 0;
		this._index = -1;
		return this;
	}

	/**
	 * Move the playhead. Re-fires onStep when it lands on a different step, so
	 * scrubbing the studio timeline updates the 3D stage.
	 * @param {number} t seconds
	 */
	seek(t) {
		this._time = clamp(Number(t) || 0, 0, this.duration);
		this._syncStep();
		return this;
	}

	/**
	 * Advance by `dt` seconds. Safe to call while paused (does nothing) and with
	 * a large dt after a background tab: the routine catches up rather than
	 * playing every intervening step.
	 * @param {number} dt
	 */
	update(dt) {
		if (!this._playing) return;
		const step = Number(dt);
		if (!Number.isFinite(step) || step <= 0) return;
		this._time += step;
		if (this._time >= this.duration) {
			if (this.loop && this.duration > 0) {
				this._time %= this.duration;
			} else {
				this._time = this.duration;
				this._playing = false;
				this._syncStep();
				this._onTick?.(this.time, this.duration);
				this._onEnd?.();
				return;
			}
		}
		this._syncStep();
		this._onTick?.(this.time, this.duration);
	}

	_syncStep() {
		const at = stepAtTime(this.routine, this._time);
		const index = at ? at.index : this.routine.steps.length - 1;
		if (index !== this._index) {
			this._index = index;
			this._onStep?.(this.routine.steps[index], index, this.routine);
		}
	}
}
