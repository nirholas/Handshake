/**
 * Contract tests for agent choreography (src/runtime/choreography.js).
 *
 * The module is the single definition of what a routine is: the /choreograph
 * studio, the agents API, the public manifest and the avatar runtime all agree
 * only because they import it. So the things pinned here are the things that
 * would let those four drift apart:
 *
 *  1. normalization is total — anything that survives it is storable, encodable
 *     and playable, and anything that would not be is rejected with a reason.
 *  2. the URL wire format round-trips exactly, including the lossy-looking bits
 *     (speed, per-step clip, loop flag, a name with punctuation in it).
 *  3. timeline math (duration, offsets, stepAtTime) is consistent with itself,
 *     because the studio's playhead and the avatar's playback read it
 *     independently and any disagreement shows up as a visibly wrong preview.
 *  4. RoutinePlayer fires each step exactly once per pass, survives a huge dt
 *     (backgrounded tab) and ends or loops as declared.
 *  5. every shipped preset is a valid routine over real slots.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	MAX_STEPS,
	MAX_ROUTINES,
	MIN_HOLD,
	MAX_HOLD,
	MIN_SPEED,
	MAX_SPEED,
	DEFAULT_HOLD,
	PRESET_ROUTINES,
	RoutinePlayer,
	decodeRoutine,
	encodeRoutine,
	normalizeRoutine,
	normalizeRoutines,
	normalizeStep,
	resolveStepClip,
	routineDuration,
	slugify,
	stepAtTime,
	stepOffsets,
} from '../src/runtime/choreography.js';
import { SLOTS, DEFAULT_ANIMATION_MAP } from '../src/runtime/animation-slots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIP_NAMES = new Set(
	JSON.parse(
		readFileSync(resolve(__dirname, '../public/animations/manifest.json'), 'utf8'),
	).map((c) => c.name),
);

const routine = (steps, extra = {}) => normalizeRoutine({ name: 'T', steps, ...extra });

describe('normalizeStep', () => {
	it('fills in the defaults a hand-written step omits', () => {
		expect(normalizeStep({ slot: 'wave' })).toEqual({
			slot: 'wave',
			clip: null,
			hold: DEFAULT_HOLD,
			speed: 1,
		});
	});

	it('rejects a slot outside the fixed vocabulary', () => {
		expect(() => normalizeStep({ slot: 'moonwalk' })).toThrow(/unknown gesture slot/);
		expect(() => normalizeStep({ slot: '' })).toThrow(/unknown gesture slot/);
	});

	it('rejects a clip name that could not be a clip', () => {
		expect(() => normalizeStep({ slot: 'wave', clip: '../etc/passwd' })).toThrow(
			/invalid clip name/,
		);
		expect(() => normalizeStep({ slot: 'wave', clip: 'a'.repeat(61) })).toThrow(/too long/);
	});

	it('drops a clip that merely restates the platform default', () => {
		// Pinning the default into the step would freeze it against today's map
		// and stop the agent's own override from applying.
		const step = normalizeStep({ slot: 'wave', clip: DEFAULT_ANIMATION_MAP.wave });
		expect(step.clip).toBeNull();
	});

	it('keeps a clip that genuinely overrides the slot', () => {
		expect(normalizeStep({ slot: 'dance', clip: 'thriller' }).clip).toBe('thriller');
	});

	it('clamps hold and speed into playable bounds', () => {
		expect(normalizeStep({ slot: 'wave', hold: 0 }).hold).toBe(MIN_HOLD);
		expect(normalizeStep({ slot: 'wave', hold: 9999 }).hold).toBe(MAX_HOLD);
		expect(normalizeStep({ slot: 'wave', speed: 0 }).speed).toBe(MIN_SPEED);
		expect(normalizeStep({ slot: 'wave', speed: 99 }).speed).toBe(MAX_SPEED);
	});

	it('rejects non-numeric timing rather than coercing it to NaN', () => {
		expect(() => normalizeStep({ slot: 'wave', hold: 'soon' })).toThrow(/hold must be a number/);
		expect(() => normalizeStep({ slot: 'wave', speed: 'fast' })).toThrow(
			/speed must be a number/,
		);
	});
});

describe('normalizeRoutine', () => {
	it('derives an id from the name', () => {
		expect(normalizeRoutine({ name: 'Ship It!', steps: [{ slot: 'wave' }] }).id).toBe('ship-it');
	});

	it('always produces an addressable id', () => {
		expect(slugify('!!!')).toBe('routine');
		expect(slugify('')).toBe('routine');
	});

	it('requires at least one step', () => {
		expect(() => normalizeRoutine({ name: 'Empty', steps: [] })).toThrow(/at least one step/);
	});

	it('caps the step count', () => {
		const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ slot: 'wave' }));
		expect(() => normalizeRoutine({ name: 'Long', steps })).toThrow(/at most/);
	});

	it('rejects duplicate ids across a routine list', () => {
		const one = { name: 'Welcome', steps: [{ slot: 'wave' }] };
		expect(() => normalizeRoutines([one, { ...one }])).toThrow(/share the id/);
	});

	it('caps the routine count', () => {
		const list = Array.from({ length: MAX_ROUTINES + 1 }, (_, i) => ({
			name: `R${i}`,
			steps: [{ slot: 'wave' }],
		}));
		expect(() => normalizeRoutines(list)).toThrow(/at most/);
	});
});

describe('timeline math', () => {
	it('sums holds, scaled by speed', () => {
		const r = routine([
			{ slot: 'wave', hold: 2 },
			{ slot: 'nod', hold: 2, speed: 2 },
		]);
		expect(routineDuration(r)).toBe(3);
	});

	it('offsets are the running sum of the scaled holds', () => {
		const r = routine([
			{ slot: 'wave', hold: 1 },
			{ slot: 'nod', hold: 2 },
			{ slot: 'bow', hold: 0.5 },
		]);
		expect(stepOffsets(r)).toEqual([0, 1, 3]);
		expect(routineDuration(r)).toBe(3.5);
	});

	it('stepAtTime agrees with stepOffsets at every boundary', () => {
		const r = routine([
			{ slot: 'wave', hold: 1 },
			{ slot: 'nod', hold: 2 },
			{ slot: 'bow', hold: 0.5 },
		]);
		stepOffsets(r).forEach((start, i) => {
			expect(stepAtTime(r, start + 0.01).index).toBe(i);
		});
	});

	it('holds the last step at the closing instant and returns null past the end', () => {
		const r = routine([
			{ slot: 'wave', hold: 1 },
			{ slot: 'nod', hold: 1 },
		]);
		expect(stepAtTime(r, 2).index).toBe(1);
		expect(stepAtTime(r, 5)).toBeNull();
	});

	it('treats a negative playhead as the start', () => {
		const r = routine([{ slot: 'wave', hold: 1 }]);
		expect(stepAtTime(r, -3).index).toBe(0);
	});
});

describe('resolveStepClip', () => {
	const step = { slot: 'dance', clip: null };

	it('falls back to the platform default', () => {
		expect(resolveStepClip(step, null)).toBe(DEFAULT_ANIMATION_MAP.dance);
	});

	it("uses the agent's own slot override when the step does not name a clip", () => {
		expect(resolveStepClip(step, { dance: 'thriller' })).toBe('thriller');
	});

	it('lets an explicit per-step clip win over the agent override', () => {
		expect(resolveStepClip({ slot: 'dance', clip: 'rumba' }, { dance: 'thriller' })).toBe(
			'rumba',
		);
	});
});

describe('wire format', () => {
	it('round-trips a routine that uses every optional field', () => {
		const original = routine(
			[
				{ slot: 'wave', hold: 1.6 },
				{ slot: 'dance', hold: 3, speed: 0.5, clip: 'rumba' },
			],
			{ name: 'Hello, world (v2)', loop: true },
		);
		const decoded = decodeRoutine(encodeRoutine(original));
		expect(decoded).toEqual(original);
	});

	it('stays legible rather than base64', () => {
		const encoded = encodeRoutine(routine([{ slot: 'wave', hold: 2 }], { name: 'Hi' }));
		expect(encoded).toBe('Hi|wave:2');
	});

	it('accepts a hand-written step list with no name', () => {
		const decoded = decodeRoutine('wave:1,nod:2');
		expect(decoded.steps.map((s) => s.slot)).toEqual(['wave', 'nod']);
		expect(decoded.name).toBe('Routine');
	});

	it('throws on a malformed routine instead of silently dropping steps', () => {
		expect(() => decodeRoutine('wave:1,notaslot:2')).toThrow(/unknown gesture slot/);
		expect(() => decodeRoutine('')).toThrow(/nothing to decode/);
	});

	it('survives a name that contains the separators', () => {
		const decoded = decodeRoutine(encodeRoutine(routine([{ slot: 'wave' }], { name: 'a|b,c:d' })));
		expect(decoded.name).toBe('a|b,c:d');
	});
});

describe('RoutinePlayer', () => {
	const build = (extra = {}) => {
		const seen = [];
		const player = new RoutinePlayer(
			routine([
				{ slot: 'wave', hold: 1 },
				{ slot: 'nod', hold: 1 },
				{ slot: 'bow', hold: 1 },
			], extra.routine),
			{ onStep: (_s, i) => seen.push(i), onEnd: () => seen.push('end'), ...extra.handlers },
		);
		return { player, seen };
	};

	it('fires the first step on start, before any time passes', () => {
		const { player, seen } = build();
		player.start();
		expect(seen).toEqual([0]);
		expect(player.time).toBe(0);
	});

	it('fires each step exactly once, in order, then ends', () => {
		const { player, seen } = build();
		player.start();
		for (let i = 0; i < 40; i++) player.update(0.1);
		expect(seen).toEqual([0, 1, 2, 'end']);
		expect(player.playing).toBe(false);
		expect(player.time).toBe(3);
	});

	it('does not advance while paused', () => {
		const { player } = build();
		player.start().pause();
		player.update(10);
		expect(player.time).toBe(0);
	});

	it('catches up rather than replaying every step after a background tab', () => {
		const { player, seen } = build();
		player.start();
		player.update(2.5);
		expect(seen).toEqual([0, 2]);
	});

	it('loops without ever firing onEnd', () => {
		const { player, seen } = build({ handlers: { loop: true } });
		player.start();
		for (let i = 0; i < 70; i++) player.update(0.1);
		expect(seen).not.toContain('end');
		expect(player.playing).toBe(true);
		// Two full passes: three steps, then the same three again.
		expect(seen.slice(0, 6)).toEqual([0, 1, 2, 0, 1, 2]);
	});

	it('honors loop declared on the routine itself', () => {
		const { player } = build({ routine: { loop: true } });
		player.start();
		for (let i = 0; i < 50; i++) player.update(0.1);
		expect(player.playing).toBe(true);
	});

	it('re-fires the step when the playhead is scrubbed', () => {
		const { player, seen } = build();
		player.start();
		player.seek(2.2);
		expect(seen).toEqual([0, 2]);
		player.seek(0.1);
		expect(seen).toEqual([0, 2, 0]);
	});

	it('clamps a seek past the end to the end', () => {
		const { player } = build();
		player.start().seek(99);
		expect(player.time).toBe(3);
	});

	it('ignores a zero or negative delta', () => {
		const { player } = build();
		player.start();
		player.update(0);
		player.update(-1);
		player.update(NaN);
		expect(player.time).toBe(0);
	});

	it('reports progress through onTick', () => {
		const ticks = [];
		const player = new RoutinePlayer(routine([{ slot: 'wave', hold: 1 }]), {
			onTick: (t, d) => ticks.push([t, d]),
		});
		player.start();
		player.update(0.5);
		expect(ticks).toEqual([[0.5, 1]]);
	});
});

describe('shipped presets', () => {
	it('every preset is a valid routine over real slots and baked clips', () => {
		for (const preset of PRESET_ROUTINES) {
			const r = normalizeRoutine(preset);
			expect(r.steps.length).toBeGreaterThan(0);
			for (const step of r.steps) {
				expect(SLOTS).toContain(step.slot);
				expect(CLIP_NAMES.has(resolveStepClip(step, null))).toBe(true);
			}
		}
	});

	it('preset ids are unique and stable, so a shared link keeps resolving', () => {
		const ids = PRESET_ROUTINES.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const preset of PRESET_ROUTINES) {
			expect(normalizeRoutine(preset).id).toBe(preset.id);
		}
	});

	it('every preset explains itself', () => {
		for (const preset of PRESET_ROUTINES) {
			expect(preset.blurb.length).toBeGreaterThan(20);
		}
	});

	it('presets fit inside the storable bounds', () => {
		expect(PRESET_ROUTINES.length).toBeLessThanOrEqual(MAX_ROUTINES);
		for (const preset of PRESET_ROUTINES) {
			expect(routineDuration(normalizeRoutine(preset))).toBeLessThanOrEqual(
				MAX_STEPS * MAX_HOLD,
			);
		}
	});
});
