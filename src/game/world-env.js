// World environment — a sleek, nocturnal arena that flows straight out of the
// monochrome lobby. Where the old build was a bright green meadow (which broke
// the brand the moment a player dropped in), this is the same design language as
// the lobby: near-black ground, a fine technical hairline grid, a thin glowing
// boundary ring, a dark silhouette treeline melting into fog, and a single cool
// "moonlight" key so the white avatars and their long shadows are the only thing
// that reads as light. Colour is expressed only as light. Self-contained: the
// scene file creates it once and ticks update(dt).
//
// Everything decorative sits OUTSIDE the playRadius circle so it frames the
// space without ever blocking a player. Geometry is low-poly and shared/cloned,
// so the whole environment is cheap enough to run alongside the avatars and
// their shadows.

import {
	Color, Fog, Group, Vector3, MathUtils, DoubleSide, SRGBColorSpace,
	HemisphereLight, DirectionalLight, AmbientLight,
	Mesh, MeshStandardMaterial, MeshBasicMaterial,
	CircleGeometry, RingGeometry, CylinderGeometry, ConeGeometry, IcosahedronGeometry,
	GridHelper, CanvasTexture,
} from 'three';

// Palette — monochrome nocturne. Pure greyscale; the only "warm" point is the
// cool moonlight key. Matches the lobby tokens (--cc-bg #060607 … hairlines).
const C_SKY_TOP = '#070709';
const C_SKY_HORIZON = '#26262c';   // also the fog colour, so ground melts into the seam
const C_GROUND = 0x0c0c0e;         // field beyond the arena
const C_PLAZA = 0x141417;          // the mown play circle reads a touch lighter
const C_GRID = 0x6f6f78;           // faint technical hairline grid
const C_RING = 0xffffff;           // glowing boundary hairline (light = the only colour)
const C_HILL = 0x131316;
const C_TRUNK = 0x101012;
const C_LEAF_A = 0x16161a;
const C_LEAF_B = 0x1d1d22;

// A seeded LCG so the treeline/hill layout is identical on every load (stable
// demos, no first-frame reshuffle) without touching Math.random.
function rng(seed) {
	let s = seed >>> 0;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

// A vertical gradient backdrop (near-black overhead → dim grey at the horizon),
// rendered as the scene background so it's immune to fog and never rotates with
// the orbit camera — a clean studio sky behind the arena.
function gradientSky() {
	const c = document.createElement('canvas');
	c.width = 4; c.height = 256;
	const x = c.getContext('2d');
	const g = x.createLinearGradient(0, 0, 0, 256);
	g.addColorStop(0, C_SKY_TOP);
	g.addColorStop(0.62, '#101015');
	g.addColorStop(1, C_SKY_HORIZON);
	x.fillStyle = g; x.fillRect(0, 0, 4, 256);
	const tex = new CanvasTexture(c);
	tex.colorSpace = SRGBColorSpace;
	return tex;
}

export function createWorldEnvironment(scene, renderer, playRadius = 58) {
	const root = new Group();
	scene.add(root);
	const rand = rng(0x3d3d3d);
	const between = (a, b) => a + (b - a) * rand();

	// --- Sky + atmosphere --------------------------------------------------
	scene.background = gradientSky();
	// Dark fog tuned to the horizon so the ground edge, treeline, and hills all
	// dissolve into the backdrop seam — no hard rim, attention stays on players.
	scene.fog = new Fog(new Color(C_SKY_HORIZON), 70, 300);

	// --- Lighting ----------------------------------------------------------
	// One cool moonlight key (casts the long shadows), a faint cool sky/ground
	// hemisphere, and a whisper of ambient so the dark geometry never crushes to
	// pure black. The avatars are the brightest thing in frame, by design.
	const hemi = new HemisphereLight(0x9fb0d8, 0x070709, 0.45);
	root.add(hemi);
	root.add(new AmbientLight(0xffffff, 0.12));

	const sun = new Vector3();
	const elevation = 48, azimuth = 135;
	sun.setFromSphericalCoords(1, MathUtils.degToRad(90 - elevation), MathUtils.degToRad(azimuth));
	const sunLight = new DirectionalLight(0xdfe6ff, 2.2);
	sunLight.position.copy(sun).multiplyScalar(120);
	sunLight.castShadow = true;
	sunLight.shadow.mapSize.set(2048, 2048);
	const sc = sunLight.shadow.camera;
	sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
	sunLight.shadow.bias = -0.0004;
	root.add(sunLight, sunLight.target);

	// --- Ground ------------------------------------------------------------
	// Near-black field reaching into the fog, a slightly lighter mown play
	// circle, a fine hairline grid for that technical lobby feel, and a single
	// glowing white hairline tracing the arena boundary.
	const field = new Mesh(new CircleGeometry(400, 64),
		new MeshStandardMaterial({ color: C_GROUND, roughness: 1, metalness: 0 }));
	field.rotation.x = -Math.PI / 2; field.receiveShadow = true;
	root.add(field);

	const plaza = new Mesh(new CircleGeometry(playRadius, 64),
		new MeshStandardMaterial({ color: C_PLAZA, roughness: 1, metalness: 0 }));
	plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.01; plaza.receiveShadow = true;
	root.add(plaza);

	// Technical hairline grid (echoes the lobby's faint background grid). Square,
	// but the dark fog and the brighter plaza disc fade its reach so it reads as
	// an intentional engineering grid rather than a hard sheet.
	const grid = new GridHelper(playRadius * 2, 30, C_GRID, C_GRID);
	grid.position.y = 0.02;
	grid.material.transparent = true;
	grid.material.opacity = 0.14;
	grid.material.depthWrite = false;
	root.add(grid);

	// Glowing boundary hairline — the one bright accent on the ground plane.
	const ring = new Mesh(new RingGeometry(playRadius - 0.12, playRadius + 0.12, 128),
		new MeshBasicMaterial({ color: C_RING, transparent: true, opacity: 0.32, side: DoubleSide }));
	ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
	root.add(ring);

	// --- Distant hills -----------------------------------------------------
	// A ring of broad, low mounds beyond the treeline gives the horizon depth as
	// near-black silhouettes against the slightly lighter sky seam.
	const hillGeo = new IcosahedronGeometry(1, 1);
	const hillMat = new MeshStandardMaterial({ color: C_HILL, roughness: 1, metalness: 0, flatShading: true });
	for (let i = 0; i < 14; i++) {
		const ang = (i / 14) * Math.PI * 2 + between(-0.12, 0.12);
		const dist = between(150, 210);
		const h = new Mesh(hillGeo, hillMat);
		const w = between(45, 80), tall = between(14, 30);
		h.scale.set(w, tall, w);
		h.position.set(Math.cos(ang) * dist, tall * 0.18 - tall, Math.sin(ang) * dist);
		root.add(h);
	}

	// --- Treeline ----------------------------------------------------------
	// Low-poly conifers scattered in a band just outside the play circle, kept as
	// dark silhouettes so they frame the arena without colour. Shared geometry +
	// two near-black leaf materials, cloned per tree (cheap at this count).
	const trunkGeo = new CylinderGeometry(0.22, 0.34, 2.4, 6);
	const trunkMat = new MeshStandardMaterial({ color: C_TRUNK, roughness: 1, metalness: 0 });
	const leafGeo = new ConeGeometry(1.5, 3.2, 7);
	const leafMatA = new MeshStandardMaterial({ color: C_LEAF_A, roughness: 1, metalness: 0, flatShading: true });
	const leafMatB = new MeshStandardMaterial({ color: C_LEAF_B, roughness: 1, metalness: 0, flatShading: true });
	const TREES = 46;
	for (let i = 0; i < TREES; i++) {
		const ang = rand() * Math.PI * 2;
		const dist = between(playRadius + 6, playRadius + 60);
		const s = between(0.8, 1.7);
		const tree = new Group();
		const trunk = new Mesh(trunkGeo, trunkMat);
		trunk.position.y = 1.2; trunk.castShadow = true;
		tree.add(trunk);
		const tiers = rand() > 0.5 ? 3 : 2;
		for (let t = 0; t < tiers; t++) {
			const leaf = new Mesh(leafGeo, rand() > 0.5 ? leafMatA : leafMatB);
			leaf.position.y = 2.6 + t * 1.4;
			leaf.scale.setScalar(1 - t * 0.22);
			leaf.castShadow = true;
			tree.add(leaf);
		}
		tree.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
		tree.scale.setScalar(s);
		tree.rotation.y = rand() * Math.PI * 2;
		root.add(tree);
	}

	// A slow breathing pulse on the boundary ring is the only motion — subtle,
	// premium, and reduced-motion-safe (the amplitude is tiny). Tracked here so
	// update() stays a one-liner.
	let t = 0;
	return {
		update(dt) {
			t += dt;
			ring.material.opacity = 0.26 + Math.sin(t * 1.1) * 0.08;
		},
		dispose() {
			scene.remove(root);
			scene.background?.dispose?.();
			scene.background = null;
			scene.fog = null;
			root.traverse((n) => {
				if (n.isMesh || n.isLine) {
					n.geometry?.dispose?.();
					const mats = Array.isArray(n.material) ? n.material : [n.material];
					for (const m of mats) m?.dispose?.();
				}
			});
		},
	};
}
