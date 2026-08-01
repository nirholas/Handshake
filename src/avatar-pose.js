// Pose stage — a self-contained Three.js surface that drops onto the avatar
// studio page (/avatars/:id) so visitors can drive the avatar through the
// pre-baked motion library instead of staring at a static T-pose.
//
// model-viewer (the default stage) can only play clips embedded in the GLB it
// loaded; most avatars ship none. The clip library in /animations/clips/* is
// authored against the canonical Avaturn skeleton and retargets onto any rigged
// humanoid at runtime via AnimationManager — but that needs a real Three.js
// scene, which is what this module owns. It mounts lazily (first time the Pose
// tab opens) and renders only while visible, so the page pays zero GPU cost
// until someone actually wants to pose.

import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	Box3,
	Vector3,
	Timer,
	HemisphereLight,
	DirectionalLight,
	AmbientLight,
	PMREMGenerator,
	SRGBColorSpace,
	ACESFilmicToneMapping,
	Mesh,
	PlaneGeometry,
	ShadowMaterial,
	VSMShadowMap,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { AnimationManager } from './animation-manager.js';
import { dracoLoader } from './game/avatar-rig.js';
import { log } from './shared/log.js';

const MANIFEST_URL = '/animations/manifest.json';

const _loader = new GLTFLoader();
_loader.setDRACOLoader(dracoLoader);
// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
const _meshoptReady = getMeshoptDecoder().then((d) => _loader.setMeshoptDecoder(d));

/**
 * @typedef {{name:string,url:string,label:string,icon:string,loop:boolean}} PoseDef
 */

/**
 * Fetch the pose/animation manifest once. Cached at module scope so reopening
 * the tab (or a second avatar in the same session) never refetches.
 * @returns {Promise<PoseDef[]>}
 */
let _manifestPromise = null;
export function loadPoseManifest() {
	if (!_manifestPromise) {
		_manifestPromise = fetch(MANIFEST_URL, { cache: 'force-cache' })
			.then((r) => (r.ok ? r.json() : []))
			.catch((err) => {
				log.warn('[pose] manifest load failed', err?.message);
				_manifestPromise = null; // allow a later retry
				return [];
			});
	}
	return _manifestPromise;
}

export class PoseStage {
	/**
	 * @param {HTMLElement} host  container the canvas fills (the av-stage element)
	 * @param {{ glbUrl: string, framing?: 'full'|'portrait', label?: string }} opts
	 *   `label` is the text alternative for what the avatar is showing. It is
	 *   applied to the CANVAS (`role="img"`), never to the host: the host also
	 *   holds the "Reset view" control, and a `role="img"` ancestor makes its
	 *   whole subtree presentational, hiding that button from assistive tech
	 *   (axe `nested-interactive`, WCAG 4.1.2).
	 */
	constructor(host, { glbUrl, framing = 'full', label = '' }) {
		this.host = host;
		this.glbUrl = glbUrl;
		this.label = label;
		// 'full' = whole body (studio default); 'portrait' = tighter on the
		// upper body, where hand signing reads clearly.
		this.framing = framing;

		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.clock = new Timer();
		this.model = null;
		this.anim = new AnimationManager();

		this._running = false;
		this._frame = 0;
		this._resizeObserver = null;
		this._homeView = null;
		this._resetBtn = null;
		this._key = null;
		this._ground = null;
		this._mounted = false;
		this._disposed = false;

		/** Fired with the active clip name (or null) whenever playback changes. */
		this.onChange = null;
	}

	/**
	 * Build the scene, load the avatar, and register the clip library.
	 * @returns {Promise<{ supported: boolean }>} supported=false when the rig
	 *   can't be driven by the canonical clip library (static mesh / non-humanoid).
	 */
	async mount() {
		if (this._mounted) return { supported: this.anim.supportsCanonicalClips() };
		this._mounted = true;

		const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.outputColorSpace = SRGBColorSpace;
		renderer.toneMapping = ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.0;
		// Shadows are the difference between a figure that is lit and a figure
		// that is THERE: the shadow under a chin, an arm falling across a chest,
		// and a contact shadow at the feet are what stop a rig reading as a
		// flat cutout. PCFSoftShadowMap is deprecated in this three version and
		// silently downgrades to hard edges, so VSM is the soft type to use.
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = VSMShadowMap;
		renderer.domElement.className = 'av-pose-canvas';
		// The rendered figure is the image; the container around it is not.
		if (this.label) {
			renderer.domElement.setAttribute('role', 'img');
			renderer.domElement.setAttribute('aria-label', this.label);
		}
		this.renderer = renderer;
		this.host.appendChild(renderer.domElement);

		const scene = new Scene();
		this.scene = scene;

		// Neutral studio environment for physically-based materials, plus a
		// three-point key/fill so the avatar reads with form even on flat GLBs.
		const pmrem = new PMREMGenerator(renderer);
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();
		// The environment already supplies broad ambient fill. Piling strong
		// hemisphere + ambient + key on top of it overexposed skin into a pale,
		// desaturated gray (ACES rolls blown highlights toward white), so the
		// added lights only shape form: a soft warm key and a gentle sky fill.
		scene.environmentIntensity = 0.85;
		scene.add(new HemisphereLight(0xffffff, 0x39404d, 0.35));
		const key = new DirectionalLight(0xfff1e0, 1.0);
		key.position.set(2, 3, 2.4);
		key.castShadow = true;
		// VSM runs a two-pass Gaussian over the shadow map every frame, so its
		// cost is mapSize² × blurSamples, NOT canvas size. 2048/16 measured
		// pathological on a software renderer (seconds per frame), which is what
		// a GPU-less visitor falls back to. 1024/8 is 8x cheaper and, blurred
		// over a single figure, visually indistinguishable. Phones halve again.
		const shadowRes = window.innerWidth < 700 ? 512 : 1024;
		key.shadow.mapSize.set(shadowRes, shadowRes);
		// VSM blurs in map space, so softness comes from radius, not from bias
		// tweaking. These read as an overcast key rather than a hard studio edge.
		key.shadow.radius = 3;
		key.shadow.blurSamples = 8;
		key.shadow.bias = -0.0005;
		scene.add(key, key.target, new AmbientLight(0xffffff, 0.12));
		this._key = key;

		// Catches the contact shadow at the feet. Invisible except where shadowed,
		// so it costs nothing on the dark hero and grounds the figure properly on
		// the light theme, where the stage background is a pale surface.
		const ground = new Mesh(new PlaneGeometry(40, 40), new ShadowMaterial({ opacity: 0.34 }));
		ground.rotation.x = -Math.PI / 2;
		ground.receiveShadow = true;
		scene.add(ground);
		this._ground = ground;

		const w = this.host.clientWidth || 1;
		const h = this.host.clientHeight || 1;
		this.camera = new PerspectiveCamera(35, w / h, 0.01, 100);

		// The wheel gate must attach to the HOST (capture phase) so it runs
		// before OrbitControls' own wheel listener on the canvas: a plain scroll
		// over the stage must keep scrolling the page. Zooming the avatar takes
		// intent: ctrl/cmd+wheel, a pinch, or a wheel after grabbing the model.
		// Without this, scrolling past the hero dollied the camera into the
		// torso and stranded the avatar out of frame with no way back.
		this._wheelEngaged = false;
		this._onWheelGate = (e) => {
			if (!e.ctrlKey && !e.metaKey && !this._wheelEngaged) e.stopImmediatePropagation();
		};
		this._onPointerEngage = () => { this._wheelEngaged = true; };
		this._onPointerDisengage = () => { this._wheelEngaged = false; };
		this.host.addEventListener('wheel', this._onWheelGate, { capture: true });
		renderer.domElement.addEventListener('pointerdown', this._onPointerEngage);
		renderer.domElement.addEventListener('pointerleave', this._onPointerDisengage);

		this.controls = new OrbitControls(this.camera, renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		// Pan moves the avatar around the frame: right-drag or two-finger drag.
		this.controls.enablePan = true;
		this.controls.screenSpacePanning = true;
		this.controls.minDistance = 0.6;
		this.controls.maxDistance = 8;
		// Keep the camera above the floor so users can't orbit under the avatar.
		this.controls.maxPolarAngle = Math.PI * 0.92;
		// One-finger vertical swipes keep scrolling the page on touch screens;
		// horizontal swipes orbit. OrbitControls sets touch-action:none, which
		// would swallow mobile page scrolling over a tall hero canvas.
		renderer.domElement.style.touchAction = 'pan-y';

		// A camera the user can move is a camera the user can lose. Double-click
		// snaps home, and a reset pill appears whenever the view leaves home.
		renderer.domElement.addEventListener('dblclick', () => this.reframe());
		this._buildResetButton();
		this.controls.addEventListener('start', () => this._setViewMoved(true));

		this._resize();
		this._resizeObserver = new ResizeObserver(() => this._resize());
		this._resizeObserver.observe(this.host);

		await _meshoptReady;
		const gltf = await _loader.loadAsync(this.glbUrl);
		if (this._disposed) return { supported: false };
		this.model = gltf.scene;
		this.model.traverse((n) => {
			if (!n.isMesh && !n.isSkinnedMesh) return;
			n.frustumCulled = false;
			// Both flags: the avatar must shadow ITSELF (arm across the chest,
			// chin onto the neck), not just drop a silhouette on the floor.
			n.castShadow = true;
			n.receiveShadow = true;
		});
		scene.add(this.model);
		this._frameModel();

		// Register + retarget the full clip library against this rig.
		this.anim.attach(this.model);
		const defs = await loadPoseManifest();
		this.anim.setAnimationDefs(defs);
		const supported = this.anim.supportsCanonicalClips();
		if (supported) {
			// Embedded clips (if any) come along for free via attach(); the
			// library is what we lazily load. Pre-warm idle so the avatar settles
			// out of bind pose the moment the stage appears.
			this.anim.crossfadeTo('idle', 0).catch(() => {});
			this.anim.onChange = (name) => { try { this.onChange?.(name); } catch {} };
		}

		return { supported };
	}

	/** Frame the avatar: face-on, full body, slightly above mid-height. */
	_frameModel() {
		const box = new Box3().setFromObject(this.model);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		const height = size.y || 1.6;

		// Drop the model so its feet sit at y=0, then look at the upper torso.
		this.model.position.y -= box.min.y;
		this._fitShadowCamera(height, center);
		// Portrait framing crops to the signing space — roughly the waist up,
		// where every handshape, the face, and both hands live. Signing reads at
		// the scale of a finger, so a full-body distance throws the detail away.
		// It also centers on the model's true x/z, since a close camera amplifies
		// any off-origin authoring the full-body distance hides.
		const portrait = this.framing === 'portrait';
		// Center on the BODY, not on the bounding box. A raised arm moves the
		// box sideways, so framing from it swings the camera off the figure the
		// moment a pose plays (a signing hand pushed the avatar to the frame's
		// edge). The hips are the one landmark a pose does not move.
		const root = this.model.getObjectByName('Hips') || this.model.getObjectByName('mixamorig:Hips');
		const bodyCenter = root ? root.getWorldPosition(new Vector3()) : center;
		const cx = portrait ? bodyCenter.x : 0;
		const cz = portrait ? bodyCenter.z : 0;
		// Full framing must contain the whole figure: at fov 35 the visible span
		// is ~0.63*dist, so 1.75*height centered at 0.52*height leaves a few
		// percent of margin above the head and below the feet.
		const target = new Vector3(cx, height * (portrait ? 0.8 : 0.52), cz);
		const dist = height * (portrait ? 0.92 : 1.75);
		this._homeView = {
			target,
			position: new Vector3(cx, height * (portrait ? 0.83 : 0.58), cz + dist),
			near: Math.max(0.01, dist / 100),
			far: dist * 20,
		};
		this.reframe();
	}

	/**
	 * Size the shadow frustum to the rig actually loaded. A fixed frustum either
	 * clips the shadow off a tall avatar or wastes most of its resolution on a
	 * short one, and three.ws rigs range from chibi to 2m.
	 * @param {number} height  model height in world units
	 * @param {Vector3} center bounding-box center, for the light's aim
	 */
	_fitShadowCamera(height, center) {
		const key = this._key;
		if (!key) return;
		// Raised arms and a signing reach put the silhouette well outside the
		// resting bounds, so the frustum covers a generous margin around it.
		const extent = height * 0.85;
		const cam = key.shadow.camera;
		cam.left = -extent;
		cam.right = extent;
		cam.top = extent;
		cam.bottom = -extent;
		cam.near = 0.05;
		cam.far = height * 6;
		cam.updateProjectionMatrix();
		// Scale the light rig to the model so the key angle holds on any size.
		key.position.set(height * 1.1, height * 1.6, height * 1.3);
		key.target.position.set(center.x, height * 0.5, center.z);
		key.target.updateMatrixWorld();
	}

	/** Snap the camera back to the home framing. Safe to call any time. */
	reframe() {
		if (!this._homeView || !this.camera) return;
		const { target, position, near, far } = this._homeView;
		this.camera.position.copy(position);
		this.camera.near = near;
		this.camera.far = far;
		this.camera.updateProjectionMatrix();
		this.controls.target.copy(target);
		this.controls.update();
		this._setViewMoved(false);
	}

	/** The reset pill lives inside the host so every PoseStage page gets it. */
	_buildResetButton() {
		if (getComputedStyle(this.host).position === 'static') this.host.style.position = 'relative';
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'av-pose-reset';
		btn.textContent = 'Reset view';
		btn.setAttribute('aria-label', 'Reset the camera to the default view');
		btn.title = 'Drag to rotate, right-drag to move, pinch or ctrl+scroll to zoom. Double-click also resets.';
		btn.style.cssText = [
			'position:absolute', 'top:10px', 'right:10px', 'z-index:2',
			'padding:6px 12px', 'border-radius:999px', 'border:1px solid rgba(167,139,250,.4)',
			'background:rgba(10,10,14,.72)', 'color:#e7e5f4', 'font:12px/1.2 ui-monospace,monospace',
			'cursor:pointer', 'opacity:0', 'visibility:hidden', 'pointer-events:none',
			'transition:opacity .2s ease, visibility .2s ease',
			'backdrop-filter:blur(6px)',
		].join(';');
		btn.addEventListener('click', () => this.reframe());
		btn.addEventListener('pointerenter', () => { btn.style.borderColor = 'rgba(167,139,250,.9)'; });
		btn.addEventListener('pointerleave', () => { btn.style.borderColor = 'rgba(167,139,250,.4)'; });
		// A focus ring the pill can't get from a stylesheet: it is built here,
		// so pages that never styled `.av-pose-reset` would otherwise focus it
		// invisibly (WCAG 2.4.7).
		btn.addEventListener('focus', () => { btn.style.outline = '2px solid rgba(167,139,250,.95)'; btn.style.outlineOffset = '2px'; });
		btn.addEventListener('blur', () => { btn.style.outline = 'none'; });
		this._resetBtn = btn;
		this.host.appendChild(btn);
	}

	_setViewMoved(moved) {
		if (!this._resetBtn) return;
		// `opacity:0` alone leaves the pill focusable and announced while it is
		// invisible, so a keyboard user tabs into nothing. `visibility` removes
		// it from the tab order and the accessibility tree, and still fades
		// because the transition covers visibility as well as opacity.
		this._resetBtn.style.visibility = moved ? 'visible' : 'hidden';
		this._resetBtn.style.opacity = moved ? '1' : '0';
		this._resetBtn.style.pointerEvents = moved ? 'auto' : 'none';
	}

	/**
	 * Play a clip by manifest name. Crossfades from whatever is current so the
	 * transition reads smoothly. Honors the def's loop flag.
	 * @param {string} name
	 * @param {PoseDef} [def]
	 */
	async play(name) {
		await this.anim.crossfadeTo(name, 0.25);
	}

	/** 1 = normal; the transport slider drives this. */
	setSpeed(scale) {
		this.anim.setSpeed(scale);
	}

	/** Stop motion and settle back to idle (or bind pose if idle is missing). */
	async reset() {
		await this.anim.crossfadeTo('idle', 0.3);
	}

	/** Begin the render loop. Idempotent. */
	start() {
		if (this._running || this._disposed) return;
		this._running = true;
		this.clock.update(); // discard the gap accumulated while hidden
		const tick = () => {
			if (!this._running) return;
			this._frame = requestAnimationFrame(tick);
			this.clock.update();
			const delta = this.clock.getDelta();
			this.anim.update(delta);
			this.controls.update();
			this.renderer.render(this.scene, this.camera);
		};
		this._frame = requestAnimationFrame(tick);
	}

	/** Pause the render loop (GPU goes quiet) without tearing down state. */
	stop() {
		this._running = false;
		if (this._frame) cancelAnimationFrame(this._frame);
		this._frame = 0;
	}

	_resize() {
		if (!this.renderer || !this.camera) return;
		const w = this.host.clientWidth || 1;
		const h = this.host.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	/** Full teardown — releases the WebGL context and all GPU resources. */
	dispose() {
		this._disposed = true;
		this.stop();
		this._resizeObserver?.disconnect();
		this._resizeObserver = null;
		this.host?.removeEventListener('wheel', this._onWheelGate, { capture: true });
		this._resetBtn?.remove();
		this._resetBtn = null;
		this._ground?.geometry?.dispose();
		this._ground?.material?.dispose();
		this._ground = null;
		this._key = null;
		this.anim.dispose();
		this.scene?.environment?.dispose?.();
		this.renderer?.domElement?.remove();
		this.renderer?.dispose();
		this.renderer = null;
		this.scene = null;
		this.model = null;
	}
}
