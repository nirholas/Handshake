// Diorama — the Three.js renderer.
//
// One sentence becomes a tiny explorable 3D world on a floating island. This
// module owns the WebGL stage: it builds the island, sky, atmosphere, and
// lighting for a Diorama, shows each not-yet-forged object as a luminous "seed",
// and materializes forged GLB meshes onto the island with a flare-and-rise
// animation. It is the visual heart of the feature.
//
// It imports the shared data contract from ./schema.js and never redefines it.
// Boundaries (GLB load, container size) are defended; the inner render loop
// trusts itself.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from '../viewer/internal.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { MOOD_LIGHT, ISLAND_RADIUS, defaultPalette } from './schema.js';

// Decoder binaries are copied into /public/three/draco/ by the repo's
// postinstall (scripts/copy-three-decoders.mjs) — the same path every other
// loader in this codebase uses. Forged GLBs that use Draco load through this.
const DRACO_PATH = '/three/draco/';

// Geometry budget. The island is a small disc; objects normalize to ~1.4m so a
// handful read as a cohesive miniature.
const TARGET_FOOTPRINT = 1.4; // metres, before object.scale multiplier
const SURFACE_Y = 0; // the island top sits at y=0
const MATERIALIZE_MS = 700;

const prefersReducedMotion = () => {
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
};

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Cheap deterministic value noise (no deps) for island undulation + rim. */
function makeNoise2D(seed = 1) {
	const hash = (x, y) => {
		let h = x * 374761393 + y * 668265263 + seed * 2246822519;
		h = (h ^ (h >> 13)) * 1274126177;
		return ((h ^ (h >> 16)) >>> 0) / 4294967295;
	};
	const smooth = (t) => t * t * (3 - 2 * t);
	return (x, y) => {
		const xi = Math.floor(x);
		const yi = Math.floor(y);
		const xf = x - xi;
		const yf = y - yi;
		const a = hash(xi, yi);
		const b = hash(xi + 1, yi);
		const c = hash(xi, yi + 1);
		const d = hash(xi + 1, yi + 1);
		const u = smooth(xf);
		const v = smooth(yf);
		return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
	};
}

/** Build a vertical gradient texture for the sky dome (top -> horizon). */
function makeSkyTexture(topHex, horizonHex) {
	const c = document.createElement('canvas');
	c.width = 4;
	c.height = 256;
	const ctx = c.getContext('2d');
	const g = ctx.createLinearGradient(0, 0, 0, 256);
	g.addColorStop(0, topHex);
	g.addColorStop(0.55, horizonHex);
	g.addColorStop(1, horizonHex);
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 4, 256);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

/** Soft radial alpha texture for the contact shadow + sparkle sprites. */
function makeRadialTexture(inner = 'rgba(0,0,0,0.55)', size = 128) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	g.addColorStop(0, inner);
	g.addColorStop(0.6, 'rgba(0,0,0,0.18)');
	g.addColorStop(1, 'rgba(0,0,0,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	const tex = new THREE.CanvasTexture(c);
	tex.needsUpdate = true;
	return tex;
}

/** Soft white glow texture (for seeds / sparkles), colored via material. */
function makeGlowTexture(size = 128) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	g.addColorStop(0, 'rgba(255,255,255,1)');
	g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
	g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	const tex = new THREE.CanvasTexture(c);
	tex.needsUpdate = true;
	return tex;
}

/** Recursively dispose a subtree's geometries, materials, and their textures. */
function disposeObject(obj) {
	obj.traverse((node) => {
		if (node.geometry) node.geometry.dispose();
		const mat = node.material;
		if (!mat) return;
		const mats = Array.isArray(mat) ? mat : [mat];
		for (const m of mats) {
			for (const key of Object.keys(m)) {
				const val = m[key];
				if (val && val.isTexture) val.dispose();
			}
			m.dispose();
		}
	});
}

/**
 * Build the floating-island geometry. The top is a gently undulating disc; the
 * underside tapers to a point for the classic floating-rock silhouette. The rim
 * is varied by `shape`: round (smooth), craggy (noisy rim + spikier base),
 * plateau (flatter top, steeper sides).
 *
 * @returns {THREE.BufferGeometry}
 */
function buildIslandGeometry(shape, noise) {
	const radius = ISLAND_RADIUS;
	const radialSegments = 96;
	const rings = 14; // top surface rings
	const positions = [];
	const indices = [];

	const rimNoise = shape === 'craggy' ? 0.9 : shape === 'plateau' ? 0.18 : 0.32;
	const topUndulation = shape === 'plateau' ? 0.12 : 0.34;
	// Depth profile of the underside cone.
	const depth = shape === 'plateau' ? 5.4 : shape === 'craggy' ? 6.6 : 5.8;

	// --- Top surface (concentric rings, center vertex first) ---
	positions.push(0, topUndulation * 0.4, 0); // center
	for (let r = 1; r <= rings; r++) {
		const rr = r / rings;
		for (let s = 0; s < radialSegments; s++) {
			const ang = (s / radialSegments) * Math.PI * 2;
			// Rim wobble grows toward the edge.
			const edge = Math.pow(rr, 1.6);
			const wob = (noise(Math.cos(ang) * 2.2 + 7, Math.sin(ang) * 2.2 + 7) - 0.5) * rimNoise * edge;
			const radHere = rr * radius * (1 + wob * 0.16);
			const x = Math.cos(ang) * radHere;
			const z = Math.sin(ang) * radHere;
			// Surface height: gentle dome + local undulation, sinking at the rim.
			const dome = (1 - rr * rr) * topUndulation;
			const local = (noise(x * 0.5 + 3, z * 0.5 + 3) - 0.5) * topUndulation * 0.9 * (1 - edge * 0.5);
			const rimDrop = -Math.pow(rr, 3) * 0.5;
			const y = dome + local + rimDrop;
			positions.push(x, y, z);
		}
	}

	const topVertCount = positions.length / 3;
	const ringStart = (r) => 1 + (r - 1) * radialSegments; // index of first vert of ring r (1-based)

	// center fan to ring 1
	for (let s = 0; s < radialSegments; s++) {
		const a = 1 + s;
		const b = 1 + ((s + 1) % radialSegments);
		indices.push(0, b, a);
	}
	// ring-to-ring quads
	for (let r = 1; r < rings; r++) {
		const cur = ringStart(r);
		const nxt = ringStart(r + 1);
		for (let s = 0; s < radialSegments; s++) {
			const sn = (s + 1) % radialSegments;
			const a = cur + s;
			const b = cur + sn;
			const c = nxt + s;
			const d = nxt + sn;
			indices.push(a, b, c);
			indices.push(b, d, c);
		}
	}

	// --- Underside: from outer rim down to a single apex point ---
	const rimRing = ringStart(rings);
	const apexIndex = positions.length / 3;
	positions.push(0, -depth, 0);
	// underside is faceted directly from the rim ring to the apex
	for (let s = 0; s < radialSegments; s++) {
		const sn = (s + 1) % radialSegments;
		const a = rimRing + s;
		const b = rimRing + sn;
		indices.push(a, apexIndex, b);
	}
	// A couple of intermediate underside rings give the cone a bulging rocky form.
	const underRings = 4;
	const underStart = positions.length / 3;
	for (let u = 1; u <= underRings; u++) {
		const t = u / (underRings + 1);
		for (let s = 0; s < radialSegments; s++) {
			const ang = (s / radialSegments) * Math.PI * 2;
			const bulge = 1 - t;
			const rockNoise = shape === 'craggy' ? 0.5 : 0.28;
			const wob = (noise(Math.cos(ang) * 3 + 21 + u, Math.sin(ang) * 3 + 21) - 0.5) * rockNoise;
			const radHere = radius * bulge * (0.7 + wob * 0.3) * (0.5 + bulge * 0.5);
			const x = Math.cos(ang) * radHere;
			const z = Math.sin(ang) * radHere;
			const y = -depth * t;
			positions.push(x, y, z);
		}
	}
	// stitch rim -> first under ring -> ... -> apex, replacing the direct fan above
	// (we keep both; overlapping faces are fine visually for a stylized rock, but
	// to avoid z-fighting we instead stitch progressively). Rebuild underside cleanly:
	// Note: the direct rim->apex fan was a fallback; remove its faces by not relying
	// on it — stitch rings explicitly here:
	if (underRings > 0) {
		// rim -> under ring 1
		const u1 = underStart;
		for (let s = 0; s < radialSegments; s++) {
			const sn = (s + 1) % radialSegments;
			indices.push(rimRing + s, u1 + s, rimRing + sn);
			indices.push(rimRing + sn, u1 + s, u1 + sn);
		}
		for (let u = 1; u < underRings; u++) {
			const cur = underStart + (u - 1) * radialSegments;
			const nxt = underStart + u * radialSegments;
			for (let s = 0; s < radialSegments; s++) {
				const sn = (s + 1) % radialSegments;
				indices.push(cur + s, nxt + s, cur + sn);
				indices.push(cur + sn, nxt + s, nxt + sn);
			}
		}
		// last under ring -> apex
		const last = underStart + (underRings - 1) * radialSegments;
		for (let s = 0; s < radialSegments; s++) {
			const sn = (s + 1) % radialSegments;
			indices.push(last + s, apexIndex, last + sn);
		}
	}

	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geo.setIndex(indices);
	geo.computeVertexNormals();
	geo.computeBoundingBox();
	geo.userData.topVertCount = topVertCount;
	geo.userData.rimRingStart = rimRing;
	return geo;
}

/** Sample the top-surface height at (x,z) so objects/seeds sit on the ground. */
function surfaceHeightAt(noise, shape, x, z) {
	const topUndulation = shape === 'plateau' ? 0.12 : 0.34;
	const r = Math.hypot(x, z);
	const rr = clamp01(r / ISLAND_RADIUS);
	const dome = (1 - rr * rr) * topUndulation;
	const local = (noise(x * 0.5 + 3, z * 0.5 + 3) - 0.5) * topUndulation * 0.9 * (1 - Math.pow(rr, 1.6) * 0.5);
	const rimDrop = -Math.pow(rr, 3) * 0.5;
	return dome + local + rimDrop;
}

/**
 * Ground material per terrain type, tinted by the palette ground colour.
 * Returns { material, accents } where accents is an optional Object3D to add.
 */
function buildGroundMaterial(ground, palette, noise, shape, getEnv) {
	const tint = new THREE.Color(palette.ground);
	const base = {
		grass: { rough: 0.95, metal: 0, sat: 1 },
		meadow: { rough: 0.92, metal: 0, sat: 1.05 },
		sand: { rough: 1, metal: 0, sat: 0.9 },
		snow: { rough: 0.7, metal: 0, sat: 0.7, emissive: 0.12 },
		stone: { rough: 1, metal: 0.02, sat: 0.8 },
		water: { rough: 0.2, metal: 0.1, sat: 1 },
		void: { rough: 1, metal: 0, sat: 0.6 },
	}[ground] || { rough: 0.95, metal: 0, sat: 1 };

	const col = tint.clone();
	// desaturate/adjust subtly per terrain
	const hsl = {};
	col.getHSL(hsl);
	col.setHSL(hsl.h, clamp01(hsl.s * base.sat), hsl.l);

	const mat = new THREE.MeshStandardMaterial({
		color: col,
		roughness: base.rough,
		metalness: base.metal,
		envMapIntensity: 0.6,
		flatShading: shape === 'craggy',
	});
	if (base.emissive) {
		mat.emissive = col.clone().multiplyScalar(0.4);
		mat.emissiveIntensity = base.emissive;
	}

	const accents = new THREE.Group();
	accents.name = 'ground-accents';

	if (ground === 'grass' || ground === 'meadow') {
		// Tiny scattered detail blades/tufts as instanced cones.
		const count = 280;
		const tuftGeo = new THREE.ConeGeometry(0.05, 0.22, 4);
		const tuftMat = mat.clone();
		const detail = col.clone();
		detail.offsetHSL(0.02, 0.05, ground === 'meadow' ? 0.04 : -0.02);
		tuftMat.color = detail;
		const inst = new THREE.InstancedMesh(tuftGeo, tuftMat, count);
		inst.castShadow = false;
		inst.receiveShadow = true;
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const sca = new THREE.Vector3();
		let placed = 0;
		for (let i = 0; i < count; i++) {
			const ang = noise(i * 1.7, 3) * Math.PI * 2;
			const rad = Math.sqrt(noise(i, 9)) * (ISLAND_RADIUS - 0.5);
			const x = Math.cos(ang) * rad;
			const z = Math.sin(ang) * rad;
			const y = surfaceHeightAt(noise, shape, x, z) + 0.1;
			const s = 0.6 + noise(i, 17) * 0.8;
			q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), noise(i, 23) * Math.PI);
			sca.set(s, s, s);
			m.compose(new THREE.Vector3(x, y, z), q, sca);
			inst.setMatrixAt(placed++, m);
		}
		inst.count = placed;
		inst.instanceMatrix.needsUpdate = true;
		accents.add(inst);
	} else if (ground === 'water') {
		// A small reflective, semi-translucent inset pool.
		const poolGeo = new THREE.CircleGeometry(ISLAND_RADIUS * 0.42, 64);
		const poolMat = new THREE.MeshStandardMaterial({
			color: col,
			roughness: 0.08,
			metalness: 0.0,
			transparent: true,
			opacity: 0.78,
			envMapIntensity: 1.2,
		});
		const env = getEnv();
		if (env) poolMat.envMap = env;
		const pool = new THREE.Mesh(poolGeo, poolMat);
		pool.rotation.x = -Math.PI / 2;
		pool.position.y = SURFACE_Y + 0.04;
		pool.receiveShadow = true;
		accents.add(pool);
	} else if (ground === 'void') {
		// Dark ground with a faint field of star sparkles hugging the surface.
		const count = 160;
		const pos = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) {
			const ang = noise(i, 41) * Math.PI * 2;
			const rad = Math.sqrt(noise(i, 53)) * (ISLAND_RADIUS - 0.3);
			pos[i * 3] = Math.cos(ang) * rad;
			pos[i * 3 + 1] = surfaceHeightAt(noise, shape, Math.cos(ang) * rad, Math.sin(ang) * rad) + 0.05 + noise(i, 61) * 0.2;
			pos[i * 3 + 2] = Math.sin(ang) * rad;
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		const pm = new THREE.PointsMaterial({
			size: 0.07,
			color: new THREE.Color(palette.accent),
			transparent: true,
			opacity: 0.9,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			map: makeGlowTexture(64),
		});
		accents.add(new THREE.Points(g, pm));
	}

	return { material: mat, accents };
}

/**
 * Create the diorama renderer bound to a container element.
 * @param {HTMLElement} container
 * @param {object} [opts]
 */
export function createDioramaRenderer(container, opts = {}) {
	if (!container) throw new Error('createDioramaRenderer(container): container is required');

	const reduced = prefersReducedMotion();

	// --- core three objects ---
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
	camera.position.set(9, 7, 11);

	const renderer = new THREE.WebGLRenderer({
		antialias: true,
		alpha: true,
		powerPreference: 'high-performance',
		preserveDrawingBuffer: Boolean(opts.preserveDrawingBuffer),
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.shadowMap.enabled = true;
	// PCFSoftShadowMap is deprecated in three.js and silently downgrades to hard
	// PCFShadowMap at runtime, warning on every boot; VSMShadowMap is the
	// supported soft-shadow type.
	renderer.shadowMap.type = THREE.VSMShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = opts.exposure ?? 1.0;
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.domElement.style.display = 'block';
	renderer.domElement.style.width = '100%';
	renderer.domElement.style.height = '100%';
	renderer.domElement.setAttribute('aria-hidden', 'true');
	container.appendChild(renderer.domElement);

	// PMREM environment from RoomEnvironment for crisp PBR reflections.
	const pmrem = new THREE.PMREMGenerator(renderer);
	pmrem.compileEquirectangularShader();
	const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
	scene.environment = envRT.texture;
	const getEnv = () => envRT.texture;

	// shared GLB loader (Draco-enabled)
	const dracoLoader = new DRACOLoader().setDecoderPath(DRACO_PATH);
	const gltfLoader = new GLTFLoader();
	gltfLoader.setDRACOLoader(dracoLoader);
	// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
	const meshoptReady = getMeshoptDecoder().then((d) => gltfLoader.setMeshoptDecoder(d));

	// controls
	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.minDistance = 6;
	controls.maxDistance = 30;
	controls.minPolarAngle = 0.15;
	controls.maxPolarAngle = Math.PI * 0.49; // never go under the island
	controls.target.set(0, 0.8, 0);
	controls.enablePan = false;

	// shared resources reused across builds
	const glowTex = makeGlowTexture(128);
	const radialTex = makeRadialTexture('rgba(0,0,0,0.5)', 128);

	// scene groups (rebuilt by setDiorama)
	const worldGroup = new THREE.Group();
	scene.add(worldGroup);

	// lights (created once, retuned per mood)
	const sun = new THREE.DirectionalLight(0xffffff, 1);
	sun.castShadow = true;
	sun.shadow.mapSize.set(1024, 1024);
	sun.shadow.bias = -0.0006;
	sun.shadow.normalBias = 0.02;
	sun.shadow.camera.near = 1;
	sun.shadow.camera.far = 60;
	sun.shadow.camera.left = -ISLAND_RADIUS * 1.6;
	sun.shadow.camera.right = ISLAND_RADIUS * 1.6;
	sun.shadow.camera.top = ISLAND_RADIUS * 1.6;
	sun.shadow.camera.bottom = -ISLAND_RADIUS * 1.6;
	scene.add(sun);
	scene.add(sun.target);

	const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.6);
	scene.add(hemi);
	const ambient = new THREE.AmbientLight(0xffffff, 0.2);
	scene.add(ambient);

	// per-diorama state
	let current = null; // normalized diorama
	let noise = makeNoise2D(1);
	let islandMesh = null;
	let skyMesh = null;
	let starField = null;
	let contactShadow = null;
	const seeds = new Map(); // objectId -> { group, status }
	const placed = new Map(); // objectId -> { group, glbUrl }
	const animations = []; // active timeline tweens
	const disposables = []; // textures/materials created per-build

	// --- camera framing ---
	const _box = new THREE.Box3();
	const _sphere = new THREE.Sphere();
	function computeContentSphere() {
		_box.makeEmpty();
		let any = false;
		worldGroup.traverse((n) => {
			if (n.isMesh || n.isPoints) {
				if (n.name === 'sky-dome') return;
				n.updateWorldMatrix(true, false);
				_box.expandByObject(n);
				any = true;
			}
		});
		if (!any) {
			_sphere.center.set(0, 0.8, 0);
			_sphere.radius = ISLAND_RADIUS;
			return _sphere;
		}
		_box.getBoundingSphere(_sphere);
		// keep the focus near the top surface, not the long underside cone
		_sphere.center.y = Math.max(_sphere.center.y, 0.4);
		_sphere.radius = Math.max(_sphere.radius * 0.7, ISLAND_RADIUS * 0.9);
		return _sphere;
	}

	let frameTween = null;
	function frameCamera(animated = true) {
		const sph = computeContentSphere();
		const fov = (camera.fov * Math.PI) / 180;
		const dist = (sph.radius / Math.sin(fov / 2)) * 1.05;
		const dir = new THREE.Vector3(0.62, 0.5, 0.78).normalize();
		const targetPos = sph.center.clone().add(dir.multiplyScalar(dist));
		const targetLook = sph.center.clone();
		targetLook.y = Math.max(targetLook.y, 0.6);

		if (!animated || reduced) {
			camera.position.copy(targetPos);
			controls.target.copy(targetLook);
			controls.update();
			return;
		}
		const fromPos = camera.position.clone();
		const fromTarget = controls.target.clone();
		frameTween = {
			t: 0,
			dur: 850,
			tick(dt) {
				this.t += dt;
				const k = easeInOutCubic(clamp01(this.t / this.dur));
				camera.position.lerpVectors(fromPos, targetPos, k);
				controls.target.lerpVectors(fromTarget, targetLook, k);
				return this.t >= this.dur;
			},
		};
	}

	// --- seeds ---
	function makeSeed(obj) {
		const group = new THREE.Group();
		const accent = new THREE.Color(current ? current.palette.accent : '#ffe08a');
		const core = new THREE.Mesh(
			new THREE.IcosahedronGeometry(0.14, 2),
			new THREE.MeshStandardMaterial({
				color: accent,
				emissive: accent,
				emissiveIntensity: 1.6,
				roughness: 0.4,
				metalness: 0,
			}),
		);
		core.castShadow = false;
		group.add(core);

		// glow sprite
		const glowMat = new THREE.SpriteMaterial({
			map: glowTex,
			color: accent,
			transparent: true,
			opacity: 0.85,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const glow = new THREE.Sprite(glowMat);
		glow.scale.setScalar(0.9);
		group.add(glow);

		// a small point light so the seed actually casts color onto the ground
		const pl = new THREE.PointLight(accent, 1.2, 2.4, 2);
		pl.position.set(0, 0.05, 0);
		group.add(pl);

		const y = surfaceHeightAt(noise, current ? current.island : 'round', obj.position[0], obj.position[2]);
		group.position.set(obj.position[0], y + 0.45 + (obj.position[1] || 0), obj.position[2]);
		group.userData = { core, glow, pl, glowMat, status: obj.status, base: group.position.y };
		return group;
	}

	function setSeedStatus(group, status) {
		group.userData.status = status;
		const accent = new THREE.Color(current ? current.palette.accent : '#ffe08a');
		if (status === 'failed') {
			const dim = new THREE.Color('#6b6b78');
			group.userData.core.material.color.copy(dim);
			group.userData.core.material.emissive.copy(dim);
			group.userData.core.material.emissiveIntensity = 0.25;
			group.userData.glowMat.color.copy(dim);
			group.userData.glowMat.opacity = 0.25;
			group.userData.pl.intensity = 0.15;
			group.userData.pl.color.copy(dim);
		} else {
			group.userData.core.material.color.copy(accent);
			group.userData.core.material.emissive.copy(accent);
			group.userData.core.material.emissiveIntensity = status === 'forging' ? 2.4 : 1.6;
			group.userData.glowMat.color.copy(accent);
			group.userData.pl.color.copy(accent);
		}
	}

	// --- starfield (night) ---
	function buildStars(palette) {
		const count = 600;
		const pos = new Float32Array(count * 3);
		const R = 60;
		for (let i = 0; i < count; i++) {
			// upper hemisphere shell
			const u = Math.random();
			const v = Math.random() * 0.5 + 0.05;
			const theta = u * Math.PI * 2;
			const phi = Math.acos(1 - 2 * v);
			pos[i * 3] = R * Math.sin(phi) * Math.cos(theta);
			pos[i * 3 + 1] = Math.abs(R * Math.cos(phi)) + 4;
			pos[i * 3 + 2] = R * Math.sin(phi) * Math.sin(theta);
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		const m = new THREE.PointsMaterial({
			size: 0.5,
			sizeAttenuation: true,
			color: new THREE.Color(palette.accent).lerp(new THREE.Color('#ffffff'), 0.5),
			transparent: true,
			opacity: 0.9,
			depthWrite: false,
			map: glowTex,
			blending: THREE.AdditiveBlending,
		});
		const pts = new THREE.Points(g, m);
		pts.name = 'stars';
		disposables.push(g, m);
		return pts;
	}

	// --- build / reset the whole world ---
	function clearWorld() {
		for (const a of animations.splice(0)) {
			/* drop tweens */ void a;
		}
		frameTween = null;
		seeds.clear();
		placed.clear();
		while (worldGroup.children.length) {
			const child = worldGroup.children[0];
			worldGroup.remove(child);
			disposeObject(child);
		}
		for (const d of disposables.splice(0)) {
			if (d && d.dispose) d.dispose();
		}
	}

	function setDiorama(diorama) {
		const d = diorama && diorama.objects ? diorama : { ...normalizedFallback() };
		current = d;
		const palette = d.palette || defaultPalette(d.mood);
		const moodKey = MOOD_LIGHT[d.mood] ? d.mood : 'day';
		const ml = MOOD_LIGHT[moodKey];

		// stable noise seed from id/prompt so re-renders match
		const seedNum = hashString(d.id || d.prompt || 'diorama');
		noise = makeNoise2D((seedNum % 9973) + 1);

		clearWorld();

		// --- sky dome (vertical gradient, painted on inside of a large sphere) ---
		const skyTex = makeSkyTexture(palette.sky[0], palette.sky[1]);
		disposables.push(skyTex);
		const skyMat = new THREE.MeshBasicMaterial({
			map: skyTex,
			side: THREE.BackSide,
			depthWrite: false,
			fog: false,
		});
		skyMesh = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), skyMat);
		skyMesh.name = 'sky-dome';
		worldGroup.add(skyMesh);
		// also set scene.background so screenshots/AR backdrop read the horizon tone
		scene.background = new THREE.Color(palette.sky[1]);

		// --- fog ---
		const fogColor = new THREE.Color(palette.fog);
		const fogDensity = 0.006 + ml.fog * 0.9;
		scene.fog = new THREE.FogExp2(fogColor, fogDensity);

		// --- island ---
		const islandGeo = buildIslandGeometry(d.island, noise);
		const { material: groundMat, accents } = buildGroundMaterial(d.ground, palette, noise, d.island, getEnv);
		// underside rocky material as a second material via vertex-based? Keep single
		// material but darken using a subtle gradient won't work without uv; instead
		// add a separate underside-tint via a darker overlay mesh would z-fight.
		// Simpler + clean: rely on lighting + the cone shape; tint underside darker
		// through vertex colors.
		applyUndersideVertexColors(islandGeo, groundMat);
		islandMesh = new THREE.Mesh(islandGeo, groundMat);
		islandMesh.castShadow = true;
		islandMesh.receiveShadow = true;
		islandMesh.frustumCulled = true;
		worldGroup.add(islandMesh);
		worldGroup.add(accents);
		disposables.push(islandGeo, groundMat);

		// --- contact shadow blob under the island ---
		const shadowMat = new THREE.MeshBasicMaterial({
			map: radialTex,
			transparent: true,
			opacity: 0.45,
			depthWrite: false,
			color: 0x000000,
			fog: false,
		});
		contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(ISLAND_RADIUS * 3.4, ISLAND_RADIUS * 3.4), shadowMat);
		contactShadow.rotation.x = -Math.PI / 2;
		contactShadow.position.y = -7.6;
		contactShadow.name = 'contact-shadow';
		worldGroup.add(contactShadow);
		disposables.push(shadowMat);

		// --- stars at night ---
		if (moodKey === 'night') {
			starField = buildStars(palette);
			worldGroup.add(starField);
		} else {
			starField = null;
		}

		// --- lights retuned for mood + palette accent ---
		const accentColor = new THREE.Color(palette.accent);
		const sunColor = new THREE.Color(0xffffff).lerp(accentColor, 0.45);
		sun.color.copy(sunColor);
		sun.intensity = ml.sunIntensity * 1.4;
		// position the sun from elevation (0..1 -> angle), azimuth fixed for hero look
		const elev = THREE.MathUtils.clamp(ml.sunElevation, -0.2, 1) * (Math.PI / 2);
		const az = Math.PI * 0.25;
		const sunDist = 24;
		sun.position.set(
			Math.cos(elev) * Math.cos(az) * sunDist,
			Math.max(2, Math.sin(elev) * sunDist + 6),
			Math.cos(elev) * Math.sin(az) * sunDist,
		);
		sun.target.position.set(0, 0, 0);

		hemi.color.copy(new THREE.Color(palette.sky[0]));
		hemi.groundColor.copy(new THREE.Color(palette.ground).multiplyScalar(0.6));
		hemi.intensity = ml.ambient * 0.9;
		ambient.intensity = ml.ambient * 0.35;
		ambient.color.copy(fogColor).lerp(new THREE.Color('#ffffff'), 0.4);

		// --- seeds for every object ---
		for (const obj of d.objects) {
			const seed = makeSeed(obj);
			worldGroup.add(seed);
			seeds.set(obj.id, seed);
			if (obj.status === 'failed') setSeedStatus(seed, 'failed');
			else setSeedStatus(seed, obj.status === 'forging' ? 'forging' : 'pending');
		}

		frameCamera(false);
		needsRender = true;
		return api;
	}

	// --- materialize a forged GLB ---
	function fitGltfScene(root, objScale) {
		const box = new THREE.Box3().setFromObject(root);
		if (box.isEmpty()) return root;
		const size = new THREE.Vector3();
		const center = new THREE.Vector3();
		box.getSize(size);
		box.getCenter(center);
		const footprint = Math.max(size.x, size.z) || Math.max(size.x, size.y, size.z) || 1;
		const norm = (TARGET_FOOTPRINT / footprint) * (objScale || 1);

		const wrapper = new THREE.Group();
		// recenter horizontally to origin, drop base to y=0
		root.position.x -= center.x;
		root.position.z -= center.z;
		root.position.y -= box.min.y;
		wrapper.add(root);
		wrapper.scale.setScalar(norm);

		root.traverse((n) => {
			if (n.isMesh) {
				n.castShadow = true;
				n.receiveShadow = true;
				n.frustumCulled = true;
				if (n.material) {
					const mats = Array.isArray(n.material) ? n.material : [n.material];
					for (const m of mats) {
						m.envMapIntensity = m.envMapIntensity ?? 1;
						if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
						m.needsUpdate = true;
					}
				}
			}
		});
		return wrapper;
	}

	function materializeObject(objectId, glbUrl) {
		return new Promise((resolve, reject) => {
			const obj = current && current.objects.find((o) => o.id === objectId);
			if (!obj) {
				reject(new Error(`materializeObject: unknown object "${objectId}"`));
				return;
			}
			const seed = seeds.get(objectId);
			if (seed) setSeedStatus(seed, 'forging');

			meshoptReady.then(() => gltfLoader.load(
				glbUrl,
				(gltf) => {
					try {
						const fitted = fitGltfScene(gltf.scene, obj.scale);
						const y = surfaceHeightAt(noise, current.island, obj.position[0], obj.position[2]);
						fitted.position.set(obj.position[0], y + (obj.position[1] || 0), obj.position[2]);
						fitted.rotation.y = obj.rotationY || 0;
						fitted.userData.glbUrl = glbUrl;
						fitted.userData.objectId = objectId;

						// remove any previously placed mesh for this object
						const prev = placed.get(objectId);
						if (prev && prev.group.parent) {
							worldGroup.remove(prev.group);
							disposeObject(prev.group);
						}
						worldGroup.add(fitted);
						placed.set(objectId, { group: fitted, glbUrl });

						playMaterialize(seed, fitted, obj);
						needsRender = true;
						resolve(fitted);
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				},
				undefined,
				(err) => {
					if (seed) setSeedStatus(seed, 'failed');
					needsRender = true;
					reject(err instanceof Error ? err : new Error(`Failed to load GLB: ${glbUrl}`));
				},
			));
		});
	}

	function playMaterialize(seed, fitted, obj) {
		const accent = new THREE.Color(current.palette.accent);

		if (reduced) {
			// snap in, hide the seed
			if (seed) {
				worldGroup.remove(seed);
				seeds.delete(obj.id);
			}
			fitted.scale.multiplyScalar(1);
			return;
		}

		// expanding ring sprite at the seed location
		const ringMat = new THREE.SpriteMaterial({
			map: glowTex,
			color: accent,
			transparent: true,
			opacity: 0.9,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const ring = new THREE.Sprite(ringMat);
		ring.position.copy(fitted.position);
		ring.position.y += 0.3;
		ring.scale.setScalar(0.2);
		worldGroup.add(ring);

		// sparkle burst
		const sparkCount = 14;
		const sparkPos = new Float32Array(sparkCount * 3);
		const sparkVel = [];
		for (let i = 0; i < sparkCount; i++) {
			sparkPos[i * 3] = 0;
			sparkPos[i * 3 + 1] = 0;
			sparkPos[i * 3 + 2] = 0;
			const a = Math.random() * Math.PI * 2;
			const up = 0.4 + Math.random() * 0.9;
			sparkVel.push(new THREE.Vector3(Math.cos(a) * (0.4 + Math.random() * 0.6), up, Math.sin(a) * (0.4 + Math.random() * 0.6)));
		}
		const sparkGeo = new THREE.BufferGeometry();
		sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
		const sparkMat = new THREE.PointsMaterial({
			size: 0.18,
			color: accent,
			transparent: true,
			opacity: 1,
			depthWrite: false,
			map: glowTex,
			blending: THREE.AdditiveBlending,
		});
		const sparks = new THREE.Points(sparkGeo, sparkMat);
		sparks.position.copy(fitted.position);
		sparks.position.y += 0.3;
		worldGroup.add(sparks);

		// mesh emerges: from below + small + transparent -> in place
		const finalScale = fitted.scale.clone();
		const startScale = finalScale.clone().multiplyScalar(0.25);
		const finalY = fitted.position.y;
		const startY = finalY - 0.6;
		fitted.scale.copy(startScale);
		fitted.position.y = startY;
		setMeshOpacity(fitted, 0);

		// seed flare then fade
		const seedStartIntensity = seed ? seed.userData.core.material.emissiveIntensity : 0;

		const tween = {
			t: 0,
			dur: MATERIALIZE_MS,
			done: false,
			tick(dt) {
				this.t += dt;
				const raw = clamp01(this.t / this.dur);
				const k = easeOutCubic(raw);

				// mesh rise + scale + fade
				fitted.scale.lerpVectors(startScale, finalScale, k);
				fitted.position.y = startY + (finalY - startY) * k;
				setMeshOpacity(fitted, k);

				// seed flares early then collapses
				if (seed) {
					const flare = raw < 0.35 ? 1 + (raw / 0.35) * 2.5 : Math.max(0, 1 - (raw - 0.35) / 0.4);
					seed.userData.core.material.emissiveIntensity = seedStartIntensity * flare + flare * 2;
					seed.userData.glowMat.opacity = 0.85 * flare;
					const ss = 1 + (raw < 0.35 ? raw * 2 : 0);
					seed.userData.core.scale.setScalar(Math.max(0.001, ss * (1 - raw)));
					seed.userData.pl.intensity = 1.2 * flare;
				}

				// ring expands + fades
				ring.scale.setScalar(0.2 + raw * 3.2);
				ringMat.opacity = 0.9 * (1 - raw);

				// sparks fly out + gravity, fade
				const sp = sparkGeo.attributes.position;
				for (let i = 0; i < sparkCount; i++) {
					const v = sparkVel[i];
					sp.array[i * 3] = v.x * raw * 1.4;
					sp.array[i * 3 + 1] = v.y * raw * 1.4 - raw * raw * 0.8;
					sp.array[i * 3 + 2] = v.z * raw * 1.4;
				}
				sp.needsUpdate = true;
				sparkMat.opacity = 1 - raw;

				if (raw >= 1) {
					this.done = true;
					setMeshOpacity(fitted, 1, true); // restore original material opacity
					fitted.scale.copy(finalScale);
					fitted.position.y = finalY;
					// remove seed + fx
					if (seed) {
						worldGroup.remove(seed);
						disposeObject(seed);
						seeds.delete(obj.id);
					}
					worldGroup.remove(ring);
					ringMat.map = null;
					ringMat.dispose();
					worldGroup.remove(sparks);
					sparkGeo.dispose();
					sparkMat.dispose();
				}
				return this.done;
			},
		};
		animations.push(tween);
		needsRender = true;
	}

	function markFailed(objectId) {
		const seed = seeds.get(objectId);
		if (seed) {
			setSeedStatus(seed, 'failed');
			needsRender = true;
		}
		if (current) {
			const obj = current.objects.find((o) => o.id === objectId);
			if (obj) obj.status = 'failed';
		}
		return api;
	}

	// --- auto orbit ---
	let autoOrbit = false;
	let userInteracting = false;
	let lastInteraction = performance.now();
	const onPointerDown = () => {
		userInteracting = true;
		lastInteraction = performance.now();
	};
	const onPointerUp = () => {
		userInteracting = false;
		lastInteraction = performance.now();
	};
	controls.addEventListener('start', onPointerDown);
	controls.addEventListener('end', onPointerUp);

	function startAutoOrbit(on) {
		autoOrbit = Boolean(on) && !reduced;
		lastInteraction = performance.now();
		needsRender = true;
		return api;
	}

	// --- render loop, gated by visibility ---
	let rafId = 0;
	let running = false;
	let visible = true;
	let needsRender = true;
	let lastTime = performance.now();

	function loop(now) {
		rafId = requestAnimationFrame(loop);
		const dt = Math.min(64, now - lastTime);
		lastTime = now;

		if (!visible || document.hidden) {
			needsRender = true; // force a fresh frame when we resume
			return;
		}

		let active = false;

		// frame tween
		if (frameTween) {
			if (frameTween.tick(dt)) frameTween = null;
			active = true;
		}

		// materialize tweens
		if (animations.length) {
			for (let i = animations.length - 1; i >= 0; i--) {
				if (animations[i].tick(dt)) animations.splice(i, 1);
			}
			active = true;
		}

		// idle pulse on forging seeds + gentle seed bob
		const tsec = now / 1000;
		if (seeds.size) {
			for (const seed of seeds.values()) {
				const ud = seed.userData;
				const bob = Math.sin(tsec * 1.6 + seed.position.x) * 0.05;
				seed.position.y = ud.base + bob;
				if (ud.status === 'forging') {
					const pulse = 0.5 + 0.5 * Math.sin(tsec * 3.4);
					ud.glowMat.opacity = 0.6 + pulse * 0.35;
					ud.core.material.emissiveIntensity = 1.8 + pulse * 1.4;
					ud.pl.intensity = 0.9 + pulse * 0.9;
				} else if (ud.status === 'pending') {
					ud.glowMat.opacity = 0.55 + 0.2 * Math.sin(tsec * 1.5 + seed.position.z);
				}
			}
			active = true;
		}

		// water shimmer
		if (current && current.ground === 'water') active = true;

		// auto orbit
		if (autoOrbit && !userInteracting && now - lastInteraction > 3000) {
			const sph = computeContentSphere();
			controls.target.lerp(new THREE.Vector3(sph.center.x, Math.max(sph.center.y, 0.6), sph.center.z), 0.02);
			// rotate camera around target
			const offset = camera.position.clone().sub(controls.target);
			const ang = 0.00018 * dt;
			const cos = Math.cos(ang);
			const sin = Math.sin(ang);
			const nx = offset.x * cos - offset.z * sin;
			const nz = offset.x * sin + offset.z * cos;
			offset.x = nx;
			offset.z = nz;
			camera.position.copy(controls.target).add(offset);
			active = true;
		}

		const damped = controls.update();
		if (damped || active || needsRender) {
			renderer.render(scene, camera);
			needsRender = false;
		}
	}

	function start() {
		if (running) return;
		running = true;
		lastTime = performance.now();
		rafId = requestAnimationFrame(loop);
	}
	function stop() {
		running = false;
		if (rafId) cancelAnimationFrame(rafId);
		rafId = 0;
	}

	// --- resize ---
	function resize() {
		const w = container.clientWidth || container.offsetWidth || 0;
		const h = container.clientHeight || container.offsetHeight || 0;
		if (w === 0 || h === 0) return;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h, false);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		needsRender = true;
	}

	let hadFirstSize = false;
	const resizeObserver = new ResizeObserver(() => {
		const w = container.clientWidth;
		const h = container.clientHeight;
		if (w > 0 && h > 0) {
			resize();
			if (!hadFirstSize) {
				hadFirstSize = true;
				start();
				if (current) frameCamera(false);
			}
		}
	});
	resizeObserver.observe(container);

	// visibility gating
	const intersectionObserver = new IntersectionObserver(
		(entries) => {
			for (const e of entries) visible = e.isIntersecting;
			needsRender = true;
		},
		{ threshold: 0.01 },
	);
	intersectionObserver.observe(container);

	const onVisibility = () => {
		needsRender = true;
	};
	document.addEventListener('visibilitychange', onVisibility);

	// kick off immediately if the container already has a size
	if (container.clientWidth > 0 && container.clientHeight > 0) {
		resize();
		hadFirstSize = true;
		start();
	}

	// --- public api ---
	function getActiveGlbUrls() {
		return Array.from(placed.values()).map((p) => p.glbUrl).filter(Boolean);
	}

	function frame() {
		frameCamera(true);
		needsRender = true;
		return api;
	}

	let disposed = false;
	function dispose() {
		if (disposed) return;
		disposed = true;
		stop();
		resizeObserver.disconnect();
		intersectionObserver.disconnect();
		document.removeEventListener('visibilitychange', onVisibility);
		controls.removeEventListener('start', onPointerDown);
		controls.removeEventListener('end', onPointerUp);
		controls.dispose();

		clearWorld();
		scene.remove(worldGroup);

		glowTex.dispose();
		radialTex.dispose();
		envRT.texture.dispose();
		pmrem.dispose();
		dracoLoader.dispose();

		if (scene.background && scene.background.isTexture) scene.background.dispose();
		scene.environment = null;

		renderer.dispose();
		if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
		renderer.forceContextLoss();
	}

	const api = {
		setDiorama,
		materializeObject,
		markFailed,
		frame,
		startAutoOrbit,
		getActiveGlbUrls,
		resize,
		dispose,
		// escape hatches the integrator may want
		get scene() {
			return scene;
		},
		get camera() {
			return camera;
		},
		get renderer() {
			return renderer;
		},
	};
	return api;
}

// --- helpers shared by both exports ---

function hashString(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function normalizedFallback() {
	const p = defaultPalette('day');
	return {
		id: 'fallback',
		prompt: '',
		title: '',
		mood: 'day',
		palette: p,
		ground: 'grass',
		island: 'round',
		objects: [],
	};
}

/** Darken underside vertices so the rocky base reads distinct from the top. */
function applyUndersideVertexColors(geo, material) {
	const pos = geo.attributes.position;
	const colors = new Float32Array(pos.count * 3);
	const base = new THREE.Color(material.color.getHex());
	const dark = base.clone().multiplyScalar(0.32);
	const c = new THREE.Color();
	for (let i = 0; i < pos.count; i++) {
		const y = pos.getY(i);
		// y >= ~ -0.6 is top surface; below blends to dark rock
		const t = clamp01((-y) / 4); // 0 at top, 1 deep
		c.copy(base).lerp(dark, t);
		colors[i * 3] = c.r;
		colors[i * 3 + 1] = c.g;
		colors[i * 3 + 2] = c.b;
	}
	geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	material.vertexColors = true;
	material.color.set(0xffffff); // let vertex colors drive it
	material.needsUpdate = true;
}

/** Set opacity across a fitted GLB subtree; remembers originals on first call. */
function setMeshOpacity(root, k, restore = false) {
	root.traverse((n) => {
		if (!n.isMesh || !n.material) return;
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) {
			if (m.userData.__baseOpacity === undefined) {
				m.userData.__baseOpacity = m.opacity;
				m.userData.__baseTransparent = m.transparent;
			}
			if (restore) {
				m.opacity = m.userData.__baseOpacity;
				m.transparent = m.userData.__baseTransparent;
				m.depthWrite = m.userData.__baseTransparent ? m.depthWrite : true;
			} else {
				m.transparent = true;
				m.opacity = m.userData.__baseOpacity * k;
			}
			m.needsUpdate = false;
		}
	});
}

/**
 * One-shot thumbnail render of a saved diorama into a canvas. Owns its own
 * scene/renderer/loader. Renders the island + mood sky always; loads the first
 * available forged GLB (or all of them, capped) so the preview is never blank.
 * Returns a dispose function the caller invokes when the thumbnail is gone.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} diorama
 * @returns {Promise<() => void>}
 */
export async function renderThumbnail(canvas, diorama) {
	if (!canvas) throw new Error('renderThumbnail(canvas): canvas is required');
	const d = diorama && diorama.objects ? diorama : normalizedFallback();
	const palette = d.palette || defaultPalette(d.mood);
	const moodKey = MOOD_LIGHT[d.mood] ? d.mood : 'day';
	const ml = MOOD_LIGHT[moodKey];

	const width = canvas.width || canvas.clientWidth || 320;
	const height = canvas.height || canvas.clientHeight || 200;

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(width, height, false);
	renderer.shadowMap.enabled = true;
	// PCFSoftShadowMap is deprecated in three.js and silently downgrades to hard
	// PCFShadowMap at runtime, warning on every boot; VSMShadowMap is the
	// supported soft-shadow type.
	renderer.shadowMap.type = THREE.VSMShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.0;
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 200);

	const pmrem = new THREE.PMREMGenerator(renderer);
	const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
	scene.environment = envRT.texture;

	const noise = makeNoise2D((hashString(d.id || d.prompt || 'diorama') % 9973) + 1);
	const created = []; // geometries/materials/textures to dispose
	const loaders = [];

	// sky
	const skyTex = makeSkyTexture(palette.sky[0], palette.sky[1]);
	const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false, fog: false });
	const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 24, 12), skyMat);
	scene.add(sky);
	scene.background = new THREE.Color(palette.sky[1]);
	created.push(skyTex, skyMat, sky.geometry);

	scene.fog = new THREE.FogExp2(new THREE.Color(palette.fog), 0.006 + ml.fog * 0.9);

	// island
	const islandGeo = buildIslandGeometry(d.island, noise);
	const { material: groundMat, accents } = buildGroundMaterial(d.ground, palette, noise, d.island, () => envRT.texture);
	applyUndersideVertexColors(islandGeo, groundMat);
	const island = new THREE.Mesh(islandGeo, groundMat);
	island.castShadow = true;
	island.receiveShadow = true;
	scene.add(island);
	scene.add(accents);
	created.push(islandGeo, groundMat);

	// contact shadow
	const radialTex = makeRadialTexture('rgba(0,0,0,0.5)', 128);
	const shadowMat = new THREE.MeshBasicMaterial({ map: radialTex, transparent: true, opacity: 0.45, depthWrite: false, color: 0x000000, fog: false });
	const contact = new THREE.Mesh(new THREE.PlaneGeometry(ISLAND_RADIUS * 3.4, ISLAND_RADIUS * 3.4), shadowMat);
	contact.rotation.x = -Math.PI / 2;
	contact.position.y = -7.6;
	scene.add(contact);
	created.push(radialTex, shadowMat, contact.geometry);

	// lights
	const accentColor = new THREE.Color(palette.accent);
	const sun = new THREE.DirectionalLight(new THREE.Color(0xffffff).lerp(accentColor, 0.45), ml.sunIntensity * 1.4);
	sun.castShadow = true;
	sun.shadow.mapSize.set(1024, 1024);
	sun.shadow.bias = -0.0006;
	sun.shadow.normalBias = 0.02;
	sun.shadow.camera.left = -ISLAND_RADIUS * 1.6;
	sun.shadow.camera.right = ISLAND_RADIUS * 1.6;
	sun.shadow.camera.top = ISLAND_RADIUS * 1.6;
	sun.shadow.camera.bottom = -ISLAND_RADIUS * 1.6;
	sun.shadow.camera.far = 60;
	const elev = THREE.MathUtils.clamp(ml.sunElevation, -0.2, 1) * (Math.PI / 2);
	sun.position.set(Math.cos(elev) * Math.cos(Math.PI * 0.25) * 24, Math.max(2, Math.sin(elev) * 24 + 6), Math.cos(elev) * Math.sin(Math.PI * 0.25) * 24);
	scene.add(sun);
	scene.add(sun.target);
	const hemi = new THREE.HemisphereLight(new THREE.Color(palette.sky[0]), new THREE.Color(palette.ground).multiplyScalar(0.6), ml.ambient * 0.9);
	scene.add(hemi);
	const ambient = new THREE.AmbientLight(new THREE.Color(palette.fog).lerp(new THREE.Color('#ffffff'), 0.4), ml.ambient * 0.35);
	scene.add(ambient);

	if (moodKey === 'night') {
		const count = 300;
		const posArr = new Float32Array(count * 3);
		const R = 60;
		for (let i = 0; i < count; i++) {
			const u = Math.random();
			const v = Math.random() * 0.5 + 0.05;
			const theta = u * Math.PI * 2;
			const phi = Math.acos(1 - 2 * v);
			posArr[i * 3] = R * Math.sin(phi) * Math.cos(theta);
			posArr[i * 3 + 1] = Math.abs(R * Math.cos(phi)) + 4;
			posArr[i * 3 + 2] = R * Math.sin(phi) * Math.sin(theta);
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
		const glowTex = makeGlowTexture(64);
		const m = new THREE.PointsMaterial({ size: 0.5, color: new THREE.Color(palette.accent).lerp(new THREE.Color('#ffffff'), 0.5), transparent: true, opacity: 0.9, depthWrite: false, map: glowTex, blending: THREE.AdditiveBlending });
		const stars = new THREE.Points(g, m);
		scene.add(stars);
		created.push(g, m, glowTex);
	}

	// seeds for any unforged objects (so it reads as a populated little world)
	const glowTex = makeGlowTexture(96);
	created.push(glowTex);
	for (const obj of d.objects) {
		if (obj.glbUrl) continue;
		const y = surfaceHeightAt(noise, d.island, obj.position[0], obj.position[2]);
		const spriteMat = new THREE.SpriteMaterial({ map: glowTex, color: accentColor, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
		const sprite = new THREE.Sprite(spriteMat);
		sprite.scale.setScalar(0.8 * (obj.scale || 1));
		sprite.position.set(obj.position[0], y + 0.45, obj.position[2]);
		scene.add(sprite);
		created.push(spriteMat);
	}

	// load forged GLBs (capped), defensively — a failure must not blank the thumb
	const dracoLoader = new DRACOLoader().setDecoderPath(DRACO_PATH);
	const gltfLoader = new GLTFLoader();
	gltfLoader.setDRACOLoader(dracoLoader);
	gltfLoader.setMeshoptDecoder(await getMeshoptDecoder());
	loaders.push(dracoLoader);

	const forged = d.objects.filter((o) => o.glbUrl).slice(0, 8);
	const placedGroups = [];
	await Promise.all(
		forged.map(
			(obj) =>
				new Promise((resolve) => {
					gltfLoader.load(
						obj.glbUrl,
						(gltf) => {
							try {
								const root = gltf.scene;
								const box = new THREE.Box3().setFromObject(root);
								if (!box.isEmpty()) {
									const size = new THREE.Vector3();
									const center = new THREE.Vector3();
									box.getSize(size);
									box.getCenter(center);
									const footprint = Math.max(size.x, size.z) || 1;
									const norm = (TARGET_FOOTPRINT / footprint) * (obj.scale || 1);
									const wrapper = new THREE.Group();
									root.position.x -= center.x;
									root.position.z -= center.z;
									root.position.y -= box.min.y;
									wrapper.add(root);
									wrapper.scale.setScalar(norm);
									const y = surfaceHeightAt(noise, d.island, obj.position[0], obj.position[2]);
									wrapper.position.set(obj.position[0], y, obj.position[2]);
									wrapper.rotation.y = obj.rotationY || 0;
									root.traverse((n) => {
										if (n.isMesh) {
											n.castShadow = true;
											n.receiveShadow = true;
											if (n.material) {
												const mats = Array.isArray(n.material) ? n.material : [n.material];
												for (const mm of mats) {
													if (mm.map) mm.map.colorSpace = THREE.SRGBColorSpace;
												}
											}
										}
									});
									scene.add(wrapper);
									placedGroups.push(wrapper);
								}
							} catch {
								/* skip this mesh; thumbnail still renders the island */
							}
							resolve();
						},
						undefined,
						() => resolve(), // ignore load failure for a thumbnail
					);
				}),
		),
	);

	// frame to a 3/4 hero angle
	const box = new THREE.Box3();
	box.makeEmpty();
	box.expandByObject(island);
	for (const g of placedGroups) box.expandByObject(g);
	const sphere = new THREE.Sphere();
	box.getBoundingSphere(sphere);
	sphere.center.y = Math.max(0.4, sphere.center.y * 0.4);
	sphere.radius = Math.max(sphere.radius * 0.62, ISLAND_RADIUS * 0.9);
	const fov = (camera.fov * Math.PI) / 180;
	const dist = (sphere.radius / Math.sin(fov / 2)) * 1.05;
	const dir = new THREE.Vector3(0.62, 0.5, 0.78).normalize();
	camera.position.copy(sphere.center).add(dir.multiplyScalar(dist));
	camera.lookAt(sphere.center.x, Math.max(sphere.center.y, 0.6), sphere.center.z);
	sun.target.position.set(0, 0, 0);
	sun.target.updateMatrixWorld();

	// render a few frames so env/shadows settle
	renderer.render(scene, camera);
	renderer.render(scene, camera);

	let disposed = false;
	return function disposeThumbnail() {
		if (disposed) return;
		disposed = true;
		for (const g of placedGroups) {
			scene.remove(g);
			disposeObject(g);
		}
		scene.traverse((n) => {
			if (n === island) return;
		});
		disposeObject(island);
		disposeObject(accents);
		for (const r of created) {
			if (r && r.dispose) r.dispose();
		}
		for (const l of loaders) {
			if (l && l.dispose) l.dispose();
		}
		envRT.texture.dispose();
		pmrem.dispose();
		if (scene.background && scene.background.isTexture) scene.background.dispose();
		renderer.dispose();
		renderer.forceContextLoss();
	};
}
