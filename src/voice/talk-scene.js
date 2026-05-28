/**
 * TalkScene — minimal three.js renderer used during "Talk to avatar" mode.
 *
 * model-viewer 4.x doesn't expose its internal three.js scene as a stable API,
 * so we render the avatar ourselves whenever lipsync needs to drive morphs in
 * real time. The showcase view (rotation, environment lighting) is still
 * served by model-viewer when talk mode is inactive — this module mounts only
 * on demand and unmounts cleanly when talk mode ends.
 *
 * Public surface:
 *   const scene = new TalkScene();
 *   await scene.mount({ container, glbUrl });
 *   scene.attachMouthTarget(target);   // AvatarMouthTarget
 *   scene.playAnimation('Idle');       // optional, if the GLB has clips
 *   scene.unmount();
 */

import {
	Clock,
	WebGLRenderer,
	SRGBColorSpace,
	ACESFilmicToneMapping,
	Scene,
	PMREMGenerator,
	AmbientLight,
	DirectionalLight,
	PerspectiveCamera,
	AnimationMixer,
	Box3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeFraming, CAMERA_PRESETS } from './camera-presets.js';
import { TalkEmotes } from './talk-emotes.js';
import { getMeshoptDecoder } from '../viewer/internal.js';

export class TalkScene {
	constructor() {
		this.container = null;
		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.gltf = null;
		this.root = null;
		this.mixer = null;
		this._clips = [];
		this._currentAction = null;
		this._clock = new Clock();
		this._rafId = 0;
		this._running = false;
		this._resizeObserver = null;
		this._mouthTarget = null;
		this._cameraPreset = 'full';
		this._emotes = null;
		// External per-frame subscribers (idle animation, custom drivers).
		// Receive dt in seconds. Use addOnTick() to register, call the returned
		// dispose function to unsubscribe.
		this._onTickFns = new Set();
	}

	/**
	 * Register a callback invoked every frame inside this scene's render loop
	 * with the elapsed dt in seconds. Returns a function that removes the
	 * subscription. Callbacks fire after controls/mixer/emotes update and
	 * before the render call, so writes to bones/morphs take effect this frame.
	 * @param {(dt: number) => void} fn
	 * @returns {() => void}
	 */
	addOnTick(fn) {
		if (typeof fn !== 'function') return () => {};
		this._onTickFns.add(fn);
		return () => this._onTickFns.delete(fn);
	}

	async mount({ container, glbUrl, glbBlob, cameraPreset = 'full' }) {
		this._cameraPreset = CAMERA_PRESETS.includes(cameraPreset) ? cameraPreset : 'full';
		if (!container) throw new Error('TalkScene.mount: container required');
		if (!glbUrl && !glbBlob) throw new Error('TalkScene.mount: glbUrl or glbBlob required');
		this.container = container;

		// preserveDrawingBuffer keeps the WebGL framebuffer readable via
		// `canvas.toBlob` — required for the snapshot pipeline (see
		// avatar-snapshot.js) to capture a valid JPEG after a render. The perf
		// cost is small for avatar-scale scenes; large at fullscreen-game scale.
		this.renderer = new WebGLRenderer({
			antialias: true,
			alpha: true,
			preserveDrawingBuffer: true,
		});
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;

		const { width, height } = sizeOf(container);
		this.renderer.setSize(width, height, false);
		this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;';
		container.appendChild(this.renderer.domElement);

		this.scene = new Scene();
		this.scene.background = null; // transparent so the page bg shows through

		// Image-based lighting via RoomEnvironment — same look-and-feel choice
		// model-viewer uses when no environment-image is set.
		const pmrem = new PMREMGenerator(this.renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

		// Fill + key + rim for visual depth.
		this.scene.add(new AmbientLight(0xffffff, 0.4));
		const key = new DirectionalLight(0xffffff, 1.4);
		key.position.set(2, 4, 3);
		this.scene.add(key);
		const rim = new DirectionalLight(0x90a0ff, 0.6);
		rim.position.set(-3, 2, -2);
		this.scene.add(rim);

		this.camera = new PerspectiveCamera(35, width / height, 0.05, 100);
		this.camera.position.set(0, 1.55, 2.0);

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.target.set(0, 1.4, 0);
		this.controls.minDistance = 0.5;
		this.controls.maxDistance = 6;
		this.controls.update();

		// Load the GLB. Baked avatars carry EXT_meshopt_compression; the
		// loader can only decode them once the meshopt decoder is wired.
		//
		// When a Blob is supplied we read it into an ArrayBuffer once and call
		// `loader.parse()` directly — no second-fetch hop via object URL. This
		// avoids the "Failed to fetch" class of errors when an unstaged blob
		// URL is invalidated mid-load (navigation away, page reload). For
		// remote URLs we still use `loader.load()`.
		const loader = new GLTFLoader();
		loader.setMeshoptDecoder(await getMeshoptDecoder());
		const gltf = await new Promise(async (resolve, reject) => {
			try {
				if (glbBlob) {
					const buf = await glbBlob.arrayBuffer();
					loader.parse(buf, '', resolve, reject);
				} else {
					loader.load(glbUrl, resolve, undefined, reject);
				}
			} catch (err) {
				reject(err);
			}
		});
		this.gltf = gltf;
		this.root = gltf.scene;
		this.scene.add(this.root);

		// Frame the avatar: aim the camera at its head (estimated as the top
		// 15% of the bounding box) and back off proportional to its height.
		this._frameAvatar();

		// If the GLB ships any animations, set up a mixer and remember the
		// clips so the caller can request one (e.g. 'Idle' for a base loop).
		if (gltf.animations?.length) {
			this.mixer = new AnimationMixer(this.root);
			this._clips = gltf.animations;
			// Auto-play an idle if one is present.
			const idle = gltf.animations.find((c) => /idle|breath/i.test(c.name));
			if (idle) this.playAnimation(idle.name);
		}

		// External emote library — loads /animations/manifest.json so callers
		// can play any baked clip (wave, dance, celebrate, …) on this avatar.
		// Tracks are filtered per-bone so unmatched rigs cleanly no-op rather
		// than throwing.
		this._emotes = new TalkEmotes();
		this._emotes.attach(this.root);
		// Manifest fetch is async — fire it but don't block mount on it. The
		// caller can `await scene.getEmoteController().loadManifest()` if it
		// needs the bar populated before showing UI.
		this._emotes.loadManifest().catch(() => {});

		this._installResizeObserver();
		this._start();
		return this.root;
	}

	/** Access the emote controller (for UI integration). */
	getEmoteController() {
		return this._emotes;
	}

	/** Convenience: play an external emote by name. */
	playEmote(name) {
		return this._emotes?.play(name) ?? Promise.resolve(false);
	}

	attachMouthTarget(target) {
		this._mouthTarget = target;
		if (this.root) target.attach(this.root);
	}

	/** Play a clip by exact or fuzzy name. Returns true if a clip was started. */
	playAnimation(nameOrHint) {
		if (!this.mixer || !this._clips.length) return false;
		const hint = String(nameOrHint).toLowerCase();
		const clip =
			this._clips.find((c) => c.name === nameOrHint) ||
			this._clips.find((c) => c.name.toLowerCase().includes(hint));
		if (!clip) return false;
		const next = this.mixer.clipAction(clip);
		next.reset();
		next.fadeIn(0.25).play();
		if (this._currentAction && this._currentAction !== next) {
			this._currentAction.fadeOut(0.25);
		}
		this._currentAction = next;
		return true;
	}

	unmount() {
		this._running = false;
		if (this._rafId) cancelAnimationFrame(this._rafId);
		this._rafId = 0;

		if (this._emotes) {
			this._emotes.detach();
			this._emotes = null;
		}

		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = null;
		}

		if (this.controls) {
			this.controls.dispose();
			this.controls = null;
		}

		// Dispose GPU resources.
		if (this.root) {
			this.root.traverse((node) => {
				node.geometry?.dispose?.();
				const mats = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
				for (const m of mats) {
					m.map?.dispose?.();
					m.normalMap?.dispose?.();
					m.roughnessMap?.dispose?.();
					m.metalnessMap?.dispose?.();
					m.emissiveMap?.dispose?.();
					m.dispose?.();
				}
			});
		}

		this.scene?.environment?.dispose?.();
		this.renderer?.dispose?.();

		if (this.renderer?.domElement && this.renderer.domElement.parentNode === this.container) {
			this.container.removeChild(this.renderer.domElement);
		}

		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.root = null;
		this.gltf = null;
		this.mixer = null;
		this._clips = [];
		this._currentAction = null;
		this._mouthTarget = null;
	}

	// ── internals ────────────────────────────────────────────────────────

	/**
	 * Switch to a different camera framing preset and reframe immediately.
	 * No-op if the avatar hasn't loaded yet — the next _frameAvatar() picks up
	 * the new preset.
	 */
	setCameraPreset(preset) {
		if (!CAMERA_PRESETS.includes(preset)) return;
		this._cameraPreset = preset;
		this._frameAvatar();
	}

	getCameraPreset() {
		return this._cameraPreset;
	}

	_frameAvatar() {
		if (!this.root || !this.camera || !this.controls) return;
		const b = new Box3().setFromObject(this.root);
		const aspect = this.camera.aspect || 1;
		const framing = computeFraming({
			box: { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } },
			preset: this._cameraPreset,
			aspectRatio: aspect,
		});
		this.controls.target.set(framing.target.x, framing.target.y, framing.target.z);
		this.camera.position.set(framing.position.x, framing.position.y, framing.position.z);
		if (this.camera.fov !== framing.fov) {
			this.camera.fov = framing.fov;
			this.camera.updateProjectionMatrix();
		}
		this.controls.update();
	}

	_installResizeObserver() {
		if (typeof ResizeObserver === 'undefined') return;
		this._resizeObserver = new ResizeObserver(() => {
			if (!this.renderer || !this.camera) return;
			const { width, height } = sizeOf(this.container);
			if (width === 0 || height === 0) return;
			this.renderer.setSize(width, height, false);
			this.camera.aspect = width / height;
			this.camera.updateProjectionMatrix();
			// Distance/target depend on aspect (T-pose width vs viewport), so a
			// resize from wide → narrow needs a reframe or the silhouette clips.
			this._frameAvatar();
		});
		this._resizeObserver.observe(this.container);
	}

	_start() {
		if (this._running) return;
		this._running = true;
		const tick = () => {
			if (!this._running) return;
			const dt = this._clock.getDelta();
			this.controls?.update();
			this.mixer?.update(dt);
			this._emotes?.update(dt);
			for (const fn of this._onTickFns) fn(dt);
			this.renderer?.render(this.scene, this.camera);
			this._rafId = requestAnimationFrame(tick);
		};
		this._rafId = requestAnimationFrame(tick);
	}
}

function sizeOf(el) {
	const rect = el.getBoundingClientRect();
	return {
		width: Math.max(1, Math.floor(rect.width)),
		height: Math.max(1, Math.floor(rect.height)),
	};
}
