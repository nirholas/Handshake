/**
 * Agent Avatar — Performer + Empathy Layer
 * -----------------------------------------
 * This is the thing that makes agents real.
 *
 * It listens to the AgentProtocol bus and drives the Three.js avatar:
 *   - speaks with lip sync hints
 *   - plays named gestures and animations
 *   - looks toward models/objects
 *
 * The Empathy Layer (novel):
 *   Every action emitted to the protocol is read for emotional valence.
 *   The avatar maintains a *continuous weighted blend* of emotional states —
 *   never snapping between moods, always drifting. Morph targets and head
 *   orientation are updated every animation frame.
 *
 *   Nobody has done this before in a three.ws system:
 *   you can feel 40% concerned + 30% curious + 30% neutral simultaneously,
 *   and the avatar's face reflects all three at once — exactly as humans do.
 */

import { ACTION_TYPES } from './agent-protocol.js';
import { Vector3, Box3, MathUtils, PositionalAudio } from 'three';
import { resolveSlot, resolveHint, DEFAULT_ANIMATION_MAP } from './runtime/animation-slots.js';
import { RoutinePlayer, normalizeRoutine, slugify } from './runtime/choreography.js';
import { ElevenLabsTTS } from './runtime/speech.js';
import { LipSyncAnalyser, VISEMES as LIPSYNC_VISEMES } from './lip-sync-analyser.js';
import { resolveMorphTargets, MORPH_ALIASES, ARKIT_VISEMES } from './runtime/arkit52.js';
import { AnimationStateMachine } from './animation-state-machine.js';
// BEGIN:IDLE_LOOP_IMPORT
import { IdleAnimation } from './idle-animation.js';
import { LookAtController } from './procedural/look-at.js';
import { log } from './shared/log.js';
// END:IDLE_LOOP_IMPORT

const DEG2RAD = Math.PI / 180;

// Scratch for resolving the live camera position when the gaze target is the
// viewer rather than a fixed world point. Reused so the per-frame look-at path
// allocates nothing.
const _lookScratch = new Vector3();

// Sustained-mood → gesture-slot bias thresholds (Living Agents · Task 07
// extension). Read against the *applied* (lerped) mood, not the raw target, so
// a gesture only fires once the mood has actually settled there — a momentary
// setMood() spike doesn't yank the body into a slot the same frame it decays.
const MOOD_GESTURE_THRESHOLD = {
	positiveValence: 0.35, // above this = "up"; below its negation = "down"
	energeticArousal: 0.6, // above this = "energetic"
	calmArousal: 0.25, // below this = "subdued"
};

// Emotion decay rates (units per second — larger = fades faster)
const DECAY = {
	concern: 0.08, // half-life ~12s — lingers, builds empathy
	celebration: 0.18, // half-life ~6s  — bright but brief
	patience: 0.035, // half-life ~20s — sustained waiting state
	curiosity: 0.12, // half-life ~8s  — alert, engaged
	empathy: 0.055, // half-life ~13s — slow to fade, like real empathy
	uncertain: 0.1, // half-life ~7s: hedged speech signal
};

// Vocabulary scored for emotional valence
// Keys map to emotion buckets; values are keyword lists
const VOCAB = {
	concern: [
		'error',
		'failed',
		'fail',
		'invalid',
		'missing',
		'broken',
		'issue',
		'warning',
		'problem',
		'wrong',
		'crash',
		'undefined',
		'null',
		'corrupt',
	],
	celebration: [
		'success',
		'complete',
		'valid',
		'clean',
		'done',
		'great',
		'loaded',
		'ready',
		'perfect',
		'excellent',
		'nice',
		'good',
		'worked',
		'saved',
	],
	patience: [
		'analyzing',
		'checking',
		'loading',
		'processing',
		'thinking',
		'please wait',
		'just a moment',
		'scanning',
		'computing',
		'fetching',
	],
	curiosity: [
		'interesting',
		'wonder',
		'what if',
		'explore',
		'curious',
		'new',
		'never seen',
		'unusual',
		'rare',
		'unique',
		'unexpected',
	],
	empathy: [
		'sorry',
		'understand',
		'difficult',
		'frustrating',
		'try again',
		'my mistake',
		'apologies',
		'hard',
		'oops',
		'unfortunately',
	],
	uncertain: [
		'i think',
		'not sure',
		'might be',
		'probably',
		'possibly',
		'i believe',
		"i'm not certain",
		'could be',
		'maybe',
		'roughly',
		'approximately',
		'unclear',
		'uncertain',
		'hard to say',
		'it depends',
		"i'd guess",
		'seems like',
		'appears to',
		'not entirely sure',
	],
};

export class AgentAvatar {
	/**
	 * @param {import('./viewer.js').Viewer}                   viewer
	 * @param {import('./agent-protocol.js').AgentProtocol}    protocol
	 * @param {import('./agent-identity.js').AgentIdentity}    identity
	 */
	constructor(viewer, protocol, identity) {
		this.viewer = viewer;
		this.protocol = protocol;
		this.identity = identity;

		// Emotional state — continuous weighted blend, updated every frame
		this._emotion = {
			neutral: 1.0,
			concern: 0.0,
			celebration: 0.0,
			patience: 0.0,
			curiosity: 0.0,
			empathy: 0.0,
			uncertain: 0.0,
		};

		// Head look-at state
		this._lookTarget = null; // Vector3 | null — consumed by _applyLookTarget()
		this._lookAtCamera = false; // when true, the gaze tracks the live camera each frame
		this._lookIk = null; // LookAtController for the current avatar, or null if the rig has no head
		this._lookIkFor = null; // the content root _lookIk was built for (rebuild on swap)
		this._currentTilt = 0; // radians
		this._targetTilt = 0; // radians
		this._currentLean = 0; // slight forward lean
		this._targetLean = 0;
		this._currentYaw = 0; // horizontal gaze (follow mode)

		// Body yaw — rotates root to face camera
		this._bodyYaw = null; // null = uninitialised (snap on first frame)

		// Follow mode state
		this._mouseGaze = { x: 0, y: 0 }; // normalised -1..1
		this._keystrokePitch = 0; // look-down impulse (radians, decays)
		this._keystrokeYaw = 0; // lateral drift impulse (radians, decays)

		// Gaze bias state
		this._userSpeaking = false;
		this._agentThinking = false;
		this._agentThinkTimer = 0;
		this._thinkGazeYaw = 0.1; // randomised on each THINK event

		// One-shot gesture tracking
		this._oneShotAction = null;
		this._oneShotDuration = 0;
		this._oneShotTimer = 0;
		this._isPlayingOneShot = false;

		// Animation slot override map (from meta.edits.animations)
		this._animationMap = {};
		this._warnedSlots = new Set();

		// Named gesture routines (from meta.choreographies) and the one currently
		// performing, if any. Driven from the same frame hook as the emotion blend.
		this._routines = new Map();
		this._routinePlayer = null;

		// Streak tracking for empathy injection
		this._errorStreak = 0;
		this._firstEncounter = true;

		// Sustained mood layer (Living Agents · Task 07). Unlike the transient
		// emotion blend above — which spikes on an event and decays to neutral —
		// this is the agent's *resting* emotional state (valence × arousal). It is
		// driven by the mood engine via setMood() and applied every frame as a
		// continuous bias on top of the transient morphs, so the body keeps
		// reflecting how the agent feels even when nothing is happening. Inactive
		// until the first setMood() call, so avatars with no mood source behave
		// exactly as before.
		this._mood = { valence: 0.12, arousal: 0.32, active: false, reduced: false };
		this._moodApplied = { valence: 0.12, arousal: 0.32 };

		// Morph target current values (lerped each frame)
		this._morphCurrent = {};
		this._morphTarget = {};
		// Cached list of meshes with morph targets — rebuilt on attach() to avoid per-frame traversal
		this._morphMeshes = null;

		// Listeners stored so we can detach later
		this._listeners = [];

		// Frequency-based lip sync (null = use mouthOpen fallback)
		this._lipSync = null;

		// Spatial audio
		this._tts = null;
		this._positionalAudio = null;

		// Animation state machine — lazy: created in attach() once the viewer's
		// animation manager is reachable.
		this._sm = null;

		this._tickBound = this._tickEmotion.bind(this);
		this._onMouseMove = this._handleMouseMove.bind(this);
		this._onKeyFollowDown = this._handleKeyPress.bind(this);
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	/** Call after viewer.setContent() loads the avatar model */
	attach() {
		// Reset emotion to neutral so re-attaching a previously emotional avatar starts clean
		this._emotion = {
			neutral: 1.0,
			concern: 0,
			celebration: 0,
			patience: 0,
			curiosity: 0,
			empathy: 0,
			uncertain: 0,
		};

		// Build the morph mesh cache once instead of traversing every frame
		this._buildMorphCache();

		// Wire spatial audio to the loaded avatar
		this._initSpatialAudio();

		// Hook into the viewer's per-frame loop
		if (!this.viewer._afterAnimateHooks) this.viewer._afterAnimateHooks = [];
		this.viewer._afterAnimateHooks.push(this._tickBound);

		// Follow mode input listeners
		this.viewer.el.addEventListener('mousemove', this._onMouseMove);
		window.addEventListener('keydown', this._onKeyFollowDown);

		// Subscribe to protocol events
		this._sub(ACTION_TYPES.SPEAK, this._onSpeak.bind(this));
		this._sub(ACTION_TYPES.THINK, this._onThink.bind(this));
		this._sub(ACTION_TYPES.GESTURE, this._onGesture.bind(this));
		this._sub(ACTION_TYPES.EMOTE, this._onEmote.bind(this));
		this._sub(ACTION_TYPES.LOOK_AT, this._onLookAt.bind(this));
		this._sub(ACTION_TYPES.PERFORM_SKILL, this._onSkillStart.bind(this));
		this._sub(ACTION_TYPES.SKILL_DONE, this._onSkillDone.bind(this));
		this._sub(ACTION_TYPES.SKILL_ERROR, this._onSkillError.bind(this));
		this._sub(ACTION_TYPES.LOAD_START, this._onLoadStart.bind(this));
		this._sub(ACTION_TYPES.LOAD_END, this._onLoadEnd.bind(this));
		this._sub(ACTION_TYPES.VALIDATE, this._onValidate.bind(this));
		this._sub(ACTION_TYPES.INTERRUPTED, this._onInterrupted.bind(this));

		// First-encounter curiosity burst
		if (this._firstEncounter) {
			this._firstEncounter = false;
			this._firstEncounterTimer = setTimeout(() => {
				this._injectStimulus('curiosity', 0.9);
				this._injectStimulus('celebration', 0.4);
			}, 600);
		}

		// BEGIN:IDLE_LOOP_INIT
		this._idle?.dispose();
		this._idle = new IdleAnimation({
			getRoot: () => this.viewer.content,
			protocol: this.protocol,
			seed: this.identity?.id ?? 'default',
			getMorphCurrent: () => this._morphCurrent,
		});
		// END:IDLE_LOOP_INIT

		// Animation state machine. The graph comes from agent meta and falls back
		// to the canonical defaults (idle / talk / walk / react / emote). onTransition
		// is wired straight to the AnimationManager so state transitions become
		// real crossfades; non-existent clips degrade to a no-op warning from AM.
		this._sm = new AnimationStateMachine(
			this.identity?.animationGraph || {},
			({ clip, def, crossfade }) => {
				const am = this.viewer?.animationManager;
				if (!am) return;
				if (def.loop) {
					am.crossfadeTo(clip, crossfade);
				} else {
					// One-shots can't crossFadeTo because the action stops on completion;
					// play() handles the hard cut + lazy load. The clip's own end will
					// be observed by callers who fire('<state>-end') manually, mirroring
					// today's _playSlot timer-driven model.
					am.play(clip);
				}
			},
		);
	}

	/** Remove all hooks and listeners */
	detach() {
		clearTimeout(this._firstEncounterTimer);
		clearTimeout(this._playAmClipTimer);
		this.stopChoreography();
		if (this.viewer._afterAnimateHooks) {
			const idx = this.viewer._afterAnimateHooks.indexOf(this._tickBound);
			if (idx !== -1) this.viewer._afterAnimateHooks.splice(idx, 1);
		}
		this.viewer.el.removeEventListener('mousemove', this._onMouseMove);
		window.removeEventListener('keydown', this._onKeyFollowDown);
		for (const [type, handler] of this._listeners) {
			this.protocol.off(type, handler);
		}
		this._listeners = [];
		// BEGIN:IDLE_LOOP_DISPOSE
		this._idle?.dispose();
		this._idle = null;
		// END:IDLE_LOOP_DISPOSE
		this._lipSync?.disconnect();
		this._lipSync = null;
		if (this._positionalAudio) {
			try {
				this._positionalAudio.disconnect();
			} catch {}
			this._positionalAudio.parent?.remove(this._positionalAudio);
			this._positionalAudio = null;
		}
		this._sm = null;
	}

	// ── Public API ────────────────────────────────────────────────────────────

	/**
	 * Fire a transition on the animation state machine. Used by callers outside
	 * AgentAvatar — element.js fires `walk` / `walk-end` from stream/chat hooks,
	 * for instance. No-op when no state machine is attached.
	 *
	 * @param {string} event
	 * @returns {string|null} new state name (null if no transition matched)
	 */
	fireAnimationEvent(event) {
		return this._sm?.fire(event) ?? null;
	}

	/** Current animation state name from the state machine, or null. */
	getAnimationState() {
		return this._sm?.getCurrent() ?? null;
	}

	/** Play a named gesture animation */
	playGesture(name) {
		this._triggerOneShot(name);
	}

	/**
	 * Set the sustained mood (Living Agents · Task 07). The body continuously
	 * reflects this resting emotional state — a gentle smile and open posture when
	 * valence is high, a worried brow and lowered gaze when it's low; alert wide
	 * eyes and a forward lean at high arousal, heavy-lidded stillness when calm.
	 * Composited on top of, and lerped under, the transient emotion blend so it
	 * never snaps. `reducedMotion` keeps the facial cue but drops postural motion.
	 *
	 * @param {number} valence  -1..1 (pleasantness)
	 * @param {number} arousal  0..1 (activation)
	 * @param {{reducedMotion?: boolean}} [opts]
	 */
	setMood(valence, arousal, opts = {}) {
		this._mood.valence = Math.max(-1, Math.min(1, Number(valence) || 0));
		this._mood.arousal = Math.max(0, Math.min(1, Number.isFinite(arousal) ? arousal : 0.32));
		this._mood.reduced = Boolean(opts.reducedMotion);
		this._mood.active = true;
	}

	/**
	 * Signal whether the user is actively speaking (mic input active).
	 * When true the avatar holds eye contact; when false normal gaze resumes.
	 * @param {boolean} active
	 */
	setUserSpeaking(active) {
		this._userSpeaking = active;
	}

	/**
	 * Connect a LipSyncAnalyser to this avatar.
	 * While active, viseme morphs are driven from real audio frequency data and
	 * the blunt mouthOpen talk-hint is suppressed.
	 * @param {AnalyserNode|HTMLMediaElement} audioSource
	 */
	connectLipSync(audioSource) {
		this._lipSync?.disconnect();
		this._lipSync = new LipSyncAnalyser();
		this._lipSync.connect(audioSource);
	}

	/**
	 * Tear down the active LipSyncAnalyser and zero every morph target the
	 * lipsync path writes so the lerp pulls the face back to neutral over the
	 * next few frames. Without this the mouth would freeze at the last viseme
	 * weight when TTS ends or is interrupted mid-word.
	 */
	disconnectLipSync() {
		this._lipSync?.disconnect();
		this._lipSync = null;
		// Zero every viseme the analyser ever writes plus the talk-hint slots
		// that the amplitude-only fallback path drives.
		for (const name of LIPSYNC_VISEMES) {
			if (name in this._morphTarget) this._morphTarget[name] = 0;
		}
		this._morphTarget['mouthOpen'] = 0;
		this._morphTarget['jawOpen'] = 0;
		// Drop out of the talk state. If the avatar was in walk before speaking,
		// the state machine's return-stack restores it (see AnimationStateMachine).
		this._sm?.fire('speak-end');
	}

	/**
	 * Set the agent's animation slot override map (from meta.edits.animations).
	 * @param {Object|null} map — { slotName: clipName, … }
	 */
	setAnimationMap(map) {
		this._animationMap = map || {};
	}

	/** Resolve a slot name to the actual clip name via agent's override map. */
	_resolveSlot(slot) {
		return resolveSlot(slot, this._animationMap);
	}

	// ── Choreography ──────────────────────────────────────────────────────────
	//
	// A routine is a named sequence of gesture slots with per-step timing
	// (src/runtime/choreography.js). The timing engine is shared with the
	// /choreograph studio, so what an owner composed there is frame-for-frame
	// what their agent performs here; this class only supplies the "play one
	// step" side effect and the frame deltas.

	/**
	 * Register the agent's saved routines (manifest `choreographies`, stored at
	 * meta.choreographies). Invalid entries are dropped rather than thrown: one
	 * bad routine must not cost the agent the rest of its body language.
	 * @param {Array} list
	 */
	setChoreographies(list) {
		this._routines = new Map();
		for (const entry of Array.isArray(list) ? list : []) {
			try {
				const routine = normalizeRoutine(entry);
				this._routines.set(routine.id, routine);
			} catch (err) {
				log.warn(`[AgentAvatar] skipping invalid choreography: ${err.message}`);
			}
		}
		return this._routines.size;
	}

	/** The agent's registered routines, newest registration order. */
	getChoreographies() {
		return [...(this._routines?.values() ?? [])];
	}

	/**
	 * Perform a routine: either one registered by id/name, or a literal routine
	 * object (what a shared /choreograph link carries).
	 *
	 * @param {string|object} nameOrRoutine
	 * @param {{loop?:boolean, onStep?:Function, onEnd?:Function}} [opts]
	 * @returns {boolean} false when no such routine exists
	 */
	playChoreography(nameOrRoutine, opts = {}) {
		let routine = null;
		if (typeof nameOrRoutine === 'string') {
			// Ids are the contract, but a caller who types the display name it saw
			// in the studio ("Take a bow") means the same routine as `take-a-bow`,
			// and failing that is a papercut with no upside.
			const key = slugify(nameOrRoutine);
			routine =
				this._routines?.get(key) ??
				[...(this._routines?.values() ?? [])].find((r) => slugify(r.name) === key) ??
				null;
			if (!routine) {
				log.warn(`[AgentAvatar] no choreography named "${nameOrRoutine}"`);
				return false;
			}
		} else {
			try {
				routine = normalizeRoutine(nameOrRoutine);
			} catch (err) {
				log.warn(`[AgentAvatar] invalid choreography: ${err.message}`);
				return false;
			}
		}

		this.stopChoreography();
		this._routinePlayer = new RoutinePlayer(routine, {
			loop: opts.loop ?? routine.loop,
			onStep: (step) => {
				// The step owns the stage for exactly its own span, so the one-shot
				// revert never fires mid-routine and steal the next step's crossfade.
				this._playSlot(step.slot, step.hold / (step.speed || 1), step.clip);
				opts.onStep?.(step);
			},
			onEnd: () => {
				this._routinePlayer = null;
				opts.onEnd?.();
			},
		});
		this._routinePlayer.start();
		return true;
	}

	/** Stop a routine mid-performance. The current gesture reverts as usual. */
	stopChoreography() {
		this._routinePlayer?.stop();
		this._routinePlayer = null;
	}

	/** True while a routine is performing. */
	get isPerforming() {
		return Boolean(this._routinePlayer?.playing);
	}

	/**
	 * Play a gesture by slot name, routing through the external animation manager.
	 * Falls back to embedded clip search (_triggerOneShot) if the clip isn't in the library.
	 * Warns once per missing clip name.
	 * @param {string} slot — e.g. 'celebrate', 'think'
	 * @param {number} [duration]
	 * @param {string|null} [clipOverride] — play this exact clip instead of the
	 *   slot's resolved one. Used by choreography steps that pin a clip; the slot
	 *   is still what the fallbacks below key off, so a bad pin degrades to the
	 *   slot's default rather than to nothing.
	 */
	_playSlot(slot, duration = 1.5, clipOverride = null) {
		const clipName = clipOverride || this._resolveSlot(slot);
		this._isPlayingOneShot = true;
		this._oneShotAction = slot;
		this._oneShotDuration = duration;
		this._oneShotTimer = 0;

		const am = this.viewer?.animationManager;
		if (am) {
			if (am.isLoaded(clipName)) {
				this._playAmClip(am, clipName, duration);
				return;
			}
			// Lazy-load from manifest definition
			const def = am.getAnimationDefs().find((d) => d.name === clipName);
			if (def) {
				const prev = am.currentName;
				am.loadAnimation(clipName, def.url, { loop: false, clipName: def.clipName }).then(
					() => {
						this._playAmClip(am, clipName, duration, prev);
					},
				);
				return;
			}
			// Clip not in library: warn once, try default slot fallback. The
			// manifest is registered asynchronously after the viewer boots
			// (src/app.js fetches /animations/manifest.json), so a slot fired
			// by LOAD_START can land before any def exists. That is not a
			// missing clip; skip the warning and take the embedded fallback.
			if (am.getAnimationDefs().length > 0 && !this._warnedSlots.has(clipName)) {
				log.warn(`[AgentAvatar] slot "${slot}" → "${clipName}" not in animation library`);
				this._warnedSlots.add(clipName);
			}
			const fallback = DEFAULT_ANIMATION_MAP[slot];
			if (fallback && fallback !== clipName && am.isLoaded(fallback)) {
				this._playAmClip(am, fallback, duration);
				return;
			}
		}

		// Final fallback: embedded clip search
		this._triggerOneShot(clipName, duration);
	}

	_playAmClip(am, clipName, duration, prevName) {
		const prev = prevName ?? am.currentName;
		am.play(clipName);
		if (prev && am.isLoaded(prev)) {
			this._playAmClipTimer = setTimeout(() => am.crossfadeTo(prev, 0.4), duration * 1000);
		}
	}

	/**
	 * Bind a TTS instance so spatial audio can be wired through it.
	 * Call before or after attach() — both orderings are handled.
	 * @param {import('./runtime/speech.js').ElevenLabsTTS|null} tts
	 */
	setTTS(tts) {
		this._tts = tts;
		if (this._positionalAudio && tts instanceof ElevenLabsTTS) {
			tts.setPositionalAudio(this._positionalAudio);
		}
	}

	/**
	 * Set a world-space point for the avatar to look toward. The chest, neck, and
	 * head turn toward it with procedural IK (see `_applyLookTarget`), clamped and
	 * damped so the gaze reads as a person turning rather than a bone snapping.
	 * Pass null to release the gaze back to the base animation.
	 * @param {import('three').Vector3|null} worldPos
	 */
	setLookTarget(worldPos) {
		this._lookAtCamera = false;
		this._lookTarget = worldPos ? worldPos.clone() : null;
	}

	/** Get current emotion blend (read-only snapshot) */
	get emotionState() {
		return { ...this._emotion };
	}

	// ── Spatial Audio ─────────────────────────────────────────────────────────

	_initSpatialAudio() {
		if (!this.viewer.audioListener) return;
		if (this._positionalAudio) {
			this._positionalAudio.parent?.remove(this._positionalAudio);
		}
		this._positionalAudio = new PositionalAudio(this.viewer.audioListener);
		this._positionalAudio.setRefDistance(1.5);
		this._positionalAudio.setRolloffFactor(1.0);
		this._positionalAudio.setDistanceModel('inverse');

		const anchor = this._findHeadBone() ?? this.viewer.content;
		if (anchor) anchor.add(this._positionalAudio);

		if (this._tts instanceof ElevenLabsTTS) {
			this._tts.setPositionalAudio(this._positionalAudio);
		}
	}

	// ── Sign language ─────────────────────────────────────────────────────────

	/**
	 * Enable or disable ASL sign-language responses: while on, every SPEAK
	 * reply is also performed in sign (dictionary signs where the library has
	 * them, fingerspelling for everything else — src/sign-speech.js). The
	 * engine loads lazily on first enable, so surfaces that never turn it on
	 * pay nothing. Resolves to the effective state: false when the rig has no
	 * canonical skeleton (no fingers, nothing to sign with).
	 */
	async setSignLanguage(on) {
		this._signLanguage = !!on;
		if (on && !this._signSpeaker) {
			const am = this.viewer?.animationManager;
			if (!am?.supportsCanonicalClips?.()) {
				this._signLanguage = false;
				return false;
			}
			const { SignSpeaker } = await import('./sign-speech.js');
			this._signSpeaker = new SignSpeaker({ manager: am });
		}
		if (!on) this._signSpeaker?.cancel();
		return this._signLanguage;
	}

	get signLanguage() {
		return !!this._signLanguage;
	}

	/**
	 * Sign one piece of text on demand, independent of any conversation.
	 * Enables the engine on first use (so a caller does not have to set the
	 * attribute first) and resolves with { signed, spelled } once the motion
	 * finishes, or null when the rig cannot sign (no finger bones).
	 *
	 * This is the entry point for captions, accessibility overlays, and any
	 * surface that has its own text and wants it performed in ASL rather than
	 * waiting for an assistant reply.
	 *
	 * @param {string} text
	 * @returns {Promise<{ signed: string[], spelled: string[] } | null>}
	 */
	async sign(text) {
		if (!text) return null;
		if (!this._signSpeaker) {
			const enabled = await this.setSignLanguage(true);
			if (!enabled) return null;
		}
		return this._signSpeaker.speak(text);
	}

	// ── Protocol Handlers ─────────────────────────────────────────────────────

	_onSpeak(action) {
		this._agentThinking = false; // agent started speaking — done thinking
		const text = action.payload?.text || '';
		const { valence, arousal } = this._analyzeSentiment(text);

		// Positive speech → celebration boost; negative → concern
		if (valence > 0.3) this._injectStimulus('celebration', valence * 0.7);
		else if (valence < -0.2) this._injectStimulus('concern', Math.abs(valence) * 0.8);

		// High-arousal text (questions, exclamations) → curiosity
		if (arousal > 0.5) this._injectStimulus('curiosity', arousal * 0.5);

		// Hedging language → uncertain
		const uncertainScore = this._scoreVocab(text, 'uncertain');
		if (uncertainScore > 0)
			this._injectStimulus('uncertain', Math.min(uncertainScore * 0.4, 0.8));

		// Trigger mouth/talk animation hint
		const duration = Math.max(1.5, text.split(' ').length * 0.3);
		this._triggerOneShot('talk', duration);

		// Sign-language mode: perform the reply in ASL as well. Unsignable
		// text (digits/symbols only) simply skips — the spoken path already
		// carried it.
		if (this._signLanguage && this._signSpeaker && text) {
			this._signSpeaker.speak(text).catch(() => {});
		}

		// Drive the state machine into the talk state so the body-loop swaps
		// (idle → talk) when the agent has a configured talk clip. Default
		// talk-clip-equals-idle is a no-op visually; lip-sync handles the mouth.
		this._sm?.fire('speak');
	}

	_onThink(_action) {
		if (!this._agentThinking) {
			// Pick a stable look-away direction for this thinking episode.
			this._thinkGazeYaw = (Math.random() * 2 - 1) * 0.15;
		}
		this._agentThinking = true;
		this._agentThinkTimer = 0;
	}

	_onGesture(action) {
		const name = action.payload?.name || 'nod';
		const loop = action.payload?.loop === true;
		const duration = (action.payload?.duration || 1500) / 1000;
		// `loop:true` lets host pages keep a chip-triggered animation running
		// indefinitely (e.g. "dance", "idle", "thriller" on the pumpfun chip
		// strip). Without it, every gesture defaults to a 1.5s one-shot that
		// auto-reverts to idle — correct for nod/wave, wrong for dance/idle.
		if (loop) {
			this._playLoopedClip(name);
			return;
		}
		this._playSlot(name, duration);
	}

	/**
	 * Play a clip in loop mode and stay there until another gesture/clip is
	 * triggered. Cancels any pending one-shot revert from a prior `_playSlot`.
	 * @param {string} name
	 */
	_playLoopedClip(name) {
		// Cancel any one-shot revert state so we don't trip back to idle.
		this._isPlayingOneShot = false;
		this._oneShotAction = null;
		this._oneShotTimer = 0;

		const am = this.viewer?.animationManager;
		if (am?.isLoaded?.(name)) {
			am.crossfadeTo(name, 0.35);
			return;
		}
		const def = am?.getAnimationDefs?.().find((d) => d.name === name);
		if (am && def) {
			am.loadAnimation(name, def.url, { loop: true, clipName: def.clipName })
				.then(() => am.crossfadeTo(name, 0.35))
				.catch(() => {});
			return;
		}
		// Baked GLB clip (non-Avaturn rig): play directly through the mixer.
		const baked = this.viewer?.clips?.find?.((c) => c?.name === name);
		const mixer = am?.mixer || this.viewer?.mixer;
		if (baked && mixer) {
			const action = mixer.clipAction(baked);
			action.reset();
			action.setLoop(2201 /* THREE.LoopRepeat */);
			action.fadeIn(0.35);
			action.play();
		}
	}

	_onEmote(action) {
		const trigger = action.payload?.trigger;
		const weight = action.payload?.weight || 0.7;
		if (trigger && this._emotion.hasOwnProperty(trigger)) {
			this._injectStimulus(trigger, weight);
		}
	}

	_onLookAt(action) {
		const target = action.payload?.target;
		this._lookAtCamera = false;
		if (target === 'model' && this.viewer?.content) {
			// Look at the bounding box center of the loaded model
			const box = new Box3();
			const center = new Vector3();
			box.setFromObject(this.viewer.content).getCenter(center);
			this._lookTarget = center;
		} else if (target === 'user' || target === 'camera') {
			// Meet the viewer's eyes: _applyLookTarget resolves the live camera
			// position each frame, so the gaze holds while the user orbits.
			this._lookAtCamera = true;
			this._lookTarget = null;
		} else if (target === 'down') {
			// Bias gaze downward — paired with concern emote for somber moments.
			this._keystrokePitch = -0.35;
			this._lookTarget = null;
		} else if (target === 'up') {
			this._keystrokePitch = 0.3;
			this._lookTarget = null;
		} else if (target === 'token' && typeof window !== 'undefined') {
			// Token-card reaction direction: glance off-camera to the right
			// where the live-feed UI typically renders (right rail).
			this._keystrokeYaw = 0.4;
			this._lookTarget = null;
		}
		this._injectStimulus('curiosity', 0.3);
	}

	_onSkillStart(action) {
		// Skills declare a hint, not a clip name (`animationHint: 'inspect'`).
		// Feeding the raw hint to _triggerOneShot only ever matched a clip
		// embedded in the GLB, so the two most common hints in the whole skill
		// catalog (`inspect` and `gesture`) silently no-op'd on every
		// library-driven avatar. Route hints through the slot vocabulary
		// instead: it resolves to a baked clip and honours agent overrides.
		const slot = resolveHint(action.payload?.animationHint);
		if (slot) this._playSlot(slot, 1.0);
		this._injectStimulus('patience', 0.4);
	}

	_onSkillDone(action) {
		const result = action.payload?.result;
		if (result?.sentiment !== undefined) {
			if (result.sentiment > 0.3) this._injectStimulus('celebration', result.sentiment * 0.8);
			else if (result.sentiment < -0.2)
				this._injectStimulus('concern', Math.abs(result.sentiment) * 0.7);
		} else {
			this._injectStimulus('celebration', 0.4);
		}
		this._errorStreak = 0;
	}

	_onSkillError(_action) {
		this._errorStreak++;
		const empathyWeight = Math.min(this._errorStreak * 0.25, 0.9);
		this._injectStimulus('concern', 0.7);
		this._injectStimulus('empathy', empathyWeight);
	}

	_onLoadStart(_action) {
		this._injectStimulus('patience', 0.6);
		this._injectStimulus('curiosity', 0.3);
		this._playSlot('think', 2.0);
	}

	_onLoadEnd(action) {
		if (action.payload?.error) {
			this._injectStimulus('concern', 0.8);
		} else {
			this._injectStimulus('celebration', 0.7);
			this._injectStimulus('curiosity', 0.5);
			this._playSlot('nod', 1.0);
		}
	}

	_onValidate(action) {
		const errors = action.payload?.errors || 0;
		const warnings = action.payload?.warnings || 0;
		if (errors > 0) {
			this._injectStimulus('concern', Math.min(0.4 + errors * 0.1, 0.95));
			this._errorStreak++;
		} else if (warnings > 0) {
			this._injectStimulus('concern', 0.3);
		} else {
			this._injectStimulus('celebration', 0.85);
			this._playSlot('celebrate', 1.5);
		}
	}

	_onInterrupted() {
		this._triggerOneShot('startle', 0.6);
		this._emotion.patience = 0;
		this._injectStimulus('curiosity', 0.5);
		// Morph impulse — lerps back to emotion-driven values on next tick
		this._setMorphTarget('browInnerUp', 0.9);
		this._setMorphTarget('mouthOpen', 0.3);
	}

	// ── Empathy Layer — The Novel Part ────────────────────────────────────────

	/**
	 * Inject a stimulus into the emotion state.
	 * Uses additive blending — stimuli accumulate, then decay.
	 * @param {string} emotion — one of the DECAY keys
	 * @param {number} weight  — 0..1
	 */
	_injectStimulus(emotion, weight) {
		if (!(emotion in this._emotion)) return;
		this._emotion[emotion] = Math.min(1.0, this._emotion[emotion] + weight);
		// Neutral inversely reflects total arousal
		this._normaliseNeutral();
	}

	_normaliseNeutral() {
		const sum = Object.keys(DECAY).reduce((acc, k) => acc + this._emotion[k], 0);
		this._emotion.neutral = Math.max(0, 1 - sum);
	}

	/**
	 * Per-frame emotion decay + avatar rendering.
	 * Called by viewer._afterAnimateHooks every animation frame.
	 * @param {number} dt — delta time in seconds
	 */
	_tickEmotion(dt) {
		// Stage 1: Decay all non-neutral emotions
		for (const [key, rate] of Object.entries(DECAY)) {
			this._emotion[key] = Math.max(0, this._emotion[key] - rate * dt);
		}
		this._normaliseNeutral();

		// Decay _agentThinking flag after 3 s
		if (this._agentThinking) {
			this._agentThinkTimer += dt;
			if (this._agentThinkTimer >= 3.0) this._agentThinking = false;
		}

		// Stage 2: One-shot gesture timer
		if (this._isPlayingOneShot) {
			this._oneShotTimer += dt;
			if (this._oneShotTimer >= this._oneShotDuration) {
				this._isPlayingOneShot = false;
				this._oneShotTimer = 0;
			}
		}

		// Stage 2b: Advance a performing routine. Runs after the one-shot timer so
		// a step whose gesture just expired is replaced on the same frame.
		this._routinePlayer?.update(dt);

		// Stage 3: Emotion-threshold gesture triggers (routed through slot map).
		// A routine outranks them: an owner who composed a performance did not ask
		// for a stray celebrate to cut into it at the seam between two steps.
		if (!this._isPlayingOneShot && !this._routinePlayer) {
			const w = this._emotion;
			if (w.celebration > 0.6) {
				this._playSlot('celebrate', 2.0);
			} else if (w.concern > 0.6) {
				this._playSlot('concern', 2.0);
			} else if (w.curiosity > 0.6) {
				this._playSlot('think', 1.5);
			} else if (this._mood.active) {
				// Stage 3.5: sustained-mood gesture bias. Stage 3 above reacts to
				// momentary emotion *spikes* (an error just happened, a task just
				// finished); this reacts to the agent's *resting* mood — the same
				// valence/arousal state that drives the facial mood layer in
				// _applyMoodLayer(). Only engages once nothing else already claims
				// the one-shot slot (the `else` above), so a live event always wins.
				// Routes through the same `_playSlot` → `resolveSlot` path as every
				// other gesture, so `meta.edits.animations` overrides still apply and
				// an unregistered clip name can never be selected.
				const { valence, arousal } = this._moodApplied;
				if (
					valence > MOOD_GESTURE_THRESHOLD.positiveValence &&
					arousal > MOOD_GESTURE_THRESHOLD.energeticArousal
				) {
					// Sustained up + energetic mood → lively, energetic body language.
					this._playSlot('celebrate', 2.5);
				} else if (
					valence < -MOOD_GESTURE_THRESHOLD.positiveValence &&
					arousal < MOOD_GESTURE_THRESHOLD.calmArousal
				) {
					// Sustained down + subdued mood → concerned stillness — the
					// opposite bias, never the energetic gesture.
					this._playSlot('concern', 2.5);
				}
			}
		}

		// Stage 4: Apply emotion to avatar
		this._applyEmotionToAvatar(dt);

		// Stage 5: Live-audio lipsync (ElevenLabs path).
		// Sample the AnalyserNode once and branch on the avatar's detected
		// lipsync mode so non-ARKit rigs (no viseme morphs) still move the jaw.
		if (this._lipSync) {
			const visemes = this._lipSync.sample();
			if (visemes) {
				if (this._lipsyncMode === 'visemes') {
					for (const [name, weight] of Object.entries(visemes)) {
						this._setMorphTarget(name, weight);
					}
					// Suppress the flat mouthOpen talk-hint while real visemes drive the mouth.
					this._setMorphTarget('mouthOpen', 0);
				} else if (this._lipsyncMode === 'jaw') {
					// No visemes on this rig — drive jawOpen straight from the
					// smoothed amplitude so the mouth still moves to speech.
					// 1.8x to push 0..~0.55 average speech amplitude up to a
					// visible open; clamped in _setMorphTarget.
					const amp = this._lipSync.getAmplitude();
					this._setMorphTarget('jawOpen', amp * 1.8);
				}
				// _lipsyncMode === 'none' → no morph path available; the existing
				// talk-hint mouthOpen on _onSpeak is the best we can do for this rig.
			}
		}

		// BEGIN:IDLE_LOOP_TICK
		this._idle?.update(dt);
		// END:IDLE_LOOP_TICK
	}

	/**
	 * Render the current emotional state onto the avatar mesh.
	 * Gracefully no-ops if morph targets or head bone don't exist.
	 */
	_applyEmotionToAvatar(dt) {
		const w = this._emotion;

		// ── Morph target targets ──────────────────────────────────────────
		// The Empathy Layer blends ALL emotions simultaneously —
		// not a discrete switch, a continuous weighted blend.
		this._setMorphTarget('mouthSmile', w.celebration * 0.85);
		this._setMorphTarget(
			'mouthOpen',
			w.celebration * 0.2 +
				(this._isPlayingOneShot && this._oneShotAction === 'talk' ? 0.4 : 0),
		);
		this._setMorphTarget('mouthFrown', w.concern * 0.55);
		this._setMorphTarget('mouthPressLeft', w.uncertain * 0.35);
		this._setMorphTarget('mouthPressRight', w.uncertain * 0.35);
		this._setMorphTarget(
			'browInnerUp',
			Math.max(w.concern * 0.6, w.uncertain * 0.45, w.empathy * 0.5),
		);
		this._setMorphTarget('browOuterUpLeft', w.curiosity * 0.7);
		this._setMorphTarget('browOuterUpRight', w.curiosity * 0.5);
		this._setMorphTarget('eyeSquintLeft', w.empathy * 0.4);
		this._setMorphTarget('eyeSquintRight', w.empathy * 0.4);
		this._setMorphTarget('eyesClosed', w.patience * 0.15); // slight, not full
		this._setMorphTarget('cheekPuff', w.celebration * 0.2);
		this._setMorphTarget('noseSneerLeft', w.concern * 0.15);
		this._setMorphTarget('noseSneerRight', w.concern * 0.15);

		// ── Sustained mood layer ─────────────────────────────────────────
		// The resting expression. Added on top of the transient targets above so
		// a calm-positive agent keeps a soft smile between events, an agitated one
		// a worried brow. Lerped slowly so mood shifts read as drifts, not cuts.
		if (this._mood.active) this._applyMoodLayer(dt);

		// ── Lerp morph influences to targets ─────────────────────────────
		const lerpSpeed = dt * 4.0; // smooth interpolation, not snapping
		this._lerpMorphTargets(lerpSpeed);

		// Propagate uncertainty to idle animation (modulates hip drift amplitude)
		this._idle?.setUncertainty(w.uncertain);

		// ── Head tilt (curiosity + empathy both tilt the head) ────────────
		this._targetTilt = (w.curiosity * 12 + w.empathy * 9 + w.concern * 4) * DEG2RAD;

		// Gaze bias — overrides emotion-derived tilt
		if (this._userSpeaking) {
			this._targetTilt = 0.04; // slight upward attentive posture
			this._idle?.setPauseSaccade(true);
		} else if (this._agentThinking || w.patience > 0.3) {
			this._targetTilt = -0.06; // look slightly down when thinking / waiting
		}

		// Sustained mood nudges the gaze (elated lifts it, subdued lowers it).
		if (this._mood.active) this._targetTilt += this._moodTilt || 0;

		this._currentTilt = _lerp(this._currentTilt, this._targetTilt, dt * 3.0);

		// ── Forward lean (curiosity leans in, patience leans back) ────────
		this._targetLean = w.curiosity * 0.03 - w.patience * 0.02;
		// Sustained mood leans the body in when up-and-alert, back when subdued.
		if (this._mood.active) this._targetLean += this._moodLean || 0;
		const _followMode = this.viewer.state?.followMode;
		if (_followMode === 'mouse') {
			// Mouse Y: -1 = top of canvas (look up), +1 = bottom (look down)
			this._targetLean += this._mouseGaze.y * (12 * DEG2RAD);
		} else if (_followMode === 'keystrokes') {
			this._targetLean += this._keystrokePitch;
			this._keystrokePitch = Math.max(0, this._keystrokePitch - dt * 0.9);
			this._keystrokeYaw = _lerp(this._keystrokeYaw, 0, dt * 0.6);
		} else {
			// Decay any residual follow-mode values if mode was switched off
			this._keystrokePitch = 0;
			this._keystrokeYaw = _lerp(this._keystrokeYaw, 0, dt * 2.0);
			this._mouseGaze.x = _lerp(this._mouseGaze.x, 0, dt * 2.0);
			this._mouseGaze.y = _lerp(this._mouseGaze.y, 0, dt * 2.0);
		}
		this._currentLean = _lerp(this._currentLean, this._targetLean, dt * 2.0);

		this._applyHeadTransform();
		this._applyLookTarget(dt);
		this._trackBodyToCamera(dt);
	}

	/**
	 * Aim the chest/neck/head chain at `_lookTarget` with procedural IK
	 * (src/procedural/look-at.js), layered on top of the pose _applyHeadTransform
	 * just set. This is what makes `setLookTarget()` and the LOOK_AT protocol
	 * action's `target: 'model'` branch actually move the avatar — before this,
	 * the target was stored and never read.
	 *
	 * Distributing the turn across three joints is why this is IK and not another
	 * head-bone Euler write: a 50-degree turn on the head bone alone reads as an
	 * owl; split 15/30/55 across chest, neck, and head it reads as a person. A rig
	 * with no mappable head reports enabled=false and this is a no-op.
	 */
	_applyLookTarget(dt) {
		const content = this.viewer?.content;
		if (!content) return;
		// Rebuild on avatar swap — the controller caches resolved bones.
		if (this._lookIkFor !== content) {
			this._lookIkFor = content;
			const ik = new LookAtController(content);
			this._lookIk = ik.enabled ? ik : null;
		}
		if (!this._lookIk) return;
		let target = this._lookTarget;
		const cam = this.viewer?.activeCamera;
		if (!target && this._lookAtCamera && cam) {
			target = cam.getWorldPosition(_lookScratch);
		}
		this._lookIk.setTarget(target);
		this._lookIk.update(dt);
	}

	// ── Morph Target Helpers ─────────────────────────────────────────────────

	/**
	 * Set the *target* influence for a named morph target.
	 * Actual mesh influence is lerped in _lerpMorphTargets().
	 */
	_setMorphTarget(name, targetWeight) {
		this._morphTarget[name] = Math.max(0, Math.min(1, targetWeight));
		if (!(name in this._morphCurrent)) this._morphCurrent[name] = 0;
	}

	/** Add to an already-set morph target (used to layer mood over emotion). */
	_addMorph(name, delta) {
		if (!delta) return;
		this._setMorphTarget(name, (this._morphTarget[name] || 0) + delta);
	}

	/**
	 * Apply the sustained mood as a continuous facial bias. Lerps the applied
	 * mood toward the target so a mood change drifts in over ~1s rather than
	 * snapping. Arousal is read relative to the calm baseline (~0.4): above it
	 * the eyes widen and brows lift (alert); below it the lids grow heavy
	 * (relaxed). Valence sets the mouth: a soft smile when positive, a frown +
	 * inner-brow worry when negative.
	 */
	_applyMoodLayer(dt) {
		const m = this._moodApplied;
		const k = Math.min(1, dt * 1.2);
		m.valence += (this._mood.valence - m.valence) * k;
		m.arousal += (this._mood.arousal - m.arousal) * k;

		const pos = Math.max(0, m.valence);
		const neg = Math.max(0, -m.valence);
		const act = Math.max(0, m.arousal - 0.4); // alertness above baseline
		const rest = Math.max(0, 0.4 - m.arousal); // drowsiness below baseline

		this._addMorph('mouthSmile', pos * 0.4);
		this._addMorph('cheekSquintLeft', pos * 0.18);
		this._addMorph('cheekSquintRight', pos * 0.18);
		this._addMorph('mouthFrown', neg * 0.4);
		this._addMorph('browInnerUp', neg * 0.4);
		this._addMorph('eyeWideLeft', act * 0.5);
		this._addMorph('eyeWideRight', act * 0.5);
		this._addMorph('browOuterUpLeft', act * 0.28);
		this._addMorph('browOuterUpRight', act * 0.28);
		this._addMorph('eyesClosed', rest * 0.3);

		// Posture: mood leans the body in/out and lifts/drops the gaze. Dropped
		// under prefers-reduced-motion — the facial cue above still carries it.
		if (!this._mood.reduced) {
			this._moodTilt = pos * act * 0.04 - neg * rest * 0.06;
			this._moodLean = pos * act * 0.03 - neg * rest * 0.02;
		} else {
			this._moodTilt = 0;
			this._moodLean = 0;
		}
	}

	/**
	 * Resolve canonical ARKit-52 names to their concrete mesh slots once per
	 * content load. The resolver understands the canonical names plus the
	 * MORPH_ALIASES synonyms (snake_case, _L/_R suffixes, combined shapes),
	 * so emotion code can refer to `mouthSmileLeft` and have it work on RPM,
	 * Avaturn, Mixamo, and custom Blender exports alike.
	 */
	_buildMorphCache() {
		this._morphResolved = new Map();
		this._lipsyncMode = 'none';
		if (!this.viewer?.content) return;
		this._morphResolved = resolveMorphTargets(this.viewer.content);

		// Determine the best lipsync rendering path for this avatar:
		//   'visemes' — at least one ARKit viseme morph exists; drive per-viseme
		//               weights from the spectral analyser
		//   'jaw'     — no visemes but jawOpen (or aliased mouthOpen) exists;
		//               drive a single morph from overall amplitude
		//   'none'    — neither; lipsync is a no-op on this rig
		const hasVisemes = ARKIT_VISEMES.some((n) => this._morphResolved.has(n));
		if (hasVisemes) this._lipsyncMode = 'visemes';
		else if (this._morphResolved.has('jawOpen')) this._lipsyncMode = 'jaw';
		else this._lipsyncMode = 'none';
	}

	/**
	 * Lerp all tracked morph target influences toward their targets. Names in
	 * `_morphTarget` are canonical ARKit-52 (or one of the recognized aliases);
	 * the resolver mapped each to one or more concrete mesh slots at load time.
	 */
	_lerpMorphTargets(speed) {
		if (!this._morphResolved || this._morphResolved.size === 0) return;
		for (const [name, target] of Object.entries(this._morphTarget)) {
			const canonical = MORPH_ALIASES[name] || name;
			const slots = this._morphResolved.get(canonical);
			if (!slots) continue;
			let current = this._morphCurrent[name] ?? 0;
			const next = _lerp(current, target, speed);
			for (const { mesh, index } of slots) {
				mesh.morphTargetInfluences[index] = next;
			}
			this._morphCurrent[name] = next;

			// Mirror to the symmetric pair when the canonical name carries a
			// 'Left' suffix and emotion code didn't explicitly set the right
			// side — common for combined-shape models.
			if (canonical.endsWith('Left')) {
				const right = canonical.slice(0, -4) + 'Right';
				if (!(right in this._morphTarget)) {
					const rSlots = this._morphResolved.get(right);
					if (rSlots) {
						for (const { mesh, index } of rSlots) {
							mesh.morphTargetInfluences[index] = next;
						}
					}
				}
			}
		}
	}

	// ── Body Yaw ─────────────────────────────────────────────────────────────

	_trackBodyToCamera(dt) {
		const content = this.viewer?.content;
		const cam = this.viewer?.activeCamera?.position;
		if (!content || !cam) return;

		// Snap to current model rotation on first call so there's no initial jump.
		if (this._bodyYaw === null) this._bodyYaw = content.rotation.y;

		// atan2(dx, dz) gives the angle where the model's +Z faces toward the camera.
		const dx = cam.x - content.position.x;
		const dz = cam.z - content.position.z;
		const target = Math.atan2(dx, dz);

		// Shortest-path delta to avoid spinning the long way round.
		let delta = target - this._bodyYaw;
		while (delta > Math.PI) delta -= 2 * Math.PI;
		while (delta < -Math.PI) delta += 2 * Math.PI;

		this._bodyYaw += delta * Math.min(1, dt * 2.0);
		content.rotation.y = this._bodyYaw;
	}

	// ── Head Transform ────────────────────────────────────────────────────────

	// Safety clamps — keep the head within believable neck range.
	// (Input signals are already bounded by design, but belt-and-braces.)
	static HEAD_MAX_YAW = 45 * DEG2RAD;
	static HEAD_MAX_TILT = 25 * DEG2RAD;
	static HEAD_MAX_LEAN = 25 * DEG2RAD;

	_applyHeadTransform() {
		if (!this.viewer?.content) return;

		// Resolve exactly one head bone (or fall back to neck) and snapshot its
		// rest rotation. Any substring match over the whole skeleton would pick
		// up Head + Neck + HeadTop_End simultaneously, and writing the same
		// local rotation to all three stacks hierarchically → owl-style 360.
		if (this._headBoneFor !== this.viewer.content) {
			this._headBoneFor = this.viewer.content;
			this._headBone = this._findHeadBone();
			if (this._headBone) {
				this._headRestRotation = {
					x: this._headBone.rotation.x,
					y: this._headBone.rotation.y,
					z: this._headBone.rotation.z,
				};
			}
		}
		if (!this._headBone) return;

		// Compute yaw target from follow mode
		const followMode = this.viewer.state?.followMode;
		let targetYaw = 0;
		if (followMode === 'mouse') {
			targetYaw = this._mouseGaze.x * (25 * DEG2RAD);
		} else if (followMode === 'keystrokes') {
			targetYaw = this._keystrokeYaw;
		}

		// Gaze bias — highest priority wins
		if (this._userSpeaking) {
			targetYaw = 0; // face camera directly
		} else if (this._agentThinking || this._emotion.patience > 0.3) {
			targetYaw = this._thinkGazeYaw; // look away to think
		}

		this._currentYaw = _lerp(this._currentYaw, targetYaw, 0.08);

		const yaw = MathUtils.clamp(
			this._currentYaw,
			-AgentAvatar.HEAD_MAX_YAW,
			AgentAvatar.HEAD_MAX_YAW,
		);
		const tilt = MathUtils.clamp(
			this._currentTilt,
			-AgentAvatar.HEAD_MAX_TILT,
			AgentAvatar.HEAD_MAX_TILT,
		);
		const lean = MathUtils.clamp(
			this._currentLean,
			-AgentAvatar.HEAD_MAX_LEAN,
			AgentAvatar.HEAD_MAX_LEAN,
		);

		// Apply pre-smoothed values directly — _currentTilt/Lean/Yaw are already
		// dt-lerped above, so a second lerp on the live bone value would fight the
		// animation mixer and cause visible head bobbing.
		const r = this._headRestRotation;
		const b = this._headBone;
		b.rotation.z = r.z + tilt;
		b.rotation.x = r.x + lean;
		b.rotation.y = r.y + yaw;
	}

	/**
	 * Find the single head bone (or neck fallback). Canonicalises common
	 * naming conventions: `Head`, `mixamorigHead`, `Armature:Head`, `rig_Head`,
	 * `CC_Base_Head`. Returns null if neither exists.
	 */
	_findHeadBone() {
		let head = null,
			neck = null;
		this.viewer.content.traverse((node) => {
			if (!node.isBone) return;
			const canon = node.name
				.replace(/^mixamorig/i, '')
				.replace(/^.*[:_]/, '')
				.toLowerCase();
			if (!head && canon === 'head') head = node;
			else if (!neck && canon === 'neck') neck = node;
		});
		return head || neck || null;
	}

	// ── Follow Mode Handlers ──────────────────────────────────────────────────

	_handleMouseMove(e) {
		const rect = this.viewer.el.getBoundingClientRect();
		this._mouseGaze.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		this._mouseGaze.y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
	}

	_handleKeyPress(e) {
		if (this.viewer.state?.followMode !== 'keystrokes') return;
		if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape'].includes(e.key))
			return;

		// Look down toward keyboard
		this._keystrokePitch = 0.18;

		// Lateral drift based on rough key column: left side → look left, right side → look right
		const leftKeys = 'qweasdzxc123`~!@#';
		const rightKeys = 'yuiophjklnm7890-=';
		const k = e.key.toLowerCase();
		if (leftKeys.includes(k)) this._keystrokeYaw = -0.12;
		else if (rightKeys.includes(k)) this._keystrokeYaw = 0.12;

		this._injectStimulus('curiosity', 0.07);
	}

	// ── Gesture / One-shot Animations ────────────────────────────────────────

	/**
	 * Trigger a one-shot animation clip if it exists on the model.
	 * Falls back gracefully if the clip doesn't exist.
	 * @param {string} clipName
	 * @param {number} [duration]
	 */
	_triggerOneShot(clipName, duration = 1.5) {
		this._isPlayingOneShot = true;
		this._oneShotAction = clipName;
		this._oneShotDuration = duration;
		this._oneShotTimer = 0;

		if (!this.viewer?.mixer || !this.viewer?.clips?.length) return;

		// Look for a clip matching the name (case-insensitive partial match)
		const clip = this.viewer.clips.find((c) =>
			c.name.toLowerCase().includes(clipName.toLowerCase()),
		);
		if (!clip) return;

		const action = this.viewer.mixer.clipAction(clip);
		action.reset();
		action.setLoop(2200, 1); // THREE.LoopOnce = 2200
		action.clampWhenFinished = true;
		action.play();
	}

	// ── Sentiment Analysis ────────────────────────────────────────────────────

	/**
	 * Lightweight keyword-based sentiment scoring — runs in browser with no external API.
	 * Returns { valence: -1..1, arousal: 0..1 }
	 */
	_analyzeSentiment(text) {
		const lower = text.toLowerCase();
		const wordSet = new Set(lower.split(/\s+/));
		const total = Math.max(wordSet.size, 1);

		let valence = 0;
		let arousal = 0;

		// Score each emotion bucket — single words use Set for O(1); phrases fall back to includes
		for (const [emotion, keywords] of Object.entries(VOCAB)) {
			let hits = 0;
			for (const kw of keywords) {
				if (kw.includes(' ') ? lower.includes(kw) : wordSet.has(kw)) hits++;
			}
			if (!hits) continue;
			const score = Math.min((hits / total) * 3.0, 1.0);

			if (emotion === 'celebration') valence += score * 0.8;
			if (emotion === 'concern') valence -= score * 0.7;
			if (emotion === 'empathy') valence -= score * 0.3; // empathy feels slightly negative (recognition of pain)
			if (emotion === 'curiosity') arousal += score * 0.9;
			if (emotion === 'patience') arousal += score * 0.3;
		}

		// Punctuation arousal (exclamation = high arousal, question = moderate)
		const exclamations = (text.match(/!/g) || []).length;
		const questions = (text.match(/\?/g) || []).length;
		arousal += Math.min(exclamations * 0.2 + questions * 0.1, 0.5);

		return {
			valence: Math.max(-1, Math.min(1, valence)),
			arousal: Math.max(0, Math.min(1, arousal)),
		};
	}

	/**
	 * Score a single emotion bucket against the text.
	 * Mirrors the per-bucket logic inside _analyzeSentiment.
	 * @param {string} text
	 * @param {string} bucket — key in VOCAB
	 * @returns {number} 0..1
	 */
	_scoreVocab(text, bucket) {
		const keywords = VOCAB[bucket];
		if (!keywords) return 0;
		const lower = text.toLowerCase();
		const wordSet = new Set(lower.split(/\s+/));
		const total = Math.max(wordSet.size, 1);
		let hits = 0;
		for (const kw of keywords) {
			if (kw.includes(' ') ? lower.includes(kw) : wordSet.has(kw)) hits++;
		}
		return Math.min((hits / total) * 3.0, 1.0);
	}

	// ── Utility ───────────────────────────────────────────────────────────────

	_sub(type, handler) {
		this.protocol.on(type, handler);
		this._listeners.push([type, handler]);
	}
}

function _lerp(a, b, t) {
	return a + (b - a) * Math.min(1, Math.max(0, t));
}
