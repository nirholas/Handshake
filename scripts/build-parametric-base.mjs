// Build the parametric avatar base: public/avatars/parametric-base.glb
//
// Bakes the CC0 MakeHuman/MPFB2 data vendored in avatar-sources/anny (base
// mesh + Mixamo-named rig + skin weights + sparse morph targets) into one
// rigged, morphable GLB:
//
//   - 4 skinned primitives (body, eyes, teeth, tongue) on a 52-bone
//     mixamorig:* skeleton, Y-up meters, feet on the floor, facing +Z. The
//     bone names canonicalize via src/glb-canonicalize.js, so the whole
//     pre-baked clip library plays through src/animation-retarget.js.
//   - A curated set of ~120 identity morphs (nose, ears, mouth, eyes, jaw,
//     cheeks, head shape, neck, body macros, torso, hips, arms, legs) baked
//     as sparse glTF morph targets. The Avatar Studio sculpt panel
//     (src/avatar-sculpt.js) discovers whatever the GLB exposes, so every
//     entry in MORPHS below becomes a working slider with zero UI changes.
//     L/R paired names (earScaleLeft/earScaleRight) collapse to one slider
//     under the panel's mirror lock.
//
// Run: node scripts/build-parametric-base.mjs
// Data provenance and license: avatar-sources/anny/README.md (all CC0).

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'avatar-sources/anny');
const OUT = resolve(ROOT, 'public/avatars/parametric-base.glb');

// MakeHuman units are decimeters; glTF wants meters.
const SCALE = 0.1;

/* ────────────────────────────────────────────────────────────────────────── *
 * Curated morph set. name → weighted recipe of .target files (region/file).
 * decr/incr target pairs become two 0..1 sliders (the sculpt panel has no
 * negative range). Macro sliders are linear blends of MakeHuman phenotype
 * targets (gender averaged where the trait itself is not gendered).
 * ────────────────────────────────────────────────────────────────────────── */

const M = (name, ...files) => ({
	name,
	files: files.map((f) => (Array.isArray(f) ? { file: f[0], scale: f[1] } : { file: f, scale: 1 })),
});

// L/R pair helper: expands to <root>Left + <root>Right from l-/r- target files.
const PAIR = (root, filePattern, ...extra) => [
	M(`${root}Left`, filePattern.replace('{s}', 'l'), ...extra.map((f) => f.replace('{s}', 'l'))),
	M(`${root}Right`, filePattern.replace('{s}', 'r'), ...extra.map((f) => f.replace('{s}', 'r'))),
];

const MACRO = 'macrodetails';
// Gender-averaged recipe entries: one target per gender at weight s each.
const g2 = (fn, s = 0.5) => ['female', 'male'].map((g) => [fn(g), s]);
// Ethnicity-averaged recipe entries: one target per ethnicity at weight s each.
const e3 = (fn, s = 1 / 3) => ['african', 'asian', 'caucasian'].map((e) => [fn(e), s]);

const MORPHS = [
	// Nose
	M('noseWider', 'nose/nose-scale-horiz-incr'),
	M('noseNarrower', 'nose/nose-scale-horiz-decr'),
	M('noseLonger', 'nose/nose-scale-vert-incr'),
	M('noseShorter', 'nose/nose-scale-vert-decr'),
	M('noseBigger', 'nose/nose-volume-incr'),
	M('noseSmaller', 'nose/nose-volume-decr'),
	M('noseTipUp', 'nose/nose-point-up'),
	M('noseTipDown', 'nose/nose-point-down'),
	M('noseHump', 'nose/nose-hump-incr'),
	M('noseConcave', 'nose/nose-curve-concave'),
	M('noseNostrilsWider', 'nose/nose-nostrils-width-incr'),
	M('noseNostrilsNarrower', 'nose/nose-nostrils-width-decr'),
	// Mouth
	M('mouthWider', 'mouth/mouth-scale-horiz-incr'),
	M('mouthNarrower', 'mouth/mouth-scale-horiz-decr'),
	M('mouthUpperLipFuller', 'mouth/mouth-upperlip-volume-incr'),
	M('mouthUpperLipThinner', 'mouth/mouth-upperlip-volume-decr'),
	M('mouthLowerLipFuller', 'mouth/mouth-lowerlip-volume-incr'),
	M('mouthLowerLipThinner', 'mouth/mouth-lowerlip-volume-decr'),
	M('mouthCornersUp', 'mouth/mouth-angles-up'),
	M('mouthCornersDown', 'mouth/mouth-angles-down'),
	M('mouthCupidsBow', 'mouth/mouth-cupidsbow-incr'),
	M('mouthDimples', 'mouth/mouth-dimples-in'),
	M('mouthForward', 'mouth/mouth-trans-forward'),
	M('mouthBackward', 'mouth/mouth-trans-backward'),
	// Ears (paired L/R sliders; mirror lock shows one slider per pair)
	...PAIR('earScale', 'ears/{s}-ear-scale-incr'),
	...PAIR('earSmaller', 'ears/{s}-ear-scale-decr'),
	...PAIR('earPointed', 'ears/{s}-ear-shape-pointed'),
	...PAIR('earLobeBigger', 'ears/{s}-ear-lobe-incr'),
	...PAIR('earWingOut', 'ears/{s}-ear-wing-incr'),
	...PAIR('earHigher', 'ears/{s}-ear-trans-up'),
	...PAIR('earLower', 'ears/{s}-ear-trans-down'),
	// Eye sockets (identity, distinct from the ARKit expression morphs)
	...PAIR('eyeBigger', 'eyes/{s}-eye-scale-incr'),
	...PAIR('eyeSmaller', 'eyes/{s}-eye-scale-decr'),
	...PAIR('eyeOuterUp', 'eyes/{s}-eye-corner2-up'),
	...PAIR('eyeOuterDown', 'eyes/{s}-eye-corner2-down'),
	...PAIR('eyeInward', 'eyes/{s}-eye-trans-in'),
	...PAIR('eyeOutward', 'eyes/{s}-eye-trans-out'),
	...PAIR('eyeBags', 'eyes/{s}-eye-bag-incr'),
	// Brows (bone structure, not expression)
	M('browsUp', 'eyebrows/eyebrows-trans-up'),
	M('browsDown', 'eyebrows/eyebrows-trans-down'),
	M('browsAngleUp', 'eyebrows/eyebrows-angle-up'),
	M('browsAngleDown', 'eyebrows/eyebrows-angle-down'),
	// Cheeks
	...PAIR('cheekBones', 'cheek/{s}-cheek-bones-incr'),
	...PAIR('cheekFuller', 'cheek/{s}-cheek-volume-incr'),
	...PAIR('cheekHollow', 'cheek/{s}-cheek-volume-decr'),
	// Jaw and chin
	M('jawWider', 'chin/chin-width-incr'),
	M('jawNarrower', 'chin/chin-width-decr'),
	M('jawChinLonger', 'chin/chin-height-incr'),
	M('jawChinShorter', 'chin/chin-height-decr'),
	M('jawChinPointed', 'chin/chin-triangle'),
	M('jawChinCleft', 'chin/chin-cleft-incr'),
	M('jawChinForward', 'chin/chin-prognathism-incr'),
	M('jawChinBack', 'chin/chin-prognathism-decr'),
	// Head shape
	M('headWider', 'head/head-scale-horiz-incr'),
	M('headNarrower', 'head/head-scale-horiz-decr'),
	M('headTaller', 'head/head-scale-vert-incr'),
	M('headShorter', 'head/head-scale-vert-decr'),
	M('headDeeper', 'head/head-scale-depth-incr'),
	M('headShallower', 'head/head-scale-depth-decr'),
	M('headRound', 'head/head-round'),
	M('headSquare', 'head/head-square'),
	M('headOval', 'head/head-oval'),
	M('foreheadRounder', 'forehead/forehead-nubian-incr'),
	M('foreheadFlatter', 'forehead/forehead-nubian-decr'),
	// Neck
	M('neckThicker', 'neck/neck-scale-horiz-incr', 'neck/neck-scale-depth-incr'),
	M('neckThinner', 'neck/neck-scale-horiz-decr', 'neck/neck-scale-depth-decr'),
	M('neckLonger', 'neck/neck-scale-vert-incr'),
	M('neckShorter', 'neck/neck-scale-vert-decr'),
	// Body macros (phenotype blends). The base mesh IS the neutral phenotype
	// (the universal avg-avg anchors are empty files), so gender comes from the
	// ethnicity-gender-age anchors averaged across ethnicities, and muscle/
	// weight come straight from the universal max/min anchors.
	M('bodyFeminine', ...e3((e) => `${MACRO}/${e}-female-young`)),
	M('bodyMasculine', ...e3((e) => `${MACRO}/${e}-male-young`)),
	M('bodyMuscular', ...g2((g) => `${MACRO}/universal-${g}-young-maxmuscle-averageweight`)),
	M('bodySofter', ...g2((g) => `${MACRO}/universal-${g}-young-minmuscle-averageweight`)),
	M('bodyHeavier', ...g2((g) => `${MACRO}/universal-${g}-young-averagemuscle-maxweight`)),
	M('bodyThinner', ...g2((g) => `${MACRO}/universal-${g}-young-averagemuscle-minweight`)),
	M(
		'bodyOlder',
		...e3((e) => `${MACRO}/${e}-female-old`, 1 / 6),
		...e3((e) => `${MACRO}/${e}-male-old`, 1 / 6),
		...e3((e) => `${MACRO}/${e}-female-young`, -1 / 6),
		...e3((e) => `${MACRO}/${e}-male-young`, -1 / 6),
	),
	M('heightTaller', ...g2((g) => `${MACRO}/height/${g}-young-averagemuscle-averageweight-maxheight`)),
	M('heightShorter', ...g2((g) => `${MACRO}/height/${g}-young-averagemuscle-averageweight-minheight`)),
	// Torso
	M('chestWider', 'torso/torso-scale-horiz-incr'),
	M('chestNarrower', 'torso/torso-scale-horiz-decr'),
	M('chestDeeper', 'torso/torso-scale-depth-incr'),
	M('chestVShape', 'torso/torso-vshape-incr'),
	M('chestPectorals', 'torso/torso-muscle-pectoral-incr'),
	M('waistWider', 'torso/measure-waist-circ-incr'),
	M('waistNarrower', 'torso/measure-waist-circ-decr'),
	M('bustBigger', 'torso/measure-bust-circ-incr'),
	M('bustSmaller', 'torso/measure-bust-circ-decr'),
	M('shouldersWider', 'torso/measure-shoulder-dist-incr'),
	M('shouldersNarrower', 'torso/measure-shoulder-dist-decr'),
	// Stomach, hips, glutes
	M('bellyBigger', 'stomach/stomach-pregnant-incr'),
	M('bellyToned', 'stomach/stomach-tone-incr'),
	M('hipsWider', 'hip/hip-scale-horiz-incr'),
	M('hipsNarrower', 'hip/hip-scale-horiz-decr'),
	M('gluteusBigger', 'buttocks/buttocks-volume-incr'),
	M('gluteusSmaller', 'buttocks/buttocks-volume-decr'),
	// Arms
	M(
		'armsMuscular',
		['arms/l-upperarm-muscle-incr', 1], ['arms/r-upperarm-muscle-incr', 1],
		['arms/l-lowerarm-muscle-incr', 1], ['arms/r-lowerarm-muscle-incr', 1],
		['arms/l-upperarm-shoulder-muscle-incr', 1], ['arms/r-upperarm-shoulder-muscle-incr', 1],
	),
	M(
		'armsThicker',
		['arms/l-upperarm-fat-incr', 1], ['arms/r-upperarm-fat-incr', 1],
		['arms/l-lowerarm-fat-incr', 1], ['arms/r-lowerarm-fat-incr', 1],
	),
	M(
		'armsThinner',
		['arms/l-upperarm-fat-decr', 1], ['arms/r-upperarm-fat-decr', 1],
		['arms/l-lowerarm-fat-decr', 1], ['arms/r-lowerarm-fat-decr', 1],
	),
	M('armsLonger', 'arms/measure-upperarm-length-incr', 'arms/measure-lowerarm-length-incr'),
	M('armsShorter', 'arms/measure-upperarm-length-decr', 'arms/measure-lowerarm-length-decr'),
	// Legs
	M('thighsThicker', ['legs/l-upperleg-fat-incr', 1], ['legs/r-upperleg-fat-incr', 1]),
	M('thighsThinner', ['legs/l-upperleg-fat-decr', 1], ['legs/r-upperleg-fat-decr', 1]),
	M('thighsMuscular', ['legs/l-upperleg-muscle-incr', 1], ['legs/r-upperleg-muscle-incr', 1]),
	M('calvesMuscular', ['legs/l-lowerleg-muscle-incr', 1], ['legs/r-lowerleg-muscle-incr', 1]),
	M('legsLonger', 'legs/upperlegs-height-incr', 'legs/lowerlegs-height-incr'),
	M('legsShorter', 'legs/upperlegs-height-decr', 'legs/lowerlegs-height-decr'),
];

/* ────────────────────────────────────────────────────────────────────────── *
 * OBJ parsing (positions in source space, faces per group, v/vt indexing)
 * ────────────────────────────────────────────────────────────────────────── */

function parseObj(text) {
	const positions = [];
	const uvs = [];
	const faces = []; // { group, corners: [[v, vt], ...] }
	let group = '';
	for (const line of text.split('\n')) {
		if (line.startsWith('v ')) {
			const [, x, y, z] = line.split(/\s+/);
			positions.push([+x, +y, +z]);
		} else if (line.startsWith('vt ')) {
			const [, u, v] = line.split(/\s+/);
			uvs.push([+u, +v]);
		} else if (line.startsWith('g ')) {
			group = line.slice(2).trim();
		} else if (line.startsWith('f ')) {
			const corners = line
				.slice(2)
				.trim()
				.split(/\s+/)
				.map((c) => {
					const [v, vt] = c.split('/');
					return [+v - 1, vt ? +vt - 1 : -1];
				});
			faces.push({ group, corners });
		}
	}
	return { positions, uvs, faces };
}

function loadTarget(relPath) {
	const raw = gunzipSync(readFileSync(resolve(SRC, 'targets', `${relPath}.target.gz`)));
	const deltas = new Map(); // origVertexIndex → [dx, dy, dz] in source units
	for (const line of raw.toString('utf8').split('\n')) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;
		const [i, dx, dy, dz] = t.split(/\s+/);
		deltas.set(+i, [+dx, +dy, +dz]);
	}
	return deltas;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Build
 * ────────────────────────────────────────────────────────────────────────── */

function main() {
	const obj = parseObj(readFileSync(resolve(SRC, '3dobjs/base.obj'), 'utf8'));
	const vertexGroups = JSON.parse(
		readFileSync(resolve(SRC, 'mesh_metadata/basemesh_vertex_groups.json'), 'utf8'),
	);
	const rig = JSON.parse(readFileSync(resolve(SRC, 'rigs/rig.mixamo.json'), 'utf8'));
	const weightsJson = JSON.parse(readFileSync(resolve(SRC, 'rigs/weights.mixamo.json'), 'utf8'));

	const groupRange = (name) => {
		const ranges = vertexGroups[name];
		if (!ranges) throw new Error(`vertex group missing: ${name}`);
		return ranges; // [[start, end], ...] inclusive
	};
	const groupCentroid = (name) => {
		let sx = 0;
		let sy = 0;
		let sz = 0;
		let n = 0;
		for (const [a, b] of groupRange(name)) {
			for (let i = a; i <= b; i++) {
				const [x, y, z] = obj.positions[i];
				sx += x;
				sy += y;
				sz += z;
				n++;
			}
		}
		return [sx / n, sy / n, sz / n];
	};

	// Floor: the joint-ground cube marks Y of the ground plane under the feet.
	const floorY = groupCentroid('joint-ground')[1] * SCALE;

	// Facing check: the nose must sit forward of the head centroid. MakeHuman
	// exports face +Z; assert rather than assume so a future data refresh that
	// flips convention fails loudly here instead of shipping backwards avatars.
	const mouthZ = groupCentroid('joint-mouth')[2];
	const headZ = groupCentroid('joint-head')[2];
	if (!(mouthZ > headZ)) throw new Error(`unexpected facing: mouth z ${mouthZ} <= head z ${headZ}`);

	const xform = ([x, y, z]) => [x * SCALE, y * SCALE - floorY, z * SCALE];

	/* Submeshes: OBJ group(s) → one skinned primitive each. */
	const SUBMESHES = [
		{ name: 'Body', groups: ['body'], color: [0.72, 0.42, 0.29, 1], rough: 0.85 },
		{ name: 'Eyes', groups: ['helper-l-eye', 'helper-r-eye'], color: [0.18, 0.12, 0.09, 1], rough: 0.25 },
		{ name: 'Teeth', groups: ['helper-upper-teeth', 'helper-lower-teeth'], color: [0.93, 0.91, 0.86, 1], rough: 0.4 },
		{ name: 'Tongue', groups: ['helper-tongue'], color: [0.66, 0.3, 0.28, 1], rough: 0.6 },
	];

	// Per-original-vertex skin influences from the per-bone weight lists.
	const boneNames = Object.keys(rig.bones);
	const boneIndex = new Map(boneNames.map((n, i) => [n, i]));
	const influences = new Map(); // origVertex → [[boneIdx, w], ...]
	for (const [bone, list] of Object.entries(weightsJson.weights)) {
		const bi = boneIndex.get(bone);
		if (bi === undefined) throw new Error(`weights reference unknown bone: ${bone}`);
		for (const [v, w] of list) {
			let arr = influences.get(v);
			if (!arr) influences.set(v, (arr = []));
			arr.push([bi, w]);
		}
	}

	// Resolve morph recipes to per-original-vertex deltas (source units).
	const targetCache = new Map();
	const getTarget = (file) => {
		if (!targetCache.has(file)) targetCache.set(file, loadTarget(file));
		return targetCache.get(file);
	};
	const morphDeltas = MORPHS.map(({ name, files }) => {
		const sum = new Map();
		for (const { file, scale } of files) {
			for (const [v, [dx, dy, dz]] of getTarget(file)) {
				const d = sum.get(v) || [0, 0, 0];
				d[0] += dx * scale;
				d[1] += dy * scale;
				d[2] += dz * scale;
				sum.set(v, d);
			}
		}
		if (!sum.size) throw new Error(`morph resolved to zero deltas: ${name}`);
		return { name, deltas: sum };
	});

	/* glTF document */
	const doc = new Document();
	doc.getRoot().getAsset().generator = 'three.ws build-parametric-base';
	const buffer = doc.createBuffer('data');
	const scene = doc.createScene('ParametricBase');
	const rootNode = doc.createNode('ParametricBase');
	scene.addChild(rootNode);

	// Skeleton: translation-only joints named exactly as the rig declares
	// (mixamorig:*). Bone head positions come from the mesh itself (MEAN of
	// vertex indices or centroid of a joint cube group), so rig and mesh agree
	// by construction. animation-retarget.js's world-delta bind correction
	// handles the identity orientations.
	const headOf = (bone) => {
		const h = bone.head;
		if (h.strategy === 'MEAN') {
			let sx = 0;
			let sy = 0;
			let sz = 0;
			for (const i of h.vertex_indices) {
				const [x, y, z] = obj.positions[i];
				sx += x;
				sy += y;
				sz += z;
			}
			const n = h.vertex_indices.length;
			return xform([sx / n, sy / n, sz / n]);
		}
		if (h.strategy === 'CUBE') return xform(groupCentroid(h.cube_name));
		throw new Error(`unknown joint strategy ${h.strategy}`);
	};

	const jointWorld = new Map(boneNames.map((n) => [n, headOf(rig.bones[n])]));
	const nodes = new Map();
	for (const name of boneNames) nodes.set(name, doc.createNode(name));
	for (const name of boneNames) {
		const parent = rig.bones[name].parent;
		const world = jointWorld.get(name);
		const parentWorld = parent && jointWorld.has(parent) ? jointWorld.get(parent) : [0, 0, 0];
		nodes.get(name).setTranslation([
			world[0] - parentWorld[0],
			world[1] - parentWorld[1],
			world[2] - parentWorld[2],
		]);
		if (parent && nodes.has(parent)) nodes.get(parent).addChild(nodes.get(name));
		else rootNode.addChild(nodes.get(name));
	}

	const ibm = new Float32Array(boneNames.length * 16);
	boneNames.forEach((name, i) => {
		const [x, y, z] = jointWorld.get(name);
		const o = i * 16;
		ibm[o] = 1;
		ibm[o + 5] = 1;
		ibm[o + 10] = 1;
		ibm[o + 15] = 1;
		ibm[o + 12] = -x;
		ibm[o + 13] = -y;
		ibm[o + 14] = -z;
	});
	const ibmAccessor = doc
		.createAccessor('ibm')
		.setType('MAT4')
		.setArray(ibm)
		.setBuffer(buffer);
	const skin = doc.createSkin('ParametricSkin').setInverseBindMatrices(ibmAccessor);
	for (const name of boneNames) skin.addJoint(nodes.get(name));
	skin.setSkeleton(nodes.get(boneNames.find((n) => !rig.bones[n].parent) || 'mixamorig:Hips'));

	const stats = [];
	for (const sub of SUBMESHES) {
		const wanted = new Set(sub.groups);
		// Assemble unique (v, vt) output vertices and triangulated indices.
		const outIndexOf = new Map();
		const origIndex = [];
		const pos = [];
		const uv = [];
		const indices = [];
		const cornerIndex = ([v, vt]) => {
			const key = `${v}/${vt}`;
			let idx = outIndexOf.get(key);
			if (idx === undefined) {
				idx = origIndex.length;
				outIndexOf.set(key, idx);
				origIndex.push(v);
				pos.push(...xform(obj.positions[v]));
				const t = vt >= 0 ? obj.uvs[vt] : [0, 0];
				uv.push(t[0], 1 - t[1]);
			}
			return idx;
		};
		for (const face of obj.faces) {
			if (!wanted.has(face.group)) continue;
			const c = face.corners.map(cornerIndex);
			for (let i = 2; i < c.length; i++) indices.push(c[0], c[i - 1], c[i]);
		}
		if (!indices.length) throw new Error(`submesh has no faces: ${sub.name}`);
		const count = origIndex.length;

		// Smooth normals from triangle accumulation.
		const normal = new Float32Array(count * 3);
		for (let i = 0; i < indices.length; i += 3) {
			const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
			const ax = pos[a * 3];
			const ay = pos[a * 3 + 1];
			const az = pos[a * 3 + 2];
			const ux = pos[b * 3] - ax;
			const uy = pos[b * 3 + 1] - ay;
			const uz = pos[b * 3 + 2] - az;
			const vx = pos[c * 3] - ax;
			const vy = pos[c * 3 + 1] - ay;
			const vz = pos[c * 3 + 2] - az;
			const nx = uy * vz - uz * vy;
			const ny = uz * vx - ux * vz;
			const nz = ux * vy - uy * vx;
			for (const k of [a, b, c]) {
				normal[k * 3] += nx;
				normal[k * 3 + 1] += ny;
				normal[k * 3 + 2] += nz;
			}
		}
		for (let i = 0; i < count; i++) {
			const nx = normal[i * 3];
			const ny = normal[i * 3 + 1];
			const nz = normal[i * 3 + 2];
			const len = Math.hypot(nx, ny, nz) || 1;
			normal[i * 3] = nx / len;
			normal[i * 3 + 1] = ny / len;
			normal[i * 3 + 2] = nz / len;
		}

		// Skinning attributes: top-4 influences, renormalized.
		const joints = new Uint16Array(count * 4);
		const weights = new Float32Array(count * 4);
		for (let i = 0; i < count; i++) {
			const inf = (influences.get(origIndex[i]) || []).slice().sort((a, b) => b[1] - a[1]).slice(0, 4);
			const total = inf.reduce((s, [, w]) => s + w, 0);
			if (!total) throw new Error(`unweighted vertex ${origIndex[i]} in ${sub.name}`);
			inf.forEach(([bi, w], k) => {
				joints[i * 4 + k] = bi;
				weights[i * 4 + k] = w / total;
			});
		}

		const material = doc
			.createMaterial(`Parametric_${sub.name}`)
			.setBaseColorFactor(sub.color)
			.setMetallicFactor(0)
			.setRoughnessFactor(sub.rough);

		const acc = (name, type, array, extra = {}) => {
			const a = doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);
			if (extra.sparse) a.setSparse(true);
			return a;
		};
		const prim = doc
			.createPrimitive()
			.setIndices(acc(`${sub.name}-idx`, 'SCALAR', new Uint32Array(indices)))
			.setAttribute('POSITION', acc(`${sub.name}-pos`, 'VEC3', new Float32Array(pos)))
			.setAttribute('NORMAL', acc(`${sub.name}-nrm`, 'VEC3', normal))
			.setAttribute('TEXCOORD_0', acc(`${sub.name}-uv`, 'VEC2', new Float32Array(uv)))
			.setAttribute('JOINTS_0', acc(`${sub.name}-jnt`, 'VEC4', joints))
			.setAttribute('WEIGHTS_0', acc(`${sub.name}-wgt`, 'VEC4', weights))
			.setMaterial(material);

		// Morph targets: only those touching this submesh, as sparse accessors.
		const targetNames = [];
		for (const { name, deltas } of morphDeltas) {
			let touched = 0;
			const arr = new Float32Array(count * 3);
			for (let i = 0; i < count; i++) {
				const d = deltas.get(origIndex[i]);
				if (!d) continue;
				arr[i * 3] = d[0] * SCALE;
				arr[i * 3 + 1] = d[1] * SCALE;
				arr[i * 3 + 2] = d[2] * SCALE;
				touched++;
			}
			if (!touched) continue;
			const target = doc
				.createPrimitiveTarget(name)
				.setAttribute('POSITION', acc(`${sub.name}-m-${name}`, 'VEC3', arr, { sparse: true }));
			prim.addTarget(target);
			targetNames.push(name);
		}

		const mesh = doc.createMesh(sub.name).addPrimitive(prim);
		if (targetNames.length) {
			mesh.setWeights(new Array(targetNames.length).fill(0));
			mesh.setExtras({ targetNames });
		}
		const meshNode = doc.createNode(sub.name).setMesh(mesh).setSkin(skin);
		rootNode.addChild(meshNode);
		stats.push({ name: sub.name, verts: count, tris: indices.length / 3, morphs: targetNames.length });
	}

	const io = new NodeIO();
	io.write(OUT, doc).then(() => {
		const size = statSync(OUT).size;
		console.log(`wrote ${OUT} (${(size / 1024 / 1024).toFixed(2)} MB)`);
		console.log(` joints: ${boneNames.length}, morph sliders: ${MORPHS.length}`);
		for (const s of stats) console.log(` ${s.name}: ${s.verts} verts, ${s.tris} tris, ${s.morphs} morphs`);
		const hips = jointWorld.get('mixamorig:Hips');
		console.log(` hips rest height: ${hips[1].toFixed(3)} m`);
		if (size > 8 * 1024 * 1024) throw new Error('output unexpectedly large; check sparse encoding');
	});
}

main();
