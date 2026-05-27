/**
 * Hero particle-to-avatar materialization for home-v4.
 * Loads a GLB, samples 6000 points from the mesh surface,
 * animates particles converging into the avatar shape,
 * then crossfades to the solid model.
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
	Points,
	BufferGeometry,
	Float32BufferAttribute,
	ShaderMaterial,
	AdditiveBlending,
	MathUtils,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const PARTICLE_COUNT = 6000;
const MATERIALIZE_DURATION = 2.0;
const CROSSFADE_START = 0.5;
const MODEL_URL = '/avatars/cz.glb';

const VERT = `
attribute vec3 aStart;
attribute vec3 aTarget;
attribute float aSeed;
uniform float uProgress;
uniform float uTime;
uniform float uParticleAlpha;
varying float vAlpha;
void main() {
	float p = clamp(uProgress + aSeed * 0.3 - 0.15, 0.0, 1.0);
	float ease = p * p * (3.0 - 2.0 * p);
	vec3 pos = mix(aStart, aTarget, ease);
	float drift = sin(uTime * 2.0 + aSeed * 6.28) * (1.0 - ease) * 0.05;
	pos.x += drift;
	pos.y += drift * 0.5;
	vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
	gl_PointSize = max(1.5, 4.0 * (300.0 / -mvPos.z));
	gl_Position = projectionMatrix * mvPos;
	vAlpha = uParticleAlpha * (0.4 + 0.6 * aSeed);
}
`;

const FRAG = `
varying float vAlpha;
void main() {
	float d = length(gl_PointCoord - 0.5) * 2.0;
	if (d > 1.0) discard;
	float alpha = (1.0 - d * d) * vAlpha;
	gl_FragColor = vec4(1.0, 0.84, 0.4, alpha);
}
`;

export class HeroScene {
	constructor(canvas) {
		this.canvas = canvas;
		this._raf = 0;
		this._disposed = false;

		const LOW_MEMORY = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 2;
		const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		this._skipParticles = LOW_MEMORY || REDUCED_MOTION || window.innerWidth < 768;

		this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.setClearColor(0x000000, 0);

		this.scene = new Scene();
		this.camera = new PerspectiveCamera(16, 1, 0.1, 100);
		this.camera.position.set(0.3, 1.0, 18);

		const pmrem = new PMREMGenerator(this.renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();

		this.scene.add(new HemisphereLight(0xffffff, 0x444466, 0.6));
		const sun = new DirectionalLight(0xffffff, 1.2);
		sun.position.set(4, 8, 6);
		this.scene.add(sun);

		this._clock = new Clock();
		this._loader = new GLTFLoader();

		this.model = null;
		this.mixer = null;
		this.particles = null;
		this._particleMat = null;
		this._progress = 0;
		this._materialized = false;
		this._modelOpacityTargets = [];

		this._mouseX = 0;
		this._mouseY = 0;
		this._targetTheta = 0;
		this._targetPhi = 0;
		this._currentTheta = 0;
		this._currentPhi = 0;

		this._baseCamPos = new Vector3();
		this._focusY = 1.0;

		this._resize();
		const ro = new ResizeObserver(() => this._resize());
		ro.observe(canvas);

		this._onMouseMove = this._onMouseMove.bind(this);
		window.addEventListener('mousemove', this._onMouseMove, { passive: true });

		this._tick = this._tick.bind(this);
		this._load();
	}

	_resize() {
		const dpr = Math.min(devicePixelRatio || 1, window.innerWidth < 768 ? 1 : 2);
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (!w || !h) return;
		this.renderer.setPixelRatio(dpr);
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	_onMouseMove(e) {
		this._mouseX = (e.clientX / window.innerWidth) * 2 - 1;
		this._mouseY = (e.clientY / window.innerHeight) * 2 - 1;
	}

	async _load() {
		const gltf = await this._loader.loadAsync(MODEL_URL);
		if (this._disposed) return;

		this.model = gltf.scene;
		this.scene.add(this.model);

		const box = new Box3().setFromObject(this.model);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		this.model.position.x -= center.x;
		this.model.position.z -= center.z;
		this.model.position.y -= box.min.y;

		const targetHeight = size.y;
		const dist = (targetHeight / 2) / Math.tan((this.camera.fov / 2) * (Math.PI / 180));
		this._focusY = targetHeight * 0.5;
		this.camera.position.set(0.3, this._focusY, dist * 1.1);
		this._baseCamPos.copy(this.camera.position);
		this.camera.lookAt(0, this._focusY, 0);

		this.mixer = new AnimationMixer(this.model);
		const knownNodes = new Set();
		this.model.traverse((n) => { if (n.name) knownNodes.add(n.name); });

		for (const clip of gltf.animations || []) {
			const tracks = clip.tracks.filter((t) => knownNodes.has(t.name.split('.')[0]));
			if (tracks.length === 0) continue;
			const filtered = new AnimationClip(clip.name, clip.duration, tracks);
			const action = this.mixer.clipAction(filtered);
			action.play();
			break;
		}

		if (!gltf.animations?.length) {
			this._loadIdleAnim(knownNodes);
		}

		if (this._skipParticles) {
			this._materialized = true;
			this._progress = 1;
			this._startLoop();
			return;
		}

		this._collectOpacityTargets();
		this._setModelOpacity(0);
		this._buildParticles();
		this._startLoop();
	}

	async _loadIdleAnim(knownNodes) {
		try {
			const manifest = await fetch('/animations/manifest.json').then(r => r.json());
			const arr = Array.isArray(manifest) ? manifest : manifest.animations || [];
			const idle = arr.find(d => d.name === 'idle' || d.name === 'av-idle-breath');
			if (!idle) return;
			const json = await fetch(idle.url).then(r => r.json());
			const clip = AnimationClip.parse(json);
			const tracks = clip.tracks.filter(t => knownNodes.has(t.name.split('.')[0]));
			if (tracks.length === 0) return;
			const filtered = new AnimationClip(clip.name, clip.duration, tracks);
			const action = this.mixer.clipAction(filtered);
			action.play();
		} catch { /* non-critical */ }
	}

	_collectOpacityTargets() {
		this._modelOpacityTargets = [];
		this.model.traverse((child) => {
			if (child.isMesh && child.material) {
				const mats = Array.isArray(child.material) ? child.material : [child.material];
				for (const mat of mats) {
					mat.transparent = true;
					this._modelOpacityTargets.push(mat);
				}
			}
		});
	}

	_setModelOpacity(v) {
		for (const mat of this._modelOpacityTargets) {
			mat.opacity = v;
		}
	}

	_buildParticles() {
		const meshes = [];
		this.model.traverse((child) => {
			if (child.isMesh && child.geometry) meshes.push(child);
		});
		if (meshes.length === 0) return;

		const starts = new Float32Array(PARTICLE_COUNT * 3);
		const targets = new Float32Array(PARTICLE_COUNT * 3);
		const seeds = new Float32Array(PARTICLE_COUNT);
		const pos = new Vector3();

		let idx = 0;
		const perMesh = Math.ceil(PARTICLE_COUNT / meshes.length);

		for (const mesh of meshes) {
			const sampler = new MeshSurfaceSampler(mesh).setWeightAttribute(null).build();
			const count = Math.min(perMesh, PARTICLE_COUNT - idx);
			for (let i = 0; i < count; i++) {
				sampler.sample(pos);
				pos.applyMatrix4(mesh.matrixWorld);
				pos.x -= this.model.position.x === 0 ? 0 : 0;

				targets[idx * 3] = pos.x + this.model.position.x;
				targets[idx * 3 + 1] = pos.y + this.model.position.y;
				targets[idx * 3 + 2] = pos.z + this.model.position.z;

				const theta = Math.random() * Math.PI * 2;
				const phi = Math.acos(2 * Math.random() - 1);
				const r = 2 + Math.random() * 4;
				starts[idx * 3] = targets[idx * 3] + r * Math.sin(phi) * Math.cos(theta);
				starts[idx * 3 + 1] = targets[idx * 3 + 1] + r * Math.sin(phi) * Math.sin(theta);
				starts[idx * 3 + 2] = targets[idx * 3 + 2] + r * Math.cos(phi);

				seeds[idx] = Math.random();
				idx++;
			}
		}

		const geo = new BufferGeometry();
		geo.setAttribute('aStart', new Float32BufferAttribute(starts, 3));
		geo.setAttribute('aTarget', new Float32BufferAttribute(targets, 3));
		geo.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1));
		geo.setAttribute('position', new Float32BufferAttribute(targets, 3));

		this._particleMat = new ShaderMaterial({
			vertexShader: VERT,
			fragmentShader: FRAG,
			uniforms: {
				uProgress: { value: 0 },
				uTime: { value: 0 },
				uParticleAlpha: { value: 1 },
			},
			transparent: true,
			depthWrite: false,
			blending: AdditiveBlending,
		});

		this.particles = new Points(geo, this._particleMat);
		this.scene.add(this.particles);
	}

	_startLoop() {
		this._clock.start();
		this._raf = requestAnimationFrame(this._tick);
	}

	_tick() {
		if (this._disposed) return;
		const dt = this._clock.getDelta();
		const elapsed = this._clock.getElapsedTime();

		if (this.mixer) this.mixer.update(dt);

		if (!this._materialized && this.particles) {
			this._progress = Math.min(this._progress + dt / MATERIALIZE_DURATION, 1);
			this._particleMat.uniforms.uProgress.value = this._progress;
			this._particleMat.uniforms.uTime.value = elapsed;

			if (this._progress >= CROSSFADE_START) {
				const fade = (this._progress - CROSSFADE_START) / (1 - CROSSFADE_START);
				this._setModelOpacity(fade);
				this._particleMat.uniforms.uParticleAlpha.value = 1 - fade;
			}

			if (this._progress >= 1) {
				this._materialized = true;
				this._setModelOpacity(1);
				this.scene.remove(this.particles);
				this.particles.geometry.dispose();
				this._particleMat.dispose();
				this.particles = null;
				this._particleMat = null;
				for (const mat of this._modelOpacityTargets) {
					mat.transparent = false;
				}
			}
		}

		if (this._materialized) {
			this._targetTheta = this._mouseX * 12;
			this._targetPhi = this._mouseY * 6;
			this._currentTheta = MathUtils.lerp(this._currentTheta, this._targetTheta, 0.03);
			this._currentPhi = MathUtils.lerp(this._currentPhi, this._targetPhi, 0.03);

			const thetaRad = this._currentTheta * (Math.PI / 180);
			const dist = this._baseCamPos.z;
			this.camera.position.x = this._baseCamPos.x + Math.sin(thetaRad) * dist * 0.05;
			this.camera.position.y = this._baseCamPos.y - this._currentPhi * 0.01;
			this.camera.lookAt(0, this._focusY, 0);
		}

		this.renderer.render(this.scene, this.camera);
		this._raf = requestAnimationFrame(this._tick);
	}

	dispose() {
		this._disposed = true;
		cancelAnimationFrame(this._raf);
		window.removeEventListener('mousemove', this._onMouseMove);
		if (this.particles) {
			this.particles.geometry.dispose();
			this._particleMat?.dispose();
		}
		this.renderer.dispose();
	}
}

const canvas = document.getElementById('v4-hero-canvas');
if (canvas) {
	const heroScene = new HeroScene(canvas);
	window._v4Hero = heroScene;
}
