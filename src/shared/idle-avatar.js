/**
 * Idle avatar mount — a living agent body, never a frozen T-pose.
 *
 * `<model-viewer>` can only render a GLB in its authored bind pose, which for
 * the vast majority of avatar rigs is a T-pose (arms straight out). three.ws
 * avatars carry no baked-in clips — idle/walk live in the runtime clip library
 * and are *retargeted* onto whatever skeleton the avatar ships with. So a static
 * viewer is structurally incapable of showing the avatar the way the platform
 * intends.
 *
 * This helper brings up the real Three.js `Viewer` (kiosk mode — no chrome),
 * loads the GLB, retargets the canonical `idle` clip onto it (arms come down,
 * weight settles), and layers the procedural idle-life loop (breathing, blink,
 * micro-saccades, weight shift) on top. The result reads as a person standing
 * there, not a mannequin pinned to a wall.
 *
 * Reuses the exact pattern proven in `avatar-embed.js`, packaged so any surface
 * that wants a small living portrait (agent hero, cards, modals) can drop it in.
 */

import { Viewer } from '../viewer.js';
import { IdleAnimation } from '../idle-animation.js';
import { playAllClips } from '../viewer/animation.js';
import { log } from './log.js';

// The clip manifest is identical for every avatar and never changes within a
// session, so fetch it once and share the promise across every mount on the page.
let _manifestPromise = null;
function loadAnimationDefs() {
	if (!_manifestPromise) {
		_manifestPromise = fetch('/animations/manifest.json')
			.then((r) => (r.ok ? r.json() : []))
			.catch(() => []);
	}
	return _manifestPromise;
}

/** True when the reader asked the platform to hold decorative motion still. */
function prefersReducedMotion() {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Mount a living, idle-animated avatar into `container`.
 *
 * @param {HTMLElement} container  Positioned element to fill (gets a relative
 *   position if static). The WebGL stage is appended as an absolute child so it
 *   inherits the container's border-radius/size from CSS.
 * @param {string} glbUrl  Avatar model URL.
 * @param {Object} [opts]
 * @param {boolean} [opts.autoRotate=true]  Slowly turn the figure on a turntable.
 *   Held still regardless when the reader prefers reduced motion.
 * @param {string}  [opts.seed]  Stable seed so the idle phase is deterministic per agent.
 * @param {string}  [opts.environment='Neutral']  Lighting environment name.
 * @param {boolean} [opts.cameraControls=false]  Allow orbit/zoom (used in the modal).
 * @param {() => void} [opts.onError]  Called if WebGL is unavailable or the GLB fails.
 * @returns {{ viewer: Viewer, setAutoRotate(v:boolean):void, dispose():void } | null}
 *   null when a WebGL context can't be created (caller should fall back to a still image).
 */
export function mountIdleAvatar(container, glbUrl, opts = {}) {
	const {
		autoRotate = true,
		seed = glbUrl,
		environment = 'Neutral',
		cameraControls = false,
		onError,
	} = opts;

	if (getComputedStyle(container).position === 'static') {
		container.style.position = 'relative';
	}

	const stage = document.createElement('div');
	stage.className = 'idle-avatar-stage';
	stage.style.position = 'absolute';
	stage.style.inset = '0';
	container.appendChild(stage);

	let viewer;
	try {
		viewer = new Viewer(stage, { kiosk: true });
	} catch (err) {
		// GPU blocklist, context budget exhausted, headless — degrade to the
		// caller's still-image fallback rather than throwing into the page.
		stage.remove();
		log.warn('[idle-avatar] WebGL unavailable', err?.message);
		onError?.(err);
		return null;
	}

	viewer.state.environment = environment;
	// A turntable is decorative motion nobody asked for: a reader who set
	// "reduce motion" gets the figure held still, and its idle life (breathing,
	// blink) still plays because that is the content, not the decoration.
	viewer.state.autoRotate = autoRotate && !prefersReducedMotion();
	viewer.controls.enabled = cameraControls;
	viewer.controls.enableZoom = cameraControls;
	viewer.controls.enablePan = false;
	// Transparent backdrop so the agent's radial glow shows through behind the body.
	viewer.renderer?.setClearAlpha(0);
	if (viewer.scene) viewer.scene.background = null;
	viewer.updateEnvironment?.();
	viewer.updateDisplay?.();

	// Procedural idle-life: breathing, blink, saccades, weight shift. Additive on
	// top of whatever clip plays, so the figure is never perfectly still.
	const idle = new IdleAnimation({ getRoot: () => viewer.content, seed });
	if (!viewer._afterAnimateHooks) viewer._afterAnimateHooks = [];
	viewer._afterAnimateHooks.push((dt) => idle.update(dt));

	let disposed = false;

	// Resolves once the GLB + clip pipeline settled, with whether this rig can
	// accept canonical library clips (humanoid): false for props/own-clip
	// models and on load failure. Lets callers (the playground chips) know
	// whether gesture playback is possible without reaching into the manager
	// mid-load.
	let _readyResolve;
	const ready = new Promise((resolve) => {
		_readyResolve = resolve;
	});

	viewer
		.load(glbUrl, '', new Map())
		.then(async () => {
			if (disposed) return;
			const mgr = viewer.animationManager;
			// A humanoid rig is driven by the pre-baked canonical clip library
			// (idle/walk retargeted onto its skeleton). A quadruped, prop, or any
			// model that ships its OWN baked animation (the three.js galloping horse,
			// a flapping bird, a spinning logo) cannot accept those clips, so
			// retargeting no-ops and it would freeze in bind pose. Play its native
			// clips on the viewer mixer instead. supportsCanonicalClips() is valid
			// here: the model attached during viewer.load() above.
			if (typeof mgr.supportsCanonicalClips === 'function' && !mgr.supportsCanonicalClips()) {
				if (viewer.clips?.length) playAllClips(viewer);
				_readyResolve(false);
				return;
			}
			const defs = await loadAnimationDefs();
			if (disposed || !Array.isArray(defs) || defs.length === 0) {
				_readyResolve(false);
				return;
			}
			viewer.animationManager.setAnimationDefs(defs);
			// Retarget the idle clip first so the arms drop out of the bind pose
			// immediately; load the rest of the library in the background for any
			// later gesture playback. crossfadeTo handles rigs that can't accept
			// canonical clips by no-op'ing — the procedural idle still gives life.
			try {
				const ready = await viewer.animationManager.ensureLoaded('idle');
				if (!disposed && ready) await viewer.animationManager.crossfadeTo('idle', 0.4);
			} catch (err) {
				log.warn('[idle-avatar] idle clip retarget failed', err?.message);
			}
			viewer.animationManager.loadAll().catch(() => {});
			_readyResolve(true);
		})
		.catch((err) => {
			if (disposed) return;
			log.warn('[idle-avatar] GLB load failed', err?.message);
			_readyResolve(false);
			onError?.(err);
		});

	return {
		viewer,
		/** Resolves true when the rig can play canonical library clips. */
		ready,
		setAutoRotate(v) {
			viewer.state.autoRotate = !!v;
			viewer.updateDisplay?.();
		},
		/**
		 * Play the first available gesture from a candidate list, then settle
		 * back into the idle loop. Candidates let one semantic action ("dance")
		 * degrade across the clip library per rig: a clip the fallen-pose guard
		 * rejected on this skeleton is skipped, not frozen on.
		 *
		 * @param {string|string[]} names  Clip name(s), most-preferred first.
		 * @param {{ settleTo?: string }} [opts]
		 * @returns {Promise<string|null>}  The clip that played, or null.
		 */
		async playGesture(names, { settleTo = 'idle' } = {}) {
			const supports = await ready;
			if (disposed || !supports) return null;
			const mgr = viewer.animationManager;
			const list = Array.isArray(names) ? names : [names];
			for (const name of list) {
				if (!mgr.canPlay(name)) continue;
				const ok = await mgr.ensureLoaded(name).catch(() => false);
				if (disposed) return null;
				if (!ok || !mgr.canPlay(name)) continue;
				await mgr.playOnce(name, { settleTo });
				return name;
			}
			return null;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			// Unblock anything awaiting `ready` (playground chips) so it settles
			// to "no gestures" instead of hanging on a torn-down mount.
			_readyResolve(false);
			try {
				viewer.dispose?.();
			} catch (err) {
				log.warn('[idle-avatar] dispose failed', err?.message);
			}
			stage.remove();
		},
	};
}
