// Shared live-preview engine for the /animations gallery.
//
// One WebGL renderer + one preview avatar serve every card and the detail
// modal. The canvas is *moved* into whichever container is previewing (hover a
// card, open the modal) and a RAF loop runs only while something is mounted —
// the page never holds more than a single GL context, where the previous
// gallery booted a full embed-viewer iframe (renderer, avatar, clip fetch) per
// hovered card.
//
// Everything heavy (three.js, the retarget engine, the avatar GLB) loads
// lazily on the first preview, so the gallery's initial paint ships no 3D at
// all. Clip JSONs and retargeted clips are cached by name, so re-hovering a
// card replays instantly.

const MODEL_URL = '/avatars/cz.glb';

export class AnimationLivePreview {
	constructor() {
		this._bootPromise = null;
		this._three = null; // three module namespace
		this._renderer = null;
		this._scene = null;
		this._camera = null;
		this._model = null;
		this._mixer = null;
		this._bones = [];
		this._restPose = new Map();
		this._maps = null; // canonical maps captured at bind pose
		this._retargetMod = null;

		this._clipJsonCache = new Map(); // clip name → raw clip JSON promise
		this._boundClipCache = new Map(); // clip name → retargeted AnimationClip

		this._container = null;
		this._action = null;
		this._activeDef = null;
		this._raf = 0;
		this._lastT = 0;
		this._playToken = 0;
		this._paused = false;
		this._onFrame = null; // (timeSec, durationSec) => void — modal scrubber hook
	}

	/** True once the engine has booted (first preview finished loading). */
	get ready() {
		return !!this._model;
	}

	/** Currently previewing def (or null). */
	get active() {
		return this._activeDef;
	}

	async _boot() {
		if (this._bootPromise) return this._bootPromise;
		this._bootPromise = (async () => {
			const [THREE, { GLTFLoader }, { RoomEnvironment }, retarget, { getMeshoptDecoder }] =
				await Promise.all([
					import('three'),
					import('three/addons/loaders/GLTFLoader.js'),
					import('three/addons/environments/RoomEnvironment.js'),
					import('./animation-retarget.js'),
					import('./viewer/internal.js'),
				]);
			this._three = THREE;
			this._retargetMod = retarget;

			const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
			renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
			renderer.shadowMap.enabled = true;
			// PCFSoftShadowMap is deprecated and silently downgrades to hard
			// PCFShadowMap at runtime (console warning, worse shadow edges).
			// VSMShadowMap is the still-supported soft-shadow type.
			renderer.shadowMap.type = THREE.VSMShadowMap;
			renderer.toneMapping = THREE.ACESFilmicToneMapping;
			renderer.toneMappingExposure = 1.05;
			renderer.domElement.className = 'alp-canvas';
			renderer.domElement.setAttribute('aria-hidden', 'true');
			this._renderer = renderer;

			const scene = new THREE.Scene();
			const pmrem = new THREE.PMREMGenerator(renderer);
			scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
			this._scene = scene;

			const key = new THREE.DirectionalLight(0xffffff, 1.6);
			key.position.set(2.2, 4.5, 3.2);
			key.castShadow = true;
			key.shadow.mapSize.set(1024, 1024);
			key.shadow.camera.left = -3;
			key.shadow.camera.right = 3;
			key.shadow.camera.top = 3;
			key.shadow.camera.bottom = -3;
			key.shadow.bias = -0.0004;
			scene.add(key);
			scene.add(key.target);
			this._keyLight = key;
			const rim = new THREE.DirectionalLight(0x99bbff, 0.7);
			rim.position.set(-2.5, 2.5, -2.5);
			scene.add(rim);

			const ground = new THREE.Mesh(
				new THREE.PlaneGeometry(40, 40),
				new THREE.ShadowMaterial({ opacity: 0.28 }),
			);
			ground.rotation.x = -Math.PI / 2;
			ground.receiveShadow = true;
			scene.add(ground);

			this._camera = new THREE.PerspectiveCamera(33, 3 / 4, 0.05, 100);

			const loader = new GLTFLoader();
			loader.setMeshoptDecoder(await getMeshoptDecoder());
			const gltf = await loader.loadAsync(MODEL_URL);
			const model = gltf.scene;
			model.traverse((o) => {
				if (o.isMesh || o.isSkinnedMesh) {
					o.castShadow = true;
					o.frustumCulled = false;
				}
				if (o.isBone) this._bones.push(o);
				this._restPose.set(o, {
					p: o.position.clone(),
					q: o.quaternion.clone(),
					s: o.scale.clone(),
				});
			});
			scene.add(model);
			model.updateMatrixWorld(true);
			this._model = model;
			// Same bind-pose capture recipe as AnimationManager.attach(), so previews
			// play exactly what the studio and embeds play.
			this._maps = {
				canonicalToNode: retarget.canonicalNodeMapFromObject(model),
				targetRest: retarget.canonicalRestMapFromObject(model),
				targetWorldRest: retarget.canonicalWorldRestMapFromObject(model),
				hipsParentWorldQuat: retarget.hipsParentWorldQuat(model),
				hipTargetLocalY: retarget.hipRestLocalHeight(model),
			};
			this._mixer = new THREE.AnimationMixer(model);
		})();
		return this._bootPromise;
	}

	async _fetchClipJson(def) {
		if (this._clipJsonCache.has(def.id)) return this._clipJsonCache.get(def.id);
		const promise = (async () => {
			if (def.source === 'community') {
				const res = await fetch(
					`/api/animations/clips/${encodeURIComponent(def.id)}?play=1`,
					{ credentials: 'include' },
				);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = await res.json();
				if (!data?.clip?.clip) throw new Error('clip payload missing');
				return data.clip.clip;
			}
			// Curated manifest clips carry a site-relative url; library clips carry an
			// absolute CDN url (or none — resolve via the library manifest by name).
			let url = def.url;
			if (!url) throw new Error('clip has no source url');
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		})();
		this._clipJsonCache.set(def.id, promise);
		promise.catch(() => this._clipJsonCache.delete(def.id));
		return promise;
	}

	_restoreRestPose() {
		this._mixer.stopAllAction();
		for (const [node, t] of this._restPose) {
			node.position.copy(t.p);
			node.quaternion.copy(t.q);
			node.scale.copy(t.s);
		}
		this._model.updateMatrixWorld(true);
	}

	async _bindClip(def) {
		if (this._boundClipCache.has(def.id)) return this._boundClipCache.get(def.id);
		const json = await this._fetchClipJson(def);
		const r = this._retargetMod;
		this._restoreRestPose();
		const clip = r.parseClipJSON(json, def.id);
		let hipScale = 1;
		const baseline = r.clipHipBaselineY(clip);
		if (this._maps.hipTargetLocalY > 0.05 && baseline > 0.05) {
			hipScale = Math.min(200, Math.max(0.2, this._maps.hipTargetLocalY / baseline));
		}
		const { clip: bound } = r.retargetClip(clip, this._maps.canonicalToNode, {
			...this._maps,
			hipScale,
			minCoverage: 0.3,
		});
		if (!bound) throw new Error('clip does not fit the preview avatar');
		this._boundClipCache.set(def.id, bound);
		// A page-lifetime cache of every hovered clip would grow unbounded on a
		// 2,000-card grid; keep the most recent ~40.
		if (this._boundClipCache.size > 40) {
			const oldest = this._boundClipCache.keys().next().value;
			if (oldest !== def.id) this._boundClipCache.delete(oldest);
		}
		return bound;
	}

	// Frame the figure's full motion envelope: sample the clip at a few points,
	// union the bone boxes, and lock the camera for the whole loop so walks and
	// flips stay in frame without camera chase.
	_frameCamera(bound) {
		const THREE = this._three;
		const box = new THREE.Box3();
		const v = new THREE.Vector3();
		const probe = this._mixer.clipAction(bound);
		probe.play();
		const samples = [0.05, 0.3, 0.55, 0.8];
		for (const s of samples) {
			this._mixer.setTime(bound.duration * s);
			this._model.updateMatrixWorld(true);
			for (const b of this._bones) box.expandByPoint(b.getWorldPosition(v));
		}
		this._mixer.setTime(0);
		box.expandByVector(new THREE.Vector3(0.24, 0.15, 0.24));
		box.min.y = Math.min(box.min.y, 0);
		const center = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3());
		const cam = this._camera;
		const fovV = THREE.MathUtils.degToRad(cam.fov);
		const fovH = 2 * Math.atan(Math.tan(fovV / 2) * cam.aspect);
		const distV = size.y / 2 / Math.tan(fovV / 2);
		const distH = Math.max(size.x, size.z) / 2 / Math.tan(fovH / 2);
		const dist = Math.max(distV, distH) * 1.15 + Math.max(size.z, size.x) / 2;
		const azimuth = THREE.MathUtils.degToRad(24);
		const elevation = THREE.MathUtils.degToRad(11);
		cam.position.set(
			center.x + dist * Math.cos(elevation) * Math.sin(azimuth),
			center.y + dist * Math.sin(elevation),
			center.z + dist * Math.cos(elevation) * Math.cos(azimuth),
		);
		cam.lookAt(center);
		this._keyLight.target.position.copy(center);
		this._keyLight.target.updateMatrixWorld();
	}

	_resizeToContainer() {
		if (!this._container || !this._renderer) return;
		const w = this._container.clientWidth || 300;
		const h = this._container.clientHeight || 400;
		this._renderer.setSize(w, h, false);
		this._renderer.domElement.style.width = '100%';
		this._renderer.domElement.style.height = '100%';
		this._camera.aspect = w / h;
		this._camera.updateProjectionMatrix();
	}

	_loop = () => {
		this._raf = requestAnimationFrame(this._loop);
		const now = performance.now();
		const dt = Math.min(0.1, (now - this._lastT) / 1000);
		this._lastT = now;
		if (!this._paused) this._mixer.update(dt);
		if (this._onFrame && this._action) {
			this._onFrame(this._action.time, this._action.getClip().duration);
		}
		this._renderer.render(this._scene, this._camera);
	};

	/**
	 * Mount the shared canvas into `container` and play `def`'s clip.
	 * Any previous preview stops. Resolves once playing; rejects on load or
	 * retarget failure (the caller shows its fallback).
	 *
	 * @param {HTMLElement} container
	 * @param {{id:string, source:string, url?:string, loop?:boolean}} def
	 * @param {{ speed?: number, onFrame?: (t:number,d:number)=>void }} [opts]
	 */
	async play(container, def, opts = {}) {
		const token = ++this._playToken;
		await this._boot();
		const bound = await this._bindClip(def);
		if (token !== this._playToken) return; // superseded while loading

		this.stop({ keepBoot: true });
		this._container = container;
		container.appendChild(this._renderer.domElement);
		this._resizeToContainer();

		this._restoreRestPose();
		const action = this._mixer.clipAction(bound);
		const THREE = this._three;
		if (def.loop === false) {
			action.setLoop(THREE.LoopOnce, 0);
			action.clampWhenFinished = true;
			// One-shots replay on a beat so a hovering user sees the motion again.
			this._mixer.removeEventListener?.('finished', this._replay);
			this._replay = () => {
				action.reset().play();
			};
			this._mixer.addEventListener('finished', this._replay);
		} else {
			action.setLoop(THREE.LoopRepeat, Infinity);
		}
		action.timeScale = opts.speed ?? 1;
		action.play();
		this._action = action;
		this._activeDef = def;
		this._paused = false;
		this._onFrame = opts.onFrame || null;
		this._frameCamera(bound);
		this._lastT = performance.now();
		cancelAnimationFrame(this._raf);
		this._raf = requestAnimationFrame(this._loop);
	}

	/** Detach the canvas and halt rendering. Cheap — the engine stays warm. */
	stop() {
		this._playToken++;
		cancelAnimationFrame(this._raf);
		this._raf = 0;
		if (this._mixer && this._replay) {
			this._mixer.removeEventListener('finished', this._replay);
			this._replay = null;
		}
		if (this._mixer) this._mixer.stopAllAction();
		this._action = null;
		this._activeDef = null;
		this._onFrame = null;
		if (this._renderer?.domElement?.parentNode) {
			this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
		}
		this._container = null;
	}

	/** Modal transport controls. No-ops when nothing is playing. */
	setPaused(paused) {
		this._paused = !!paused;
	}
	isPaused() {
		return this._paused;
	}
	setSpeed(factor) {
		if (this._action) this._action.timeScale = factor;
	}
	/** Seek to a 0..1 position in the clip. */
	seek(t01) {
		if (!this._action) return;
		const d = this._action.getClip().duration;
		this._action.time = Math.max(0, Math.min(0.999, t01)) * d;
		this._mixer.update(0);
	}
	/** Re-fit renderer + camera after the container was resized (modal open). */
	refit() {
		this._resizeToContainer();
		if (this._action) this._frameCamera(this._action.getClip());
	}
}

/** Page-singleton accessor. */
let _instance = null;
export function getLivePreview() {
	if (!_instance) _instance = new AnimationLivePreview();
	return _instance;
}
