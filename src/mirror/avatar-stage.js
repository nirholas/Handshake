/**
 * AvatarStage — the cinematic 3D render surface for /mirror ("Become your agent").
 *
 * Loads a GLB avatar, lights it like a portrait studio, and drives its face +
 * head from the FaceFrame stream produced by FaceTracker (MediaPipe). The
 * mapping is name-for-name: MediaPipe FaceLandmarker emits ARKit blendshape
 * names (jawOpen, eyeBlinkLeft, mouthSmileLeft, browInnerUp, eyeLookInLeft …)
 * and the avatars we ship carry morph targets with those exact names, so a
 * smile becomes a smile with no guesswork. A small alias table extends support
 * to rigs that only carry the combined morphs (eyesClosed / mouthSmile /
 * mouthOpen) so user-supplied avatars still emote.
 *
 * Head pose (pitch/yaw/roll in radians) is split across the Neck and Head bones
 * for a natural turn, damped and clamped so the avatar never snaps or breaks
 * its neck. When no face is present the avatar stays alive: slow breathing,
 * gentle head sway, and the occasional blink.
 *
 * The class owns nothing but its <canvas> and the WebGL context. It exposes a
 * single applyFace(frame) entry point, plus background / mirror / head-tracking
 * controls and snapshot access for the recorder. No DOM scaffolding, no CSS.
 *
 * @module mirror/avatar-stage
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Bone names seen across the riggers that target three.ws (ReadyPlayerMe,
// Avaturn, Mixamo, VRoid, Rigify). Matched case-insensitively.
const HEAD_BONE_NAMES = [
	'head', 'mixamorig:head', 'mixamorighead', 'cc_base_head', 'bip01_head',
	'j_bip_c_head', 'head_01', 'headbone', 'def-spine.006', 'def-head', 'org-head',
];
const NECK_BONE_NAMES = [
	'neck', 'mixamorig:neck', 'mixamorigneck', 'cc_base_neckTwist01', 'cc_base_neck',
	'bip01_neck', 'j_bip_c_neck', 'neck_01', 'neckbone', 'def-spine.004', 'org-neck',
];
const SPINE_BONE_NAMES = [
	'spine2', 'spine1', 'spine', 'mixamorig:spine2', 'mixamorigspine2',
	'cc_base_spine02', 'j_bip_c_spine', 'def-spine.003', 'chest', 'upperchest',
];

// Avatars that only carry combined morphs still emote: feed the granular ARKit
// channel into the combined target. left/right pairs average so a one-sided
// smile reads correctly. Keys + values are lower-cased.
const MORPH_ALIASES = {
	eyeblinkleft: ['eyesclosed', 'blink', 'blink_left', 'eyeblink_l'],
	eyeblinkright: ['eyesclosed', 'blink', 'blink_right', 'eyeblink_r'],
	mouthsmileleft: ['mouthsmile', 'smile'],
	mouthsmileright: ['mouthsmile', 'smile'],
	jawopen: ['mouthopen', 'mouth_open', 'aa', 'viseme_aa', 'a'],
	mouthfunnel: ['mouth_o', 'viseme_o', 'o'],
	mouthpucker: ['viseme_u', 'u'],
	eyelookupleft: ['eyeslookup'],
	eyelookupright: ['eyeslookup'],
	eyelookdownleft: ['eyeslookdown'],
	eyelookdownright: ['eyeslookdown'],
};

// Head rotation clamps (radians). Keeps motion expressive but anatomical.
const YAW_LIMIT = 0.62;
const PITCH_LIMIT = 0.5;
const ROLL_LIMIT = 0.42;

export class AvatarStage {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {object} [opts]
	 * @param {number} [opts.expressiveness=1.15] global gain on blendshape weights
	 * @param {number} [opts.headGain=1.0] global gain on head rotation
	 */
	constructor(canvas, opts = {}) {
		this.canvas = canvas;
		this.expressiveness = opts.expressiveness ?? 1.15;
		this.headGain = opts.headGain ?? 1.0;

		this._mirror = true;
		this._headTracking = true;
		this._faceActive = false;
		this._lastFaceTs = 0;
		this._disposed = false;
		this._running = false;

		// Smoothed state.
		this._morphState = new Map(); // morph key -> current weight
		this._headTarget = { pitch: 0, yaw: 0, roll: 0 };
		this._headCurrent = { pitch: 0, yaw: 0, roll: 0 };

		// Synthetic idle blink scheduling.
		this._nextBlink = 1.5;
		this._blinkPhase = -1; // -1 idle, else 0..1 progress
		this._clock = new THREE.Clock();

		this._model = null;
		this._morphTargets = new Map(); // lower morph name -> [{mesh, index}]
		this._headBone = null;
		this._neckBone = null;
		this._spineBone = null;
		this._restRot = new WeakMap(); // bone -> THREE.Euler base rotation

		this._scratchEuler = new THREE.Euler();
		this._scratchQuat = new THREE.Quaternion();

		this._initRenderer();
		this._initScene();
		this._onResize = this._onResize.bind(this);
		window.addEventListener('resize', this._onResize);
		this._resizeObserver = new ResizeObserver(this._onResize);
		this._resizeObserver.observe(canvas.parentElement || canvas);
	}

	_initRenderer() {
		const renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			antialias: true,
			alpha: true,
			preserveDrawingBuffer: true, // needed for PNG snapshots
			powerPreference: 'high-performance',
		});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.05;
		renderer.shadowMap.enabled = true;
		// PCFSoftShadowMap is deprecated in three.js and silently downgrades to hard
		// PCFShadowMap at runtime, warning on every boot; VSMShadowMap is the
		// supported soft-shadow type.
		renderer.shadowMap.type = THREE.VSMShadowMap;
		this.renderer = renderer;
	}

	_initScene() {
		const scene = new THREE.Scene();
		this.scene = scene;

		const pmrem = new THREE.PMREMGenerator(this.renderer);
		this._envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
		scene.environment = this._envRT.texture;
		pmrem.dispose();

		const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
		camera.position.set(0, 1.55, 1.35);
		this.camera = camera;

		// Portrait three-point lighting.
		const key = new THREE.DirectionalLight(0xfff4e6, 2.1);
		key.position.set(1.4, 2.4, 2.0);
		key.castShadow = true;
		key.shadow.mapSize.set(1024, 1024);
		key.shadow.camera.near = 0.5;
		key.shadow.camera.far = 8;
		key.shadow.bias = -0.0004;
		scene.add(key);

		const fill = new THREE.DirectionalLight(0xbfd4ff, 0.7);
		fill.position.set(-2.0, 1.4, 1.2);
		scene.add(fill);

		const rim = new THREE.DirectionalLight(0xffffff, 1.6);
		rim.position.set(-0.8, 2.0, -2.4);
		scene.add(rim);

		scene.add(new THREE.AmbientLight(0xffffff, 0.25));

		// Soft contact shadow catcher.
		const shadowMat = new THREE.ShadowMaterial({ opacity: 0.25 });
		const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), shadowMat);
		ground.rotation.x = -Math.PI / 2;
		ground.position.y = 0;
		ground.receiveShadow = true;
		scene.add(ground);
		this._ground = ground;

		this._buildLoaders();
		this.setBackground('studio');
	}

	_buildLoaders() {
		const draco = new DRACOLoader().setDecoderPath('/three/draco/gltf/');
		const ktx2 = new KTX2Loader()
			.setTranscoderPath('/three/basis/')
			.detectSupport(this.renderer);
		const loader = new GLTFLoader()
			.setDRACOLoader(draco)
			.setKTX2Loader(ktx2)
			.setMeshoptDecoder(MeshoptDecoder);
		this._loader = loader;
		this._draco = draco;
		this._ktx2 = ktx2;
	}

	/**
	 * Load (or hot-swap) a GLB avatar by URL.
	 * @param {string} url
	 * @returns {Promise<{morphCount:number, hasHead:boolean}>}
	 */
	async loadAvatar(url) {
		const gltf = await this._loader.loadAsync(url);
		this._teardownModel();

		const model = gltf.scene || gltf.scenes?.[0];
		if (!model) throw new Error('GLB contains no scene');
		model.traverse((o) => {
			if (o.isMesh || o.isSkinnedMesh) {
				o.castShadow = true;
				o.frustumCulled = false; // morphed heads can escape their static bounds
				if (o.material) o.material.envMapIntensity = 1.0;
			}
		});

		this._scanRig(model);
		this.scene.add(model);
		this._model = model;
		this._frameOnFace(model);
		return {
			morphCount: this._morphTargets.size,
			hasHead: !!this._headBone,
		};
	}

	_scanRig(root) {
		this._morphTargets = new Map();
		this._headBone = this._neckBone = this._spineBone = null;
		this._morphState.clear();

		const lc = (s) => String(s).toLowerCase();
		root.traverse((node) => {
			if (node.isMesh && node.morphTargetDictionary && node.morphTargetInfluences) {
				for (const [name, idx] of Object.entries(node.morphTargetDictionary)) {
					const key = lc(name);
					if (!this._morphTargets.has(key)) this._morphTargets.set(key, []);
					this._morphTargets.get(key).push({ mesh: node, index: idx });
				}
			}
			if (node.isBone || node.type === 'Bone') {
				const name = lc(node.name);
				if (!this._headBone && HEAD_BONE_NAMES.includes(name)) this._headBone = node;
				if (!this._neckBone && NECK_BONE_NAMES.includes(name)) this._neckBone = node;
				if (!this._spineBone && SPINE_BONE_NAMES.includes(name)) this._spineBone = node;
			}
		});

		for (const bone of [this._headBone, this._neckBone, this._spineBone]) {
			if (bone) this._restRot.set(bone, bone.rotation.clone());
		}
	}

	// Frame the camera on the avatar's head / upper body.
	_frameOnFace(model) {
		const box = new THREE.Box3().setFromObject(model);
		const size = new THREE.Vector3();
		const center = new THREE.Vector3();
		box.getSize(size);
		box.getCenter(center);

		// Drop the model so its feet sit on y=0 for the shadow catcher.
		model.position.y -= box.min.y;
		box.translate(new THREE.Vector3(0, -box.min.y, 0));

		// Aim at the head: use the head bone world position when available,
		// else estimate near the top of the bounding box.
		let headY;
		if (this._headBone) {
			const wp = new THREE.Vector3();
			this._headBone.getWorldPosition(wp);
			headY = wp.y + size.y * 0.04;
		} else {
			headY = box.min.y + size.y * 0.92;
		}
		const target = new THREE.Vector3(0, headY, 0);

		// Distance scales with head size so tall and short rigs both frame well.
		const dist = THREE.MathUtils.clamp(size.y * 0.55, 0.55, 1.6);
		this.camera.position.set(0, headY + size.y * 0.02, dist);
		this.camera.near = 0.05;
		this.camera.far = 100;
		this.camera.updateProjectionMatrix();
		this.camera.lookAt(target);
		this._cameraTarget = target;

		if (!this._controls) {
			const controls = new OrbitControls(this.camera, this.canvas);
			controls.enablePan = false;
			controls.enableZoom = true;
			controls.minDistance = 0.4;
			controls.maxDistance = 3.2;
			controls.minPolarAngle = Math.PI * 0.28;
			controls.maxPolarAngle = Math.PI * 0.62;
			controls.enableDamping = true;
			controls.dampingFactor = 0.08;
			controls.rotateSpeed = 0.5;
			this._controls = controls;
		}
		this._controls.target.copy(target);
		this._controls.update();
	}

	_teardownModel() {
		if (!this._model) return;
		this.scene.remove(this._model);
		this._model.traverse((o) => {
			if (o.geometry) o.geometry.dispose();
			if (o.material) {
				const mats = Array.isArray(o.material) ? o.material : [o.material];
				for (const m of mats) {
					for (const k of Object.keys(m)) {
						if (m[k] && m[k].isTexture) m[k].dispose();
					}
					m.dispose();
				}
			}
		});
		this._model = null;
	}

	/**
	 * Apply a FaceFrame from the tracker. Safe to call before a model loads.
	 * @param {{present:boolean, blendshapes:Object, head:?{pitch:number,yaw:number,roll:number}, ts:number}} frame
	 */
	applyFace(frame) {
		if (!frame) return;
		this._faceActive = !!frame.present;
		if (frame.present) this._lastFaceTs = performance.now();

		if (frame.present && frame.blendshapes) {
			const mirror = this._mirror;
			for (const [rawName, rawVal] of Object.entries(frame.blendshapes)) {
				let name = rawName;
				let val = rawVal;
				// In mirror mode swap left/right channels so the avatar mirrors
				// the user like a reflection rather than aping them.
				if (mirror) name = this._swapSide(name);
				this._setMorphTarget(name, val * this.expressiveness);
			}
		}

		if (frame.present && frame.head && this._headTracking) {
			let { pitch, yaw, roll } = frame.head;
			if (this._mirror) { yaw = -yaw; roll = -roll; }
			this._headTarget.pitch = THREE.MathUtils.clamp(pitch * this.headGain, -PITCH_LIMIT, PITCH_LIMIT);
			this._headTarget.yaw = THREE.MathUtils.clamp(yaw * this.headGain, -YAW_LIMIT, YAW_LIMIT);
			this._headTarget.roll = THREE.MathUtils.clamp(roll * this.headGain, -ROLL_LIMIT, ROLL_LIMIT);
		}
	}

	_swapSide(name) {
		if (name.endsWith('Left')) return name.slice(0, -4) + 'Right';
		if (name.endsWith('Right')) return name.slice(0, -5) + 'Left';
		return name;
	}

	// Record a desired weight for a blendshape against every morph it maps to
	// (direct name match + aliases). Actual easing happens in the render loop.
	_setMorphTarget(arkitName, weight) {
		const key = arkitName.toLowerCase();
		const w = Math.max(0, Math.min(1, weight));
		this._stageMorph(key, w);
		const aliases = MORPH_ALIASES[key];
		if (aliases) for (const a of aliases) this._stageMorph(a, w, true);
	}

	_stageMorph(key, w, isAlias = false) {
		if (!this._morphTargets.has(key)) return;
		// For aliases, take the max so two granular channels feeding one combined
		// morph don't cancel each other between calls within a frame.
		const prev = this._pendingMorph.get(key);
		if (isAlias && prev != null) this._pendingMorph.set(key, Math.max(prev, w));
		else this._pendingMorph.set(key, w);
	}

	setMirror(on) { this._mirror = !!on; }
	setHeadTracking(on) {
		this._headTracking = !!on;
		if (!on) { this._headTarget.pitch = this._headTarget.yaw = this._headTarget.roll = 0; }
	}
	setExpressiveness(v) { this.expressiveness = Math.max(0, Math.min(2.5, v)); }

	/**
	 * Background presets. 'transparent' lets a CSS layer show through (and
	 * records with alpha); the others paint an in-scene backdrop so snapshots
	 * and recordings include the background.
	 * @param {'studio'|'noir'|'aurora'|'transparent'} preset
	 */
	setBackground(preset) {
		this._bgPreset = preset;
		if (preset === 'transparent') {
			this.scene.background = null;
			this.renderer.setClearColor(0x000000, 0);
			return;
		}
		const grad = this._gradientTexture(preset);
		this.scene.background = grad;
		this.renderer.setClearColor(0x000000, 1);
	}

	_gradientTexture(preset) {
		const stops = {
			studio: ['#1a1d27', '#0b0c10', '#050507'],
			noir: ['#15151a', '#0a0a0c', '#000000'],
			aurora: ['#16313a', '#101a2c', '#08070f'],
		}[preset] || ['#1a1d27', '#0b0c10', '#050507'];
		const c = document.createElement('canvas');
		c.width = 16; c.height = 256;
		const ctx = c.getContext('2d');
		const g = ctx.createLinearGradient(0, 0, 0, 256);
		g.addColorStop(0, stops[0]);
		g.addColorStop(0.55, stops[1]);
		g.addColorStop(1, stops[2]);
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, 16, 256);
		const tex = new THREE.CanvasTexture(c);
		tex.colorSpace = THREE.SRGBColorSpace;
		return tex;
	}

	start() {
		if (this._running || this._disposed) return;
		this._running = true;
		this._pendingMorph = this._pendingMorph || new Map();
		this._clock.start();
		const tick = () => {
			if (!this._running) return;
			this._raf = requestAnimationFrame(tick);
			this._update(this._clock.getDelta());
			this._controls?.update();
			this.renderer.render(this.scene, this.camera);
		};
		this._raf = requestAnimationFrame(tick);
	}

	stop() {
		this._running = false;
		if (this._raf) cancelAnimationFrame(this._raf);
		this._raf = null;
	}

	_update(dt) {
		dt = Math.min(dt, 0.05);
		const now = performance.now();
		const faceFresh = this._faceActive && now - this._lastFaceTs < 400;

		this._pendingMorph = this._pendingMorph || new Map();

		// When the face is lost, relax all driven morphs toward 0.
		if (!faceFresh) this._pendingMorph.clear();

		// Idle life: breathing + sway + synthetic blink when untracked.
		if (!faceFresh) this._driveIdle(dt);

		// Ease every known morph toward its pending (or zero) target.
		const ease = 1 - Math.pow(0.001, dt); // ~frame-rate independent snappy ease
		for (const [key, bindings] of this._morphTargets) {
			const target = this._pendingMorph.get(key) ?? 0;
			const cur = this._morphState.get(key) ?? 0;
			const next = cur + (target - cur) * Math.min(1, ease * 1.6);
			if (Math.abs(next - cur) < 1e-4 && next === 0) {
				if (cur !== 0) this._writeMorph(bindings, 0);
				this._morphState.set(key, 0);
				continue;
			}
			this._morphState.set(key, next);
			this._writeMorph(bindings, next);
		}

		// Head pose easing + application.
		this._driveHead(dt, faceFresh);
	}

	_writeMorph(bindings, value) {
		for (const b of bindings) b.mesh.morphTargetInfluences[b.index] = value;
	}

	_driveIdle(dt) {
		this._t = (this._t || 0) + dt;
		const t = this._t;
		// Breathing through the spine, gentle and slow (~14 breaths/min).
		const breath = Math.sin(t * 1.45) * 0.5 + 0.5;
		if (this._spineBone) {
			const rest = this._restRot.get(this._spineBone);
			this._spineBone.rotation.x = rest.x + (breath - 0.5) * 0.018;
		}
		// Drifting head sway target.
		this._headTarget.yaw = Math.sin(t * 0.35) * 0.12;
		this._headTarget.pitch = Math.sin(t * 0.27 + 1.0) * 0.05;
		this._headTarget.roll = Math.sin(t * 0.22) * 0.04;

		// Synthetic blink.
		this._nextBlink -= dt;
		if (this._blinkPhase < 0 && this._nextBlink <= 0) {
			this._blinkPhase = 0;
			this._nextBlink = 2.2 + Math.random() * 3.2;
		}
		if (this._blinkPhase >= 0) {
			this._blinkPhase += dt / 0.16; // ~160ms blink
			const p = this._blinkPhase;
			const v = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
			this._stageMorph('eyeblinkleft', v);
			this._stageMorph('eyeblinkright', v);
			this._stageMorph('eyesclosed', v);
			if (p >= 1) this._blinkPhase = -1;
		}
	}

	_driveHead(dt, faceFresh) {
		const ease = Math.min(1, (1 - Math.pow(0.002, dt)) * (faceFresh ? 1.8 : 1.0));
		const c = this._headCurrent;
		c.pitch += (this._headTarget.pitch - c.pitch) * ease;
		c.yaw += (this._headTarget.yaw - c.yaw) * ease;
		c.roll += (this._headTarget.roll - c.roll) * ease;

		// Split rotation across neck + head for a believable turn.
		this._applyBoneRot(this._neckBone, c.pitch * 0.45, c.yaw * 0.4, c.roll * 0.4);
		this._applyBoneRot(this._headBone, c.pitch * 0.6, c.yaw * 0.62, c.roll * 0.62);
	}

	_applyBoneRot(bone, px, py, pz) {
		if (!bone) return;
		const rest = this._restRot.get(bone);
		if (!rest) return;
		this._scratchEuler.set(rest.x + px, rest.y + py, rest.z + pz, 'XYZ');
		bone.quaternion.setFromEuler(this._scratchEuler);
	}

	/** @returns {Promise<Blob>} PNG of the current frame. */
	snapshotPNG() {
		// Force a fresh render so the buffer is current before reading it.
		this.renderer.render(this.scene, this.camera);
		return new Promise((resolve, reject) => {
			this.canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error('snapshot failed'))),
				'image/png',
			);
		});
	}

	get isFaceActive() { return this._faceActive && performance.now() - this._lastFaceTs < 400; }

	_onResize() {
		const parent = this.canvas.parentElement || this.canvas;
		const w = parent.clientWidth || window.innerWidth;
		const h = parent.clientHeight || window.innerHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	dispose() {
		this._disposed = true;
		this.stop();
		window.removeEventListener('resize', this._onResize);
		this._resizeObserver?.disconnect();
		this._teardownModel();
		this._controls?.dispose();
		this._draco?.dispose();
		this._ktx2?.dispose();
		this._envRT?.dispose();
		this.renderer.dispose();
	}
}
