// Shared material palette for the Machine Atlas.
//
// One palette across both machines is what makes them read as one collection.
// Values are physically plausible (roughness/metalness, not hand-tuned tints)
// so the same set survives a lighting change without a re-grade.

import * as THREE from 'three';

const cache = new Map();

function mat(name, params) {
	if (cache.has(name)) return cache.get(name);
	const m = new THREE.MeshStandardMaterial({ name, ...params });
	cache.set(name, m);
	return m;
}

export const MATERIALS = {
	// Machined steel: bright, tight highlight. Rods, pins, guide bars.
	get steel() {
		return mat('steel', { color: 0xb9bdc4, metalness: 0.95, roughness: 0.24 });
	},
	// Sand-cast aluminium: the crankcase and cylinder heads.
	get castAlloy() {
		return mat('castAlloy', { color: 0x9aa0a6, metalness: 0.72, roughness: 0.58 });
	},
	// Grey iron: cylinder barrels, wheel centres.
	get castIron() {
		return mat('castIron', { color: 0x4c5257, metalness: 0.62, roughness: 0.7 });
	},
	get brass() {
		return mat('brass', { color: 0xc9a447, metalness: 0.95, roughness: 0.3 });
	},
	get copper() {
		return mat('copper', { color: 0xb87333, metalness: 0.95, roughness: 0.34 });
	},
	// Boiler cladding and bodywork: the only painted surfaces on the atlas.
	get paintDark() {
		return mat('paintDark', { color: 0x1d2427, metalness: 0.2, roughness: 0.45 });
	},
	get paintRed() {
		return mat('paintRed', { color: 0x7c2b22, metalness: 0.2, roughness: 0.5 });
	},
	get graphite() {
		return mat('graphite', { color: 0x2a2d30, metalness: 0.55, roughness: 0.62 });
	},
	get timber() {
		return mat('timber', { color: 0x6b5745, metalness: 0.02, roughness: 0.88 });
	},
	get ballast() {
		return mat('ballast', { color: 0x55585c, metalness: 0.05, roughness: 0.95 });
	},
	get glass() {
		return mat('glass', {
			color: 0xa8c6cf,
			metalness: 0.1,
			roughness: 0.08,
			transparent: true,
			opacity: 0.32,
		});
	},
};

// The wireframe overlay used by the "structure" view: one shared material so
// toggling it costs a single uniform change, not a per-part rebuild.
export function ghostMaterial() {
	return mat('ghost', {
		color: 0x7fd4ff,
		wireframe: true,
		transparent: true,
		opacity: 0.22,
		metalness: 0,
		roughness: 1,
	});
}

// Machines own their geometry but never their materials, so a rebuild frees
// only what it allocated.
export function disposeTree(root) {
	root.traverse((o) => {
		if (o.isMesh && o.geometry) o.geometry.dispose();
	});
}
