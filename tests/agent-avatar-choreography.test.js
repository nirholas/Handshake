/**
 * AgentAvatar x choreography: routine playback on a live avatar.
 *
 * tests/choreography.test.js pins the routine format and the timing engine in
 * isolation. This file pins the half that engine cannot check on its own: that
 * a routine actually reaches the rig, in order, with the right clips, and that
 * it holds the stage against the reflexes that would otherwise cut into it.
 *
 * Every historical bug in this area was one of those two failures (a gesture
 * that resolved to nothing, or an autonomous trigger stomping a deliberate
 * one), so both are asserted against clip names the fake rig actually has, in
 * the same style as tests/agent-avatar-mood-gesture.test.js. No renderer or real
 * clips needed: `_tickEmotion()` is the frame hook, so driving it directly is
 * driving the real playback path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_ANIMATION_MAP } from '../src/runtime/animation-slots.js';

let AgentAvatar;

function makeRoot() {
	return {
		isObject3D: true,
		children: [],
		traverse(fn) {
			fn(this);
		},
	};
}

/** Records every clip name handed to the animation manager, in order. */
function makeFakeAnimationManager(loadedNames = []) {
	const loaded = new Set(loadedNames);
	const played = [];
	return {
		currentName: null,
		isLoaded: (name) => loaded.has(name),
		getAnimationDefs: () => [],
		play: (name) => {
			played.push(name);
			return Promise.resolve(true);
		},
		crossfadeTo: (name) => {
			played.push(name);
		},
		played,
	};
}

function makeAvatar(am) {
	return new AgentAvatar({ content: makeRoot(), animationManager: am, state: {} }, {}, {
		id: 'test',
	});
}

/** Advance the avatar's frame hook by `seconds`, in `steps` slices. */
function run(avatar, seconds, steps = 20) {
	for (let i = 0; i < steps; i++) avatar._tickEmotion(seconds / steps);
}

const WELCOME = {
	name: 'Welcome',
	steps: [
		{ slot: 'wave', hold: 1 },
		{ slot: 'nod', hold: 1 },
		{ slot: 'celebrate', hold: 1 },
	],
};

/** The clips WELCOME resolves to on a rig with no overrides. */
const WELCOME_CLIPS = ['wave', 'nod', 'celebrate'].map((s) => DEFAULT_ANIMATION_MAP[s]);

beforeEach(async () => {
	if (!AgentAvatar) ({ AgentAvatar } = await import('../src/agent-avatar.js'));
});

describe('AgentAvatar.playChoreography', () => {
	it('plays every step, in order, on the rig', () => {
		const am = makeFakeAnimationManager(WELCOME_CLIPS);
		const avatar = makeAvatar(am);

		expect(avatar.playChoreography(WELCOME)).toBe(true);
		run(avatar, 3.2);

		expect(am.played).toEqual(WELCOME_CLIPS);
	});

	it('plays the first step immediately, before a frame has passed', () => {
		const am = makeFakeAnimationManager(WELCOME_CLIPS);
		const avatar = makeAvatar(am);

		avatar.playChoreography(WELCOME);
		expect(am.played).toEqual([WELCOME_CLIPS[0]]);
	});

	it('honors the agent’s own slot overrides', () => {
		const am = makeFakeAnimationManager(['victory-dance-custom', 'nod', 'wave']);
		const avatar = makeAvatar(am);
		avatar.setAnimationMap({ celebrate: 'victory-dance-custom' });

		avatar.playChoreography(WELCOME);
		run(avatar, 3.2);

		expect(am.played).toContain('victory-dance-custom');
		expect(am.played).not.toContain(DEFAULT_ANIMATION_MAP.celebrate);
	});

	it('a step that pins a clip beats both the override and the default', () => {
		const am = makeFakeAnimationManager(['thriller', 'rumba']);
		const avatar = makeAvatar(am);
		avatar.setAnimationMap({ dance: 'rumba' });

		avatar.playChoreography({ name: 'Pinned', steps: [{ slot: 'dance', clip: 'thriller' }] });

		expect(am.played).toEqual(['thriller']);
	});

	it('reports performing state and stops on request', () => {
		const am = makeFakeAnimationManager(WELCOME_CLIPS);
		const avatar = makeAvatar(am);

		avatar.playChoreography(WELCOME);
		expect(avatar.isPerforming).toBe(true);

		avatar.stopChoreography();
		expect(avatar.isPerforming).toBe(false);

		const before = am.played.length;
		run(avatar, 3.2);
		// A stopped routine must not keep firing steps on later frames.
		expect(am.played.length).toBe(before);
	});

	it('stops performing once the routine ends', () => {
		const am = makeFakeAnimationManager(WELCOME_CLIPS);
		const avatar = makeAvatar(am);

		avatar.playChoreography(WELCOME);
		run(avatar, 3.5);

		expect(avatar.isPerforming).toBe(false);
		expect(am.played).toEqual(WELCOME_CLIPS);
	});

	it('loops without ever ending when asked to', () => {
		const am = makeFakeAnimationManager(WELCOME_CLIPS);
		const avatar = makeAvatar(am);

		avatar.playChoreography(WELCOME, { loop: true });
		run(avatar, 7, 70);

		expect(avatar.isPerforming).toBe(true);
		expect(am.played.length).toBeGreaterThan(WELCOME_CLIPS.length);
		expect(am.played.slice(0, 6)).toEqual([...WELCOME_CLIPS, ...WELCOME_CLIPS]);
	});

	it('starting a second routine replaces the first rather than interleaving', () => {
		const am = makeFakeAnimationManager([...WELCOME_CLIPS, DEFAULT_ANIMATION_MAP.bow]);
		const avatar = makeAvatar(am);

		avatar.playChoreography(WELCOME);
		avatar.playChoreography({ name: 'Bow', steps: [{ slot: 'bow', hold: 1 }] });
		run(avatar, 3.2);

		expect(am.played).toEqual([WELCOME_CLIPS[0], DEFAULT_ANIMATION_MAP.bow]);
	});

	it('an emotion spike cannot cut into a performing routine', () => {
		// A high celebration weight normally fires the celebrate slot on its own
		// (Stage 3). While a routine performs, the routine owns the body: without
		// this gate the reflex fires in the seam between two steps and the
		// authored performance visibly breaks.
		const am = makeFakeAnimationManager([DEFAULT_ANIMATION_MAP.bow, DEFAULT_ANIMATION_MAP.celebrate]);
		const avatar = makeAvatar(am);

		avatar.playChoreography({
			name: 'Slow bow',
			steps: [
				{ slot: 'bow', hold: 2 },
				{ slot: 'bow', hold: 2 },
			],
		});
		avatar._emotion.celebration = 1;
		run(avatar, 4, 80);

		expect(am.played.every((clip) => clip === DEFAULT_ANIMATION_MAP.bow)).toBe(true);
	});

	it('the same emotion spike still fires once the routine is over', () => {
		const am = makeFakeAnimationManager([DEFAULT_ANIMATION_MAP.bow, DEFAULT_ANIMATION_MAP.celebrate]);
		const avatar = makeAvatar(am);

		avatar.playChoreography({ name: 'Quick bow', steps: [{ slot: 'bow', hold: 0.5 }] });
		run(avatar, 0.6, 6);
		avatar._emotion.celebration = 1;
		run(avatar, 1, 10);

		expect(am.played).toContain(DEFAULT_ANIMATION_MAP.celebrate);
	});
});

describe('AgentAvatar.setChoreographies', () => {
	const SAVED = [
		{ id: 'welcome', name: 'Welcome', steps: [{ slot: 'wave', hold: 1 }] },
		{ id: 'bow', name: 'Take a bow', steps: [{ slot: 'bow', hold: 1 }] },
	];

	it('registers routines and plays one by id', () => {
		const am = makeFakeAnimationManager([DEFAULT_ANIMATION_MAP.wave]);
		const avatar = makeAvatar(am);

		expect(avatar.setChoreographies(SAVED)).toBe(2);
		expect(avatar.playChoreography('welcome')).toBe(true);
		expect(am.played).toEqual([DEFAULT_ANIMATION_MAP.wave]);
	});

	it('resolves a routine by its display name too', () => {
		const am = makeFakeAnimationManager([DEFAULT_ANIMATION_MAP.bow]);
		const avatar = makeAvatar(am);
		avatar.setChoreographies(SAVED);

		expect(avatar.playChoreography('Take a bow')).toBe(true);
		expect(am.played).toEqual([DEFAULT_ANIMATION_MAP.bow]);
	});

	it('reports a miss instead of guessing a routine', () => {
		const am = makeFakeAnimationManager([]);
		const avatar = makeAvatar(am);
		avatar.setChoreographies(SAVED);

		expect(avatar.playChoreography('nope')).toBe(false);
		expect(am.played).toEqual([]);
	});

	it('drops an invalid saved routine without losing the valid ones', () => {
		// One malformed entry (a stored routine from a future format, a hand-edited
		// record) must not cost the agent its whole body language.
		const am = makeFakeAnimationManager([DEFAULT_ANIMATION_MAP.wave]);
		const avatar = makeAvatar(am);

		expect(avatar.setChoreographies([{ id: 'broken', steps: [] }, SAVED[0]])).toBe(1);
		expect(avatar.playChoreography('welcome')).toBe(true);
	});

	it('refuses an invalid literal routine rather than throwing at the caller', () => {
		const am = makeFakeAnimationManager([]);
		const avatar = makeAvatar(am);

		expect(avatar.playChoreography({ name: 'Nope', steps: [{ slot: 'moonwalk' }] })).toBe(false);
		expect(avatar.isPerforming).toBe(false);
	});

	it('exposes the registered routines', () => {
		const avatar = makeAvatar(makeFakeAnimationManager([]));
		avatar.setChoreographies(SAVED);

		expect(avatar.getChoreographies().map((r) => r.id)).toEqual(['welcome', 'bow']);
	});
});
