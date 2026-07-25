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
	 * @param {{ glbUrl: string }} opts
	 */
	constructor(host, { glbUrl, framing = 'full' }) {
		this.host = host;
		this.glbUrl = glbUrl;
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
		renderer.toneMappingExposure = 1.05;
		renderer.domElement.className = 'av-pose-canvas';
		this.renderer = renderer;
		this.host.appendChild(renderer.domElement);

		const scene = new Scene();
		this.scene = scene;

		// Neutral studio environment for physically-based materials, plus a
		// three-point key/fill so the avatar reads with form even on flat GLBs.
		const pmrem = new PMREMGenerator(renderer);
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();
		scene.add(new HemisphereLight(0xffffff, 0x39404d, 0.9));
		const key = new DirectionalLight(0xffffff, 1.5);
		key.position.set(2, 3, 2.4);
		scene.add(key, new AmbientLight(0xffffff, 0.35));

		const w = this.host.clientWidth || 1;
		const h = this.host.clientHeight || 1;
		this.camera = new PerspectiveCamera(35, w / h, 0.01, 100);

		this.controls = new OrbitControls(this.camera, renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.enablePan = false;
		this.controls.minDistance = 0.6;
		this.controls.maxDistance = 8;
		// Keep the camera above the floor so users can't orbit under the avatar.
		this.controls.maxPolarAngle = Math.PI * 0.92;

		this._resize();
		this._resizeObserver = new ResizeObserver(() => this._resize());
		this._resizeObserver.observe(this.host);

		await _meshoptReady;
		const gltf = await _loader.loadAsync(this.glbUrl);
		if (this._disposed) return { supported: false };
		this.model = gltf.scene;
		this.model.traverse((n) => { if (n.isMesh) n.frustumCulled = false; });
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
		// Portrait framing crops to the signing space — roughly the waist up,
		// where every handshape, the face, and both hands live. Signing reads at
		// the scale of a finger, so a full-body distance throws the detail away.
		// It also centers on the model's true x/z, since a close camera amplifies
		// any off-origin authoring the full-body distance hides.
		const portrait = this.framing === 'portrait';
		const cx = portrait ? center.x : 0;
		const cz = portrait ? center.z : 0;
		const target = new Vector3(cx, height * (portrait ? 0.8 : 0.55), cz);
		const dist = height * (portrait ? 0.92 : 1.6);
		this.camera.position.set(cx, height * (portrait ? 0.83 : 0.62), cz + dist);
		this.camera.near = Math.max(0.01, dist / 100);
		this.camera.far = dist * 20;
		this.camera.updateProjectionMatrix();
		this.controls.target.copy(target);
		this.controls.update();
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
		this.anim.dispose();
		this.scene?.environment?.dispose?.();
		this.renderer?.domElement?.remove();
		this.renderer?.dispose();
		this.renderer = null;
		this.scene = null;
		this.model = null;
	}
}
