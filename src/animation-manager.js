import {
	AdditiveAnimationBlendMode,
	AnimationClip,
	AnimationMixer,
	AnimationUtils,
	LoopRepeat,
	LoopOnce,
	Quaternion,
	Vector3,
} from 'three';
import { canonicalizeBoneName } from './glb-canonicalize.js';
import {
	canonicalNodeMapFromObject,
	canonicalRestMapFromObject,
	canonicalWorldRestMapFromObject,
	clipHipBaselineY,
	hipGroundLocalY,
	hipRestLocalHeight,
	hipsParentWorldQuat,
	morphTargetMapFromObject,
	retargetClip,
} from './animation-retarget.js';
import { relaxUndrivenArms } from './animation-arm-relax.js';
import { log } from './shared/log.js';

// Past this many degrees off vertical, the rig's Hips have tipped onto their
// back — the catastrophic "lying down" retarget failure. The bind-correction in
// animation-retarget.js keeps every healthy rig's at-rest Hips under ~18°
// (measured across cz + michelle × the featured clips, locked in
// tests/animation-upright-invariant.test.js), so 45° is a generous catastrophe
// floor that only ever trips a genuinely broken retarget, never a healthy one
// (dance, the most hip-led clip, peaks at ~30° mid-clip but rests near 18°).
const CATASTROPHE_TILT_DEG = 45;

// Reused scratch so the guard's once-per-clip measurement allocates nothing.
const _worldUp = new Vector3();
const _wq = new Quaternion();
const _UP = new Vector3(0, 1, 0);

/**
 * At-rest Hips tilt (degrees off world vertical) a retargeted clip would impose
 * on a model — the same world-matrix reconstruction the lying-down bug was
 * diagnosed with, but evaluated from the clip's first Hips keyframe so it costs
 * nothing per frame. Sets the Hips bone to the clip's keyframe-0 rotation,
 * composes world matrices, and measures the angle between the bone's world
 * up-axis and vertical. Restores the bone afterwards so it's side-effect free.
 * Returns null when there's nothing to measure (no Hips, no quaternion track),
 * which callers treat as "can't assess" — never as a failure.
 *
 * @param {THREE.AnimationClip|null} retargetedClip clip already renamed to the rig's nodes
 * @param {THREE.Object3D|null} model the attached rig (world matrices may be stale)
 * @param {Map<string,string>|null} canonicalToNode canonical bone → rig node name
 * @returns {number|null} degrees off vertical, or null
 */
export function measureHipsTiltDeg(retargetedClip, model, canonicalToNode) {
	if (!retargetedClip || !model || !canonicalToNode) return null;
	const hipsName = canonicalToNode.get('Hips');
	if (!hipsName) return null;
	const hips = model.getObjectByName(hipsName);
	if (!hips) return null;
	const qTrack = retargetedClip.tracks.find((t) => t.name === `${hipsName}.quaternion`);
	if (!qTrack || qTrack.values.length < 4) return null;

	const v = qTrack.values;
	const restX = hips.quaternion.x;
	const restY = hips.quaternion.y;
	const restZ = hips.quaternion.z;
	const restW = hips.quaternion.w;

	hips.quaternion.set(v[0], v[1], v[2], v[3]);
	hips.updateWorldMatrix(true, false);
	hips.getWorldQuaternion(_wq);
	_worldUp.copy(_UP).applyQuaternion(_wq);

	// Restore the authored rest so the measurement leaves no trace; the mixer
	// drives the real pose from here on.
	hips.quaternion.set(restX, restY, restZ, restW);
	hips.updateWorldMatrix(true, false);

	const dot = Math.max(-1, Math.min(1, _worldUp.dot(_UP)));
	return (Math.acos(dot) * 180) / Math.PI;
}

// Minimum number of canonical bones a skinned model must expose before the
// pre-baked clip library can drive it meaningfully. The clips address tracks by
// canonical Avaturn bone names; a model sharing only a stray bone or two would
// twitch a single joint rather than perform the motion. Eight covers the torso
// + a limb, which is enough to read as a real humanoid performance.
const MIN_CANONICAL_BONES = 8;

// Canonical bones that belong to the lower body. When a gesture plays as an
// upper-body overlay (so the avatar can wave while it keeps walking), every
// track addressing one of these bones is stripped from the additive clip — the
// base locomotion layer owns the hips, legs, and feet; the overlay only adds
// motion to the spine, arms, neck, and head. Hips is included so the overlay
// never fights the walk cycle's root sway.
const LOWER_BODY_CANONICAL = Object.freeze([
	'Hips',
	'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
	'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
]);

/**
 * Manages pre-baked animation clips for skinned agents.
 *
 * Clips are authored at build time (scripts/build-animations.mjs):
 *   - Mixamo FBX → retargeted to canonical Avaturn skeleton → JSON
 *   - No FBXLoader or retargeting in the browser; just fetch + parse.
 *
 * Usage:
 *   const mgr = new AnimationManager();
 *   mgr.attach(skinnedModel);
 *   await mgr.loadAll();   // reads manifest, fetches clips lazily on first play
 *   mgr.play('idle');
 *   mgr.crossfadeTo('dance', 0.4);
 */

const DEFAULT_CROSSFADE = 0.35; // seconds

export class AnimationManager {
	constructor() {
		/** @type {THREE.Object3D|null} */
		this.model = null;
		/** @type {AnimationMixer|null} */
		this.mixer = null;
		/** @type {Map<string, THREE.AnimationClip>} */
		this.clips = new Map();
		/** @type {Map<string, THREE.AnimationAction>} */
		this.actions = new Map();
		/** @type {string|null} */
		this.currentName = null;
		/** @type {THREE.AnimationAction|null} */
		this.currentAction = null;
		/** @type {Function|null} Fired with the new clip name (or null) on every change. */
		this.onChange = null;
		/** @type {Array<{name:string, url:string, label:string, icon:string, loop:boolean}>} */
		this._animationDefs = [];
		/** @type {Set<string>} Clip names that failed to load — buttons grayed out in UI. */
		this._failed = new Set();
		/** @type {Map<string,string>|null} canonical bone → actual node name on the attached model. */
		this._canonicalToNode = null;
		/** @type {boolean} Whether the attached model's rig can play the canonical clip library. */
		this._canonicalClipsSupported = false;
		/** @type {{ avatarId?: string, avatarUrl?: string }} Context for the fallen-pose guard's reports. */
		this._avatarContext = {};
		/** @type {Set<string>} `${avatarUrl}|${clip}` keys whose fallen-pose has already been reported (debounce). */
		this._fallenReported = new Set();
		/** @type {Set<string>} Clip names disabled because they retargeted to a fallen pose on this rig. */
		this._fallen = new Set();
		/** @type {string|null} Name of the most-recently-requested crossfade target. Used to cancel stale async requests. */
		this._latestCrossfadeTarget = null;
		/** @type {THREE.AnimationAction|null} The additive upper-body overlay action (gesture-over-walk), if any. */
		this.overlayAction = null;
		/** @type {string|null} Name of the active overlay gesture clip. */
		this.overlayName = null;
		/** @type {Map<string, THREE.AnimationClip>} Cache of built additive overlay clips, keyed by `${name}|${upperBodyOnly}`. */
		this._overlayClips = new Map();
		/** @type {Function|null} mixer 'finished' listener for the current one-shot overlay. */
		this._overlayFinishHandler = null;
		/** @type {Function|null} mixer 'finished' listener for the settle-to-idle after a playOnce. */
		this._settleFinishHandler = null;
	}

	/**
	 * Tell the manager which avatar is attached so the fallen-pose guard can
	 * report actionable context. Both fields are optional; url alone is enough.
	 * @param {{ avatarId?: string, avatarUrl?: string }} ctx
	 */
	setAvatarContext(ctx) {
		this._avatarContext = ctx && typeof ctx === 'object' ? { ...ctx } : {};
	}

	// ── Model binding ──────────────────────────────────────────────────────────

	/**
	 * Attach to a loaded model. Call this every time a new model is loaded.
	 * Re-creates actions for any clips that are already in memory.
	 * @param {THREE.Object3D} model
	 * @param {{ avatarId?: string, avatarUrl?: string }} [context] avatar id/url for the fallen-pose guard
	 */
	attach(model, context) {
		this.detach();
		if (context) this.setAvatarContext(context);
		this.model = model;
		this.mixer = new AnimationMixer(model);
		this.actions.clear();
		this.currentAction = null;
		this.currentName = null;
		this._fallen.clear();
		// Build the canonical→node map once. Every clip is retargeted through it,
		// so the library drives ANY humanoid rig — Mixamo, VRM-via-Mixamo,
		// CharacterStudio, Blender — not just an already-canonical Avaturn rig.
		this._canonicalToNode = canonicalNodeMapFromObject(model);
		// Captured here, while the model is still in its authored bind pose, so
		// the retargeter can re-express each clip in the rig's own rest frame
		// (a Mixamo rig bakes the up-axis as a −90°X Hips rest the clips would
		// otherwise overwrite, tipping the avatar onto its back).
		this._canonicalRest = canonicalRestMapFromObject(model);
		// World-frame companion to _canonicalRest, captured in the same bind pose.
		// Supplying it lets the retargeter use the world-delta-preserving correction
		// (L = Rt·WT⁻¹·WS·Rs⁻¹) instead of the local-only premultiply fallback, which
		// skews an A-pose clip's limbs ~30° on a T-pose rig. Matches the server
		// (retargetClipToObject) and rig (retargetClipToRig) paths.
		this._canonicalWorldRest = canonicalWorldRestMapFromObject(model);
		// World rotation of the Hips' parent (within the model), so root motion is
		// re-expressed in the rig's own frame and travels the right way on any rig.
		this._hipsParentWorldQuat = hipsParentWorldQuat(model);
		// Blendshapes this avatar carries, so a clip's face lanes (the non-manual
		// markers a signed question needs) can be re-pointed at its own meshes. An
		// avatar with no face shapes simply gets no face lanes.
		this._morphTargets = morphTargetMapFromObject(model);
		// Rest height of the Hips in the parent's local units (metres for a
		// metre-native rig, ~100 for a centimetre-scale Mixamo armature). Hip
		// tracks set the Hips' *local* position, so _retarget scales each clip by
		// this ÷ the clip's authored baseline — without it a 0.01-scaled rig's
		// hips collapse to the floor (metre-valued track × 0.01 parent ≈ 1cm).
		this._hipTargetLocalY = hipRestLocalHeight(model);
		// Where this rig's floor sits in the hips-parent's local frame (0 for a
		// ground-native export). The retarget adds it to the hip track so the
		// clip's ground lands on the model's actual ground.
		this._hipGroundLocalY = hipGroundLocalY(model);
		this._canonicalClipsSupported = _modelSupportsCanonicalClips(model);

		for (const [name, clip] of this.clips) {
			const bound = this._retarget(clip);
			if (!bound) continue;
			const action = this.mixer.clipAction(bound);
			action.enabled = true;
			this.actions.set(name, action);
		}
	}

	/**
	 * Re-measure the height-dependent retarget inputs and rebuild every bound
	 * action. Call after a skeleton-space proportion edit (leg length, stature,
	 * foot size: see src/avatar-proportions.js) has moved the rig's hips.
	 *
	 * A clip's hip translation is authored around one hip height and rescaled
	 * onto the rig's actual height at attach time. Lengthen the legs and that
	 * factor is stale: the root travels the old distance while longer legs cover
	 * more ground per stride, and the avatar foot-slides. Re-measuring and
	 * re-retargeting fixes the stride without re-attaching, which matters because
	 * attach() also re-captures the rest frames: and those must be read in the
	 * bind pose, which a mid-animation rig is not in.
	 *
	 * Safe precisely because proportions never touch bone *rotations*: the
	 * captured local/world rest rotations, the canonical→node map and the morph
	 * map all stay valid. The caller must have the rig at rest when it calls
	 * (applyProportionsToRoot leaves it there).
	 *
	 * @returns {boolean} true when the rig was re-measured
	 */
	remeasureRigProportions() {
		if (!this.model || !this.mixer) return false;
		const resume = this.currentName;
		this._hipTargetLocalY = hipRestLocalHeight(this.model);
		this._hipGroundLocalY = hipGroundLocalY(this.model);

		this.mixer.stopAllAction();
		for (const action of this.actions.values()) {
			const clip = action.getClip?.();
			if (clip) this.mixer.uncacheClip(clip);
		}
		this.actions.clear();
		this.currentAction = null;
		this.currentName = null;
		this._latestCrossfadeTarget = null;
		// Overlays are built from the old retarget too, so drop the cache and let
		// the next gesture rebuild against the new proportions.
		this.overlayAction = null;
		this.overlayName = null;
		this._overlayClips.clear();
		this._detachOverlayFinish?.();

		for (const [name, clip] of this.clips) {
			const bound = this._retarget(clip);
			if (!bound) continue;
			const action = this.mixer.clipAction(bound);
			action.enabled = true;
			this.actions.set(name, action);
		}
		if (resume && this.actions.has(resume)) this.play(resume);
		return true;
	}

	/**
	 * Retarget a canonical-skeleton library clip onto the attached model's actual
	 * bone names. Returns null when the rig shares too few bones to perform the
	 * motion (a static prop, a non-humanoid rig), so callers skip building a dead
	 * action. A clip whose tracks already match the rig 1:1 round-trips unchanged.
	 * @param {THREE.AnimationClip} clip
	 * @returns {THREE.AnimationClip|null}
	 */
	_retarget(clip) {
		if (!this._canonicalToNode || this._canonicalToNode.size === 0) return null;
		// Scale the clip's hip translation into the rig's local frame. For a
		// metre-native rig this is ≈1 (no-op); for a centimetre-scale armature it
		// is ~100, which is what keeps the dancer standing on the stage instead of
		// sinking a metre through it. Clamped so a degenerate baseline can't fling
		// the root away.
		let hipScale = 1;
		const baseline = clipHipBaselineY(clip);
		if (this._hipTargetLocalY > 0.05 && baseline > 0.05) {
			hipScale = Math.min(200, Math.max(0.2, this._hipTargetLocalY / baseline));
		}
		const { clip: out } = retargetClip(clip, this._canonicalToNode, {
			targetRest: this._canonicalRest,
			targetWorldRest: this._canonicalWorldRest,
			hipsParentWorldQuat: this._hipsParentWorldQuat,
			morphTargets: this._morphTargets,
			hipScale,
			hipOffsetY: this._hipGroundLocalY || 0,
		});
		return out;
	}

	/**
	 * Runtime "fallen pose" guard. Before an action plays, sample the at-rest Hips
	 * world up-axis the retargeted clip would impose. If it tips past
	 * CATASTROPHE_TILT_DEG the retarget failed (the rig would lie on its back), so
	 * we disable that action, leave the rig in its authored bind pose — the same
	 * fallback the viewer already prefers over a broken retarget — and report once
	 * through the existing client-error channel with enough context to diagnose.
	 * Sampled once per (avatar, clip), never per frame.
	 *
	 * @param {string} name clip name
	 * @param {THREE.AnimationAction} action
	 * @returns {boolean} true if the clip is safe to play; false if it was rejected
	 */
	_guardAgainstFallenPose(name, action) {
		if (this._fallen.has(name)) return false;
		const clip = action?.getClip?.();
		const tiltDeg = measureHipsTiltDeg(clip, this.model, this._canonicalToNode);
		// NaN means the measurement couldn't complete (degenerate world matrix, missing
		// bone quaternion, etc.) — treat as safe rather than incorrectly flagging the
		// clip as fallen. NaN comparisons are always false, so without this check a NaN
		// would fall through the guard and falsely reject the clip.
		if (tiltDeg == null || !Number.isFinite(tiltDeg) || tiltDeg <= CATASTROPHE_TILT_DEG) return true;

		// Reject: stop and disable the action, drop it so it can't be selected
		// again, and fall back to the authored bind pose (do not play the broken
		// clip). If it was the current action, clear playback state.
		try {
			action.stop();
		} catch (e) {
			log.warn('[AnimationManager] failed to stop fallen-pose action:', e);
		}
		action.enabled = false;
		this.actions.delete(name);
		this._fallen.add(name);
		if (this.currentAction === action) {
			this.currentAction = null;
			this.currentName = null;
		}

		const avatarUrl = this._avatarContext.avatarUrl || '';
		const avatarId = this._avatarContext.avatarId || '';
		const dedupeKey = `${avatarId || avatarUrl}|${name}`;
		if (!this._fallenReported.has(dedupeKey)) {
			this._fallenReported.add(dedupeKey);
			log.warn(
				`[AnimationManager] "${name}" retargeted to a fallen pose (${tiltDeg.toFixed(1)}° off vertical) — falling back to bind pose`,
			);
			reportFallenPose({
				avatarId,
				avatarUrl,
				clip: name,
				tiltDeg: Math.round(tiltDeg * 10) / 10,
			});
		}
		return false;
	}

	/** Detach, stop all actions, dispose mixer. */
	detach() {
		if (this.mixer) {
			this.mixer.stopAllAction();
			this.mixer.uncacheRoot(this.mixer.getRoot());
			this.mixer = null;
		}
		this.model = null;
		this._canonicalToNode = null;
		this._canonicalRest = null;
		this._canonicalWorldRest = null;
		this._hipsParentWorldQuat = null;
		this._morphTargets = null;
		this._hipTargetLocalY = 0;
		this._hipGroundLocalY = 0;
		this._canonicalClipsSupported = false;
		this.actions.clear();
		this.currentAction = null;
		this.currentName = null;
		this._latestCrossfadeTarget = null;
		this._fallen.clear();
		// Overlay clips are retargeted to the (now-gone) model's bones — drop them
		// so a freshly-attached rig rebuilds its own.
		this.overlayAction = null;
		this.overlayName = null;
		this._overlayClips.clear();
		this._overlayFinishHandler = null;
	}

	// ── Definitions ────────────────────────────────────────────────────────────

	/**
	 * Register animation definitions (from manifest.json).
	 * @param {Array<{name:string, url:string, label?:string, icon?:string, loop?:boolean}>} defs
	 */
	setAnimationDefs(defs) {
		this._animationDefs = defs;
	}

	/**
	 * Append additional defs (e.g. user/public clips from the API) without
	 * replacing the manifest-sourced ones. Skips defs whose name is already
	 * registered to avoid duplicates when called multiple times.
	 * @param {Array<{name:string, url:string, label?:string, icon?:string, loop?:boolean}>} defs
	 */
	appendAnimationDefs(defs) {
		const existing = new Set(this._animationDefs.map((d) => d.name));
		for (const def of defs) {
			if (!existing.has(def.name)) {
				this._animationDefs.push(def);
				existing.add(def.name);
			}
		}
	}

	/** @returns {Array} */
	getAnimationDefs() {
		return this._animationDefs;
	}

	/** @param {string} name @returns {boolean} */
	isFailed(name) {
		return this._failed.has(name);
	}

	/**
	 * Whether the currently attached model can be driven by the pre-baked
	 * canonical clip library. True only for a skinned humanoid whose skeleton
	 * shares enough bones with the canonical Avaturn rig that a retargeted clip
	 * actually moves it. A static mesh (no skeleton) or a non-humanoid rig
	 * returns false, so callers can hide animation affordances that would
	 * otherwise play to no visible effect.
	 * @returns {boolean}
	 */
	supportsCanonicalClips() {
		return this._canonicalClipsSupported;
	}

	/**
	 * Guard against frozen T-pose arms. When the attached rig's upper-arm bones
	 * could NOT be name-mapped, the retargeted clip drives the torso and legs but
	 * leaves both arms stuck out at the authored bind pose. Swing those un-driven
	 * arms down to a relaxed rest so the avatar never reads as broken. No-op when
	 * the arms name-mapped (the clip already drives them) or no model is attached.
	 * Call once, after attach() and before the first play/crossfade.
	 * @returns {number} arms relaxed (0, 1, or 2)
	 */
	relaxUndrivenArms() {
		if (!this.model) return 0;
		return relaxUndrivenArms(this.model, this._canonicalToNode);
	}

	/**
	 * Whether a named clip can actually be driven on the attached rig: it's
	 * either already loaded, or registered in the defs and not yet known to
	 * have failed. Lets callers (e.g. the paid club stage) drop un-performable
	 * steps from a routine before playback instead of crossfading to a silent
	 * no-op and leaving the avatar frozen.
	 * @param {string} name
	 * @returns {boolean}
	 */
	canPlay(name) {
		// A clip already rejected by the fallen-pose guard must not pass this
		// filter — it would make club.js route a routine step to it, then silently
		// no-op the crossfade, leaving the dancer frozen for the full step duration.
		if (this._fallen.has(name)) return false;
		if (this.clips.has(name)) return true;
		if (this._failed.has(name)) return false;
		return this._animationDefs.some((d) => d.name === name);
	}

	// ── Loading ────────────────────────────────────────────────────────────────

	/**
	 * Load a single clip from a pre-baked JSON URL and register it.
	 * Idempotent — returns the cached clip if already loaded.
	 *
	 * Handles two response shapes:
	 *  - Static clip JSON:  { name, duration, tracks }  (manifest clips)
	 *  - API clip response: { clip: { clip: { name, duration, tracks } } }
	 *    (/api/animations/clips/:id — detected by URL containing /api/animations/)
	 *
	 * @param {string} name
	 * @param {string} url  URL to a clip JSON or /api/animations/clips/:id endpoint
	 * @param {{ loop?: boolean }} [opts]
	 * @returns {Promise<THREE.AnimationClip>}
	 */
	async loadAnimation(name, url, opts = {}) {
		if (this.clips.has(name)) return this.clips.get(name);

		const isApiClip = url.includes('/api/animations/');
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 15_000);
		let res;
		try {
			res = await fetch(url, {
				signal: controller.signal,
				// API clips need auth; static clips are same-origin assets. Use
				// 'same-origin' (not 'omit') so a credential-gated host proxy — e.g.
				// a private-forwarded Codespaces port — still receives the auth cookie
				// and serves the asset instead of 302-ing it to a login tunnel.
				credentials: isApiClip ? 'include' : 'same-origin',
				redirect: 'error',
			});
		} finally {
			clearTimeout(timeoutId);
		}
		if (!res.ok) throw new Error(`HTTP ${res.status} loading animation ${name}`);
		const json = await res.json();
		// API responses wrap the baked clip one level deeper.
		const clipJson = isApiClip ? json?.clip?.clip : json;
		if (!clipJson) throw new Error(`clip payload missing from ${url}`);
		const clip = AnimationClip.parse(clipJson);
		clip.name = name;

		return this._registerParsedClip(name, clip, opts);
	}

	/**
	 * Register a clip from already-fetched JSON — skips all network I/O.
	 * Useful for callers that pre-fetch clip data alongside other parallel loads
	 * so animations are ready before the first render frame.
	 * @param {string} name
	 * @param {object} clipJson  Raw AnimationClip JSON (same shape as the files in /animations/clips/)
	 * @param {{ loop?: boolean }} [opts]
	 */
	injectClip(name, clipJson, opts = {}) {
		if (!clipJson || this.clips.has(name)) return;
		try {
			const clip = AnimationClip.parse(clipJson);
			clip.name = name;
			this._registerParsedClip(name, clip, opts);
		} catch (err) {
			log.warn(`[AnimationManager] injectClip "${name}" parse error:`, err.message);
		}
	}

	/** @private Shared finalization for both load paths. */
	_registerParsedClip(name, clip, opts) {
		this.clips.set(name, clip);

		if (this.model && this.mixer) {
			const bound = this._retarget(clip);
			if (bound) {
				const action = this.mixer.clipAction(bound);
				action.enabled = true;
				action.setLoop(opts.loop === false ? LoopOnce : LoopRepeat);
				if (opts.loop === false) action.clampWhenFinished = true;
				this.actions.set(name, action);
			}
		}
		return clip;
	}

	/**
	 * Load all registered definitions in parallel.
	 * Failed clips are logged and added to _failed; they do not throw.
	 */
	async loadAll() {
		const CONCURRENCY = 4;
		const queue = [...this._animationDefs];
		const worker = async () => {
			let def;
			while ((def = queue.shift())) {
				try {
					await this.loadAnimation(def.name, def.url, { loop: def.loop !== false });
				} catch (err) {
					log.warn(`[AnimationManager] failed to load "${def.name}":`, err.message);
					this._failed.add(def.name);
				}
			}
		};
		await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	}

	/**
	 * Lazily load a single clip by name (from registered defs) if not yet loaded.
	 * Used so the first click on a strip button triggers a load without blocking startup.
	 * @param {string} name
	 * @returns {Promise<boolean>} true if ready
	 */
	async ensureLoaded(name) {
		if (this.clips.has(name)) return true;
		if (this._failed.has(name)) return false;
		const def = this._animationDefs.find((d) => d.name === name);
		if (!def) return false;
		try {
			await this.loadAnimation(def.name, def.url, { loop: def.loop !== false });
			return true;
		} catch {
			this._failed.add(name);
			return false;
		}
	}

	// ── Playback ───────────────────────────────────────────────────────────────

	/**
	 * Play a named clip immediately (hard cut, no crossfade).
	 * Lazily loads if not yet in memory.
	 * @param {string} name
	 * @returns {Promise<boolean>} true if the clip started playing, false if unavailable or rejected
	 */
	async play(name) {
		const ready = await this.ensureLoaded(name);
		if (!ready) {
			if (this._failed.has(name) || this._animationDefs.some((d) => d.name === name))
				log.warn(`[AnimationManager] "${name}" unavailable`);
			return false;
		}
		// Re-check after async load so concurrent play() calls don't all reset
		// the action's timeline back to 0 once the clip finally resolves.
		if (name === this.currentName) return true;
		const action = this.actions.get(name);
		if (!action) return false;
		// Reject a retarget that would lie the avatar on its back; fall back to the
		// authored bind pose rather than play a fallen clip.
		if (!this._guardAgainstFallenPose(name, action)) return false;

		if (this.currentAction && this.currentAction !== action) {
			this.currentAction.fadeOut(0.01);
		}
		action.reset().fadeIn(0.01).play();
		this.currentAction = action;
		this.currentName = name;
		try { this.onChange?.(name); } catch (e) { log.warn('[AnimationManager] onChange threw:', e); }
		return true;
	}

	/**
	 * Play a one-shot clip exactly once, then settle into a looping clip
	 * (`idle` by default) with a crossfade — instead of clamping and freezing on
	 * the final frame, which reads as a hard snap on a looping thumbnail. This is
	 * the seamless path for manifest clips whose `loop` field is false
	 * (`celebrate`, `wave`, …). Lazily loads both the one-shot and the settle clip.
	 *
	 * @param {string} name
	 * @param {{ settleTo?: string|null, fade?: number }} [opts]
	 */
	async playOnce(name, { settleTo = 'idle', fade = DEFAULT_CROSSFADE } = {}) {
		fade = Math.max(0, Math.min(fade, 5));
		const ready = await this.ensureLoaded(name);
		const action = ready ? this.actions.get(name) : null;
		// Reject a fallen-pose retarget the same way an unavailable clip is handled:
		// settle into the looping fallback rather than play the broken one-shot.
		if (!action || !this._guardAgainstFallenPose(name, action)) {
			// One-shot unavailable on this rig — fall back to the settle clip so
			// the avatar is never left frozen in its bind pose.
			if (settleTo) return this.crossfadeTo(settleTo, fade);
			return;
		}

		action.reset();
		action.setLoop(LoopOnce, 1);
		// Hold the final frame until the settle crossfade picks it up — without
		// this the action would snap back to frame 0 the instant it completes.
		action.clampWhenFinished = true;
		action.play();
		if (this.currentAction && this.currentAction !== action) {
			this.currentAction.crossFadeTo(action, fade, true);
		} else {
			action.fadeIn(fade);
		}
		this.currentAction = action;
		this.currentName = name;

		// Tear down any previous settle listener before registering a new one so
		// interrupted one-shots don't accumulate listeners on the mixer.
		if (this._settleFinishHandler && this.mixer) {
			this.mixer.removeEventListener('finished', this._settleFinishHandler);
			this._settleFinishHandler = null;
		}
		if (settleTo && this.mixer) {
			const onFinished = (e) => {
				if (e.action !== action) return;
				this.mixer.removeEventListener('finished', onFinished);
				if (this._settleFinishHandler === onFinished) this._settleFinishHandler = null;
				// Only settle if nothing else took over the avatar meanwhile.
				if (this.currentAction === action) this.crossfadeTo(settleTo, fade);
			};
			this._settleFinishHandler = onFinished;
			this.mixer.addEventListener('finished', onFinished);
		}
		try { this.onChange?.(name); } catch (e) { log.warn('[AnimationManager] onChange threw:', e); }
	}

	/**
	 * Freeze the active clip on its current pose and release it as the active
	 * action so the host viewer's render loop can settle (it stops scheduling
	 * frames once nothing is animating). The paused action keeps applying its
	 * held pose whenever the mixer does tick again (e.g. on scroll-back-in), so
	 * the avatar shows a clean static pose rather than a T-pose.
	 *
	 * Used for `prefers-reduced-motion`: a calm held pose with no looping motion
	 * and no continuous GPU/CPU cost.
	 */
	freeze() {
		if (this.currentAction) this.currentAction.paused = true;
		this.currentAction = null;
		this.currentName = null;
		this._latestCrossfadeTarget = null;
	}

	/**
	 * Crossfade from the current clip to a named clip.
	 * Lazily loads if not yet in memory.
	 * @param {string} name
	 * @param {number} [duration] seconds
	 */
	async crossfadeTo(name, duration = DEFAULT_CROSSFADE) {
		duration = Math.max(0, Math.min(duration, 5));
		if (name === this.currentName) return;
		// Record this as the latest-requested clip before the async load so that
		// if a newer crossfadeTo call arrives while this one is fetching, we can
		// detect the race and abort — preventing a slow-loading walk clip from
		// overriding an idle/dance that was applied while it was still fetching.
		this._latestCrossfadeTarget = name;
		const ready = await this.ensureLoaded(name);
		if (!ready) {
			if (this._failed.has(name) || this._animationDefs.some((d) => d.name === name))
				log.warn(`[AnimationManager] "${name}" unavailable`);
			return;
		}
		// Re-check after the async load: if a newer crossfadeTo superseded this
		// request while the clip was fetching, discard this stale crossfade.
		// Also catches the common case where stepAvatar queues many identical calls.
		if (this._latestCrossfadeTarget !== name) return;
		if (name === this.currentName) return;
		const next = this.actions.get(name);
		if (!next) return;
		// Reject a fallen-pose retarget: keep the current clip (or the authored
		// bind pose when nothing is playing) instead of crossfading onto a body
		// that would land on its back.
		if (!this._guardAgainstFallenPose(name, next)) return;

		next.reset().play();
		if (this.currentAction && this.currentAction !== next) {
			this.currentAction.crossFadeTo(next, duration, true);
		} else {
			next.fadeIn(duration);
		}
		this.currentAction = next;
		this.currentName = name;
		try { this.onChange?.(name); } catch (e) { log.warn('[AnimationManager] onChange threw:', e); }
	}

	// ── Additive overlay (gesture-over-locomotion) ──────────────────────────────

	/**
	 * Build (and cache) an additive clip for the named library clip, retargeted to
	 * the attached rig. The clip is made additive relative to its own first frame —
	 * the standard three.js technique (see webgl_animation_skinning_additive_blending) —
	 * so playing it adds its pose delta on top of whatever the base layer is doing.
	 * When `upperBodyOnly` is set, every lower-body track (hips, legs, feet) is
	 * dropped first so locomotion keeps full control of the legs.
	 *
	 * @param {string} name
	 * @param {boolean} upperBodyOnly
	 * @returns {THREE.AnimationClip|null}
	 */
	_buildOverlayClip(name, upperBodyOnly) {
		const cacheKey = `${name}|${upperBodyOnly ? 'upper' : 'full'}`;
		const cached = this._overlayClips.get(cacheKey);
		if (cached) return cached;

		const raw = this.clips.get(name);
		if (!raw) return null;
		const retargeted = this._retarget(raw);
		if (!retargeted) return null;

		let tracks = retargeted.tracks;
		if (upperBodyOnly && this._canonicalToNode) {
			const lowerNodes = new Set();
			for (const canonical of LOWER_BODY_CANONICAL) {
				const node = this._canonicalToNode.get(canonical);
				if (node) lowerNodes.add(node);
			}
			tracks = tracks.filter((t) => {
				const node = t.name.split('.')[0];
				return !lowerNodes.has(node);
			});
			if (tracks.length === 0) return null; // rig shares no upper-body bones
		}

		const overlay = new AnimationClip(`${name}__additive`, retargeted.duration, tracks);
		// Subtract frame 0 so the clip becomes a pose-delta the mixer can add.
		AnimationUtils.makeClipAdditive(overlay);
		this._overlayClips.set(cacheKey, overlay);
		return overlay;
	}

	/**
	 * Play a gesture as an additive overlay on top of the current base clip, so the
	 * avatar can (e.g.) wave or cheer while it keeps walking. The base
	 * idle/walk/run action is untouched — only this additive layer is added.
	 *
	 * @param {string} name clip name (library or appended def)
	 * @param {{ loop?: boolean, crossfade?: number, upperBodyOnly?: boolean, timeScale?: number, onFinished?: Function }} [opts]
	 * @returns {Promise<boolean>} true if the overlay started
	 */
	async playOverlay(name, { loop = false, crossfade = 0.25, upperBodyOnly = true, timeScale = 1, onFinished = null } = {}) {
		crossfade = Math.max(0, Math.min(crossfade, 5));
		const ready = await this.ensureLoaded(name);
		if (!ready || !this.mixer) return false;

		const overlayClip = this._buildOverlayClip(name, upperBodyOnly);
		if (!overlayClip) return false;

		const next = this.mixer.clipAction(overlayClip, undefined, AdditiveAnimationBlendMode);
		// Tear down any previous overlay listener and fade the old overlay out.
		this._detachOverlayFinish();
		const prev = this.overlayAction;
		if (prev && prev !== next) prev.fadeOut(crossfade);

		next.enabled = true;
		next.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
		next.clampWhenFinished = !loop;
		next.setEffectiveTimeScale(timeScale);
		next.reset();
		next.setEffectiveWeight(1);
		next.fadeIn(crossfade);
		next.play();

		this.overlayAction = next;
		this.overlayName = name;

		if (!loop) {
			const handler = (e) => {
				if (e.action !== next) return;
				this.mixer.removeEventListener('finished', handler);
				if (this._overlayFinishHandler === handler) this._overlayFinishHandler = null;
				// Fade the held final frame out and clear, unless something already
				// replaced this overlay.
				if (this.overlayAction === next) {
					next.fadeOut(crossfade);
					this.overlayAction = null;
					this.overlayName = null;
				}
				try { onFinished?.(name); } catch (err) { log.warn('[AnimationManager] overlay onFinished threw:', err); }
			};
			this._overlayFinishHandler = handler;
			this.mixer.addEventListener('finished', handler);
		}
		return true;
	}

	/** @private Detach the pending one-shot overlay 'finished' listener. */
	_detachOverlayFinish() {
		if (this._overlayFinishHandler && this.mixer) {
			this.mixer.removeEventListener('finished', this._overlayFinishHandler);
		}
		this._overlayFinishHandler = null;
	}

	/**
	 * Fade out and clear the active additive overlay, returning the avatar to the
	 * pure base layer. No-op when no overlay is playing.
	 * @param {{ crossfade?: number }} [opts]
	 */
	stopOverlay({ crossfade = 0.2 } = {}) {
		crossfade = Math.max(0, Math.min(crossfade, 5));
		this._detachOverlayFinish();
		if (this.overlayAction) {
			this.overlayAction.fadeOut(crossfade);
			this.overlayAction = null;
			this.overlayName = null;
		}
	}

	/** @returns {boolean} whether an additive overlay is currently playing. */
	hasOverlay() {
		return this.overlayAction != null;
	}

	/**
	 * Scale playback speed of the active clip. 1 = normal; >1 plays faster
	 * (used to make a walk cycle read as a run).
	 * @param {number} scale
	 */
	setSpeed(scale) {
		this.currentAction?.setEffectiveTimeScale(scale);
	}

	/** Stop all animations. */
	stopAll() {
		this.mixer?.stopAllAction();
		this._detachOverlayFinish();
		this.currentAction = null;
		this.currentName = null;
		this.overlayAction = null;
		this.overlayName = null;
		try { this.onChange?.(null); } catch (e) { log.warn('[AnimationManager] onChange threw:', e); }
	}

	/**
	 * Tick the mixer. Call from the render loop.
	 * @param {number} delta seconds since last frame
	 */
	update(delta) {
		this.mixer?.update(delta);
	}

	/** @returns {string[]} */
	getLoadedNames() {
		return [...this.clips.keys()];
	}

	/** @param {string} name @returns {boolean} */
	isLoaded(name) {
		return this.clips.has(name);
	}

	dispose() {
		this.detach();
		this.clips.clear();
		this._animationDefs = [];
		this._failed.clear();
	}
}

// A pre-baked clip only deforms the mesh when its tracks address real skeleton
// bones. Require both a SkinnedMesh and enough canonically-named bones so we
// don't mistake a static prop (whose node happens to be named "Head") for a
// rig the library can animate.
function _modelSupportsCanonicalClips(model) {
	let hasSkinnedMesh = false;
	const canonical = new Set();
	model.traverse((node) => {
		if (node.isSkinnedMesh) hasSkinnedMesh = true;
		if (node.name) {
			const c = canonicalizeBoneName(node.name);
			if (c) canonical.add(c);
		}
	});
	return hasSkinnedMesh && canonical.size >= MIN_CANONICAL_BONES;
}

// Surface a fallen-pose retarget through the existing client-error pipeline
// (public/error-reporter.js → POST /api/client-errors, logged "[client-error]").
// That hook is a no-op on dev hosts and fails silent, exactly what we want here.
// Guarded for Node/SSR (vitest, the apply_animation MCP tool) where neither
// `window` nor the hook exists — the guard's logic still runs; only the report
// is skipped.
function reportFallenPose(context) {
	try {
		const hook =
			typeof window !== 'undefined' &&
			typeof window.reportClientError === 'function'
				? window.reportClientError
				: null;
		if (!hook) return;
		hook(new Error('fallen-pose retarget'), context);
	} catch (e) {
		log.warn('[AnimationManager] fallen-pose report failed:', e);
	}
}
