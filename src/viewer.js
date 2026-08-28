import {
	AudioListener,
	AxesHelper,
	Box3,
	BufferAttribute,
	BufferGeometry,
	Cache,
	CanvasTexture,
	Color,
	GridHelper,
	LoaderUtils,
	LoopOnce,
	LoopRepeat,
	Mesh,
	PMREMGenerator,
	PerspectiveCamera,
	PCFShadowMap,
	PlaneGeometry,
	Points,
	PointsMaterial,
	Scene,
	ShadowMaterial,
	SkeletonHelper,
	Spherical,
	Vector3,
	WebGLRenderer,
	LinearToneMapping,
	ACESFilmicToneMapping,
	NeutralToneMapping,
} from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { GUI } from 'dat.gui';

import { environments } from './environments.js';
import { createModelInfo } from './model-info.js';
import { isDecentralizedURI, resolveURI, normalizeGatewayURL } from './ipfs.js';
import { canUseQuickLook, openQuickLook } from './ar/quick-look.js';
import { canUseSceneViewer, openSceneViewer } from './ar/scene-viewer.js';
import { WebXRSession } from './ar/webxr.js';
import { buildAnnotations, renderAnnotationCanvas } from './annotations.js';
import {
	DEFAULT_CAMERA,
	Preset,
	MANAGER,
	getDecoders,
	traverseMaterials,
} from './viewer/internal.js';
import { addLights, removeLights } from './viewer/lights.js';
import { getCubeMapTexture } from './viewer/environment.js';
import { takeScreenshot, captureScreenshot } from './viewer/screenshot.js';
import { setClips, playAllClips } from './viewer/animation.js';
import { computeFramingExtent, computeFramingWidth } from './viewer/framing.js';
import { estimateFacingYaw, forwardFromYaw, horizontalExtentAt } from './viewer/facing.js';
import { LightProbeGrid } from './light-probe-grid.js';
import { AnimationManager } from './animation-manager.js';
import { applyAvatarMaterialRealism, looksLikeAvatarMesh } from './shared/avatar-material-realism.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
	CinematicPipeline,
	CINEMATIC_PRESET_NAMES,
	CINEMATIC_DEFAULTS,
	DEFAULT_CINEMATIC_PRESET,
} from './viewer/cinematic.js';
import { log } from './shared/log.js';

// Install BVH-accelerated raycasting on Three.js prototypes. This must happen
// before any geometry is created so every Mesh benefits transparently.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

Cache.enabled = true;

// Canvas focus ring + reduced-motion opt-out, injected once per document.
// The viewer's <canvas> is appended directly into arbitrary host pages (forge,
// avatar-page, embeds, kiosks) with no guaranteed shared stylesheet, so this
// mirrors the pattern used by the SDK's <three-ws-viewer> (avatar-sdk/src/viewer.js):
// a tiny scoped <style> tag rather than assuming a page-level CSS file loaded.
// `var(--accent, …)` matches the site's existing focus-visible token
// (see src/character-creator.css, src/exchanges.css) with a safe fallback for
// pages that don't define it.
const VIEWER_A11Y_STYLE_ID = 'tws-viewer-canvas-a11y';
function ensureViewerA11yStyles() {
	if (typeof document === 'undefined' || document.getElementById(VIEWER_A11Y_STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = VIEWER_A11Y_STYLE_ID;
	style.textContent = `
		canvas.tws-viewer-canvas { outline: none; touch-action: none; }
		canvas.tws-viewer-canvas:focus-visible { outline: 2px solid var(--accent, #6ee7b7); outline-offset: -2px; }
		@media (prefers-reduced-motion: reduce) {
			canvas.tws-viewer-canvas { scroll-behavior: auto; }
		}
	`;
	document.head.appendChild(style);
}

function viewerPrefersReducedMotion() {
	return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Low-power heuristic: coarse pointer (touch) + few cores/little memory almost
// always means an entry-level phone/tablet. `deviceMemory` is Chromium-only
// and absent on iOS/Firefox, so it only ever *adds* signal, never gates alone.
// The touch requirement means desktop — mouse or trackpad, any core count —
// never matches, so default desktop behavior is unchanged. Mirrors
// avatar-sdk/src/viewer.js's identical heuristic for the lightweight SDK
// component, kept as a local copy since the two are separate bundles.
function viewerLooksLowPower() {
	if (typeof navigator === 'undefined' || typeof matchMedia === 'undefined') return false;
	const touch = matchMedia('(pointer: coarse)').matches;
	if (!touch) return false;
	const fewCores = typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 4;
	const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
	return fewCores || lowMem;
}

// Draw a small gold coin sprite on a canvas for the pump.fun trade shower, so the
// effect is self-contained (no external image asset to 404). A fresh texture is
// returned each call; the caller owns disposal.
function makeCoinTexture() {
	const size = 64;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	const r = size / 2;
	const grad = ctx.createRadialGradient(r * 0.7, r * 0.7, r * 0.2, r, r, r);
	grad.addColorStop(0, '#ffe9a8');
	grad.addColorStop(0.6, '#f4b73d');
	grad.addColorStop(1, '#b9791a');
	ctx.beginPath();
	ctx.arc(r, r, r - 2, 0, Math.PI * 2);
	ctx.fillStyle = grad;
	ctx.fill();
	ctx.lineWidth = 3;
	ctx.strokeStyle = 'rgba(255,243,205,0.85)';
	ctx.stroke();
	const tex = new CanvasTexture(canvas);
	tex.needsUpdate = true;
	return tex;
}

/**
 * @class Viewer
 *
 * @param {Element} el
 * @param {object} options
 */

/**
 * dat.GUI renders every control as a bare `<input>`/`<select>` beside a text
 * span, which leaves each one without an accessible name: a screen reader
 * announces "checkbox" with no idea what it toggles, and axe flags it on every
 * page that embeds a viewer. dat.GUI has no hook for this, so the rows are
 * labelled after the fact from the property name each row already displays.
 * @param {HTMLElement} root the GUI's DOM element
 */
function labelGUIControls(root) {
	if (!root) return;
	for (const row of root.querySelectorAll('.cr')) {
		const name = row.querySelector('.property-name')?.textContent?.trim();
		if (!name) continue;
		for (const field of row.querySelectorAll('input, select')) {
			if (!field.getAttribute('aria-label') && !field.id) field.setAttribute('aria-label', name);
		}
	}
	// Folder titles are clickable <li>s, not buttons: give them a role and a
	// name so the panel can be operated without a mouse.
	for (const title of root.querySelectorAll('li.folder > .title')) {
		if (!title.getAttribute('role')) title.setAttribute('role', 'button');
		if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '0');
	}
}

/**
 * Controls appear long after the panel is built: the animation, morph-target
 * and camera folders fill in when a model finishes loading, and refill on every
 * model swap. Labelling once at construction therefore leaves every
 * later-added row nameless, so the panel is watched and each new row labelled
 * as it arrives.
 * @param {HTMLElement} root the GUI's DOM element
 * @returns {MutationObserver|null}
 */
function watchGUIControls(root) {
	if (!root || typeof MutationObserver !== 'function') return null;
	const observer = new MutationObserver(() => labelGUIControls(root));
	observer.observe(root, { childList: true, subtree: true });
	return observer;
}

export class Viewer {
	constructor(el, options) {
		this.el = el;
		this.options = options;
		this.postToParent = options.postToParent || null;

		this.lights = [];
		this.content = null;
		this.mixer = null;
		this.clips = [];
		this.gui = null;
		this._lightProbeGrid = null;

		// External animation system (Mixamo-style)
		this.animationManager = new AnimationManager();
		this._animPanelEl = null;
		// Restart the on-demand render loop whenever an external clip starts.
		// crossfadeTo/play set currentAction asynchronously and hold no viewer
		// reference, so onChange is the only signal that a new action is live —
		// without invalidating here, a clip started after the load-reveal frames
		// settle would never tick the mixer and the avatar would freeze in its
		// bind pose (T-pose). Wired at construction so it survives kiosk mode,
		// where _setupAnimationPanel (and its own onChange) is skipped.
		this.animationManager.onChange = () => {
			if (this._animPanelEl) this._renderAnimButtons();
			this.invalidate();
		};

		this.state = {
			environment:
				options.preset === Preset.ASSET_GENERATOR
					? environments.find((e) => e.id === 'footprint-court').name
					: environments[1].name,
			background: false,
			playbackSpeed: 1.0,
			actionStates: {},
			camera: DEFAULT_CAMERA,
			wireframe: false,
			skeleton: false,
			grid: false,
			autoRotate: false,

			// Lights — studio three-point rig (key + fill + rim) plus ambient
			// base, lit by the Khronos PBR-Neutral tone mapper. Neutral keeps
			// midtone brightness and saturation instead of crushing them the way
			// ACES/Linear do, so auto-generated avatars read bright and true
			// rather than dark and muddy in gallery cards. See updateLights() and
			// viewer/lights.js for how the rig is assembled.
			punctualLights: true,
			exposure: 0.0,
			toneMapping: NeutralToneMapping,
			ambientIntensity: 0.45,
			ambientColor: '#FFFFFF',
			// The 0.8 * π factor compensates for three.js's historical
			// `irradiance *= PI` step on punctual lights and keeps direct
			// lighting visually matched to the upstream three-gltf-viewer
			// baseline. See donmccurdy/three-gltf-viewer#116 — closed as a
			// question; removing π would require a shader-side adjustment.
			directIntensity: 0.8 * Math.PI,
			directColor: '#FFFFFF',
			// Fill softens the key's shadow side; rim/back light carves the
			// silhouette out of dark backdrops so even a black-clad avatar never
			// disappears into a black card. Ratios are relative to directIntensity.
			fillRatio: 0.4,
			fillColor: '#DCE6FF',
			rimRatio: 0.55,
			rimColor: '#FFFFFF',
			// Image-based lighting strength (RoomEnvironment / HDRI). >1 lifts the
			// ambient PBR response without washing out direct highlights.
			environmentIntensity: 1.15,
			bgColor: '#000000',
			transparentBg: false,

			pointSize: 1.0,

			// Info overlay
			showInfo: true,
			showLabels: false,

			// Avatar follow mode
			followMode: 'mouse',

			// Light probe grid
			probeNx: 4,
			probeNy: 2,
			probeNz: 4,
			probeCubeFace: 64,
		};

		this.prevTime = 0;

		this.stats = new Stats();
		this.stats.dom.height = '48px';
		[].forEach.call(this.stats.dom.children, (child) => (child.style.display = ''));

		this.backgroundColor = new Color(this.state.bgColor);

		this.scene = new Scene();
		this.scene.background = this.backgroundColor;

		// The host element can still be unlaid-out at construction (hidden tab,
		// CSS not applied yet, flex parent that sizes on the next frame). A 0-px
		// renderer/composer allocates zero-dimension GL textures, which the
		// driver rejects (glTexStorage2D: dimensions must be > 0) and every
		// subsequent clear/blit/draw then fails against an incomplete
		// framebuffer. Start at 1 px and let the ResizeObserver below re-size to
		// the real box on the first frame that has one.
		const initialWidth = Math.max(1, el.clientWidth);
		const initialHeight = Math.max(1, el.clientHeight);

		const fov = options.preset === Preset.ASSET_GENERATOR ? (0.8 * 180) / Math.PI : 60;
		const aspect = el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1;
		this.defaultCamera = new PerspectiveCamera(fov, aspect, 0.01, 1000);
		this.activeCamera = this.defaultCamera;
		this.scene.add(this.defaultCamera);

		this.audioListener = new AudioListener();
		// Patch: Chrome throws TypeError("non-finite") from AudioParam when the
		// listener's world matrix contains NaN (e.g. first frame before the scene
		// graph is fully initialized). Swallow silently — position corrects next frame.
		const _alUpdate = this.audioListener.updateMatrixWorld.bind(this.audioListener);
		this.audioListener.updateMatrixWorld = (force) => {
			try { _alUpdate(force); } catch (e) {
				if (!(e instanceof TypeError)) throw e;
			}
		};
		this.defaultCamera.add(this.audioListener);

		// Quality auto-degrade: a touch device with few cores/little memory
		// (entry-level phone/tablet) skips MSAA — the single biggest GPU cost on
		// weak mobile GPUs — in exchange for a stable frame rate. Gated on a
		// coarse pointer, so desktop (mouse/trackpad) never matches — default
		// desktop behavior is unchanged.
		this._lowPower = viewerLooksLowPower();
		this.renderer = window.renderer = new WebGLRenderer({ antialias: !this._lowPower, alpha: true });
		this.renderer.setClearColor(0x000000, 1);
		// DPR cap: kiosk/embed modes default to 1.5 (saves ~40% fragment work on
		// retina). Override with options.maxPixelRatio. Standalone tabs default
		// to 2.0 to preserve sharpness on high-DPI displays. Low-power devices
		// are capped at 1.0 regardless of mode — resolution is the second
		// biggest lever after MSAA on weak mobile GPUs.
		const dprCap = this._lowPower ? 1 : (options.maxPixelRatio ?? (options.kiosk ? 1.5 : 2));
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
		this.renderer.setSize(initialWidth, initialHeight);

		// Ground contact shadow (the one rendering-quality gap vs the
		// model-viewer surfaces). Cheap when nothing casts; skipped entirely on
		// low-power devices, matching the MSAA/DPR degrade above.
		this.renderer.shadowMap.enabled = !this._lowPower;
		this.renderer.shadowMap.type = PCFShadowMap;
		this.shadowCatcher = null;

		this.pmremGenerator = new PMREMGenerator(this.renderer);
		this.pmremGenerator.compileEquirectangularShader();

		this.neutralEnvironment = this.pmremGenerator.fromScene(new RoomEnvironment()).texture;

		this.controls = new OrbitControls(this.defaultCamera, this.renderer.domElement);
		this.controls.screenSpacePanning = true;
		this._onControlsChange = () => this.invalidate();
		this.controls.addEventListener('change', this._onControlsChange);
		// prefers-reduced-motion: OrbitControls damping (inertial drift after
		// pointer release) is opt-in in three.js and defaults off, so there's
		// nothing to disable here — this flag only gates the keyboard-orbit
		// step size below, keeping motion-sensitive users' arrow-key input
		// snappy/discrete rather than smoothed.
		this._reducedMotion = viewerPrefersReducedMotion();

		this.el.appendChild(this.renderer.domElement);

		// Accessibility: the canvas is the primary interactive surface but has
		// no accessible name or keyboard path by default. Make it a reachable,
		// labeled, orbit/zoom-able control — mirrors the SDK's lightweight
		// <three-ws-viewer> (avatar-sdk/src/viewer.js) so keyboard behavior is
		// consistent whichever viewer a page embeds.
		ensureViewerA11yStyles();
		const canvasEl = this.renderer.domElement;
		canvasEl.classList.add('tws-viewer-canvas');
		canvasEl.tabIndex = 0;
		canvasEl.setAttribute('role', 'img');
		canvasEl.setAttribute('aria-label', options.alt || options.title || '3D model viewer. Focus and use arrow keys to orbit, +/- to zoom.');
		this._onCanvasKeyDown = (e) => this._handleOrbitKeydown(e);
		canvasEl.addEventListener('keydown', this._onCanvasKeyDown);

		// Post-processing: the CinematicPipeline owns the full post chain (SSAO,
		// depth-of-field, bloom, colour grade, chromatic aberration, film grain,
		// vignette) behind selectable presets. The default 'Studio' preset
		// reproduces the historical look exactly — subtle bloom + vignette, nothing
		// else — so gallery thumbnails and embeds are unchanged unless a user opts
		// into a richer look. Screenshot capture bypasses this — see screenshot.js.
		this.state.cinematicPreset = options.cinematicPreset ?? DEFAULT_CINEMATIC_PRESET;
		this._cinematic = new CinematicPipeline(this.renderer, this.scene, this.activeCamera, {
			width: initialWidth,
			height: initialHeight,
			preset: this.state.cinematicPreset,
		});
		this._composer = this._cinematic.composer;

		this.cameraCtrl = null;
		this.cameraFolder = null;
		this.animFolder = null;
		this.animCtrls = [];
		this.morphFolder = null;
		this.morphCtrls = [];
		this.skeletonHelpers = [];
		this.gridHelper = null;
		this.axesHelper = null;
		this.modelInfo = null;
		this.annotationEls = [];
		this._tempVec = new Vector3();

		this.addAxesHelper();
		this.addGUI();
		if (options.kiosk) this.gui.close();

		this.animate = this.animate.bind(this);
		this._rafId = null;
		this._visible = true;
		this._tabVisible = !document.hidden;
		this._disposed = false;
		this._loadedEnvironment = null;
		this._guiWrap = null;
		this._needsRender = true;
		this._animating = false;

		this._onVisibilityChange = () => {
			const wasHidden = !this._tabVisible;
			this._tabVisible = !document.hidden;
			if (wasHidden && this._tabVisible) this._needsRender = true;
			this._updateRenderLoop();
		};
		document.addEventListener('visibilitychange', this._onVisibilityChange);

		if (typeof IntersectionObserver !== 'undefined') {
			this._intersectionObserver = new IntersectionObserver(
				(entries) => {
					const wasHidden = !this._visible;
					this._visible = entries[entries.length - 1].isIntersecting;
					if (wasHidden && this._visible) this._needsRender = true;
					this._updateRenderLoop();
				},
				{ threshold: 0 },
			);
			this._intersectionObserver.observe(this.el);
		}

		// Coalesce resize bursts (a window drag, or the ResizeObserver firing
		// alongside the window 'resize' event) into one resize() per animation
		// frame — resize() reallocates the renderer + composer framebuffers and
		// may re-frame the model, which is wasteful to run several times per
		// frame. _resizeRaf holds the pending frame id; resize() runs once when
		// it fires.
		this._resizeRaf = null;
		this._onResize = () => {
			if (this._resizeRaf != null) return;
			this._resizeRaf = requestAnimationFrame(() => {
				this._resizeRaf = null;
				if (!this._disposed) this.resize();
			});
		};
		this._onKeyDown = (e) => {
			if (this.isInputFocused()) return;
			if (e.key === 'p' || e.key === 'P') {
				this.takeScreenshot();
			} else if (e.code === 'Space') {
				e.preventDefault();
				this.toggleAnimationPlayback();
			} else if (e.key === 'f' || e.key === 'F') {
				this.frameContent();
			}
		};

		this._onDblClick = () => this.frameContent({ animate: true });
		this._onMessage = this.onMessage.bind(this);

		this._updateRenderLoop();
		window.addEventListener('resize', this._onResize, false);
		window.addEventListener('keydown', this._onKeyDown);
		this.renderer.domElement.addEventListener('dblclick', this._onDblClick);
		window.addEventListener('message', this._onMessage, false);

		// Track the host element's own box (not just the window) so the canvas
		// follows when the embed wrap is resized, the page lays out late, or a
		// flex/grid parent reflows.
		if (typeof ResizeObserver !== 'undefined') {
			this._ro = new ResizeObserver(() => this._onResize());
			this._ro.observe(this.el);
		}
	}

	// Keyboard-only orbit + zoom for users who can't drag a pointer: arrow keys
	// rotate azimuth/polar around the current OrbitControls target, +/- and
	// PageUp/PageDown dolly. Scoped to the canvas element's own keydown (only
	// fires while the canvas has focus) so it never steals arrow-key
	// scroll/navigation elsewhere on the host page. Step sizes match
	// avatar-sdk/src/viewer.js's keyboard orbit for a consistent feel across
	// every three.ws viewer surface; reduced-motion halves the step so users
	// who asked for less motion get finer, calmer control instead of smoothing.
	_handleOrbitKeydown(event) {
		if (!this.controls || !this.activeCamera) return;
		const stepScale = this._reducedMotion ? 0.5 : 1;
		const rotateStep = 0.05 * stepScale;
		const zoomStep = 1.08;
		const offset = this._tempVec.subVectors(this.activeCamera.position, this.controls.target);
		const spherical = new Spherical().setFromVector3(offset);
		let handled = true;
		switch (event.key) {
			case 'ArrowLeft': spherical.theta -= rotateStep; break;
			case 'ArrowRight': spherical.theta += rotateStep; break;
			case 'ArrowUp': spherical.phi = Math.max(0.05, spherical.phi - rotateStep); break;
			case 'ArrowDown': spherical.phi = Math.min(Math.PI - 0.05, spherical.phi + rotateStep); break;
			case '+':
			case '=':
			case 'PageUp': spherical.radius /= zoomStep; break;
			case '-':
			case '_':
			case 'PageDown': spherical.radius *= zoomStep; break;
			default: handled = false;
		}
		if (!handled) return;
		event.preventDefault();
		event.stopPropagation();
		const newOffset = new Vector3().setFromSpherical(spherical);
		this.activeCamera.position.copy(this.controls.target).add(newOffset);
		this.controls.update();
		this.invalidate();
	}

	setCameraTarget(boneName) {
		if (!this.content) return;
		const bone = this.content.getObjectByName(boneName);
		if (bone) {
			const target = new Vector3();
			bone.getWorldPosition(target);
			this._tweenCamera(this.defaultCamera.position, target, 600);
		}
	}

	invalidate() {
		if (this._disposed) return;
		this._needsRender = true;
		this._updateRenderLoop();
	}

	onMessage(e) {
		if (!e.data || typeof e.data !== 'object' || !e.data.op) return;
		// SECURITY: Check origin if we ever handle sensitive ops. For gesture/emote,
		// it's fine to be promiscuous so any parent window can control the avatar.

		switch (e.data.op) {
			case 'gesture':
				this.onGesture(e.data.payload);
				break;
			case 'get_clips': {
				if (!this.postToParent) return;
				const clips = this.clips.map((c) => ({
					name: c.name,
					loop: true, // Assume baked-in clips loop by default
					source: 'glb',
				}));
				this.postToParent({ __agent: true, type: 'clips', clips });
				break;
			}
			case 'clips':
				// This is one-way for now; the embed doesn't need to receive clips.
				break;
			default:
				log.warn(`[a-embed] unhandled op: ${e.data.op}`);
		}
	}

	async onGesture(payload) {
		if (!payload || !payload.name) return;
		const { name, loop } = payload;

		// If the name looks like an API clip id (uuid or user:<id> prefix), load it
		// from the API before trying the manifest. This lets embeds trigger user
		// animations by id through the same postMessage channel as built-ins.
		let ready = await this.animationManager.ensureLoaded(name);
		if (!ready && (name.startsWith('user:') || /^[0-9a-f-]{36}$/i.test(name))) {
			try {
				const clipId = name.startsWith('user:') ? name.slice(5) : name;
				await this.playAnimationById(clipId);
				return;
			} catch {
				/* fall through — clip not found or private */
			}
		}
		if (!ready) return;

		const action = this.animationManager.actions.get(name);
		if (action) {
			action.setLoop(loop ? LoopRepeat : LoopOnce);
			if (!loop) action.clampWhenFinished = true;
		}

		this.animationManager.play(name);
	}

	// Per-agent scene preferences (background, environment, exposure, etc.)
	// persisted to localStorage. Call attachScenePrefs(agentId) once per
	// session — it restores the saved values into state and starts auto-saving
	// future tweaks.
	attachScenePrefs(agentId) {
		if (!agentId || typeof window === 'undefined') return;
		this._prefsKey = `3dagent:scene:${agentId}`;

		try {
			const raw = localStorage.getItem(this._prefsKey);
			if (raw) {
				const saved = JSON.parse(raw);
				const KEYS = [
					'background',
					'transparentBg',
					'bgColor',
					'autoRotate',
					'exposure',
					'environment',
					'cinematicPreset',
				];
				let touched = false;
				for (const key of KEYS) {
					if (saved[key] !== undefined && saved[key] !== this.state[key]) {
						this.state[key] = saved[key];
						touched = true;
					}
				}
				if (touched) {
					this.backgroundColor.set(this.state.bgColor);
					this.updateLights();
					this.updateEnvironment();
					this.updateDisplay();
					this.updateBackground();
					this._cinematic?.applyPreset(this.state.cinematicPreset);
					this.updateGUI?.();
				}
			}
		} catch {
			/* ignore corrupt prefs */
		}

		const save = () => {
			if (!this._prefsKey) return;
			try {
				const snapshot = {
					background: this.state.background,
					transparentBg: this.state.transparentBg,
					bgColor: this.state.bgColor,
					autoRotate: this.state.autoRotate,
					exposure: this.state.exposure,
					environment: this.state.environment,
					cinematicPreset: this.state.cinematicPreset,
				};
				localStorage.setItem(this._prefsKey, JSON.stringify(snapshot));
			} catch {
				/* quota or disabled storage */
			}
		};
		// Debounce to avoid hammering localStorage while users drag a slider.
		let timer = null;
		this._scenePrefsSave = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(save, 250);
		};
	}

	// Public hook — controllers (dat.gui, drawer UI) call this after a state
	// change so we persist the latest value.
	notifyScenePrefChange() {
		if (this._scenePrefsSave) this._scenePrefsSave();
	}

	// Spacebar handler: pause/resume the active animation, or play the first
	// available one if nothing is currently selected.
	toggleAnimationPlayback() {
		const a = this.animationManager;
		if (!a) return;
		if (a.currentAction) {
			a.currentAction.paused = !a.currentAction.paused;
			this.invalidate();
			this._recomputeAnimating();
			this._updateRenderLoop();
			return;
		}
		const defs = a.getAnimationDefs?.() || [];
		const first = defs.find((d) => a.isLoaded?.(d.name));
		if (first) {
			a.play(first.name);
			this.invalidate();
			this._recomputeAnimating();
			this._updateRenderLoop();
		}
	}

	// Frame the loaded model with a flattering 3/4 angle. Optionally animates
	// the camera over a short duration ("F" key snaps; double-click animates).
	frameContent({ animate = false, durationMs = 600 } = {}) {
		if (!this.content || !this.defaultCamera || !this.controls) return;
		const box = new Box3().setFromObject(this.content);
		const bbSize = box.getSize(new Vector3());
		const size = bbSize.length();
		if (!isFinite(size) || size === 0) return;
		const bbCenter = box.getCenter(new Vector3());

		const vFovRad = this.defaultCamera.fov * (Math.PI / 180);
		const aspect = Math.max(this.defaultCamera.aspect, 0.01);
		const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);

		const panelFrac = this._panelFrac();
		const usableFrac = Math.max(1 - panelFrac, 0.55);

		// Padding around the model. 1.25 leaves ~12.5% margin per side so the
		// avatar isn't clipped at idle and stays mostly visible during animations
		// with root motion (Death, Jump, etc).
		const PAD_V = 1.25;
		const PAD_H = 1.15;

		// `portrait` framing crops to head-to-mid-thigh so the avatar fills the
		// frame in a wide/short card; `full` is unchanged (baseY == bbCenter.y).
		const framingMode = this.options?.framing === 'portrait' ? 'portrait' : 'full';
		const { visH, baseY } = computeFramingExtent(bbSize.y, box.max.y, framingMode);

		// Sit the camera in front of the avatar's face, whichever way its rig
		// was authored; yaw 0 (no readable rig) keeps the historical +Z seat.
		const yaw = estimateFacingYaw(this.content, bbSize.y) ?? 0;
		const forward = forwardFromYaw(yaw);

		const extentV = (visH / 2) * PAD_V / usableFrac;
		const distV = extentV / Math.tan(vFovRad / 2);
		const framingWidth = computeFramingWidth(horizontalExtentAt(bbSize.x, bbSize.z, yaw), bbSize.y, framingMode);
		const distH = (framingWidth / 2) * PAD_H / Math.tan(hFovRad / 2);
		const dist = Math.max(distV, distH);

		// Center look-at on the usable area: with no panel focusY = baseY;
		// with a bottom panel, shift down so the avatar rises into the upper area.
		const focusY = baseY - extentV * panelFrac;
		const target = new Vector3(bbCenter.x, focusY, bbCenter.z);
		const pos = new Vector3(
			bbCenter.x + forward.x * dist,
			focusY,
			bbCenter.z + forward.z * dist,
		);

		if (animate) {
			this._tweenCamera(pos, target, durationMs);
		} else {
			this.defaultCamera.position.copy(pos);
			this.controls.target.copy(target);
			this.controls.update();
			this.invalidate();
		}
	}

	/**
	 * Switch the framing mode ('full' | 'portrait') at runtime and re-frame.
	 * Used by the <agent-3d> `framing` attribute so an embed can opt into the
	 * head-to-mid-thigh crop without reloading the model.
	 * @param {'full'|'portrait'} mode
	 */
	setFraming(mode) {
		const next = mode === 'portrait' ? 'portrait' : 'full';
		if (!this.options) this.options = {};
		if (this.options.framing === next) return;
		this.options.framing = next;
		if (this.content) this.frameContent({ animate: true });
	}

	/** Fraction of canvas height occupied by the animation panel (0 when no panel). */
	_panelFrac() {
		if (!this._animPanelEl) return 0;
		const ph = this._animPanelEl.offsetHeight;
		const pb = parseFloat(getComputedStyle(this._animPanelEl).bottom) || 0;
		const ch = this.renderer.domElement.clientHeight;
		if (!ch) return 0;
		return Math.min((ph + pb) / ch, 0.45);
	}

	// Smooth ease-out camera tween. Both position and OrbitControls.target
	// are interpolated together so the framing stays correct mid-flight.
	_tweenCamera(toPos, toTarget, durationMs = 600) {
		if (this._cameraTweenRaf) cancelAnimationFrame(this._cameraTweenRaf);
		const fromPos = this.defaultCamera.position.clone();
		const fromTarget = this.controls.target.clone();
		const start = performance.now();
		const ease = (t) => 1 - Math.pow(1 - t, 3); // cubic ease-out
		const step = (now) => {
			const t = Math.min(1, (now - start) / durationMs);
			const k = ease(t);
			this.defaultCamera.position.lerpVectors(fromPos, toPos, k);
			this.controls.target.lerpVectors(fromTarget, toTarget, k);
			this.controls.update();
			this.invalidate();
			if (t < 1 && !this._disposed) {
				this._cameraTweenRaf = requestAnimationFrame(step);
			} else {
				this._cameraTweenRaf = null;
			}
		};
		this._cameraTweenRaf = requestAnimationFrame(step);
	}

	_recomputeAnimating() {
		let animating = false;
		if (this.state && this.state.autoRotate) animating = true;
		if (!animating && this.mixer && this.state) {
			for (const key in this.state.actionStates) {
				if (this.state.actionStates[key]) {
					animating = true;
					break;
				}
			}
		}
		// External animation manager also drives the render loop
		if (!animating && this.animationManager.currentAction) {
			animating = true;
		}
		this._animating = animating;
	}

	_updateRenderLoop() {
		if (this._disposed) return;
		const canRun = this._visible && this._tabVisible;
		const shouldRun = canRun && (this._needsRender || this._animating);
		if (shouldRun && this._rafId === null) {
			this.prevTime = performance.now();
			this._rafId = requestAnimationFrame(this.animate);
		} else if (!canRun && this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
	}

	animate(time) {
		const dt = (time - this.prevTime) / 1000;
		this.prevTime = time;

		this._recomputeAnimating();

		this.controls.update();
		this.stats.update();
		if (this.mixer) this.mixer.update(dt);
		this.animationManager.update(dt);
		if (this._lightProbeGrid) this._lightProbeGrid.update(this.activeCamera.position);

		// Extension point for the AgentAvatar empathy tick and any other per-frame hooks
		if (this._afterAnimateHooks) {
			for (let i = 0; i < this._afterAnimateHooks.length; i++) {
				this._afterAnimateHooks[i](dt);
			}
		}

		this.render(dt);
		this._needsRender = false;

		if (this._animating && this._visible && this._tabVisible && !this._disposed) {
			this._rafId = requestAnimationFrame(this.animate);
		} else {
			this._rafId = null;
		}
	}

	isInputFocused() {
		const el = document.activeElement;
		return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
	}

	getHeadScreenPosition() {
		if (!this.content || !this.activeCamera || !this.renderer) return null;
		let headBone = null, neckBone = null;
		this.content.traverse((obj) => {
			if (!obj.isBone) return;
			const canon = obj.name.replace(/^mixamorig/i, '').replace(/^.*[:_]/, '').toLowerCase();
			if (!headBone && canon === 'head') headBone = obj;
			else if (!neckBone && canon === 'neck') neckBone = obj;
		});
		const bone = headBone || neckBone;
		if (!bone) return null;
		const pos = new Vector3();
		bone.getWorldPosition(pos);
		pos.project(this.activeCamera);
		const canvas = this.renderer.domElement;
		return {
			x: (pos.x * 0.5 + 0.5) * canvas.clientWidth,
			y: (-pos.y * 0.5 + 0.5) * canvas.clientHeight,
		};
	}

	render(deltaTime = 0) {
		// Additive bloom bleeds bright highlights into neighbouring pixels —
		// including the alpha-0 background. Over a transparent canvas that halo
		// composites onto the host page as a washed-out "box" around the avatar
		// (very visible on light backgrounds). For transparent embeds we skip the
		// bloom/vignette pass and render the scene straight to the canvas so it
		// composites cleanly; opaque/studio backgrounds keep the cinematic pass.
		if (this.state.transparentBg) {
			this.renderer.render(this.scene, this.activeCamera);
		} else {
			this._cinematic.render(deltaTime);
		}
		if (this.state.grid) {
			this._ensureAxesRenderer();
			this.axesCamera.position.copy(this.defaultCamera.position);
			this.axesCamera.lookAt(this.axesScene.position);
			this.axesRenderer.render(this.axesScene, this.axesCamera);
		}
		this.projectAnnotations();
	}

	showPumpFunTrades() {
		// Re-entrant guard: a second call while a shower is live would orphan the
		// first's geometry/material/texture and stack animate hooks.
		if (this._pumpFunFx || this._disposed) return;

		const particleCount = 1000;
		const particles = new BufferGeometry();
		const positions = new Float32Array(particleCount * 3);
		const coinTexture = makeCoinTexture();

		for (let i = 0; i < particleCount; i++) {
			positions[i * 3] = (Math.random() * 2 - 1) * 10;
			positions[i * 3 + 1] = Math.random() * 20;
			positions[i * 3 + 2] = (Math.random() * 2 - 1) * 10;
		}

		particles.setAttribute('position', new BufferAttribute(positions, 3));

		const particleMaterial = new PointsMaterial({
			map: coinTexture,
			size: 0.5,
			transparent: true,
			alphaTest: 0.5,
		});

		const particleSystem = new Points(particles, particleMaterial);
		this.scene.add(particleSystem);

		const animateParticles = () => {
			const pos = particleSystem.geometry.attributes.position.array;
			for (let i = 0; i < particleCount; i++) {
				pos[i * 3 + 1] -= 0.1;
				if (pos[i * 3 + 1] < -10) {
					pos[i * 3 + 1] = 20;
				}
			}
			particleSystem.geometry.attributes.position.needsUpdate = true;
			this.invalidate();
		};

		if (!this._afterAnimateHooks) {
			this._afterAnimateHooks = [];
		}
		this._afterAnimateHooks.push(animateParticles);

		this._pumpFunFx = { particleSystem, particles, particleMaterial, coinTexture, animateParticles };
		this._pumpFunTimer = setTimeout(() => this._clearPumpFunTrades(), 10000);
	}

	// Tear down the pump.fun coin shower: detach the animate hook, remove from the
	// scene, and dispose every GPU resource it allocated. Idempotent.
	_clearPumpFunTrades() {
		if (this._pumpFunTimer) {
			clearTimeout(this._pumpFunTimer);
			this._pumpFunTimer = null;
		}
		const fx = this._pumpFunFx;
		if (!fx) return;
		this._pumpFunFx = null;
		if (this._afterAnimateHooks) {
			const index = this._afterAnimateHooks.indexOf(fx.animateParticles);
			if (index > -1) this._afterAnimateHooks.splice(index, 1);
		}
		this.scene.remove(fx.particleSystem);
		fx.particles.dispose();
		fx.particleMaterial.dispose();
		fx.coinTexture.dispose();
		this.invalidate();
	}

	takeScreenshot() {
		takeScreenshot(this);
	}

	captureScreenshot() {
		return captureScreenshot(this);
	}

	async bakeLightProbes() {
		if (!this.content) {
			log.warn('LightProbeGrid: load a model first');
			return;
		}

		if (this._lightProbeGrid) {
			this._lightProbeGrid.removeFromScene(this.scene);
			this._lightProbeGrid.dispose();
		}

		const bounds = new Box3().setFromObject(this.content);
		// Expand slightly so probes sit inside the volume, not on surface.
		bounds.expandByScalar(0.5);

		const { probeNx, probeNy, probeNz, probeCubeFace } = this.state;
		const grid = new LightProbeGrid(probeNx, probeNy, probeNz, bounds);

		let progressEl = this.el.querySelector('.lpg-progress');
		if (!progressEl) {
			progressEl = document.createElement('div');
			progressEl.className = 'lpg-progress';
			progressEl.style.cssText =
				'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);' +
				'background:rgba(0,0,0,.7);color:#fff;font:12px/1.5 monospace;' +
				'padding:6px 12px;border-radius:4px;pointer-events:none;z-index:100';
			this.el.appendChild(progressEl);
		}
		progressEl.textContent = 'Baking probes… 0%';
		progressEl.style.display = 'block';

		try {
			await grid.bake(this.renderer, this.scene, probeCubeFace, (t) => {
				progressEl.textContent = `Baking probes… ${Math.round(t * 100)}%`;
			});
		} catch (err) {
			log.error('LightProbeGrid bake failed:', err);
			return;
		} finally {
			progressEl.style.display = 'none';
		}

		this._lightProbeGrid = grid;
		grid.addToScene(this.scene);

		log.log(`LightProbeGrid baked: ${probeNx}×${probeNy}×${probeNz} cells`);
	}

	saveLightProbes() {
		if (!this._lightProbeGrid) {
			log.warn('LightProbeGrid: bake or load a grid first');
			return;
		}
		const json = JSON.stringify(this._lightProbeGrid.toJSON());
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'light-probe-grid.json';
		a.click();
		URL.revokeObjectURL(url);
	}

	loadLightProbes() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.onchange = async (e) => {
			const file = e.target.files[0];
			if (!file) return;
			const text = await file.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				log.error('LightProbeGrid: invalid JSON file');
				return;
			}
			if (this._lightProbeGrid) {
				this._lightProbeGrid.removeFromScene(this.scene);
				this._lightProbeGrid.dispose();
			}
			this._lightProbeGrid = LightProbeGrid.fromJSON(json);
			this._lightProbeGrid.addToScene(this.scene);
			log.log(`LightProbeGrid loaded: ${json.nx}×${json.ny}×${json.nz} cells`);
		};
		input.click();
	}

	/**
	 * Update the AR button visibility and target URLs after a model loads.
	 * @param {string|null} glbUrl  — absolute or relative URL to the GLB (for Android/WebXR)
	 * @param {string|null} usdzUrl — absolute or relative URL to a USDZ (for iOS Quick Look)
	 */
	async setARTarget(glbUrl, usdzUrl = null) {
		this._arGlbUrl = glbUrl;
		this._arUsdzUrl = usdzUrl;

		if (!this._arBtn) return;

		const hasGlb = !!glbUrl;
		const hasUsdz = !!usdzUrl;

		const iosOk = hasUsdz && canUseQuickLook();
		const androidOk = hasGlb && canUseSceneViewer();
		const webxrOk = hasGlb && (await WebXRSession.isSupported());

		this._arBtn.hidden = !(iosOk || androidOk || webxrOk);
	}

	async _launchAR() {
		if (canUseQuickLook() && this._arUsdzUrl) {
			openQuickLook(this._arUsdzUrl);
		} else if (canUseSceneViewer() && this._arGlbUrl) {
			openSceneViewer(this._arGlbUrl);
		} else if (this._arGlbUrl) {
			// Desktop WebXR
			if (this._xrSession) {
				await this._xrSession.end();
				this._xrSession = null;
				this._arBtn.classList.remove('ar-btn--active');
				return;
			}
			this._xrSession = new WebXRSession(this, {
				onEnd: () => {
					this._xrSession = null;
					this._arBtn.classList.remove('ar-btn--active');
				},
			});
			await this._xrSession.start();
			this._arBtn.classList.add('ar-btn--active');
		}
	}

	resize() {
		const { clientHeight, clientWidth } = this.el;
		if (clientWidth === 0 || clientHeight === 0) return;

		const prevAspect = this.defaultCamera.aspect;
		const nextAspect = clientWidth / clientHeight;
		this.defaultCamera.aspect = nextAspect;
		this.defaultCamera.updateProjectionMatrix();
		this.renderer.setSize(clientWidth, clientHeight);
		this._composer?.setSize(clientWidth, clientHeight);

		this.axesCamera.aspect = this.axesDiv.clientWidth / this.axesDiv.clientHeight;
		this.axesCamera.updateProjectionMatrix();
		this.axesRenderer?.setSize(this.axesDiv.clientWidth, this.axesDiv.clientHeight);

		// Re-frame so the full avatar stays visible after the canvas changes
		// shape — the initial framing uses the aspect at load time, which is
		// often stale (e.g. before ResizeObserver kicks in on first paint).
		if (this.content && Math.abs(nextAspect - prevAspect) > 0.001) {
			this.frameContent();
		}

		this.invalidate();
	}

	load(url, rootPath, assetMap, onProgress) {
		const baseURL = LoaderUtils.extractUrlBase(url);
		// Remember the source URL so the animation manager's fallen-pose guard can
		// report which avatar produced a broken retarget (passed to attach below).
		this._sourceUrl = url;

		// Load.
		return new Promise((resolve, reject) => {
			// Intercept and override relative URLs.
			MANAGER.setURLModifier((url, path) => {
				// Repair retired IPFS gateway hosts (cf-ipfs.com /
				// cloudflare-ipfs.com) and resolve ipfs://, ar:// schemes.
				let finalUrl = normalizeGatewayURL(url);

				if (isDecentralizedURI(finalUrl)) {
					return resolveURI(finalUrl);
				}

				// URIs in a glTF file may be escaped, or not. Assume that assetMap is
				// from an un-escaped source, and decode all URIs before lookups.
				// See: https://github.com/nirholas/three.ws/issues/146
				const normalizedURL =
					rootPath +
					decodeURI(finalUrl)
						.replace(baseURL, '')
						.replace(/^(\.?\/)/, '');

				if (assetMap.has(normalizedURL)) {
					const blob = assetMap.get(normalizedURL);
					const blobURL = URL.createObjectURL(blob);
					blobURLs.push(blobURL);
					return blobURL;
				}

				return (path || '') + finalUrl;
			});

			const blobURLs = [];

			getDecoders().then(({ dracoLoader, ktx2Loader, meshoptDecoder }) => {
				const loader = new GLTFLoader(MANAGER)
					.setCrossOrigin('anonymous')
					.setDRACOLoader(dracoLoader)
					.setKTX2Loader(ktx2Loader.detectSupport(this.renderer))
					.setMeshoptDecoder(meshoptDecoder);

				loader.load(
					url,
					(gltf) => {
						if (window.VIEWER) window.VIEWER.json = gltf;

						const scene = gltf.scene || gltf.scenes[0];
						const clips = gltf.animations || [];

						if (!scene) {
							// Valid, but not supported by this viewer.
							throw new Error(
								'This model contains no scene, and cannot be viewed here. However,' +
									' it may contain individual 3D resources.',
							);
						}

						this.setContent(scene, clips);

						blobURLs.forEach(URL.revokeObjectURL);

						// See: https://github.com/google/draco/issues/349
						// DRACOLoader.releaseDecoderModule();

						resolve(gltf);
					},
					// XHR progress events while the GLB streams down. The `total`
					// field is only populated when the server sends a
					// Content-Length header — R2 does, our blob URLs do not.
					typeof onProgress === 'function'
						? (xhr) => {
								try {
									onProgress(xhr);
								} catch (e) {
									log.warn('[viewer] onProgress threw', e);
								}
							}
						: undefined,
					reject,
				);
			}, reject);
		});
	}

	/**
	 * @param {THREE.Object3D} object
	 * @param {Array<THREE.AnimationClip} clips
	 */
	// Soft ground contact shadow: a ShadowMaterial plane just under the
	// recentered model (feet sit at -bbSize.y/2 after setContent recentering).
	// Created once, then resized/repositioned per load; invisible except where
	// the shadow_light's shadow falls, so it composes with any bgColor.
	_updateShadowCatcher(bbSize) {
		if (this._lowPower) return;
		if (!isFinite(bbSize.x) || !isFinite(bbSize.y) || !isFinite(bbSize.z)) return;
		if (!this.shadowCatcher) {
			this.shadowCatcher = new Mesh(
				new PlaneGeometry(1, 1),
				new ShadowMaterial({ opacity: 0.25, depthWrite: false }),
			);
			this.shadowCatcher.rotation.x = -Math.PI / 2;
			this.shadowCatcher.receiveShadow = true;
			this.shadowCatcher.name = 'shadow_catcher';
			this.scene.add(this.shadowCatcher);
		}
		const span = Math.max(bbSize.x, bbSize.z, 0.5) * 3;
		this.shadowCatcher.scale.set(span, span, 1);
		this.shadowCatcher.position.y = -bbSize.y / 2 + 0.002;

		// Fit the caster's frustum to the model so shadow texels aren't wasted
		// on a prop or clipped on an oversized scene.
		const sun = this.lights.find((l) => l.name === 'shadow_light');
		if (sun) {
			const r = Math.max(bbSize.x, bbSize.y, bbSize.z, 0.5) * 1.2;
			sun.position.set(r * 0.4, r * 1.6, r * 0.7); // keep the overhead angle at any scale
			const cam = sun.shadow.camera;
			cam.left = -r;
			cam.right = r;
			cam.top = r;
			cam.bottom = -r;
			cam.near = 0.1;
			cam.far = r * 4;
			cam.updateProjectionMatrix();
		}
	}

	setContent(object, clips) {
		this.clear();

		object.updateMatrixWorld(); // nirholas/3d-agent#330

		const box = new Box3().setFromObject(object);
		const size = box.getSize(new Vector3()).length();
		const center = box.getCenter(new Vector3());

		this.controls.reset();

		// Guard: empty bounding box (no geometry / all-invisible meshes) yields
		// Infinity center → NaN after subtraction, which corrupts world matrices
		// and causes AudioParam "non-finite" throws in PositionalAudio.updateMatrixWorld.
		if (isFinite(center.x) && isFinite(center.y) && isFinite(center.z)) {
			object.position.x -= center.x;
			object.position.y -= center.y;
			object.position.z -= center.z;
		}

		this.controls.maxDistance = isFinite(size) && size > 0 ? size * 10 : 10;

		this.defaultCamera.near = isFinite(size) && size > 0 ? size / 100 : 0.01;
		this.defaultCamera.far = isFinite(size) && size > 0 ? size * 100 : 1000;
		this.defaultCamera.updateProjectionMatrix();

		// Add content and build the animation panel BEFORE computing the camera
		// so the panel's rendered height is available for panel-aware framing.
		this.scene.add(object);
		// Avatars are authored with +Z as their forward axis (see
		// _trackBodyToCamera in agent-avatar.js, which faces them via
		// atan2(dx, dz)). The framing camera sits on +Z looking at origin,
		// so a zero yaw already presents the front. Do NOT flip 180° here —
		// that turns every static preview (dashboard card, kiosk embed)
		// around to show the avatar's back.
		object.rotation.y = 0;
		this.content = object;

		// Build BVH acceleration structures for every mesh geometry so raycasting
		// (hover / click interactions) is O(log n) instead of O(n) on triangle count.
		object.traverse((node) => {
			if (node.isMesh && node.geometry) {
				node.geometry.computeBoundsTree();
				node.castShadow = true;
			}
		});

		// Skin/eye/hair realism pass — name-matched, so props and non-humanoid
		// meshes are never touched. See src/shared/avatar-material-realism.js.
		if (looksLikeAvatarMesh(object)) {
			applyAvatarMaterialRealism(object);
		}

		this.state.punctualLights = true;
		this.content.traverse((node) => {
			if (node.isLight) {
				this.state.punctualLights = false;
			}
		});

		this.setClips(clips);
		this.animationManager.attach(this.content, { avatarUrl: this._sourceUrl || '' });
		this._setupAnimationPanel();

		// _panelFrac() reads offsetHeight after _setupAnimationPanel has
		// populated the panel DOM, which forces a synchronous reflow.
		const panelFrac = this._panelFrac();
		const usableFrac = Math.max(1 - panelFrac, 0.55);

		// Compute camera distance so the full avatar fits in the usable viewport
		// area (above the animation panel) with breathing room above/below.
		const bbSize = box.getSize(new Vector3());
		const vFovRad = this.defaultCamera.fov * (Math.PI / 180);
		const aspect = Math.max(this.defaultCamera.aspect, 0.01);
		const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);

		// Same padding as frameContent() — keep both code paths in sync.
		const PAD_V = 1.25;
		const PAD_H = 1.15;

		// Model has been recentered so the body spans [-bbSize.y/2, +bbSize.y/2]
		// and the crown is at +bbSize.y/2. `portrait` crops to head-to-mid-thigh;
		// `full` reduces to the original full-body framing (baseY == 0).
		const framingMode = this.options?.framing === 'portrait' ? 'portrait' : 'full';
		const { visH, baseY } = computeFramingExtent(bbSize.y, bbSize.y / 2, framingMode);

		// Same front-on seat as frameContent(): read the rig's facing rather
		// than assuming the avatar was authored looking down +Z.
		const yaw = estimateFacingYaw(this.content, bbSize.y) ?? 0;
		const forward = forwardFromYaw(yaw);

		const extentV = (visH / 2) * PAD_V / usableFrac;
		const distV = extentV / Math.tan(vFovRad / 2);
		const framingWidth = computeFramingWidth(horizontalExtentAt(bbSize.x, bbSize.z, yaw), bbSize.y, framingMode);
		const distH = (framingWidth / 2) * PAD_H / Math.tan(hFovRad / 2);
		const dist = Math.max(distV, distH);

		// Center the look-at on the usable area: with no panel focusY=baseY;
		// with a bottom panel shift down so the avatar rises into the usable
		// upper portion of the canvas.
		const focusY = baseY - extentV * panelFrac;

		// Final framed camera (the position the user should end up at).
		// Avatar sits dead-centered front-on by default: no lateral offset, and
		// the seat rotates with the rig's facing so "front" means the face.
		const framedPos = new Vector3();
		if (this.options.cameraPosition) {
			framedPos.fromArray(this.options.cameraPosition);
		} else {
			framedPos.set(forward.x * dist, focusY, forward.z * dist);
		}
		const orbitalTarget = new Vector3(0, focusY, 0);

		// In kiosk / embed modes (and on subsequent loads), snap straight to
		// the framed position. On the first interactive load we tween in from
		// a slightly wider angle so the reveal feels intentional.
		const skipReveal =
			this.options.kiosk || this.options.cameraPosition || this._hasRevealed === true;

		if (skipReveal) {
			this.defaultCamera.position.copy(framedPos);
			this.defaultCamera.lookAt(orbitalTarget);
		} else {
			// Start ~40% wider and slightly higher, then ease into the framed pose.
			const startPos = new Vector3()
				.subVectors(framedPos, orbitalTarget)
				.multiplyScalar(1.4)
				.add(orbitalTarget);
			startPos.y += size / 8;
			this.defaultCamera.position.copy(startPos);
			this.defaultCamera.lookAt(orbitalTarget);
			this._pendingReveal = { framedPos: framedPos.clone(), target: orbitalTarget.clone() };
			this._hasRevealed = true;
		}

		this.setCamera(DEFAULT_CAMERA);

		this.axesCamera.position.copy(this.defaultCamera.position);
		this.axesCamera.lookAt(this.axesScene.position);
		this.axesCamera.near = size / 100;
		this.axesCamera.far = size * 100;
		this.axesCamera.updateProjectionMatrix();
		this.axesCorner.scale.set(size, size, size);

		this.controls.target.copy(orbitalTarget);
		this.controls.update();
		this.controls.saveState();

		this.updateLights();
		this._updateShadowCatcher(bbSize); // after updateLights so shadow_light exists to fit
		this.updateGUI();
		this.updateEnvironment();
		this.updateDisplay();
		this.updateModelInfo(object, clips);
		this.updateAnnotations();

		if (window.VIEWER) window.VIEWER.scene = this.content;

		this.controls.enabled = true;
		this.invalidate();

		// Smooth first-load camera reveal — runs after the scene is fully wired
		// so OrbitControls and damping pick it up cleanly.
		if (this._pendingReveal) {
			const { framedPos, target } = this._pendingReveal;
			this._pendingReveal = null;
			this._tweenCamera(framedPos, target, 1500);
		}

		// Announce the swap so overlays can react to the new rig (e.g. re-filter
		// animation suggestions against what this model can actually perform).
		try {
			window.dispatchEvent(new CustomEvent('viewer:model-loaded', { detail: { viewer: this } }));
		} catch {}
	}

	setClips(clips) {
		setClips(this, clips);
	}

	playAllClips() {
		playAllClips(this);
	}

	/**
	 * @param {string} name
	 */
	setCamera(name) {
		if (name === DEFAULT_CAMERA) {
			this.controls.enabled = true;
			this.activeCamera = this.defaultCamera;
		} else {
			this.controls.enabled = false;
			this.content.traverse((node) => {
				if (node.isCamera && node.name === name) {
					this.activeCamera = node;
				}
			});
		}
		// Keep the post-processing passes pointed at the live camera.
		if (this._cinematic) this._cinematic.setCamera(this.activeCamera);
		this.invalidate();
	}

	updateLights() {
		const state = this.state;
		const lights = this.lights;

		if (state.punctualLights && !lights.length) {
			addLights(this);
		} else if (!state.punctualLights && lights.length) {
			removeLights(this);
		}

		this.renderer.toneMapping = Number(state.toneMapping);
		this.renderer.toneMappingExposure = Math.pow(2, state.exposure);

		// Image-based lighting strength (RoomEnvironment / HDRI). Supported by
		// three r163+; guarded so older peers degrade to the baseline response.
		if (this.scene && 'environmentIntensity' in this.scene) {
			this.scene.environmentIntensity = state.environmentIntensity ?? 1.0;
		}

		// Keep the studio rig in sync with GUI / scene-pref edits, addressing
		// each light by name so the rig can grow without re-indexing.
		for (const light of lights) {
			switch (light.name) {
				case 'ambient_light':
					light.intensity = state.ambientIntensity;
					light.color.set(state.ambientColor);
					break;
				case 'main_light':
					light.intensity = state.directIntensity;
					light.color.set(state.directColor);
					break;
				case 'fill_light':
					light.intensity = state.directIntensity * (state.fillRatio ?? 0.4);
					light.color.set(state.fillColor ?? '#DCE6FF');
					break;
				case 'rim_light':
					light.intensity = state.directIntensity * (state.rimRatio ?? 0.65);
					light.color.set(state.rimColor ?? '#FFFFFF');
					break;
				default:
					break;
			}
		}

		this.invalidate();
	}

	updateEnvironment() {
		const environment = environments.filter(
			(entry) => entry.name === this.state.environment,
		)[0];

		getCubeMapTexture(this, environment)
			.then(({ envMap }) => {
				if (this._disposed || !this.scene) return;
				this.scene.environment = envMap;
				this.scene.background = this.state.transparentBg
					? null
					: this.state.background
						? envMap
						: this.backgroundColor;
				this.invalidate();
			})
			.catch((err) => {
				// EXR HDRIs are fetched from an external CDN; a network drop or a
				// blocked request (Safari surfaces these as "Load failed") must not
				// escape as an unhandled rejection. The scene keeps its current
				// environment — IBL is a visual nicety, never load-blocking.
				log.warn('[viewer] environment HDRI load failed', err?.message || err);
			});
	}

	/**
	 * Public env preset switcher used by the widget config pipeline + JSON-RPC
	 * `viewer.setEnvironment`. Accepts an environment id (e.g. `neutral`,
	 * `venice-sunset`) or a display name. Internally we store the name on
	 * `state.environment` because the GUI dropdown binds to it.
	 */
	setEnvironment(preset) {
		const key = String(preset || '').trim();
		if (!key) return;
		const entry =
			environments.find((e) => e.id === key) ||
			environments.find((e) => e.name === key) ||
			environments.find((e) => e.name.toLowerCase() === key.toLowerCase());
		if (!entry) return;
		this.state.environment = entry.name;
		this.updateEnvironment();
	}

	updateDisplay() {
		if (this.skeletonHelpers.length) {
			this.skeletonHelpers.forEach((helper) => this.scene.remove(helper));
		}

		// May run before any model has loaded (e.g. idle-avatar configures the
		// viewer up front, then loads the GLB). The material/skeleton passes need
		// content; the grid/auto-rotate state below does not, so skip just these.
		if (this.content) {
			traverseMaterials(this.content, (material) => {
				material.wireframe = this.state.wireframe;

				if (material instanceof PointsMaterial) {
					material.size = this.state.pointSize;
				}
			});

			this.content.traverse((node) => {
				if (node.geometry && node.skeleton && this.state.skeleton) {
					const helper = new SkeletonHelper(node.skeleton.bones[0].parent);
					helper.material.linewidth = 3;
					this.scene.add(helper);
					this.skeletonHelpers.push(helper);
				}
			});
		}

		if (this.state.grid !== Boolean(this.gridHelper)) {
			if (this.state.grid) {
				this._ensureAxesRenderer();
				this.gridHelper = new GridHelper();
				this.axesHelper = new AxesHelper();
				this.axesHelper.renderOrder = 999;
				this.axesHelper.onBeforeRender = (renderer) => renderer.clearDepth();
				this.scene.add(this.gridHelper);
				this.scene.add(this.axesHelper);
			} else {
				this.scene.remove(this.gridHelper);
				this.scene.remove(this.axesHelper);
				this.gridHelper = null;
				this.axesHelper = null;
				this.axesRenderer?.clear();
			}
		}

		this.controls.autoRotate = this.state.autoRotate;

		this.invalidate();
	}

	updateBackground() {
		this.backgroundColor.set(this.state.bgColor);
		if (this.state.transparentBg) {
			this.scene.background = null;
			this.renderer.setClearColor(0x000000, 0);
		} else {
			this.scene.background = this.backgroundColor;
			this.renderer.setClearColor(0x000000, 1);
		}
		// Always apply IBL — updateEnvironment() sets scene.background to null for
		// transparent mode so the canvas stays clear while still lighting materials.
		this.updateEnvironment();
		this.invalidate();
	}

	/**
	 * Public setter for the scene background color. Used by the widget runtime
	 * + Studio postMessage bridge to apply brand config without touching dat.gui.
	 * @param {string|number} color  CSS color string or hex int.
	 */
	setBackgroundColor(color) {
		this.state.bgColor =
			typeof color === 'string' ? color : '#' + color.toString(16).padStart(6, '0');
		this.state.transparentBg = false;
		this.updateBackground();
	}

	/**
	 * Adds AxesHelper.
	 *
	 * See: https://stackoverflow.com/q/16226693/1314762
	 */
	updateModelInfo(object, clips) {
		if (this.modelInfo) {
			this.modelInfo.remove();
			this.modelInfo = null;
		}
		if (this.state.showInfo && object) {
			this.modelInfo = createModelInfo(this.el, object, clips);
		}
	}

	updateAnnotations() {
		// Clear existing
		this.annotationEls.forEach((a) => a.el.remove());
		this.annotationEls = [];

		if (!this.state.showLabels || !this.content) return;

		const annotations = buildAnnotations(this.content);

		annotations.forEach((ann) => {
			const canvas = renderAnnotationCanvas(ann);
			const el = document.createElement('div');
			el.classList.add('annotation-label');
			el.appendChild(canvas);
			this.el.appendChild(el);
			this.annotationEls.push({ el, position: ann.position });
		});

		this.invalidate();
	}

	projectAnnotations() {
		if (this.annotationEls.length === 0) return;

		const width = this.el.clientWidth;
		const height = this.el.clientHeight;
		const halfW = width / 2;
		const halfH = height / 2;
		const tempVec = this._tempVec;

		this.annotationEls.forEach(({ el, position }) => {
			tempVec.copy(position);
			tempVec.project(this.activeCamera);

			// Behind camera check
			if (tempVec.z > 1) {
				el.style.display = 'none';
				return;
			}

			const x = tempVec.x * halfW + halfW;
			const y = -(tempVec.y * halfH) + halfH;

			el.style.display = '';
			el.style.left = x + 'px';
			el.style.top = y + 'px';
		});
	}

	addAxesHelper() {
		this.axesDiv = document.createElement('div');
		this.el.appendChild(this.axesDiv);
		this.axesDiv.classList.add('axes');

		const { clientWidth, clientHeight } = this.axesDiv;

		this.axesScene = new Scene();
		this.axesCamera = new PerspectiveCamera(50, clientWidth / clientHeight, 0.1, 10);
		this.axesScene.add(this.axesCamera);

		// The axes gizmo is a debug helper, shown only when the "grid" display
		// toggle is on (off by default, and the GUI is closed entirely in kiosk/
		// embed mode). Its WebGLRenderer is a whole second GL context, so we
		// create it lazily — otherwise every <agent-3d> on a page would burn two
		// contexts and exhaust the browser's ~16-context budget twice as fast.
		this.axesRenderer = null;

		this.axesCamera.up = this.defaultCamera.up;

		this.axesCorner = new AxesHelper(5);
		this.axesScene.add(this.axesCorner);
	}

	_ensureAxesRenderer() {
		if (this.axesRenderer || !this.axesDiv) return this.axesRenderer;
		this.axesRenderer = new WebGLRenderer({ alpha: true });
		// Match the main renderer's DPR cap — the tiny axes gizmo gains nothing
		// from rendering at full retina density and the extra fragments are pure
		// waste on high-DPI phones.
		this.axesRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.axesRenderer.setSize(this.axesDiv.clientWidth, this.axesDiv.clientHeight);
		this.axesDiv.appendChild(this.axesRenderer.domElement);
		return this.axesRenderer;
	}

	addGUI() {
		const isMobile = window.innerWidth <= 700;
		const gui = (this.gui = new GUI({
			autoPlace: false,
			width: isMobile ? 220 : 260,
			hideable: true,
		}));

		// dat.GUI's OptionController change handler reads
		// `select.options[select.selectedIndex].value` with no guard, so a `change`
		// event fired while a dropdown sits at selectedIndex === -1 throws
		// "Cannot read properties of undefined (reading 'value')". A user can never
		// put a populated <select> in that state, but a programmatic deselect — an
		// automated form fuzzer or accessibility crawler dispatching synthetic
		// change events — can. Normalize the index in the capture phase, before
		// dat.GUI's own bubble-phase listener runs, so the control degrades to its
		// first option (or the event is dropped when there is nothing to select)
		// instead of crashing the whole viewer.
		gui.domElement.addEventListener(
			'change',
			(e) => {
				const t = /** @type {HTMLSelectElement} */ (e.target);
				if (t && t.tagName === 'SELECT' && t.selectedIndex < 0) {
					if (t.options.length) t.selectedIndex = 0;
					else e.stopImmediatePropagation();
				}
			},
			true,
		);

		// Display controls.
		const dispFolder = gui.addFolder('Display');
		const envBackgroundCtrl = dispFolder.add(this.state, 'background');
		envBackgroundCtrl.onChange(() => {
			this.updateEnvironment();
			this.notifyScenePrefChange();
		});
		const autoRotateCtrl = dispFolder.add(this.state, 'autoRotate');
		autoRotateCtrl.onChange(() => {
			this.updateDisplay();
			this.notifyScenePrefChange();
		});
		const wireframeCtrl = dispFolder.add(this.state, 'wireframe');
		wireframeCtrl.onChange(() => this.updateDisplay());
		const skeletonCtrl = dispFolder.add(this.state, 'skeleton');
		skeletonCtrl.onChange(() => this.updateDisplay());
		const gridCtrl = dispFolder.add(this.state, 'grid');
		gridCtrl.onChange(() => this.updateDisplay());
		dispFolder.add(this.controls, 'screenSpacePanning');
		const pointSizeCtrl = dispFolder.add(this.state, 'pointSize', 1, 16);
		pointSizeCtrl.onChange(() => this.updateDisplay());
		const transparentCtrl = dispFolder.add(this.state, 'transparentBg').name('transparent bg');
		transparentCtrl.onChange(() => {
			this.updateBackground();
			this.notifyScenePrefChange();
		});
		const bgColorCtrl = dispFolder.addColor(this.state, 'bgColor');
		bgColorCtrl.onChange(() => {
			this.updateBackground();
			this.notifyScenePrefChange();
		});
		dispFolder
			.add({ screenshot: () => this.takeScreenshot() }, 'screenshot')
			.name('Screenshot [P]');
		const infoCtrl = dispFolder.add(this.state, 'showInfo').name('model info');
		infoCtrl.onChange(() => this.updateModelInfo(this.content, this.clips));
		const labelsCtrl = dispFolder.add(this.state, 'showLabels').name('mesh labels');
		labelsCtrl.onChange(() => this.updateAnnotations());

		// Lighting controls.
		const lightFolder = gui.addFolder('Lighting');
		const envMapCtrl = lightFolder.add(
			this.state,
			'environment',
			environments.map((env) => env.name),
		);
		envMapCtrl.onChange(() => {
			this.updateEnvironment();
			this.notifyScenePrefChange();
		});
		const exposureCtrl = lightFolder.add(this.state, 'exposure', -10, 10, 0.01);
		exposureCtrl.onChange(() => {
			this.updateLights();
			this.notifyScenePrefChange();
		});
		[
			lightFolder.add(this.state, 'toneMapping', {
				Neutral: NeutralToneMapping,
				Linear: LinearToneMapping,
				'ACES Filmic': ACESFilmicToneMapping,
			}),
			lightFolder.add(this.state, 'punctualLights').listen(),
			lightFolder.add(this.state, 'environmentIntensity', 0, 3).name('IBL intensity'),
			lightFolder.add(this.state, 'ambientIntensity', 0, 2),
			lightFolder.addColor(this.state, 'ambientColor'),
			// Slider range tracks the π-scaled default above (see #116 note).
			lightFolder.add(this.state, 'directIntensity', 0, 4),
			lightFolder.addColor(this.state, 'directColor'),
			lightFolder.add(this.state, 'fillRatio', 0, 1).name('fill'),
			lightFolder.addColor(this.state, 'fillColor'),
			lightFolder.add(this.state, 'rimRatio', 0, 1.5).name('rim'),
			lightFolder.addColor(this.state, 'rimColor'),
		].forEach((ctrl) => ctrl.onChange(() => this.updateLights()));

		// Cinematic FX — selectable post-processing looks plus live per-effect
		// tuning. Preset picker rewrites every slider; sliders write straight into
		// the live pipeline so the canvas updates as you drag.
		const fxFolder = gui.addFolder('Cinematic FX');
		const fx = this._cinematic;
		const presetHolder = { preset: this.state.cinematicPreset };
		const fxCtrls = [];
		const syncFxCtrls = () => fxCtrls.forEach((c) => c.updateDisplay());

		fxFolder
			.add(presetHolder, 'preset', CINEMATIC_PRESET_NAMES)
			.name('preset')
			.onChange((name) => {
				fx.applyPreset(name);
				this.state.cinematicPreset = name;
				syncFxCtrls();
				this.invalidate();
				this.notifyScenePrefChange();
			});

		// Each slider mutates fx.params[key] in place, then re-pushes the whole
		// param set so the canvas updates live as you drag.
		const onFxChange = () => {
			fx.apply();
			this.invalidate();
		};
		const addFx = (key, min, max, step, label) => {
			const c = fxFolder.add(fx.params, key, min, max, step).name(label).onChange(onFxChange);
			fxCtrls.push(c);
			return c;
		};

		addFx('bloom', 0, 3, 0.01, 'bloom');
		addFx('bloomThreshold', 0, 1, 0.01, 'bloom threshold');
		addFx('vignette', 0, 1, 0.01, 'vignette');
		addFx('ssao', 0, 1, 1, 'ambient occlusion');
		addFx('ssaoIntensity', 0, 4, 0.05, 'AO strength');
		addFx('dof', 0, 1, 1, 'depth of field');
		addFx('dofFocusDistance', 0.2, 12, 0.1, 'focus distance');
		addFx('dofBokeh', 0, 6, 0.1, 'bokeh');
		addFx('saturation', -1, 1, 0.01, 'saturation');
		addFx('contrast', -1, 1, 0.01, 'contrast');
		addFx('brightness', -1, 1, 0.01, 'brightness');
		addFx('hue', 0, Math.PI * 2, 0.01, 'hue shift');
		addFx('chromaticAberration', 0, 0.01, 0.0001, 'chromatic ab.');
		addFx('grain', 0, 0.5, 0.01, 'film grain');
		fxFolder.close();

		// Light Probe Grid controls.
		const probeFolder = gui.addFolder('Light Probes');
		probeFolder.add(this.state, 'probeNx', 1, 8, 1).name('grid X');
		probeFolder.add(this.state, 'probeNy', 1, 4, 1).name('grid Y');
		probeFolder.add(this.state, 'probeNz', 1, 8, 1).name('grid Z');
		probeFolder.add(this.state, 'probeCubeFace', { '32px': 32, '64px': 64, '128px': 128 }).name('cube face');
		probeFolder.add({ bake: () => this.bakeLightProbes() }, 'bake').name('Bake Probes');
		probeFolder.add({ save: () => this.saveLightProbes() }, 'save').name('Save JSON');
		probeFolder.add({ load: () => this.loadLightProbes() }, 'load').name('Load JSON');

		// Animation controls.
		this.animFolder = gui.addFolder('Animation');
		this.animFolder.domElement.style.display = 'none';
		const playbackSpeedCtrl = this.animFolder.add(this.state, 'playbackSpeed', 0, 1);
		playbackSpeedCtrl.onChange((speed) => {
			if (this.mixer) this.mixer.timeScale = speed;
		});
		this.animFolder.add({ playAll: () => this.playAllClips() }, 'playAll');

		// Morph target controls.
		this.morphFolder = gui.addFolder('Morph Targets');
		this.morphFolder.domElement.style.display = 'none';

		// Camera controls.
		this.cameraFolder = gui.addFolder('Cameras');
		this.cameraFolder.domElement.style.display = 'none';

		// Agent controls.
		const agentFolder = gui.addFolder('Agent');
		agentFolder
			.add(this.state, 'followMode', {
				None: 'none',
				'Follow Mouse': 'mouse',
				'Follow Keystrokes': 'keystrokes',
			})
			.name('follow mode');

		// Stats.
		const perfFolder = gui.addFolder('Performance');
		const perfLi = document.createElement('li');
		this.stats.dom.style.position = 'static';
		perfLi.appendChild(this.stats.dom);
		perfLi.classList.add('gui-stats');
		perfFolder.__ul.appendChild(perfLi);

		const guiWrap = document.createElement('div');
		this.el.appendChild(guiWrap);
		guiWrap.classList.add('gui-wrap');
		guiWrap.classList.add('gui-wrap--hidden');
		guiWrap.appendChild(gui.domElement);
		this._guiWrap = guiWrap;
		labelGUIControls(gui.domElement);
		this._guiObserver = watchGUIControls(gui.domElement);

		// Toggle button — hides dat.GUI behind an "Advanced" control
		const toggle = document.createElement('button');
		toggle.className = 'gui-toggle';
		// In kiosk/embed there's no GUI surface to expose.
		if (this.options.kiosk) toggle.hidden = true;
		toggle.setAttribute('title', 'Toggle advanced controls');
		toggle.setAttribute('aria-label', 'Toggle advanced controls');
		toggle.innerHTML =
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<circle cx="12" cy="12" r="3"></circle>' +
			'<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
			'</svg>' +
			'<span class="gui-toggle__label">Controls</span>';
		toggle.addEventListener('click', () => {
			const shown = guiWrap.classList.toggle('gui-wrap--hidden');
			toggle.classList.toggle('gui-toggle--active', !shown);
		});
		this.el.appendChild(toggle);
		this._guiToggle = toggle;

		// AR button — hidden until setARTarget() is called with a supported URL
		const arBtn = document.createElement('button');
		arBtn.className = 'ar-btn';
		arBtn.setAttribute('title', 'View in AR');
		arBtn.setAttribute('aria-label', 'View in AR');
		arBtn.innerHTML =
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M1 6l5-3 5 3v5l-5 3-5-3z"></path>' +
			'<path d="M11 3l5 3v5l-5-3z"></path>' +
			'<path d="M1 11l5 3 5-3"></path>' +
			'<path d="M6 9v5"></path>' +
			'<path d="M16 6v5l5 3v-5z"></path>' +
			'<path d="M11 8l5 3"></path>' +
			'</svg>' +
			'<span class="ar-btn__label">AR</span>';
		arBtn.hidden = true;
		arBtn.addEventListener('click', () => this._launchAR());
		this.el.appendChild(arBtn);
		this._arBtn = arBtn;
		this._arGlbUrl = null;
		this._arUsdzUrl = null;
		this._xrSession = null;

		if (isMobile) {
			gui.close();
		} else {
			gui.open();
		}
	}

	updateGUI() {
		this.cameraFolder.domElement.style.display = 'none';

		this.morphCtrls.forEach((ctrl) => ctrl.remove());
		this.morphCtrls.length = 0;
		this.morphFolder.domElement.style.display = 'none';

		this.animCtrls.forEach((ctrl) => ctrl.remove());
		this.animCtrls.length = 0;
		this.animFolder.domElement.style.display = 'none';

		const cameraNames = [];
		const morphMeshes = [];
		this.content.traverse((node) => {
			if (node.geometry && node.morphTargetInfluences) {
				morphMeshes.push(node);
			}
			if (node.isCamera) {
				node.name = node.name || `VIEWER__camera_${cameraNames.length + 1}`;
				cameraNames.push(node.name);
			}
		});

		if (cameraNames.length) {
			this.cameraFolder.domElement.style.display = '';
			if (this.cameraCtrl) this.cameraCtrl.remove();
			const cameraOptions = [DEFAULT_CAMERA].concat(cameraNames);
			this.cameraCtrl = this.cameraFolder.add(this.state, 'camera', cameraOptions);
			this.cameraCtrl.onChange((name) => this.setCamera(name));
		}

		if (morphMeshes.length) {
			this.morphFolder.domElement.style.display = '';
			morphMeshes.forEach((mesh) => {
				if (mesh.morphTargetInfluences.length) {
					const nameCtrl = this.morphFolder.add(
						{ name: mesh.name || 'Untitled' },
						'name',
					);
					this.morphCtrls.push(nameCtrl);
				}
				for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
					const ctrl = this.morphFolder
						.add(mesh.morphTargetInfluences, i, 0, 1, 0.01)
						.listen();
					Object.keys(mesh.morphTargetDictionary).forEach((key) => {
						if (key && mesh.morphTargetDictionary[key] === i) ctrl.name(key);
					});
					this.morphCtrls.push(ctrl);
				}
			});
		}

		if (this.clips.length) {
			this.animFolder.domElement.style.display = '';
			const actionStates = (this.state.actionStates = {});
			this.clips.forEach((clip, clipIndex) => {
				clip.name = `${clipIndex + 1}. ${clip.name}`;

				// Autoplay the first clip.
				let action;
				if (clipIndex === 0) {
					actionStates[clip.name] = true;
					action = this.mixer.clipAction(clip);
					action.play();
				} else {
					actionStates[clip.name] = false;
				}

				// Play other clips when enabled.
				const ctrl = this.animFolder.add(actionStates, clip.name).listen();
				ctrl.onChange((playAnimation) => {
					action = action || this.mixer.clipAction(clip);
					action.setEffectiveTimeScale(1);
					playAnimation ? action.play() : action.stop();
					this.invalidate();
				});
				this.animCtrls.push(ctrl);
			});
		}
	}

	// ── External Animation Panel (Mixamo-style) ─────────────────────────────

	/**
	 * Register a list of external animation definitions (name + URL).
	 * @param {Array<{name: string, url: string, label?: string, icon?: string, loop?: boolean}>} defs
	 */
	setAnimationDefs(defs) {
		this.animationManager.setAnimationDefs(defs);
		if (this.content) this._setupAnimationPanel();
	}

	/**
	 * Create / rebuild the animation selector panel.
	 * @private
	 */
	_setupAnimationPanel() {
		// Remove existing panel
		if (this._animPanelEl) {
			this._animPanelEl.remove();
			this._animPanelEl = null;
		}

		if (this.options.kiosk) return;

		const defs = this.animationManager.getAnimationDefs();
		if (defs.length === 0) return;

		// Check model has a skeleton (no point showing anim panel for static meshes)
		let hasSkeleton = false;
		this.content.traverse((node) => {
			if (node.isSkinnedMesh) hasSkeleton = true;
		});
		if (!hasSkeleton) return;

		// Create panel container
		const panel = document.createElement('div');
		panel.className = 'anim-panel';
		panel.innerHTML =
			'<div class="anim-panel__header">' +
			'<span class="anim-panel__title">Animations</span>' +
			'<button class="anim-panel__stop" title="Stop all">⏹</button>' +
			'</div>' +
			'<div class="anim-panel__grid"></div>';
		this.el.appendChild(panel);
		this._animPanelEl = panel;

		// Render buttons
		this._renderAnimButtons();

		// Preload walk and idle first so they're ready before the first brain:stream.
		// loadAll() below fetches all clips with CONCURRENCY=4 and may not reach
		// these two before the user sends a message; ensureLoaded kicks them off
		// immediately and returns early if they're already in-progress or cached.
		// allSettled so a missing walk clip doesn't block idle from playing.
		console.time('walk-ready');
		Promise.allSettled([
			this.animationManager.ensureLoaded('idle'),
			this.animationManager.ensureLoaded('walk'),
		]).then(() => {
			console.timeEnd('walk-ready');
			if (!this.animationManager.currentAction) {
				this.animationManager.play('idle');
			}
		});

		// Load all animations in background. We deliberately do NOT auto-play
		// the first animation: external Mixamo-rigged FBX clips often retarget
		// imperfectly onto Ready Player Me / Avaturn avatars, which collapses
		// the rig and makes the model look "disappeared" on first load. Show
		// the authored pose instead and let the user pick an animation when
		// they want one.
		this.animationManager.loadAll().then(() => {
			this._renderAnimButtons();
		});

		// Fetch user-owned and public animations from the API and append them
		// to the panel alongside the built-in manifest clips.
		this._fetchAndAppendUserAnimations();

		// Stop button
		panel.querySelector('.anim-panel__stop').addEventListener('click', () => {
			this.animationManager.stopAll();
			this._renderAnimButtons();
			this.invalidate();
		});

		// onChange (render panel buttons + invalidate the render loop) is wired
		// once in the constructor so it also runs in kiosk mode, where this panel
		// setup is skipped entirely.
	}

	/**
	 * Fetch user-owned and public animation clips from the API and append them
	 * to the animation panel so they appear alongside the manifest built-ins.
	 * Non-fatal: if the API is unavailable or the user isn't signed in the panel
	 * still shows the built-in clips.
	 * @private
	 */
	async _fetchAndAppendUserAnimations() {
		try {
			const res = await fetch('/api/animations/clips?include_public=true&limit=100', {
				credentials: 'include',
			});
			if (!res.ok) return;
			const { items } = await res.json();
			if (!Array.isArray(items) || items.length === 0) return;

			const defs = items.map((c) => ({
				name: `user:${c.id}`,
				url: `/api/animations/clips/${encodeURIComponent(c.id)}?play=1`,
				label: c.name || c.slug || 'Animation',
				icon: c.visibility === 'public' ? '🌐' : '🔒',
				loop: c.loop !== false,
				source: 'user',
			}));
			this.animationManager.appendAnimationDefs(defs);
			this._renderAnimButtons();
		} catch {
			/* Non-fatal — user clips just won't appear in the panel */
		}
	}

	/**
	 * Load a user or public animation clip by its API id (or slug) and play it
	 * on the currently attached avatar. Increments play_count on the server.
	 * Safe to call before setAnimationDefs; registers the clip directly.
	 *
	 * @param {string} clipId  — animation_clips.id (UUID) or slug
	 * @returns {Promise<string>} the internal clip name used by the manager
	 */
	async playAnimationById(clipId) {
		const name = `user:${clipId}`;
		// If already registered as a def, use the normal ensureLoaded path.
		const existing = this.animationManager.getAnimationDefs().find(
			(d) => d.name === name || d.url?.includes(`/${encodeURIComponent(clipId)}`),
		);
		if (!existing) {
			// Register the def so the manager knows how to lazy-load it.
			this.animationManager.appendAnimationDefs([{
				name,
				url: `/api/animations/clips/${encodeURIComponent(clipId)}?play=1`,
				label: 'Animation',
				icon: '🎬',
				loop: true,
				source: 'user',
			}]);
		}
		const ready = await this.animationManager.ensureLoaded(name);
		if (!ready) throw new Error(`animation ${clipId} unavailable`);
		await this.animationManager.crossfadeTo(name);
		this.invalidate();
		this._recomputeAnimating?.();
		this._updateRenderLoop?.();
		return name;
	}

	/**
	 * Render / re-render animation buttons in the panel.
	 * @private
	 */
	_renderAnimButtons() {
		if (!this._animPanelEl) return;

		const grid = this._animPanelEl.querySelector('.anim-panel__grid');
		const defs = this.animationManager.getAnimationDefs();
		const activeName = this.animationManager.currentName;

		const ICONS = {
			idle: '🧍',
			breathing: '🧍',
			standing: '🧍',
			walking: '🚶',
			walk: '🚶',
			running: '🏃',
			run: '🏃',
			waving: '👋',
			wave: '👋',
			dancing: '💃',
			dance: '💃',
			sitting: '🪑',
			sit: '🪑',
			jumping: '🦘',
			jump: '🦘',
			talking: '🗣️',
			talk: '🗣️',
			clapping: '👏',
			clap: '👏',
			punching: '👊',
			punch: '👊',
			kicking: '🦵',
			kick: '🦵',
		};

		grid.innerHTML = defs
			.map((def, i) => {
				const loaded = this.animationManager.isLoaded(def.name);
				const isActive = activeName === def.name;
				const icon = def.icon || ICONS[def.name.toLowerCase()] || '▶';
				const label = def.label || def.name.charAt(0).toUpperCase() + def.name.slice(1);
				const keyHint = i < 9 ? i + 1 : '';
				return (
					'<button class="anim-btn' +
					(isActive ? ' anim-btn--active' : '') +
					(loaded ? '' : ' anim-btn--loading') +
					'" data-anim="' +
					def.name +
					'"' +
					' title="' +
					label +
					(keyHint ? ' — press ' + keyHint : '') +
					'"' +
					(loaded ? '' : ' disabled') +
					'>' +
					(keyHint ? '<span class="anim-btn__key">' + keyHint + '</span>' : '') +
					'<span class="anim-btn__icon">' +
					icon +
					'</span>' +
					'<span class="anim-btn__label">' +
					label +
					'</span>' +
					'</button>'
				);
			})
			.join('');

		// Bind click events
		grid.querySelectorAll('.anim-btn:not([disabled])').forEach((btn) => {
			btn.addEventListener('click', () => {
				const name = btn.dataset.anim;
				this.animationManager.crossfadeTo(name);
				this.invalidate();
				this._recomputeAnimating();
				this._updateRenderLoop();
			});
		});

		// Bind keyboard shortcuts (1-9) — only once. Stored on `this` so
		// dispose() can remove it; otherwise viewer recreations stack handlers.
		if (!this._onAnimHotkey) {
			this._onAnimHotkey = (e) => {
				if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
				if (e.metaKey || e.ctrlKey || e.altKey) return;
				const n = parseInt(e.key, 10);
				if (!n || n < 1 || n > 9) return;
				const currentDefs = this.animationManager.getAnimationDefs();
				const def = currentDefs[n - 1];
				if (!def || !this.animationManager.isLoaded(def.name)) return;
				this.animationManager.crossfadeTo(def.name);
				this.invalidate();
				this._recomputeAnimating();
				this._updateRenderLoop();
			};
			document.addEventListener('keydown', this._onAnimHotkey);
		}
	}

	clear() {
		if (!this.content) return;

		// Detach external animation manager
		this.animationManager.detach();
		if (this._animPanelEl) {
			this._animPanelEl.remove();
			this._animPanelEl = null;
		}

		if (this.modelInfo) {
			this.modelInfo.remove();
			this.modelInfo = null;
		}

		this.annotationEls.forEach((a) => a.el.remove());
		this.annotationEls = [];

		this.scene.remove(this.content);

		// dispose BVH acceleration structures before geometry
		this.content.traverse((node) => {
			if (node.isMesh && node.geometry?.boundsTree) {
				node.geometry.disposeBoundsTree();
			}
		});

		// dispose geometry
		this.content.traverse((node) => {
			if (!node.geometry) return;

			node.geometry.dispose();
		});

		// dispose textures
		traverseMaterials(this.content, (material) => {
			for (const key in material) {
				if (key !== 'envMap' && material[key] && material[key].isTexture) {
					material[key].dispose();
				}
			}
		});

		this.content = null;
		if (!this._disposed) this.invalidate();
	}

	dispose() {
		if (this._disposed) return;
		this._disposed = true;

		// Stop watching the control panel before its DOM goes away.
		this._guiObserver?.disconnect();
		this._guiObserver = null;

		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
		if (this._resizeRaf != null) {
			cancelAnimationFrame(this._resizeRaf);
			this._resizeRaf = null;
		}

		document.removeEventListener('visibilitychange', this._onVisibilityChange);
		window.removeEventListener('resize', this._onResize, false);
		window.removeEventListener('keydown', this._onKeyDown);
		if (this._onDblClick && this.renderer?.domElement) {
			this.renderer.domElement.removeEventListener('dblclick', this._onDblClick);
		}
		if (this._onCanvasKeyDown && this.renderer?.domElement) {
			this.renderer.domElement.removeEventListener('keydown', this._onCanvasKeyDown);
			this._onCanvasKeyDown = null;
		}
		if (this._onMessage) {
			window.removeEventListener('message', this._onMessage, false);
		}
		if (this._cameraTweenRaf) cancelAnimationFrame(this._cameraTweenRaf);
		this._clearPumpFunTrades();
		if (this._onAnimHotkey) {
			document.removeEventListener('keydown', this._onAnimHotkey);
			this._onAnimHotkey = null;
		}

		if (this._intersectionObserver) {
			this._intersectionObserver.disconnect();
			this._intersectionObserver = null;
		}

		if (this._ro) {
			this._ro.disconnect();
			this._ro = null;
		}

		this.clear();

		if (this.mixer) {
			this.mixer.stopAllAction();
			const root = this.mixer.getRoot();
			if (root) this.mixer.uncacheRoot(root);
			this.mixer = null;
		}
		this.clips = [];

		// Dispose external animation system
		this.animationManager.dispose();
		if (this._animPanelEl) {
			this._animPanelEl.remove();
			this._animPanelEl = null;
		}

		if (this.skeletonHelpers.length) {
			this.skeletonHelpers.forEach((helper) => {
				this.scene.remove(helper);
				helper.dispose?.();
			});
			this.skeletonHelpers.length = 0;
		}

		if (this.gridHelper) {
			this.scene.remove(this.gridHelper);
			this.gridHelper.geometry?.dispose();
			this.gridHelper.material?.dispose();
			this.gridHelper = null;
		}
		if (this.axesHelper) {
			this.scene.remove(this.axesHelper);
			this.axesHelper.geometry?.dispose();
			this.axesHelper.material?.dispose();
			this.axesHelper = null;
		}
		if (this.axesCorner) {
			this.axesScene?.remove(this.axesCorner);
			this.axesCorner.geometry?.dispose();
			this.axesCorner.material?.dispose();
			this.axesCorner = null;
		}

		this.lights.forEach((light) => light.parent?.remove(light));
		this.lights = [];

		if (this.shadowCatcher) {
			this.scene.remove(this.shadowCatcher);
			this.shadowCatcher.geometry?.dispose();
			this.shadowCatcher.material?.dispose();
			this.shadowCatcher = null;
		}

		if (this.annotationEls.length) {
			this.annotationEls.forEach((a) => a.el.remove());
			this.annotationEls = [];
		}
		if (this.modelInfo) {
			this.modelInfo.remove();
			this.modelInfo = null;
		}

		if (this.gui) {
			this.gui.destroy();
			this.gui = null;
		}
		if (this._guiWrap) {
			this._guiWrap.remove();
			this._guiWrap = null;
		}
		if (this._guiToggle) {
			this._guiToggle.remove();
			this._guiToggle = null;
		}

		if (this.stats?.dom) this.stats.dom.remove();

		if (this.controls) {
			if (this._onControlsChange) {
				this.controls.removeEventListener('change', this._onControlsChange);
				this._onControlsChange = null;
			}
			this.controls.dispose();
			this.controls = null;
		}

		if (this._loadedEnvironment) {
			this._loadedEnvironment.dispose();
			this._loadedEnvironment = null;
		}
		if (this.neutralEnvironment) {
			this.neutralEnvironment.dispose();
			this.neutralEnvironment = null;
		}
		if (this.scene) {
			this.scene.environment = null;
			this.scene.background = null;
		}

		if (this._lightProbeGrid) {
			this._lightProbeGrid.removeFromScene(this.scene);
			this._lightProbeGrid.dispose();
			this._lightProbeGrid = null;
		}

		if (this.pmremGenerator) {
			this.pmremGenerator.dispose();
			this.pmremGenerator = null;
		}

		if (this.axesRenderer) {
			this.axesRenderer.dispose();
			this.axesRenderer.forceContextLoss?.();
			this.axesRenderer.domElement?.remove();
			this.axesRenderer = null;
		}
		if (this.axesDiv) {
			this.axesDiv.remove();
			this.axesDiv = null;
		}
		this.axesScene = null;
		this.axesCamera = null;

		if (this._cinematic) {
			this._cinematic.dispose();
			this._cinematic = null;
			this._composer = null;
		}

		if (this.renderer) {
			this.renderer.dispose();
			this.renderer.forceContextLoss?.();
			this.renderer.domElement?.remove();
			if (window.renderer === this.renderer) window.renderer = null;
			this.renderer = null;
		}

		if (this.audioListener) {
			this.defaultCamera?.remove(this.audioListener);
			this.audioListener = null;
		}

		this.scene = null;
		this.content = null;
		this.activeCamera = null;
		this.defaultCamera = null;
		this._afterAnimateHooks = null;
	}
}
