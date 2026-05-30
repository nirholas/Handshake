// World environment — a distinct, living biome for every coin community.
//
// The lobby/landing stays monochrome by design, but the moment a player drops
// into a world it should feel alive AND feel like *this* community's place.
// Two coins should never share a skin. We hash the coin's mint into a stable
// seed, pick one of several biome archetypes from it (meadow, desert, tundra,
// volcanic, alien, tropical), then jitter that biome's palette and scatter its
// vegetation from the same seed — so a given coin always renders the same world,
// and a thousand coins render a thousand recognisably different ones.
//
// Colour does the heavy lifting here — the monochrome restraint is the lobby's
// job, not the world's. Everything decorative sits OUTSIDE the playRadius circle
// so it frames the space without ever blocking a player. Geometry is low-poly
// and shared/cloned, so the whole environment is cheap enough to run alongside
// the avatars and their shadows. The scene file creates it once per community
// and ticks update(dt).

import {
	Color, Fog, Group, Vector3, MathUtils, DoubleSide, SRGBColorSpace,
	HemisphereLight, DirectionalLight, AmbientLight,
	Mesh, MeshStandardMaterial, MeshBasicMaterial,
	CircleGeometry, RingGeometry, CylinderGeometry, ConeGeometry, IcosahedronGeometry,
	GridHelper, CanvasTexture,
} from 'three';

// FNV-1a hash → a stable 32-bit seed from a coin mint (or any string). Identical
// input always yields the identical world; no Math.random in the layout path.
export function seedFromString(str) {
	let h = 2166136261 >>> 0;
	const s = String(str || 'three-ws');
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// A seeded LCG so a community's treeline/hill/prop layout is identical on every
// load (stable demos, no first-frame reshuffle) without touching Math.random.
function rng(seed) {
	let s = seed >>> 0;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

// --- Biome archetypes ------------------------------------------------------
// Each entry is a complete mood: graded sky, atmospheric fog, a key/fill light
// rig, ground + plaza + accent palette, and which flora the band outside the
// arena is planted with. The mint's seed picks one of these, then a per-coin
// hue jitter (below) shifts it so two coins in the same biome still read apart.
const BIOMES = [
	{
		id: 'meadow', label: 'Verdant Meadow',
		sky: ['#2f6fd0', '#7fb4ec', '#eaf2ff'], fog: '#cfe0f4', fogNear: 90, fogFar: 340,
		hemi: [0xbfd8ff, 0x4a6b3a, 0.75], ambient: 0.25,
		sun: { color: 0xfff2d0, intensity: 2.1, elevation: 48, azimuth: 135 },
		ground: 0x4f9d5b, plaza: 0xcdb892, grid: 0x8f7f5e, ring: 0x4ea8ff,
		hill: 0x6f9f86, trunk: 0x6b4a2f, leafA: 0x3f8a49, leafB: 0x57ab60,
		flora: 'conifer', density: 46,
	},
	{
		id: 'desert', label: 'Dune Sea',
		sky: ['#3b7bc4', '#c9a86a', '#f6e6c4'], fog: '#ead8b0', fogNear: 80, fogFar: 320,
		hemi: [0xffe7bf, 0xb98a4a, 0.85], ambient: 0.3,
		sun: { color: 0xffe1a8, intensity: 2.4, elevation: 58, azimuth: 110 },
		ground: 0xd9b878, plaza: 0xc9a25e, grid: 0xa07c44, ring: 0xff9a3c,
		hill: 0xcaa569, trunk: 0x3f7a44, leafA: 0x4f9a52, leafB: 0x5fae5a,
		flora: 'cactus', density: 26,
	},
	{
		id: 'tundra', label: 'Frostfields',
		sky: ['#5b7fb0', '#bcd3ea', '#f2f7fb'], fog: '#dfeaf4', fogNear: 70, fogFar: 300,
		hemi: [0xdfeeff, 0x9fb0c2, 0.8], ambient: 0.35,
		sun: { color: 0xeaf2ff, intensity: 1.9, elevation: 32, azimuth: 150 },
		ground: 0xe7eef5, plaza: 0xcfd9e2, grid: 0x9fb0bf, ring: 0x7fd4ff,
		hill: 0xc9d6e2, trunk: 0x4a3f33, leafA: 0xdfe9f2, leafB: 0xcdd9e6,
		flora: 'snowpine', density: 40,
	},
	{
		id: 'volcanic', label: 'Ashen Caldera',
		sky: ['#3a1f2a', '#7a3322', '#d65a2e'], fog: '#5a2a22', fogNear: 60, fogFar: 280,
		hemi: [0xff8a5a, 0x2a1410, 0.55], ambient: 0.22,
		sun: { color: 0xff7a3a, intensity: 1.7, elevation: 22, azimuth: 200 },
		ground: 0x2a2424, plaza: 0x3a2e2c, grid: 0x6a3a2a, ring: 0xff5a2a,
		hill: 0x352828, trunk: 0x241c18, leafA: 0x140e0c, leafB: 0x1c1410,
		flora: 'deadtree', density: 34,
	},
	{
		id: 'alien', label: 'Neon Expanse',
		sky: ['#1a0f3a', '#5a2a8a', '#c25ad6'], fog: '#3a1f6a', fogNear: 70, fogFar: 320,
		hemi: [0xc59aff, 0x2a1a5a, 0.7], ambient: 0.28,
		sun: { color: 0xc8a0ff, intensity: 1.8, elevation: 40, azimuth: 160 },
		ground: 0x3a2a6a, plaza: 0x2e2456, grid: 0x6a4ab0, ring: 0x2af0e0,
		hill: 0x4a3a8a, trunk: 0x6a4ab0, leafA: 0x2af0e0, leafB: 0xff5ad0,
		flora: 'crystal', density: 30,
	},
	{
		id: 'tropical', label: 'Lagoon Shore',
		sky: ['#1f9fd0', '#7fdce8', '#eafbff'], fog: '#cdeef4', fogNear: 90, fogFar: 340,
		hemi: [0xcdf4ff, 0x3a8a7a, 0.8], ambient: 0.3,
		sun: { color: 0xfff4d8, intensity: 2.2, elevation: 52, azimuth: 120 },
		ground: 0x2fb89a, plaza: 0xe6d8a8, grid: 0xb8a878, ring: 0x2ad0ff,
		hill: 0x3fae9a, trunk: 0x7a5a36, leafA: 0x3f9a54, leafB: 0x5fbf66,
		flora: 'palm', density: 30,
	},
];

// Map any seed to a biome. Exposed so the UI can name the world the player is in.
export function biomeForSeed(seed) {
	return BIOMES[(seed >>> 3) % BIOMES.length];
}

// Look up a biome by its archetype id (e.g. a curated world that pins its look
// instead of drawing it from the mint seed). Returns null for an unknown id so
// the caller can fall back to the seeded pick.
export function biomeById(id) {
	return BIOMES.find((b) => b.id === id) || null;
}

// A vertical gradient backdrop, rendered as the scene background so it's immune
// to fog and never rotates with the orbit camera — a clean graded sky per biome.
function gradientSky(top, mid, horizon) {
	const c = document.createElement('canvas');
	c.width = 4; c.height = 256;
	const x = c.getContext('2d');
	const g = x.createLinearGradient(0, 0, 0, 256);
	g.addColorStop(0, top);
	g.addColorStop(0.55, mid);
	g.addColorStop(1, horizon);
	x.fillStyle = g; x.fillRect(0, 0, 4, 256);
	const tex = new CanvasTexture(c);
	tex.colorSpace = SRGBColorSpace;
	return tex;
}

// Per-coin hue jitter: nudge a base hex around the colour wheel + lightness so
// two communities sharing a biome still feel distinct. Natural biomes get a
// gentle shift; the accent ring gets a wider one so it clearly differs per coin.
function jitter(hex, rand, hueAmt = 0.06, litAmt = 0.06) {
	return new Color(hex).offsetHSL((rand() - 0.5) * 2 * hueAmt, 0, (rand() - 0.5) * 2 * litAmt);
}

// --- Flora builders --------------------------------------------------------
// Each returns a Group positioned at origin; the caller scatters/scales it. They
// share geometry/material passed in so a whole treeline is a handful of buffers.

function makeConifer(g, mats, rand, snow = false) {
	const trunk = new Mesh(g.trunk, mats.trunk);
	trunk.position.y = 1.2; trunk.castShadow = true;
	const tree = new Group(); tree.add(trunk);
	const tiers = rand() > 0.5 ? 3 : 2;
	for (let t = 0; t < tiers; t++) {
		const leaf = new Mesh(g.leaf, rand() > 0.5 ? mats.leafA : mats.leafB);
		leaf.position.y = 2.6 + t * 1.4;
		leaf.scale.setScalar(1 - t * 0.22);
		leaf.castShadow = true;
		tree.add(leaf);
	}
	if (snow) tree.scale.y *= 1.05;
	return tree;
}

function makeCactus(g, mats, rand) {
	const cactus = new Group();
	const body = new Mesh(g.cactus, mats.leafA);
	body.position.y = 1.6; body.castShadow = true;
	cactus.add(body);
	const arms = rand() > 0.4 ? 2 : 1;
	for (let i = 0; i < arms; i++) {
		const arm = new Mesh(g.cactusArm, rand() > 0.5 ? mats.leafA : mats.leafB);
		const side = i === 0 ? 1 : -1;
		arm.position.set(side * 0.62, 1.6 + rand() * 0.7, 0);
		arm.rotation.z = side * 0.5;
		arm.castShadow = true;
		cactus.add(arm);
	}
	return cactus;
}

function makeDeadtree(g, mats, rand) {
	const tree = new Group();
	const trunk = new Mesh(g.deadTrunk, mats.trunk);
	trunk.position.y = 1.7; trunk.castShadow = true;
	tree.add(trunk);
	const branches = 2 + Math.floor(rand() * 3);
	for (let i = 0; i < branches; i++) {
		const b = new Mesh(g.branch, mats.trunk);
		b.position.y = 1.8 + rand() * 1.4;
		b.rotation.z = (rand() - 0.5) * 1.6;
		b.rotation.y = rand() * Math.PI * 2;
		b.castShadow = true;
		tree.add(b);
	}
	return tree;
}

function makeCrystal(g, mats, rand) {
	const cluster = new Group();
	const shards = 1 + Math.floor(rand() * 3);
	for (let i = 0; i < shards; i++) {
		const shard = new Mesh(g.crystal, rand() > 0.5 ? mats.leafA : mats.leafB);
		const h = 2.4 + rand() * 3.4;
		shard.scale.set(0.5 + rand() * 0.5, h, 0.5 + rand() * 0.5);
		shard.position.set((rand() - 0.5) * 1.6, h * 0.5, (rand() - 0.5) * 1.6);
		shard.rotation.y = rand() * Math.PI;
		shard.castShadow = true;
		cluster.add(shard);
	}
	return cluster;
}

function makePalm(g, mats, rand) {
	const palm = new Group();
	const lean = (rand() - 0.5) * 0.4;
	const trunk = new Mesh(g.palmTrunk, mats.trunk);
	trunk.position.y = 2.6; trunk.rotation.z = lean; trunk.castShadow = true;
	palm.add(trunk);
	const crown = new Group();
	crown.position.set(Math.sin(lean) * -5.2, 5.2, 0);
	const fronds = 6 + Math.floor(rand() * 3);
	for (let i = 0; i < fronds; i++) {
		const frond = new Mesh(g.frond, rand() > 0.5 ? mats.leafA : mats.leafB);
		frond.rotation.y = (i / fronds) * Math.PI * 2;
		frond.rotation.z = 0.9;
		frond.position.y = 0.1;
		frond.castShadow = true;
		crown.add(frond);
	}
	palm.add(crown);
	return palm;
}

export function createWorldEnvironment(scene, renderer, playRadius = 58, opts = {}) {
	const seed = (typeof opts.seed === 'number' ? opts.seed : seedFromString(opts.mint)) >>> 0;
	// A curated world can pin its archetype by id; everyone else draws theirs from
	// the mint seed. The per-coin palette jitter below still runs off the seed, so
	// even a pinned biome keeps a touch of this coin's own colour.
	const biome = (opts.biome && biomeById(opts.biome)) || biomeForSeed(seed);
	const root = new Group();
	scene.add(root);
	const rand = rng(seed || 0x3d3d3d);
	const between = (a, b) => a + (b - a) * rand();
	const animators = [];

	// --- Sky + atmosphere --------------------------------------------------
	scene.background = gradientSky(biome.sky[0], biome.sky[1], biome.sky[2]);
	scene.fog = new Fog(new Color(biome.fog), biome.fogNear, biome.fogFar);

	// --- Lighting ----------------------------------------------------------
	// One key sun (casts the long shadows), a sky/ground hemisphere fill, and a
	// touch of ambient so shadowed geometry never goes muddy. All biome-tuned.
	root.add(new HemisphereLight(biome.hemi[0], biome.hemi[1], biome.hemi[2]));
	root.add(new AmbientLight(0xffffff, biome.ambient));

	const sun = new Vector3();
	sun.setFromSphericalCoords(1, MathUtils.degToRad(90 - biome.sun.elevation), MathUtils.degToRad(biome.sun.azimuth));
	const sunLight = new DirectionalLight(biome.sun.color, biome.sun.intensity);
	sunLight.position.copy(sun).multiplyScalar(120);
	sunLight.castShadow = true;
	sunLight.shadow.mapSize.set(2048, 2048);
	const sc = sunLight.shadow.camera;
	sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
	sunLight.shadow.bias = -0.0004;
	root.add(sunLight, sunLight.target);

	// --- Palette (per-coin jitter over the biome base) ---------------------
	const cGround = jitter(biome.ground, rand);
	const cPlaza = jitter(biome.plaza, rand, 0.04, 0.04);
	const cHill = jitter(biome.hill, rand);
	const cRing = jitter(biome.ring, rand, 0.12, 0.04);

	// --- Ground ------------------------------------------------------------
	const field = new Mesh(new CircleGeometry(400, 64),
		new MeshStandardMaterial({ color: cGround, roughness: 1, metalness: 0 }));
	field.rotation.x = -Math.PI / 2; field.receiveShadow = true;
	root.add(field);

	const plaza = new Mesh(new CircleGeometry(playRadius, 64),
		new MeshStandardMaterial({ color: cPlaza, roughness: 1, metalness: 0 }));
	plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.01; plaza.receiveShadow = true;
	root.add(plaza);

	// Faint paving grid over the plaza — a sense of scale that the haze fades.
	const grid = new GridHelper(playRadius * 2, 30, biome.grid, biome.grid);
	grid.position.y = 0.02;
	grid.material.transparent = true;
	grid.material.opacity = 0.18;
	grid.material.depthWrite = false;
	root.add(grid);

	// Glowing boundary hairline — the bright accent ring around the plaza, the
	// most per-coin-distinct colour in the scene.
	const ring = new Mesh(new RingGeometry(playRadius - 0.12, playRadius + 0.12, 128),
		new MeshBasicMaterial({ color: cRing, transparent: true, opacity: 0.55, side: DoubleSide }));
	ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
	root.add(ring);

	// --- Distant hills -----------------------------------------------------
	// A ring of broad, low mounds beyond the flora gives the horizon depth,
	// hazing into the biome's sky seam.
	const hillGeo = new IcosahedronGeometry(1, 1);
	const hillMat = new MeshStandardMaterial({ color: cHill, roughness: 1, metalness: 0, flatShading: true });
	for (let i = 0; i < 14; i++) {
		const ang = (i / 14) * Math.PI * 2 + between(-0.12, 0.12);
		const dist = between(150, 210);
		const h = new Mesh(hillGeo, hillMat);
		const w = between(45, 80), tall = between(14, 30);
		h.scale.set(w, tall, w);
		h.position.set(Math.cos(ang) * dist, tall * 0.18 - tall, Math.sin(ang) * dist);
		root.add(h);
	}

	// --- Flora -------------------------------------------------------------
	// Shared geometry + materials; one builder per biome scatters them in a band
	// just outside the play circle. Two leaf tones per biome give natural variety.
	const cLeafA = jitter(biome.leafA, rand, 0.05, 0.05);
	const cLeafB = jitter(biome.leafB, rand, 0.05, 0.05);
	const neon = biome.flora === 'crystal';
	const mats = {
		trunk: new MeshStandardMaterial({ color: jitter(biome.trunk, rand, 0.03, 0.04), roughness: 1, metalness: 0 }),
		leafA: new MeshStandardMaterial({ color: cLeafA, roughness: neon ? 0.3 : 1, metalness: 0, flatShading: true, emissive: neon ? cLeafA : 0x000000, emissiveIntensity: neon ? 0.6 : 0 }),
		leafB: new MeshStandardMaterial({ color: cLeafB, roughness: neon ? 0.3 : 1, metalness: 0, flatShading: true, emissive: neon ? cLeafB : 0x000000, emissiveIntensity: neon ? 0.6 : 0 }),
	};
	const geo = {
		trunk: new CylinderGeometry(0.22, 0.34, 2.4, 6),
		leaf: new ConeGeometry(1.5, 3.2, 7),
		cactus: new CylinderGeometry(0.5, 0.6, 3.2, 8),
		cactusArm: new CylinderGeometry(0.26, 0.3, 1.6, 7),
		deadTrunk: new CylinderGeometry(0.18, 0.3, 3.4, 6),
		branch: new CylinderGeometry(0.08, 0.14, 1.6, 5),
		crystal: new ConeGeometry(0.6, 1, 5),
		palmTrunk: new CylinderGeometry(0.22, 0.36, 5.2, 7),
		frond: new ConeGeometry(0.5, 3.4, 4),
	};
	const builder = {
		conifer: makeConifer, snowpine: (g, m, r) => makeConifer(g, m, r, true),
		cactus: makeCactus, deadtree: makeDeadtree, crystal: makeCrystal, palm: makePalm,
	}[biome.flora] || makeConifer;

	const crystals = [];
	for (let i = 0; i < biome.density; i++) {
		const ang = rand() * Math.PI * 2;
		const dist = between(playRadius + 6, playRadius + 60);
		const s = between(0.8, 1.7);
		const plant = builder(geo, mats, rand);
		plant.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
		plant.scale.multiplyScalar(s);
		plant.rotation.y = rand() * Math.PI * 2;
		root.add(plant);
		if (neon) crystals.push(plant);
	}
	// Alien crystals breathe with a faint emissive shimmer — biome-specific life.
	if (crystals.length) {
		animators.push((t) => {
			const k = 0.45 + Math.sin(t * 0.8) * 0.25;
			mats.leafA.emissiveIntensity = 0.4 + k * 0.4;
			mats.leafB.emissiveIntensity = 0.4 + (1 - k) * 0.4;
		});
	}

	// --- Live-market reactivity --------------------------------------------
	// The boundary ring is the world's heartbeat: a slow breathing pulse is the
	// baseline, but a trade can kick it to a colour (green on a buy, red on a
	// sell) that decays back to the per-coin accent — so the arena visibly
	// flinches with the on-chain tape. The market-reactor drives flashRing().
	const baseRing = cRing.clone();
	const flashColor = new Color();
	let flash = 0; // 0..1, decays each frame
	animators.push((t, dt) => {
		flash = Math.max(0, flash - dt * 1.7); // ~0.6s to settle
		ring.material.opacity = 0.48 + Math.sin(t * 1.1) * 0.1 + flash * 0.5;
		ring.material.color.copy(baseRing).lerp(flashColor, flash);
	});

	// Mood is the slow weather: the rolling % change pushes the world between a
	// storm (fog closes in, the key dims) and euphoria (fog opens out, the sun
	// flares). We lerp toward the target so a jumpy feed reads as a tide, not a
	// strobe. Baselines are captured so every community settles back to its own.
	const baseFogNear = biome.fogNear, baseFogFar = biome.fogFar;
	const baseSun = biome.sun.intensity;
	let mood = 0, moodTarget = 0; // -1 storm … +1 euphoric
	animators.push((t, dt) => {
		mood += (moodTarget - mood) * Math.min(1, dt * 0.6);
		scene.fog.near = baseFogNear * (1 + mood * 0.18);
		scene.fog.far = baseFogFar * (1 + mood * 0.28);
		sunLight.intensity = baseSun * (1 + mood * 0.22);
	});

	let t = 0;
	return {
		biome,
		seed,
		// Kick the boundary ring to a colour. strength 0..1 sets the flash
		// intensity; it decays back to the coin's accent within ~0.6s.
		flashRing(color, strength = 0.6) {
			const s = Math.max(0, Math.min(1, strength));
			if (s <= flash) return; // don't let a small trade stomp a bigger one mid-decay
			flash = s;
			flashColor.set(color);
		},
		// Set the weather target from a signed intensity (−1 storm … +1 euphoric).
		setMood(target) {
			moodTarget = Math.max(-1, Math.min(1, target || 0));
		},
		update(dt) {
			t += dt;
			for (const a of animators) a(t, dt);
		},
		dispose() {
			scene.remove(root);
			scene.background?.dispose?.();
			scene.background = null;
			scene.fog = null;
			root.traverse((n) => {
				if (n.isMesh || n.isLine) {
					n.geometry?.dispose?.();
					const ms = Array.isArray(n.material) ? n.material : [n.material];
					for (const m of ms) m?.dispose?.();
				}
			});
		},
	};
}
