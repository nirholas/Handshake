// Animation state machine — replaces the flat clip list / hard-cut playback
// model with a small directed graph that picks the next clip when protocol
// events fire and crossfades between them.
//
// States are simple roles the avatar can be in (idle, talk, walk, react, emote).
// Each state maps to a single library clip name; the mapping is editable per
// agent so creators can swap in custom motion (e.g. "their idle is the dance
// clip"). Events fire transitions:
//
//   idle ─speak──► talk ─speak-end──► idle ─walk──► walk ─walk-end──► idle
//                                      ▲                                ▲
//                                      └─ react ◄─reaction-end──────────┘
//                                      └─ emote ◄──emote-end────────────┘
//
// `react` and `emote` are one-shots: they play once, then auto-fire their
// `-end` transition (driven externally by the caller calling fire('react-end')
// after the clip duration elapses — the machine itself is duration-agnostic).
//
// `listen` and `think` are looping conversational postures (worn while a peer
// speaks / while a reply is generated). They behave like idle/talk/walk — held
// until a `listen-end` / `think-end` (or any other) event crossfades them out.
//
// This module is pure: no Three.js, no DOM, no async. Playback side effects
// are delivered through a single `onTransition({ state, clip, crossfade })`
// callback supplied by the caller. That makes the state machine unit-testable
// without a render loop and reusable by anything that drives an avatar
// (the embed bundle, /app, future server-side previewers).

/** Built-in state definitions.
 *
 * `talk` defaults to the same clip as `idle` because the three.ws animation
 * library doesn't ship a dedicated talking-body loop and the live lip-sync
 * already animates the mouth. Agents that have a talking-body clip (e.g. a
 * subtle idle-2) override `states.talk.clip` via meta.animationGraph.
 */
import { log } from './shared/log.js';
const DEFAULT_STATES = Object.freeze({
	idle:   { clip: 'idle',                loop: true,  crossfade: 0.5,  oneShot: false, returnTo: null },
	talk:   { clip: 'idle',                loop: true,  crossfade: 0.35, oneShot: false, returnTo: null },
	walk:   { clip: 'walk',                loop: true,  crossfade: 0.3,  oneShot: false, returnTo: null },
	react:  { clip: 'reaction',            loop: false, crossfade: 0.25, oneShot: true,  returnTo: 'idle' },
	emote:  { clip: 'wave',                loop: false, crossfade: 0.25, oneShot: true,  returnTo: 'idle' },
	// Postural modes the body holds while a conversation is in flight. `listen`
	// is the attentive sway worn while the user/peer is speaking; `think` is the
	// considering pose worn while a reply is being generated. Both loop and are
	// left via their `-end` event (or any other transition), so they crossfade
	// cleanly back to idle/talk without a T-pose pop. Clips are baked library
	// loops, retargeted to any humanoid rig like every other state.
	listen: { clip: 'av-listening-music',  loop: true,  crossfade: 0.4,  oneShot: false, returnTo: null },
	think:  { clip: 'av-waiting',          loop: true,  crossfade: 0.4,  oneShot: false, returnTo: null },
});

/** Built-in event → target-state transition table. */
const DEFAULT_TRANSITIONS = Object.freeze({
	'speak':       'talk',
	'speak-end':   'idle',
	'walk':        'walk',
	'walk-end':    'idle',
	'react':       'react',
	'react-end':   'idle',
	'emote':       'emote',
	'emote-end':   'idle',
	'listen':      'listen',
	'listen-end':  'idle',
	'think':       'think',
	'think-end':   'idle',
});

const STATE_NAMES = Object.freeze(Object.keys(DEFAULT_STATES));

/**
 * Gesture / emote library — a parallel "slot" that plays over the base
 * walk/idle layer rather than replacing it. Each gesture names a real clip in
 * the animation library and declares how it composes with locomotion:
 *
 *   layer: 'upper'  — additive upper-body overlay. Plays *on top of* whatever
 *                     the base layer is doing, so the avatar can wave while it
 *                     walks (legs keep the walk cycle, arms/torso/head gesture).
 *   layer: 'full'   — whole-body clip that takes over the base layer (the avatar
 *                     stops to sit or dance). Locomotion is suppressed until the
 *                     gesture ends.
 *
 *   loop: false     — one-shot; auto-returns to the base layer when the clip ends.
 *   loop: true      — holds until explicitly cleared (toggle off, movement input,
 *                     or another gesture). `talking` is held for the duration of
 *                     TTS narration; `dance` until the user stops it.
 *
 *   exitOnMove      — a full-body gesture (sit) that the avatar rises out of the
 *                     instant a movement key/stick is pressed.
 *
 * `clip` names map to baked clips in public/animations/clips/. Every gesture now
 * names its own dedicated clip: the borrowed stand-ins several of them shipped
 * with (`point` → `reaction`, `nod` → `xbot-agree`, `shrug` → `defeated`,
 * `jog` → `xbot-run`, `sit` → the 2-key `sitidle` hold) predated the Mixamo
 * clips that cover them exactly, and outlived that reason.
 */
const GESTURES = Object.freeze({
	wave:     { clip: 'wave',            label: 'Wave',     icon: '👋', loop: false, layer: 'upper', crossfade: 0.25 },
	dance:    { clip: 'dance',           label: 'Dance',    icon: '💃', loop: true,  layer: 'full',  crossfade: 0.3  },
	// `sitloop` is a breathing seated idle; `sitidle` is a 2-key hold pose that
	// freezes the avatar mid-frame for as long as the gesture is held.
	sit:      { clip: 'sitloop',         label: 'Sit',      icon: '🪑', loop: true,  layer: 'full',  crossfade: 0.35, exitOnMove: true },
	point:    { clip: 'point',           label: 'Point',    icon: '👉', loop: false, layer: 'upper', crossfade: 0.25 },
	cheer:    { clip: 'av-cheering',     label: 'Cheer',    icon: '🙌', loop: false, layer: 'upper', crossfade: 0.25 },
	agree:    { clip: 'xbot-agree',      label: 'Agree',    icon: '✅', loop: false, layer: 'upper', crossfade: 0.2  },
	disagree: { clip: 'xbot-head-shake', label: 'Disagree', icon: '🙅', loop: false, layer: 'upper', crossfade: 0.2  },
	talking:  { clip: 'av-vtubing',      label: 'Talking',  icon: '💬', loop: true,  layer: 'upper', crossfade: 0.3  },
	// Conversational + locomotion gestures. `shrug` is a shoulder shrug, so it
	// overlays the base layer (shrug while walking) rather than taking the whole
	// body over the way the borrowed `defeated` clip had to. All clip names are
	// baked in public/animations/manifest.json (covered by the gesture-manifest
	// test).
	nod:      { clip: 'nod',             label: 'Nod',      icon: '🙂', loop: false, layer: 'upper', crossfade: 0.2  },
	shrug:    { clip: 'shrug',           label: 'Shrug',    icon: '🤷', loop: false, layer: 'upper', crossfade: 0.25 },
	jog:      { clip: 'jog',             label: 'Jog',      icon: '🏃', loop: true,  layer: 'full',  crossfade: 0.3  },
	celebrate:{ clip: 'av-celebrating',  label: 'Celebrate',icon: '🎉', loop: false, layer: 'full',  crossfade: 0.3  },
});

const GESTURE_NAMES = Object.freeze(Object.keys(GESTURES));

export { DEFAULT_STATES, DEFAULT_TRANSITIONS, STATE_NAMES, GESTURES, GESTURE_NAMES };

/**
 * @typedef {Object} StateDef
 * @property {string}        clip         - library clip name to play in this state
 * @property {boolean}       loop         - whether the clip loops
 * @property {number}        crossfade    - seconds to crossfade in
 * @property {boolean}       oneShot      - if true, the state auto-resolves to `returnTo` after playback
 * @property {string|null}   returnTo     - state to return to after a one-shot (idle by default)
 */

/**
 * @typedef {Object} AnimationGraph
 * @property {Object<string,Partial<StateDef>>} [states]       - per-state overrides (defaults filled in)
 * @property {Object<string,string>}            [transitions]  - event → target-state overrides
 * @property {string}                           [initial]      - starting state, defaults to "idle"
 */

export class AnimationStateMachine {
	/**
	 * @param {AnimationGraph}  [graph]
	 * @param {(payload: {state: string, def: StateDef, clip: string, crossfade: number}) => void} [onTransition]
	 *   Called every time the current state changes. The caller wires this to the
	 *   actual animation playback (e.g. `viewer.animationManager.crossfadeTo(clip, crossfade)`).
	 * @param {(payload: {gesture: string|null, def: object|null, active: boolean, prev: string|null}) => void} [onGesture]
	 *   Called every time the gesture slot changes. The caller wires this to the
	 *   overlay playback (additive upper-body layer, or a full-body takeover).
	 */
	constructor(graph = {}, onTransition = null, onGesture = null) {
		this.states      = mergeStates(graph.states);
		this.transitions = mergeTransitions(graph.transitions);
		this.initial     = graph.initial && this.states[graph.initial] ? graph.initial : 'idle';
		this.current     = this.initial;
		this.onTransition = typeof onTransition === 'function' ? onTransition : null;
		this.onGesture    = typeof onGesture === 'function' ? onGesture : null;
		// The gesture slot runs in parallel to `current`: a one-shot wave or a
		// held dance/sit that overlays (or, for full-body gestures, takes over)
		// the base state without rewriting the locomotion graph.
		this.gesture = null;
		// History of one-shot returns. A `react` fired during a `talk` should
		// return to `talk` afterwards, not blindly to `idle`. We keep a small
		// stack so nested one-shots compose cleanly.
		this._returnStack = [];
	}

	/** Current state name (e.g. "idle", "talk"). */
	getCurrent() { return this.current; }

	/** Current state's clip name from its definition. */
	getCurrentClip() { return this.states[this.current]?.clip ?? null; }

	/**
	 * Fire a transition. Returns the new state name (which may equal the old
	 * if no edge matched), or null if the machine has no clip for the target.
	 * @param {string} event
	 * @returns {string|null}
	 */
	fire(event) {
		if (!event || typeof event !== 'string') return null;

		// Special case: every state has an implicit "<state-name>" event that
		// transitions directly into it (e.g. fire('walk') always goes to walk).
		const target = this.transitions[event] || (this.states[event] ? event : null);
		if (!target) return null;

		const targetDef = this.states[target];
		if (!targetDef || !targetDef.clip) return null;

		// If the new state is a one-shot, remember where to return so we can
		// resume the long-running state (talk / walk) afterwards.
		const fromDef = this.states[this.current];
		if (targetDef.oneShot && fromDef && !fromDef.oneShot) {
			this._returnStack.push(this.current);
		}

		// "*-end" transitions resolve to the return stack if there's one, falling
		// back to the configured returnTo / initial.
		const isEndEvent = event.endsWith('-end');
		let resolvedTarget = target;
		if (isEndEvent && this._returnStack.length > 0) {
			const popped = this._returnStack.pop();
			if (this.states[popped]) resolvedTarget = popped;
		}

		if (resolvedTarget === this.current) return this.current;

		const def = this.states[resolvedTarget];
		this.current = resolvedTarget;
		if (this.onTransition) {
			try {
				this.onTransition({
					state: resolvedTarget,
					def,
					clip: def.clip,
					crossfade: def.crossfade,
				});
			} catch (err) {
				log.warn('[AnimationStateMachine] onTransition threw:', err);
			}
		}
		return resolvedTarget;
	}

	// ── Gesture slot ────────────────────────────────────────────────────────

	/** Currently-playing gesture name, or null. */
	getGesture() { return this.gesture; }

	/** The resolved definition for a gesture name, or null if unknown. */
	getGestureDef(name) {
		const def = GESTURES[name];
		return def ? { name, ...def } : null;
	}

	/**
	 * Play a gesture in the parallel gesture slot. Validates the name against the
	 * built-in {@link GESTURES} library and fires `onGesture` with the resolved
	 * definition so the caller can crossfade the overlay/full-body clip in.
	 * Re-firing the gesture that's already active is a no-op (prevents restarting
	 * a held loop every keypress).
	 *
	 * @param {string} name
	 * @returns {string|null} the gesture name if it started, else null
	 */
	playGesture(name) {
		const def = GESTURES[name];
		if (!def) return null;
		if (this.gesture === name) return name;
		const prev = this.gesture;
		this.gesture = name;
		if (this.onGesture) {
			try {
				this.onGesture({ gesture: name, def: { name, ...def }, active: true, prev });
			} catch (err) {
				log.warn('[AnimationStateMachine] onGesture threw:', err);
			}
		}
		return name;
	}

	/**
	 * Clear the active gesture and return the base layer to view. Fires
	 * `onGesture` with `active: false` so the caller can fade the overlay out and
	 * resume locomotion. No-op when no gesture is active.
	 * @returns {string|null} the gesture that was cleared, or null
	 */
	endGesture() {
		if (!this.gesture) return null;
		const prev = this.gesture;
		this.gesture = null;
		if (this.onGesture) {
			try {
				this.onGesture({ gesture: null, def: null, active: false, prev });
			} catch (err) {
				log.warn('[AnimationStateMachine] onGesture threw:', err);
			}
		}
		return prev;
	}

	/** Reset to the initial state and clear any pending returns + gesture. */
	reset() {
		this._returnStack.length = 0;
		this.current = this.initial;
		this.endGesture();
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mergeStates(overrides) {
	const out = {};
	for (const name of STATE_NAMES) {
		const def = { ...DEFAULT_STATES[name] };
		const o = overrides && overrides[name];
		if (o && typeof o === 'object') {
			if (typeof o.clip === 'string' && o.clip.length > 0) def.clip = o.clip;
			if (typeof o.loop === 'boolean') def.loop = o.loop;
			if (typeof o.crossfade === 'number' && Number.isFinite(o.crossfade)) {
				def.crossfade = Math.max(0, Math.min(5, o.crossfade));
			}
			if (typeof o.oneShot === 'boolean') def.oneShot = o.oneShot;
			if (typeof o.returnTo === 'string' || o.returnTo === null) def.returnTo = o.returnTo;
		}
		out[name] = def;
	}
	// Allow custom user-defined states beyond the built-ins.
	if (overrides && typeof overrides === 'object') {
		for (const [name, o] of Object.entries(overrides)) {
			if (out[name] || !o || typeof o !== 'object' || !o.clip) continue;
			out[name] = {
				clip:      o.clip,
				loop:      o.loop ?? false,
				crossfade: typeof o.crossfade === 'number' ? Math.max(0, Math.min(5, o.crossfade)) : 0.25,
				oneShot:   o.oneShot ?? true,
				returnTo:  typeof o.returnTo === 'string' ? o.returnTo : 'idle',
			};
		}
	}
	return out;
}

function mergeTransitions(overrides) {
	const out = { ...DEFAULT_TRANSITIONS };
	if (overrides && typeof overrides === 'object') {
		for (const [event, target] of Object.entries(overrides)) {
			if (typeof event === 'string' && typeof target === 'string') {
				out[event] = target;
			}
		}
	}
	return out;
}
