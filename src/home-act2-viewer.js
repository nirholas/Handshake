/**
 * Three.js viewer for the homepage Act 2 — same trick as /app:
 * loads any GLB, fetches the project's animation manifest
 * (/animations/manifest.json), lazy-loads clips on first play, and
 * retargets them onto whatever skeleton is loaded.
 *
 * Public API (mounted on window):
 *   const v = new Act2Viewer(canvas);
 *   v.onClipsReady = (defs) => { /* build chips */ /* };
 *   await v.loadModel('/avatars/cz.glb');
 *   v.playClip('dance');
 */
import {
	WebGLRenderer,
	Scene,
	PerspectiveCamera,
	AnimationMixer,
	AnimationClip,
	Box3,
	Vector3,
	Clock,
	HemisphereLight,
	DirectionalLight,
	ACESFilmicToneMapping,
	SRGBColorSpace,
	PMREMGenerator,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const CROSSFADE = 0.35;

export class Act2Viewer {
	constructor(canvas, { fov = 14 } = {}) {
		this.canvas = canvas;
		this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;
		this.renderer.outputColorSpace = SRGBColorSpace;

		this.scene = new Scene();
		this.camera = new PerspectiveCamera(fov, 1, 0.1, 100);
		this.camera.position.set(0, 1.0, 22);

		/* neutral environment (matches model-viewer's environment-image="neutral") */
		const pmrem = new PMREMGenerator(this.renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

		this.scene.add(new HemisphereLight(0xffffff, 0x444466, 0.8));
		const sun = new DirectionalLight(0xffffff, 1.2);
		sun.position.set(4, 8, 6);
		this.scene.add(sun);

		/** @type {Map<string, AnimationClip>} */
		this.clips = new Map();
		/** @type {THREE.AnimationAction|null} */
		this.currentAction = null;
		this.mixer = null;
		this.model = null;

		/** @type {Array<{name:string,url:string,label:string,icon:string,loop?:boolean}>} */
		this._manifest = [];
		this._manifestPromise = null;

		this._loader = new GLTFLoader();
		this._clock = new Clock();
		this._modelYaw = 0;
		this._modelFocusY = 1.0;
		this._focusX = 0;
		this._externalOrbit = false;

		/** Optional callback when the chip list changes (manifest + GLB-baked combined). */
		this.onClipsReady = null;

		this._resize();
		const ro = new ResizeObserver(() => this._resize());
		ro.observe(canvas);

		this._disposed = false;
		this._tick = this._tick.bind(this);
		requestAnimationFrame(this._tick);
	}

	_resize() {
		const dpr = Math.min(devicePixelRatio || 1, 2);
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (!w || !h) return;
		this.renderer.setPixelRatio(dpr);
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	_tick() {
		if (this._disposed) return;
		const dt = this._clock.getDelta();
		if (this.mixer) this.mixer.update(dt);
		if (this.model && !this._externalOrbit) {
			this._modelYaw += dt * 0.18;
			this.model.rotation.y = this._modelYaw;
		}
		this.renderer.render(this.scene, this.camera);
		requestAnimationFrame(this._tick);
	}

	dispose() {
		this._disposed = true;
		if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; }
		if (this.model) { this.scene.remove(this.model); this.model = null; }
		this.renderer.dispose();
	}

	async _loadManifest() {
		if (this._manifest.length) return this._manifest;
		if (this._manifestPromise) return this._manifestPromise;
		this._manifestPromise = fetch('/animations/manifest.json')
			.then((r) => r.json())
			.then((data) => {
				const arr = Array.isArray(data) ? data : data.animations || [];
				this._manifest = arr;
				return arr;
			})
			.catch(() => {
				this._manifest = [];
				return [];
			});
		return this._manifestPromise;
	}

	/** Returns combined: GLB-baked clips + project animation manifest, deduped by name.
	 *  When the model ships its own rich animation set (robot, etc.) those are shown
	 *  exclusively — manifest clips are Mixamo-retargeted and won't work on a different skeleton.
	 */
	listAvailableClips() {
		const IDLE_RE = /idle/i;
		const glbNames = [...this.clips.keys()];
		const glbGoodNames = glbNames.filter((n) => !IDLE_RE.test(n));
		const glbIdleName = glbNames.find((n) => IDLE_RE.test(n));

		/* Model has its own animations — skip manifest entirely */
		if (glbGoodNames.length >= 3) {
			return glbNames.map((name) => ({
				name,
				label: name,
				icon: '✨',
				loop: true,
				source: 'glb',
			}));
		}

		const out = [];
		const seen = new Set();
		/* manifest first (humanoid / Mixamo models like CZ). When the GLB
		 * ships its own idle clip, swap it in for the manifest idle — the
		 * baked clip is authored for this exact rig and plays cleaner than
		 * the retargeted Mixamo one. */
		for (const def of this._manifest) {
			if (seen.has(def.name)) continue;
			if (def.name === 'idle' && glbIdleName) {
				out.push({ ...def, name: glbIdleName, source: 'glb' });
				seen.add(def.name);
				seen.add(glbIdleName);
			} else {
				out.push({ ...def, source: 'manifest' });
				seen.add(def.name);
			}
		}
		/* then any extra GLB clips not already in manifest */
		for (const name of glbNames) {
			if (seen.has(name)) continue;
			seen.add(name);
			out.push({ name, label: name, icon: '✨', loop: true, source: 'glb' });
		}
		return out;
	}

	async _fetchClip(url) {
		const r = await fetch(url);
		if (!r.ok) throw new Error('clip ' + url + ' ' + r.status);
		const json = await r.json();
		return AnimationClip.parse(json);
	}

	async loadModel(url, { autoPlay = true } = {}) {
		/* swap out previous model */
		if (this.model) {
			if (this.mixer) this.mixer.stopAllAction();
			this.scene.remove(this.model);
			this.model = null;
			this.mixer = null;
			this.currentAction = null;
			this.clips.clear();
		}

		const gltf = await this._loader.loadAsync(url);
		this.model = gltf.scene;
		this.scene.add(this.model);

		/* center horizontally + plant feet on ground */
		const box = new Box3().setFromObject(this.model);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		this.model.position.x -= center.x;
		this.model.position.z -= center.z;
		this.model.position.y -= box.min.y;

		/* fit camera to model height with a comfortable framing */
		const targetHeight = size.y;
		const dist = (targetHeight / 2) / Math.tan((this.camera.fov / 2) * (Math.PI / 180));
		this._modelFocusY = targetHeight * 0.55;
		this._externalOrbit = false;
		this.camera.position.set(0, this._modelFocusY, dist * 1.2);
		this.camera.lookAt(0, this._modelFocusY, 0);

		this.mixer = new AnimationMixer(this.model);

		/* collect node names available on this skeleton so we can drop
		 * tracks that target bones the current model doesn't have — otherwise
		 * three.js floods the console with "No target node found" warnings
		 * for every mismatched bone, every frame the clip plays. */
		const knownNodes = new Set();
		this.model.traverse((n) => {
			if (n.name) knownNodes.add(n.name);
		});

		/* register baked-in clips, filtering tracks to those that bind */
		for (const clip of gltf.animations || []) {
			const tracks = clip.tracks.filter((t) => {
				const nodeName = t.name.split('.')[0];
				return knownNodes.has(nodeName);
			});
			if (tracks.length === 0) continue;
			this.clips.set(clip.name, new AnimationClip(clip.name, clip.duration, tracks));
		}

		/* ensure manifest is fetched */
		await this._loadManifest();

		/* fire chip rebuild */
		if (typeof this.onClipsReady === 'function') {
			this.onClipsReady(this.listAvailableClips());
		}

		/* auto-play first clip unless caller wants to handle it */
		if (autoPlay) {
			const startName = this._pickStartName();
			if (startName) await this.playClip(startName);
		}

		return this.model;
	}

	_pickStartName() {
		const SKIP_RE = /idle|silly/i;
		const all = this.listAvailableClips();
		/* When model uses its own GLB clips, pick a lively one from those */
		if (all.length && all[0].source === 'glb') {
			const PREFERRED = ['Dance', 'Wave', 'Jump', 'Punch', 'Running', 'ThumbsUp'];
			for (const p of PREFERRED) {
				const match = all.find((c) => c.name === p);
				if (match) return match.name;
			}
			return all.find((c) => !SKIP_RE.test(c.name))?.name || all[0]?.name || null;
		}
		/* Humanoid / manifest models */
		for (const preferred of ['dance', 'rumba', 'capoeira', 'wave', 'thriller']) {
			const match = all.find((c) => c.name === preferred);
			if (match) return match.name;
		}
		return all.find((c) => !SKIP_RE.test(c.name))?.name || all[0]?.name || null;
	}

	async playClip(name) {
		if (!this.mixer) return;
		let clip = this.clips.get(name);

		if (!clip) {
			/* lazy-load from manifest */
			const def = this._manifest.find((d) => d.name === name);
			if (!def) return;
			clip = await this._fetchClip(def.url);
			const knownNodes = new Set();
			this.model?.traverse((n) => {
				if (n.name) knownNodes.add(n.name);
			});
			const tracks = clip.tracks.filter((t) =>
				knownNodes.has(t.name.split('.')[0]),
			);
			clip = new AnimationClip(clip.name, clip.duration, tracks);
			this.clips.set(name, clip);
		}

		const action = this.mixer.clipAction(clip);
		action.enabled = true;
		action.setLoop(undefined, Infinity); /* default loop */
		if (this.currentAction && this.currentAction !== action) {
			action.reset().fadeIn(CROSSFADE).play();
			this.currentAction.fadeOut(CROSSFADE);
		} else {
			action.reset().play();
		}
		this.currentAction = action;
	}

	/**
	 * Orbit the camera around the model using polar coordinates matching model-viewer's
	 * camera-orbit convention: theta = azimuth (deg), phi = elevation from top (deg),
	 * radius = distance (m).  Calling this disables internal auto-rotate.
	 */
	setOrbit(thetaDeg, phiDeg, radius) {
		this._externalOrbit = true;
		const theta = thetaDeg * (Math.PI / 180);
		const phi = phiDeg * (Math.PI / 180);
		const sinPhi = Math.sin(phi);
		const cosPhi = Math.cos(phi);
		const fx = this._focusX;
		this.camera.position.set(
			fx + radius * sinPhi * Math.sin(theta),
			this._modelFocusY + radius * cosPhi,
			radius * sinPhi * Math.cos(theta),
		);
		this.camera.lookAt(fx, this._modelFocusY, 0);
	}

	setExposure(v) {
		this.renderer.toneMappingExposure = v;
	}

	zoom(distance) {
		const cur = this.camera.position.length();
		this.camera.position.normalize().multiplyScalar(distance);
		this.camera.lookAt(0, this.camera.position.y * 0.6, 0);
	}
}

/* expose on window so the inline home.html script can use it */
window.Act2Viewer = Act2Viewer;
