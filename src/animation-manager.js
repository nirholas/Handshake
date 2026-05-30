import { AnimationClip, AnimationMixer, LoopRepeat, LoopOnce } from 'three';

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
		/** @type {Set<string>|null} Bone/node names of the currently attached model. */
		this._boneNames = null;
	}

	// ── Model binding ──────────────────────────────────────────────────────────

	/**
	 * Attach to a loaded model. Call this every time a new model is loaded.
	 * Re-creates actions for any clips that are already in memory.
	 * @param {THREE.Object3D} model
	 */
	attach(model) {
		this.detach();
		this.model = model;
		this.mixer = new AnimationMixer(model);
		this.actions.clear();
		this.currentAction = null;
		this.currentName = null;
		this._boneNames = _collectBoneNames(model);

		for (const [name, clip] of this.clips) {
			const filtered = _filterClip(clip, this._boneNames);
			const action = this.mixer.clipAction(filtered);
			action.enabled = true;
			this.actions.set(name, action);
		}
	}

	/** Detach, stop all actions, dispose mixer. */
	detach() {
		if (this.mixer) {
			this.mixer.stopAllAction();
			this.mixer.uncacheRoot(this.mixer.getRoot());
			this.mixer = null;
		}
		this.model = null;
		this._boneNames = null;
		this.actions.clear();
		this.currentAction = null;
		this.currentName = null;
	}

	// ── Definitions ────────────────────────────────────────────────────────────

	/**
	 * Register animation definitions (from manifest.json).
	 * @param {Array<{name:string, url:string, label?:string, icon?:string, loop?:boolean}>} defs
	 */
	setAnimationDefs(defs) {
		this._animationDefs = defs;
	}

	/** @returns {Array} */
	getAnimationDefs() {
		return this._animationDefs;
	}

	/** @param {string} name @returns {boolean} */
	isFailed(name) {
		return this._failed.has(name);
	}

	// ── Loading ────────────────────────────────────────────────────────────────

	/**
	 * Load a single clip from a pre-baked JSON URL and register it.
	 * Idempotent — returns the cached clip if already loaded.
	 *
	 * @param {string} name
	 * @param {string} url  URL to a clip JSON produced by build-animations.mjs
	 * @param {{ loop?: boolean }} [opts]
	 * @returns {Promise<THREE.AnimationClip>}
	 */
	async loadAnimation(name, url, opts = {}) {
		if (this.clips.has(name)) return this.clips.get(name);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10_000);
		let res;
		try {
			res = await fetch(url, { signal: controller.signal });
		} finally {
			clearTimeout(timeoutId);
		}
		if (!res.ok) throw new Error(`HTTP ${res.status} loading animation ${name}`);
		const json = await res.json();
		const clip = AnimationClip.parse(json);
		clip.name = name;

		this.clips.set(name, clip);

		if (this.model && this.mixer) {
			const filtered = _filterClip(clip, this._boneNames);
			const action = this.mixer.clipAction(filtered);
			action.enabled = true;
			action.setLoop(opts.loop === false ? LoopOnce : LoopRepeat);
			if (opts.loop === false) action.clampWhenFinished = true;
			this.actions.set(name, action);
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
					console.warn(`[AnimationManager] failed to load "${def.name}":`, err.message);
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
	 */
	async play(name) {
		const ready = await this.ensureLoaded(name);
		if (!ready) {
			if (this._failed.has(name) || this._animationDefs.some((d) => d.name === name))
				console.warn(`[AnimationManager] "${name}" unavailable`);
			return;
		}
		const action = this.actions.get(name);
		if (!action) return;

		if (this.currentAction && this.currentAction !== action) {
			this.currentAction.fadeOut(0.01);
		}
		action.reset().fadeIn(0.01).play();
		this.currentAction = action;
		this.currentName = name;
		try { this.onChange?.(name); } catch (e) { console.warn('[AnimationManager] onChange threw:', e); }
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
		const ready = await this.ensureLoaded(name);
		if (!ready) {
			if (this._failed.has(name) || this._animationDefs.some((d) => d.name === name))
				console.warn(`[AnimationManager] "${name}" unavailable`);
			return;
		}
		const next = this.actions.get(name);
		if (!next) return;

		next.reset().play();
		if (this.currentAction) {
			this.currentAction.crossFadeTo(next, duration, true);
		} else {
			next.fadeIn(duration);
		}
		this.currentAction = next;
		this.currentName = name;
		try { this.onChange?.(name); } catch (e) { console.warn('[AnimationManager] onChange threw:', e); }
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
		this.currentAction = null;
		this.currentName = null;
		try { this.onChange?.(null); } catch (e) { console.warn('[AnimationManager] onChange threw:', e); }
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

function _collectBoneNames(model) {
	const names = new Set();
	model.traverse((n) => { if (n.name) names.add(n.name); });
	return names;
}

function _filterClip(clip, boneNames) {
	if (!boneNames || boneNames.size === 0) return clip;
	const valid = clip.tracks.filter((t) => {
		const dot = t.name.indexOf('.');
		const bone = dot !== -1 ? t.name.slice(0, dot) : t.name;
		return boneNames.has(bone);
	});
	if (valid.length === clip.tracks.length) return clip;
	const copy = clip.clone();
	copy.tracks = valid;
	return copy;
}
