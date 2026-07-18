/**
 * AvatarStage: @three-ws/concierge (shared lineage: page-agent-sdk/src/stage.js)
 * ==================================
 *
 * The 3D surface: a transparent WebGL canvas that loads a rigged glTF agent,
 * frames it (bust / upper / full), and keeps it alive with skeletal idle motion
 *, a played idle clip when the GLB ships one, otherwise a procedural breathing
 * + sway + blink loop so the agent never looks like a frozen statue (the whole
 * reason we require rigged avatars). It exposes the morph map + a per-frame hook
 * so the lipsync driver and speech narrator can drive the mouth in sync.
 *
 * Peer-depends on `three` only. Addons resolve through the consumer's bundler
 * (or the import map / inlined build for <script> usage).
 */

import {
	Scene, PerspectiveCamera, WebGLRenderer, AmbientLight, DirectionalLight,
	Box3, Vector3, Color, Clock, PMREMGenerator, AnimationMixer, LoopRepeat,
	ACESFilmicToneMapping, SRGBColorSpace, MathUtils,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildMorphMap } from './lipsync.js';

// Catalog rigs served by three.ws (e.g. cz.glb) carry EXT_meshopt_compression;
// GLTFLoader throws "setMeshoptDecoder must be called" without a decoder.
// Lazy + memoized so pages using only uncompressed rigs skip the wasm init.
let _meshoptPromise = null;
function getMeshoptDecoder() {
	if (!_meshoptPromise) {
		_meshoptPromise = import('three/addons/libs/meshopt_decoder.module.js').then((m) => m.MeshoptDecoder);
	}
	return _meshoptPromise;
}

const FRAMING = {
	// [vertical fraction of model height to center on, distance multiplier]
	bust: { center: 0.86, dist: 0.62, fov: 28 },
	upper: { center: 0.72, dist: 1.0, fov: 30 },
	full: { center: 0.5, dist: 1.9, fov: 32 },
};

const BLINK_MORPHS = ['eyeBlinkLeft', 'eyeBlinkRight', 'eyesClosed', 'blink'];

export class AvatarStage {
	/**
	 * @param {HTMLElement} container  Element the canvas fills.
	 * @param {{ background?: string }} [opts]
	 */
	constructor(container, opts = {}) {
		this.container = container;
		this._opts = opts;

		this.scene = new Scene();
		this._applyBackground(opts.background);

		this.canvas = document.createElement('canvas');
		this.canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none';
		container.appendChild(this.canvas);

		const w = container.clientWidth || 320;
		const h = container.clientHeight || 360;

		this.camera = new PerspectiveCamera(30, w / h, 0.05, 200);
		this.camera.position.set(0, 1.5, 2.2);

		this.renderer = new WebGLRenderer({
			canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setSize(w, h, false);
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;

		const pmrem = new PMREMGenerator(this.renderer);
		this._envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		this.scene.environment = this._envTex;
		pmrem.dispose();

		this.scene.add(new AmbientLight(0xffffff, 0.6));
		const key = new DirectionalLight(0xffffff, 1.4);
		key.position.set(1.5, 3, 2.5);
		this.scene.add(key);
		const rim = new DirectionalLight(0x99bbff, 0.5);
		rim.position.set(-2, 2, -2);
		this.scene.add(rim);

		this.clock = new Clock();
		this.mixer = null;
		this.model = null;
		this.morph = null;
		this._idleAction = null;
		this._talkAction = null;
		this._speaking = false;
		this._loadToken = 0;
		this._frameHooks = new Set();
		this._headBone = null;
		this._blinkTargets = [];
		this._nextBlink = 1 + Math.random() * 3;
		this._blinkT = -1;
		this._reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

		this._resizeObs = new ResizeObserver(() => this._resize());
		this._resizeObs.observe(container);

		// Pause the render loop when the tab is backgrounded or the agent scrolls
		// offscreen, a docked WebGL canvas should never burn GPU it can't be seen on.
		this._visible = !document.hidden;
		this._onscreen = true;
		this._render = this._render.bind(this);
		this._onVisibility = () => { this._visible = !document.hidden; this._kick(); };
		document.addEventListener('visibilitychange', this._onVisibility);
		this._inViewObs = new IntersectionObserver(
			(entries) => { this._onscreen = entries.some((e) => e.isIntersecting); this._kick(); },
			{ threshold: 0 },
		);
		this._inViewObs.observe(container);

		this._raf = 0;
		this._raf = requestAnimationFrame(this._render);
	}

	/** (Re)start the render loop if it is paused and the stage is currently visible. */
	_kick() {
		if (this._raf || !this.renderer || !this._visible || !this._onscreen) return;
		this.clock.getDelta(); // discard the idle gap so motion resumes smoothly
		this._raf = requestAnimationFrame(this._render);
	}

	/** Register a per-frame callback `(dtSeconds, nowMs) => void`. Returns an unsubscribe. */
	onFrame(fn) {
		this._frameHooks.add(fn);
		return () => this._frameHooks.delete(fn);
	}

	/**
	 * Load a rigged GLB. Replaces any current model. Resolves once framed.
	 * @param {string} url
	 * @param {{ framing?: 'bust'|'upper'|'full' }} [opts]
	 */
	async load(url, opts = {}) {
		const token = ++this._loadToken;
		const loader = new GLTFLoader();
		loader.setMeshoptDecoder(await getMeshoptDecoder());
		const gltf = await loader.loadAsync(url);
		if (token !== this._loadToken) return null; // superseded

		if (this.model) {
			this.scene.remove(this.model);
			this._disposeObject(this.model);
		}
		if (this.mixer) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model); }
		this.mixer = null;
		this._idleAction = null;
		this._talkAction = null;

		this.model = gltf.scene;
		this.scene.add(this.model);
		this.morph = buildMorphMap(this.model);
		this._collectRigRefs(this.model);

		// Animation: prefer a named idle clip; keep any talk clip for speaking.
		if (gltf.animations?.length) {
			this.mixer = new AnimationMixer(this.model);
			const idle = pickClip(gltf.animations, ['idle', 'breathing', 'stand', 'rest']) || gltf.animations[0];
			const talk = pickClip(gltf.animations, ['talk', 'talking', 'speak', 'gesture', 'wave']);
			if (idle) {
				this._idleAction = this.mixer.clipAction(idle);
				this._idleAction.setLoop(LoopRepeat, Infinity).play();
			}
			if (talk && talk !== idle) {
				this._talkAction = this.mixer.clipAction(talk);
				this._talkAction.setLoop(LoopRepeat, Infinity);
				this._talkAction.enabled = true;
				this._talkAction.setEffectiveWeight(0);
				this._talkAction.play();
			}
		}

		this._frame(opts.framing || 'upper');
		return gltf;
	}

	/** Begin/halt the talking visual state (animation weight + body emphasis). */
	setSpeaking(on) {
		this._speaking = !!on;
		if (this._talkAction) {
			// Crossfade talk-clip weight; idle stays underneath.
			this._talkAction.setEffectiveWeight(on ? 0.85 : 0);
		}
	}

	_collectRigRefs(root) {
		this._headBone = null;
		this._blinkTargets = [];
		root.traverse((node) => {
			if (node.isBone && /head/i.test(node.name) && !/headtop|end/i.test(node.name) && !this._headBone) {
				this._headBone = node;
				node.userData._restQ = node.quaternion.clone();
			}
			if (node.isMesh && node.morphTargetDictionary) {
				for (const name of BLINK_MORPHS) {
					const idx = node.morphTargetDictionary[name];
					if (idx !== undefined) this._blinkTargets.push({ mesh: node, index: idx });
				}
			}
		});
	}

	_frame(framing) {
		const conf = FRAMING[framing] || FRAMING.upper;
		const box = new Box3().setFromObject(this.model);
		const size = new Vector3();
		const center = new Vector3();
		box.getSize(size);
		box.getCenter(center);
		const height = size.y || 1.7;
		const focusY = box.min.y + height * conf.center;
		const focusX = center.x;
		const maxDim = Math.max(size.x, height) || 1;

		this.camera.fov = conf.fov;
		const fov = (conf.fov * Math.PI) / 180;
		const dist = ((maxDim / 2) / Math.tan(fov / 2)) * conf.dist;
		this.camera.position.set(focusX, focusY, box.max.z + dist);
		this.camera.near = Math.max(0.01, dist / 100);
		this.camera.far = dist * 50;
		this.camera.lookAt(focusX, focusY, center.z);
		this.camera.updateProjectionMatrix();
		this._focus = new Vector3(focusX, focusY, center.z);
	}

	_proceduralIdle(t) {
		if (this.mixer || this._reduce || !this.model) return; // clip-driven or static
		// Subtle breathing on the whole model + head sway when no skeletal clip.
		const breathe = Math.sin(t * 1.6) * 0.006;
		this.model.position.y = breathe;
		if (this._headBone && this._headBone.userData._restQ) {
			const sway = Math.sin(t * 0.6) * 0.05;
			const nod = Math.sin(t * 0.9) * 0.03 + (this._speaking ? Math.sin(t * 6) * 0.04 : 0);
			this._headBone.quaternion.copy(this._headBone.userData._restQ);
			this._headBone.rotateY(sway);
			this._headBone.rotateX(nod);
		}
	}

	_blink(dt) {
		if (!this._blinkTargets.length || this._reduce) return;
		if (this._blinkT < 0) {
			this._nextBlink -= dt;
			if (this._nextBlink <= 0) { this._blinkT = 0; this._nextBlink = 2 + Math.random() * 4; }
			return;
		}
		this._blinkT += dt;
		const dur = 0.16;
		const v = this._blinkT < dur / 2
			? this._blinkT / (dur / 2)
			: 1 - (this._blinkT - dur / 2) / (dur / 2);
		const w = MathUtils.clamp(v, 0, 1);
		for (const { mesh, index } of this._blinkTargets) mesh.morphTargetInfluences[index] = w;
		if (this._blinkT >= dur) this._blinkT = -1;
	}

	_render() {
		// Re-arm only while visible & onscreen; _kick() resumes when that changes.
		if (!this.renderer || !this._visible || !this._onscreen) { this._raf = 0; return; }
		this._raf = requestAnimationFrame(this._render);
		const dt = Math.min(this.clock.getDelta(), 0.05);
		const t = this.clock.elapsedTime;
		const nowMs = t * 1000;
		this.mixer?.update(dt);
		this._proceduralIdle(t);
		this._blink(dt);
		for (const fn of this._frameHooks) {
			try { fn(dt, nowMs); } catch { /* a misbehaving hook must not kill the loop */ }
		}
		this.renderer.render(this.scene, this.camera);
	}

	_resize() {
		if (!this.renderer || !this.camera) return;
		const w = this.container.clientWidth || 1;
		const h = this.container.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	_applyBackground(value) {
		if (!value || value === 'transparent') { this.scene.background = null; return; }
		try { this.scene.background = new Color(value); } catch { this.scene.background = null; }
	}

	_disposeObject(obj) {
		obj.traverse?.((n) => {
			n.geometry?.dispose?.();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			mats.forEach((m) => {
				if (!m) return;
				for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
				m.dispose?.();
			});
		});
	}

	dispose() {
		cancelAnimationFrame(this._raf);
		this._raf = 0;
		this._resizeObs?.disconnect();
		this._inViewObs?.disconnect();
		document.removeEventListener('visibilitychange', this._onVisibility);
		this._frameHooks.clear();
		if (this.model) { this.scene.remove(this.model); this._disposeObject(this.model); }
		this._envTex?.dispose();
		this._envTex = null;
		this.renderer?.dispose();
		this.renderer?.forceContextLoss?.();
		this.renderer = null;
		this.canvas?.remove();
		this.scene = null;
		this.camera = null;
		this.model = null;
	}
}

function pickClip(clips, hints) {
	for (const hint of hints) {
		const found = clips.find((c) => c.name && c.name.toLowerCase().includes(hint));
		if (found) return found;
	}
	return null;
}
