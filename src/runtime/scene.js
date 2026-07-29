// SceneController — wraps a Viewer instance with the scene-tool API the runtime
// and skills expect (playClipByName, lookAt, setExpression, loadClip, loadGLB).
//
// Keeps viewer.js untouched while giving agents a coherent control surface.

import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from '../viewer/internal.js';
import { resolveURI } from '../ipfs.js';
import { resolveSlot } from './animation-slots.js';
import { LookAtController } from '../procedural/look-at.js';
import { canonicalNodeMapFromObject } from '../animation-retarget.js';
import { log } from '../shared/log.js';

const EXPRESSION_MAP = {
	neutral: {
		/* reset all */
	},
	happy: { mouthSmile: 1, browInnerUp: 0.3, cheekSquintL: 0.4, cheekSquintR: 0.4 },
	sad: { mouthFrownL: 0.8, mouthFrownR: 0.8, browDownL: 0.6, browDownR: 0.6 },
	surprised: { jawOpen: 0.5, eyeWideL: 0.8, eyeWideR: 0.8, browInnerUp: 0.9 },
	confused: { browInnerUp: 0.5, browOuterUpL: 0.4, mouthPressL: 0.3, mouthPressR: 0.3 },
	focused: { browDownL: 0.4, browDownR: 0.4, eyeSquintL: 0.3, eyeSquintR: 0.3 },
};

export class SceneController {
	constructor(viewer) {
		this.viewer = viewer;
		this._loader = new GLTFLoader();
		// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
		this._meshoptReady = getMeshoptDecoder().then((d) => this._loader.setMeshoptDecoder(d));
		this._userTarget = new Vector3(0, 1.6, 2); // approx user head position
		this._animationMap = {};
		this._group = null;
		this._groupMixer = null;
		this._groupClips = null;
		this._mixerHook = null;
		// Gaze state (see lookAt / _ensureGazeIk): the standing target, the IK
		// layer that applies it, the content root that layer was built for, and
		// the per-frame hook that re-applies it after the mixer.
		this._gazeTarget = null;
		this._gazeIk = null;
		this._gazeIkFor = null;
		this._gazeHook = null;
		this._gazeScratch = new Vector3();
		// Canonical bone lookup cache (see getCanonicalBone), rebuilt on swap.
		this._boneMap = null;
		this._boneMapFor = null;
	}

	// Expose the underlying Three.js handles skills may need
	get scene() {
		return this.viewer.scene;
	}
	get renderer() {
		return this.viewer.renderer;
	}
	get mixer() {
		return this._groupMixer || this.viewer.mixer;
	}
	get clips() {
		return this._groupClips || this.viewer.clips || [];
	}
	get content() {
		return this._group || this.viewer.content;
	}

	// Scope all scene operations to a sub-group (used by <agent-stage>).
	setGroup(group, { mixer = null, clips = null } = {}) {
		this._group = group;
		this._groupMixer = mixer;
		this._groupClips = clips;
		if (mixer) {
			this._mixerHook = (dt) => {
				mixer.update(dt);
				this.viewer._animating = true;
				this.viewer.invalidate();
			};
			this._addHook(this._mixerHook);
		}
	}

	dispose() {
		if (this._gazeHook) this._removeHook(this._gazeHook);
		this._gazeHook = null;
		this._gazeIk = null;
		this._gazeIkFor = null;
		this._gazeTarget = null;
		if (this._mixerHook) this._removeHook(this._mixerHook);
		if (this._groupMixer) {
			try {
				this._groupMixer.stopAllAction();
			} catch {}
			try {
				this._groupMixer.uncacheRoot(this._group);
			} catch {}
		}
		this._mixerHook = null;
		this._groupMixer = null;
		this._groupClips = null;
		this._group = null;
	}

	/**
	 * Set the agent's animation slot override map (from meta.edits.animations).
	 * @param {Object|null} map — { slotName: clipName, … }
	 */
	setAnimationMap(map) {
		this._animationMap = map || {};
	}

	/**
	 * Resolve a slot name (e.g. 'celebrate') to the actual clip name.
	 * Falls back to DEFAULT_ANIMATION_MAP, then the slot name itself.
	 * @param {string} name
	 * @returns {string}
	 */
	resolveAnimationSlot(name) {
		return resolveSlot(name, this._animationMap);
	}

	// Delegate raw load for ad-hoc cases
	async load(url, rootPath = '', assetMap = new Map()) {
		return this.viewer.load(url, rootPath, assetMap);
	}

	// --- Animation ---

	playClipByName(name, { loop = false, fade_ms = 200 } = {}) {
		// Try embedded clips (viewer.clips / viewer.mixer) first
		const clip = this._findClip(name);
		const mixer = this.mixer;
		if (clip && mixer) {
			const action = mixer.clipAction(clip);
			action.reset();
			action.setLoop(loop ? 2201 /* LoopRepeat */ : 2200 /* LoopOnce */);
			action.clampWhenFinished = !loop;
			action.fadeIn(fade_ms / 1000);
			action.play();
			if (!this._group) this.viewer.state.actionStates[clip.name] = true;
			this.viewer._animating = true;
			this.viewer.invalidate();
			return true;
		}
		// Fall back to animation manager (external clips from manifest).
		// crossfadeTo/play are async (lazy-load on demand); fire-and-forget is fine.
		const am = this.viewer?.animationManager;
		if (!am || am.isFailed(name)) return false;
		if (loop) am.crossfadeTo(name, fade_ms / 1000);
		else am.play(name);
		return true;
	}

	playAnimationByHint(hint, opts) {
		const lower = hint.toLowerCase();
		// Search embedded clips
		const match = this.clips.find((c) => c.name.toLowerCase().includes(lower));
		if (match) return this.playClipByName(match.name, opts);
		// Search external clips in animation manager
		const am = this.viewer?.animationManager;
		if (am) {
			for (const name of am.clips.keys()) {
				if (name.toLowerCase().includes(lower)) {
					return this.playClipByName(name, opts);
				}
			}
		}
		return false;
	}

	stopClip(name) {
		const mixer = this.mixer;
		if (!mixer) return;
		const clip = name ? this._findClip(name) : null;
		if (clip) {
			const action = mixer.existingAction(clip);
			if (action) action.fadeOut(0.2);
			if (!this._group) this.viewer.state.actionStates[clip.name] = false;
		} else {
			mixer.stopAllAction();
			if (!this._group) {
				for (const k in this.viewer.state.actionStates)
					this.viewer.state.actionStates[k] = false;
			}
		}
		this.viewer.invalidate();
	}

	async play(clip, opts) {
		// Accept either a clip name or an AnimationClip instance.
		if (typeof clip === 'string') return this.playClipByName(clip, opts);
		const mixer = this.mixer;
		if (!mixer || !clip) return false;
		const action = mixer.clipAction(clip);
		action.reset();
		action.fadeIn(opts?.blend ?? 0.2);
		action.play();
		this.viewer._animating = true;
		this.viewer.invalidate();
		return true;
	}

	async loadClip(uri) {
		await this._meshoptReady;
		const resolved = resolveURI(uri);
		return new Promise((resolve, reject) => {
			this._loader.load(
				resolved,
				(gltf) => resolve(gltf.animations?.[0] || null),
				undefined,
				reject,
			);
		});
	}

	async loadGLB(uri) {
		await this._meshoptReady;
		const resolved = resolveURI(uri);
		return new Promise((resolve, reject) => {
			this._loader.load(resolved, resolve, undefined, reject);
		});
	}

	// --- Gaze ---

	/**
	 * Aim the avatar's gaze at a world point, a named target ('camera', 'user',
	 * 'center'), or null to release it.
	 *
	 * The gaze is a standing state, not a one-off pose write: a per-frame hook
	 * re-applies it after the mixer, so it survives on an avatar that is playing
	 * a clip. Turning is spread across the chest, neck, and head and clamped, so
	 * a target off to the side reads as a person glancing over rather than a head
	 * spinning on its axis. Rigs with no mappable head fall back to rotating the
	 * whole model on its Y axis, which is the best a headless rig can do.
	 *
	 * @param {import('three').Vector3|'camera'|'user'|'center'|null} target
	 */
	lookAt(target) {
		if (target == null) {
			this._gazeTarget = null;
			this._gazeIk?.setTarget(null);
			this.viewer.invalidate();
			return;
		}
		const t = this._resolveTarget(target);
		if (!t) {
			log.warn(`[SceneController] unknown lookAt target: "${target}"`);
			return;
		}
		if (!this.content) return;

		// 'camera' and 'user' move as the viewer moves, so remember the request
		// and re-resolve it every frame instead of freezing today's position.
		this._gazeTarget = typeof target === 'string' ? target : t.clone();

		if (!this._ensureGazeIk()) {
			// Headless rig (a prop, a non-humanoid): yaw the whole model instead.
			this.content.lookAt(t.x, this.content.position.y, t.z);
		}
		this.viewer.invalidate();
	}

	/**
	 * @private Build (or rebuild, after a model swap) the gaze IK layer and its
	 * per-frame hook. Returns false when the loaded rig exposes no head chain,
	 * which tells lookAt() to fall back to whole-model rotation.
	 */
	_ensureGazeIk() {
		const content = this.content;
		if (!content) return false;
		if (this._gazeIkFor !== content) {
			this._gazeIkFor = content;
			const ik = new LookAtController(content);
			this._gazeIk = ik.enabled ? ik : null;
		}
		if (!this._gazeIk) return false;
		if (!this._gazeHook) {
			// Runs in _afterAnimateHooks, i.e. after the mixer has posed the
			// skeleton — the order every procedural layer requires.
			this._gazeHook = (dt) => {
				if (!this._gazeIk) return;
				const t = this._gazeTarget;
				this._gazeIk.setTarget(t ? this._resolveTargetInto(t, this._gazeScratch) : null);
				this._gazeIk.update(dt);
				this.viewer.invalidate();
			};
			this._addHook(this._gazeHook);
		}
		return true;
	}

	_resolveTarget(target) {
		if (target instanceof Vector3) return target;
		if (target === 'camera') return this.viewer.activeCamera.position.clone();
		if (target === 'center') return new Vector3(0, 1, 0);
		if (target === 'user') {
			// In WebXR, track the live XR camera position so lookAt('user') follows the wearer
			if (this.viewer.renderer?.xr?.isPresenting) {
				return this.viewer.renderer.xr.getCamera().position.clone();
			}
			return this._userTarget.clone();
		}
		return null;
	}

	/**
	 * @private Same resolution as {@link _resolveTarget} but writing into a
	 * caller-owned vector, so the per-frame gaze hook allocates nothing. A
	 * Vector3 target is returned as-is (nothing to resolve).
	 * @param {import('three').Vector3|string} target
	 * @param {import('three').Vector3} out
	 * @returns {import('three').Vector3|null}
	 */
	_resolveTargetInto(target, out) {
		if (target instanceof Vector3) return target;
		if (target === 'camera') return out.copy(this.viewer.activeCamera.position);
		if (target === 'center') return out.set(0, 1, 0);
		if (target === 'user') {
			if (this.viewer.renderer?.xr?.isPresenting) {
				return out.copy(this.viewer.renderer.xr.getCamera().position);
			}
			return out.copy(this._userTarget);
		}
		return null;
	}

	/**
	 * Resolve a canonical bone ('Head', 'Neck', 'Hips', 'LeftFoot', …) on the
	 * loaded rig, or null when this rig has no equivalent. Goes through the
	 * shared canonicalizer, so it resolves Mixamo, VRM, Avaturn, Daz, Character
	 * Creator, and Blender naming alike — never a hardcoded list of spellings.
	 * The map is cached per loaded model and rebuilt on swap.
	 * @param {string} canonical
	 * @returns {import('three').Object3D|null}
	 */
	getCanonicalBone(canonical) {
		const content = this.content;
		if (!content) return null;
		if (this._boneMapFor !== content) {
			this._boneMapFor = content;
			this._boneMap = canonicalNodeMapFromObject(content);
		}
		const name = this._boneMap.get(canonical);
		return name ? content.getObjectByName(name) : null;
	}

	// --- Expression (morph targets) ---

	setExpression(preset, intensity = 1) {
		const influences = EXPRESSION_MAP[preset] || EXPRESSION_MAP.neutral;
		if (!this.viewer.content) return;
		this.viewer.content.traverse((mesh) => {
			if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
			// Reset all first
			for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
				mesh.morphTargetInfluences[i] = 0;
			}
			// Apply preset influences by morph target name
			for (const [morphName, value] of Object.entries(influences)) {
				const idx = mesh.morphTargetDictionary[morphName];
				if (idx !== undefined) {
					mesh.morphTargetInfluences[idx] = value * intensity;
				}
			}
		});
		this.viewer.invalidate();
	}

	// --- Movement ---

	moveTo(position, { duration = 600 } = {}) {
		if (!this.viewer.content) return;
		// Cancel any in-progress tween before starting a new one
		if (this._moveToHook) {
			this._removeHook(this._moveToHook);
			this._moveToHook = null;
		}
		const start = this.viewer.content.position.clone();
		const end = new Vector3(
			position.x ?? start.x,
			position.y ?? start.y,
			position.z ?? start.z,
		);
		const startT = performance.now();
		const tick = (dt) => {
			const elapsed = performance.now() - startT;
			const t = Math.min(elapsed / duration, 1);
			const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
			this.viewer.content.position.lerpVectors(start, end, eased);
			this.viewer.invalidate();
			if (t >= 1) {
				this._removeHook(tick);
				this._moveToHook = null;
			}
		};
		this._moveToHook = tick;
		this._addHook(tick);
	}

	// --- Per-frame hooks (uses Viewer._afterAnimateHooks extension point) ---

	_addHook(fn) {
		if (!this.viewer._afterAnimateHooks) this.viewer._afterAnimateHooks = [];
		this.viewer._afterAnimateHooks.push(fn);
		this.viewer._animating = true;
		this.viewer.invalidate();
	}

	_removeHook(fn) {
		const hooks = this.viewer._afterAnimateHooks;
		if (!hooks) return;
		const i = hooks.indexOf(fn);
		if (i >= 0) hooks.splice(i, 1);
	}

	// --- Helpers ---

	_findClip(name) {
		if (!this.clips.length) return null;
		const exact = this.clips.find((c) => c.name === name);
		if (exact) return exact;
		const ci = name.toLowerCase();
		return (
			this.clips.find((c) => c.name.toLowerCase() === ci) ||
			this.clips.find((c) => c.name.toLowerCase().includes(ci))
		);
	}
}
