#!/usr/bin/env node
// Procedural accessory GLB generator.
//
// Builds the small GLB files worn on an avatar's Head bone. Seven are the
// character-studio presets in public/accessories/presets.json:
//   hat-baseball.glb, hat-beanie.glb, hat-cowboy.glb,
//   glasses-round.glb, glasses-shades.glb,
//   earrings-hoops.glb, earrings-studs.glb
// One more is the /play wardrobe's event souvenir (multiplayer/src/
// cosmetics-catalog.js, tier 'event'), which is granted, never sold:
//   laurel-meetup.glb
//
// Each is a real glTF 2.0 binary with positions, normals, UVs, indices, and a
// PBR material — small enough to commit to the repo, large enough to be visibly
// correct when attached to a humanoid avatar's Head bone.
//
// Coordinates are in meters, oriented for a head bone whose +Y is up and +Z is
// forward (the standard glTF convention). The Head bone sits at the top of the
// neck; these meshes are offset to sit naturally on top of / in front of /
// beside it.
//
// Run with: node scripts/generate-accessory-glbs.mjs
// One file only (leaves every other committed GLB byte-for-byte untouched):
//   node scripts/generate-accessory-glbs.mjs laurel-meetup.glb

import { Document, NodeIO } from '@gltf-transform/core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'public', 'accessories');

// ── Geometry primitives ────────────────────────────────────────────────────

// Tessellated half-sphere ("dome") of radius r, sliced at y = 0.
function halfSphere({ r = 1, segments = 16, rings = 8, yOffset = 0 } = {}) {
	const positions = [];
	const normals = [];
	const uvs = [];
	const indices = [];

	for (let i = 0; i <= rings; i++) {
		const v = i / rings;
		const phi = v * (Math.PI / 2); // 0 (top) → π/2 (equator)
		for (let j = 0; j <= segments; j++) {
			const u = j / segments;
			const theta = u * Math.PI * 2;
			const x = r * Math.sin(phi) * Math.cos(theta);
			const y = r * Math.cos(phi) + yOffset;
			const z = r * Math.sin(phi) * Math.sin(theta);
			positions.push(x, y, z);
			const nLen = Math.hypot(x, y - yOffset, z) || 1;
			normals.push(x / nLen, (y - yOffset) / nLen, z / nLen);
			uvs.push(u, 1 - v);
		}
	}

	const stride = segments + 1;
	for (let i = 0; i < rings; i++) {
		for (let j = 0; j < segments; j++) {
			const a = i * stride + j;
			const b = a + stride;
			indices.push(a, b, a + 1, b, b + 1, a + 1);
		}
	}
	return { positions, normals, uvs, indices };
}

// Solid cylinder of radius r between y=y0 and y=y1. side + caps.
function cylinder({ r = 1, y0 = 0, y1 = 1, segments = 24 } = {}) {
	const positions = [];
	const normals = [];
	const uvs = [];
	const indices = [];

	// Side
	for (let j = 0; j <= segments; j++) {
		const u = j / segments;
		const theta = u * Math.PI * 2;
		const x = Math.cos(theta);
		const z = Math.sin(theta);
		// bottom + top
		positions.push(r * x, y0, r * z);
		normals.push(x, 0, z);
		uvs.push(u, 0);
		positions.push(r * x, y1, r * z);
		normals.push(x, 0, z);
		uvs.push(u, 1);
	}
	for (let j = 0; j < segments; j++) {
		const a = j * 2;
		const b = a + 2;
		indices.push(a, a + 1, b + 1, a, b + 1, b);
	}

	// Caps — fan triangulated from centers.
	const ringStart = positions.length / 3;
	// Top center
	positions.push(0, y1, 0);
	normals.push(0, 1, 0);
	uvs.push(0.5, 0.5);
	const topCenter = ringStart;
	for (let j = 0; j <= segments; j++) {
		const u = j / segments;
		const theta = u * Math.PI * 2;
		positions.push(r * Math.cos(theta), y1, r * Math.sin(theta));
		normals.push(0, 1, 0);
		uvs.push(0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta));
	}
	for (let j = 0; j < segments; j++) {
		indices.push(topCenter, topCenter + 1 + j, topCenter + 2 + j);
	}

	const botCenter = positions.length / 3;
	positions.push(0, y0, 0);
	normals.push(0, -1, 0);
	uvs.push(0.5, 0.5);
	for (let j = 0; j <= segments; j++) {
		const u = j / segments;
		const theta = u * Math.PI * 2;
		positions.push(r * Math.cos(theta), y0, r * Math.sin(theta));
		normals.push(0, -1, 0);
		uvs.push(0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta));
	}
	for (let j = 0; j < segments; j++) {
		indices.push(botCenter, botCenter + 2 + j, botCenter + 1 + j);
	}

	return { positions, normals, uvs, indices };
}

// Annulus (flat ring) lying in the XZ plane at height y. innerR..outerR.
function annulus({ y = 0, innerR = 1, outerR = 1.4, segments = 32 } = {}) {
	const positions = [];
	const normals = [];
	const uvs = [];
	const indices = [];
	for (let j = 0; j <= segments; j++) {
		const u = j / segments;
		const theta = u * Math.PI * 2;
		const c = Math.cos(theta);
		const s = Math.sin(theta);
		positions.push(innerR * c, y, innerR * s);
		normals.push(0, 1, 0);
		uvs.push(u, 0);
		positions.push(outerR * c, y, outerR * s);
		normals.push(0, 1, 0);
		uvs.push(u, 1);
	}
	for (let j = 0; j < segments; j++) {
		const a = j * 2;
		const b = a + 2;
		indices.push(a, a + 1, b + 1, a, b + 1, b);
		indices.push(a, b + 1, a + 1, a, b, b + 1); // double-sided
	}
	return { positions, normals, uvs, indices };
}

// Torus in the XY plane, tube radius r2, ring radius r1.
function torus({ r1 = 1, r2 = 0.1, segments = 32, tubeSegments = 12 } = {}) {
	const positions = [];
	const normals = [];
	const uvs = [];
	const indices = [];
	for (let i = 0; i <= segments; i++) {
		const u = i / segments;
		const theta = u * Math.PI * 2;
		const cx = r1 * Math.cos(theta);
		const cy = r1 * Math.sin(theta);
		for (let j = 0; j <= tubeSegments; j++) {
			const v = j / tubeSegments;
			const phi = v * Math.PI * 2;
			const nx = Math.cos(theta) * Math.cos(phi);
			const ny = Math.sin(theta) * Math.cos(phi);
			const nz = Math.sin(phi);
			positions.push(cx + r2 * nx, cy + r2 * ny, r2 * nz);
			normals.push(nx, ny, nz);
			uvs.push(u, v);
		}
	}
	const stride = tubeSegments + 1;
	for (let i = 0; i < segments; i++) {
		for (let j = 0; j < tubeSegments; j++) {
			const a = i * stride + j;
			const b = a + stride;
			indices.push(a, b, a + 1, b, b + 1, a + 1);
		}
	}
	return { positions, normals, uvs, indices };
}

// Full sphere of radius r centered at origin.
function sphere({ r = 1, segments = 16, rings = 10 } = {}) {
	const positions = [];
	const normals = [];
	const uvs = [];
	const indices = [];
	for (let i = 0; i <= rings; i++) {
		const v = i / rings;
		const phi = v * Math.PI;
		for (let j = 0; j <= segments; j++) {
			const u = j / segments;
			const theta = u * Math.PI * 2;
			const x = Math.sin(phi) * Math.cos(theta);
			const y = Math.cos(phi);
			const z = Math.sin(phi) * Math.sin(theta);
			positions.push(r * x, r * y, r * z);
			normals.push(x, y, z);
			uvs.push(u, 1 - v);
		}
	}
	const stride = segments + 1;
	for (let i = 0; i < rings; i++) {
		for (let j = 0; j < segments; j++) {
			const a = i * stride + j;
			const b = a + stride;
			indices.push(a, b, a + 1, b, b + 1, a + 1);
		}
	}
	return { positions, normals, uvs, indices };
}

// ── Geometry composition (bake transforms, merge parts) ────────────────────
//
// A part list turns into one mesh + one material per entry. That is right for a
// hat with three distinct pieces and wrong for a wreath with sixteen identical
// leaves, which would ship sixteen materials for one look. These helpers bake a
// transform into a geometry's vertices and concatenate geometries, so a repeated
// element is authored as a loop and emitted as a single primitive.

// Hamilton product — `a` applied AFTER `b` (q = a ⊗ b), both [x,y,z,w].
function quatMul(a, b) {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

// Quaternion for a rotation of `angle` radians about a cardinal axis.
function quatAxis(axis, angle) {
	const s = Math.sin(angle / 2);
	const c = Math.cos(angle / 2);
	return axis === 'x' ? [s, 0, 0, c] : axis === 'y' ? [0, s, 0, c] : [0, 0, s, c];
}

// Rotate the vector v by the unit quaternion q.
function quatRotate(q, v) {
	const [qx, qy, qz, qw] = q;
	const [vx, vy, vz] = v;
	// t = 2 * (q_vec × v); v' = v + qw * t + q_vec × t
	const tx = 2 * (qy * vz - qz * vy);
	const ty = 2 * (qz * vx - qx * vz);
	const tz = 2 * (qx * vy - qy * vx);
	return [
		vx + qw * tx + (qy * tz - qz * ty),
		vy + qw * ty + (qz * tx - qx * tz),
		vz + qw * tz + (qx * ty - qy * tx),
	];
}

// Bake scale → rotation → translation into a geometry's vertices, returning a
// new geometry. Normals get the rotation and the inverse-scale (so a squashed
// leaf still lights correctly), then are renormalised.
function transformGeom(geom, { scale = [1, 1, 1], rotation = [0, 0, 0, 1], translate = [0, 0, 0] } = {}) {
	const positions = [];
	const normals = [];
	for (let i = 0; i < geom.positions.length; i += 3) {
		const p = quatRotate(rotation, [
			geom.positions[i] * scale[0],
			geom.positions[i + 1] * scale[1],
			geom.positions[i + 2] * scale[2],
		]);
		positions.push(p[0] + translate[0], p[1] + translate[1], p[2] + translate[2]);
		const n = quatRotate(rotation, [
			geom.normals[i] / scale[0],
			geom.normals[i + 1] / scale[1],
			geom.normals[i + 2] / scale[2],
		]);
		const len = Math.hypot(n[0], n[1], n[2]) || 1;
		normals.push(n[0] / len, n[1] / len, n[2] / len);
	}
	return { positions, normals, uvs: [...geom.uvs], indices: [...geom.indices] };
}

// Concatenate geometries into one, offsetting each one's indices.
function mergeGeoms(geoms) {
	const out = { positions: [], normals: [], uvs: [], indices: [] };
	for (const g of geoms) {
		const base = out.positions.length / 3;
		out.positions.push(...g.positions);
		out.normals.push(...g.normals);
		out.uvs.push(...g.uvs);
		for (const idx of g.indices) out.indices.push(idx + base);
	}
	return out;
}

// ── GLB writer ─────────────────────────────────────────────────────────────

// Build a GLB from an array of { geom, color, name, translate? } parts.
// All parts live under a single root node so the AccessoryManager / bake step
// can re-parent the whole accessory under a bone with one operation.
async function writeGLB(filePath, parts, { rootName }) {
	const doc = new Document();
	doc.createBuffer();
	doc.getRoot().getAsset().generator = 'three.ws procedural accessory generator';

	const root = doc.createNode(rootName);

	for (const part of parts) {
		const positions = doc
			.createAccessor(part.name + '_pos')
			.setType('VEC3')
			.setArray(new Float32Array(part.geom.positions));
		const normals = doc
			.createAccessor(part.name + '_nor')
			.setType('VEC3')
			.setArray(new Float32Array(part.geom.normals));
		const uvs = doc
			.createAccessor(part.name + '_uv')
			.setType('VEC2')
			.setArray(new Float32Array(part.geom.uvs));
		const indices = doc
			.createAccessor(part.name + '_idx')
			.setType('SCALAR')
			.setArray(new Uint16Array(part.geom.indices));

		const material = doc
			.createMaterial(part.name + '_mat')
			.setBaseColorFactor([part.color[0], part.color[1], part.color[2], 1])
			.setMetallicFactor(part.metallic ?? 0.05)
			.setRoughnessFactor(part.roughness ?? 0.7)
			.setDoubleSided(true);

		const prim = doc
			.createPrimitive()
			.setAttribute('POSITION', positions)
			.setAttribute('NORMAL', normals)
			.setAttribute('TEXCOORD_0', uvs)
			.setIndices(indices)
			.setMaterial(material);

		const mesh = doc.createMesh(part.name).addPrimitive(prim);
		const node = doc.createNode(part.name).setMesh(mesh);
		if (part.translate) node.setTranslation(part.translate);
		if (part.rotation) node.setRotation(part.rotation);
		if (part.scale) node.setScale(part.scale);
		root.addChild(node);
	}

	const scene = doc.createScene(rootName).addChild(root);
	doc.getRoot().setDefaultScene(scene);

	const io = new NodeIO();
	const bytes = await io.writeBinary(doc);
	await writeFile(filePath, Buffer.from(bytes));
	return bytes.byteLength;
}

// ── Accessory definitions ──────────────────────────────────────────────────
//
// All meshes are authored relative to the Head bone origin, which on a Mixamo
// rig sits at the top of the neck. +Y is up, +Z is forward, scale is meters.
// Head radius is roughly 0.10–0.12 m, so a hat needs r ≈ 0.11 to fit snugly.

const ACCESSORIES = {
	'hat-baseball.glb': {
		rootName: 'HatBaseball',
		parts: [
			// Crown: dome above the head, sitting just above the head bone.
			{
				name: 'crown',
				geom: halfSphere({ r: 0.115, segments: 24, rings: 10, yOffset: 0.10 }),
				color: [0.07, 0.18, 0.45], // navy
			},
			// Visor: thin disc, offset forward.
			{
				name: 'visor',
				geom: annulus({ y: 0.105, innerR: 0.06, outerR: 0.17, segments: 24 }),
				color: [0.07, 0.18, 0.45],
				translate: [0, 0, 0.06], // push forward
				scale: [1, 1, 0.6], // squash front-back so it looks like a visor not a disc
			},
		],
	},

	'hat-beanie.glb': {
		rootName: 'HatBeanie',
		parts: [
			{
				name: 'beanie',
				geom: halfSphere({ r: 0.125, segments: 20, rings: 10, yOffset: 0.08 }),
				color: [0.55, 0.12, 0.22], // wine red
				roughness: 0.95, // wool
			},
			// Cuff (folded brim) — short cylinder around the base.
			{
				name: 'cuff',
				geom: cylinder({ r: 0.125, y0: 0.07, y1: 0.10, segments: 24 }),
				color: [0.45, 0.08, 0.16],
				roughness: 0.95,
			},
		],
	},

	'hat-cowboy.glb': {
		rootName: 'HatCowboy',
		parts: [
			// Crown — tall halfsphere
			{
				name: 'crown',
				geom: halfSphere({ r: 0.11, segments: 20, rings: 10, yOffset: 0.11 }),
				color: [0.32, 0.18, 0.07], // saddle brown
				scale: [1, 1.4, 1],
			},
			// Brim — wide flat ring with subtle upcurl approximated via scale.
			{
				name: 'brim',
				geom: annulus({ y: 0.11, innerR: 0.10, outerR: 0.24, segments: 32 }),
				color: [0.32, 0.18, 0.07],
			},
		],
	},

	'glasses-round.glb': {
		rootName: 'GlassesRound',
		parts: [
			// Left lens rim
			{
				name: 'rim_l',
				geom: torus({ r1: 0.034, r2: 0.005, segments: 24, tubeSegments: 8 }),
				color: [0.08, 0.08, 0.08],
				metallic: 0.7,
				roughness: 0.3,
				translate: [-0.038, 0.005, 0.085],
			},
			// Right lens rim
			{
				name: 'rim_r',
				geom: torus({ r1: 0.034, r2: 0.005, segments: 24, tubeSegments: 8 }),
				color: [0.08, 0.08, 0.08],
				metallic: 0.7,
				roughness: 0.3,
				translate: [0.038, 0.005, 0.085],
			},
			// Bridge
			{
				name: 'bridge',
				geom: cylinder({ r: 0.005, y0: 0, y1: 0.018, segments: 8 }),
				color: [0.08, 0.08, 0.08],
				metallic: 0.7,
				roughness: 0.3,
				translate: [-0.009, 0.012, 0.085],
				rotation: [0, 0, -0.707, 0.707], // rotate to lie horizontally along X
			},
		],
	},

	'glasses-shades.glb': {
		rootName: 'GlassesShades',
		parts: [
			// Single wraparound lens approximated by a flat squashed annulus.
			{
				name: 'lens',
				geom: annulus({ y: 0, innerR: 0.0, outerR: 0.085, segments: 32 }),
				color: [0.05, 0.05, 0.08],
				metallic: 0.1,
				roughness: 0.15,
				translate: [0, 0.005, 0.09],
				scale: [1, 0.45, 0.4],
			},
		],
	},

	'earrings-hoops.glb': {
		rootName: 'EarringsHoops',
		parts: [
			{
				name: 'hoop_l',
				geom: torus({ r1: 0.018, r2: 0.0025, segments: 20, tubeSegments: 8 }),
				color: [0.95, 0.78, 0.20], // gold
				metallic: 1.0,
				roughness: 0.2,
				translate: [-0.085, -0.02, 0.0],
			},
			{
				name: 'hoop_r',
				geom: torus({ r1: 0.018, r2: 0.0025, segments: 20, tubeSegments: 8 }),
				color: [0.95, 0.78, 0.20],
				metallic: 1.0,
				roughness: 0.2,
				translate: [0.085, -0.02, 0.0],
			},
		],
	},

	'earrings-studs.glb': {
		rootName: 'EarringsStuds',
		parts: [
			{
				name: 'stud_l',
				geom: sphere({ r: 0.005, segments: 12, rings: 8 }),
				color: [0.95, 0.95, 0.98],
				metallic: 1.0,
				roughness: 0.1,
				translate: [-0.082, -0.005, 0.0],
			},
			{
				name: 'stud_r',
				geom: sphere({ r: 0.005, segments: 12, rings: 8 }),
				color: [0.95, 0.95, 0.98],
				metallic: 1.0,
				roughness: 0.1,
				translate: [0.082, -0.005, 0.0],
			},
		],
	},

	// The event souvenir: a gold laurel circlet, open at the front where three
	// pearl berries sit (the nod to $THREE). Granted to everyone who was in the
	// world during the live meetup window and never sold — see
	// multiplayer/src/cosmetics-catalog.js (tier 'event') and the join-time grant
	// in multiplayer/src/rooms/WalkRoom.js. Authored as a loop and merged into
	// three primitives so eighteen identical leaves cost one material, not
	// eighteen.
	'laurel-meetup.glb': {
		rootName: 'LaurelMeetup',
		parts: laurelParts(),
	},
};

// Build the laurel's three primitives: the circlet band, the merged leaf ring,
// and the three front berries.
function laurelParts() {
	const BAND_R = 0.104;   // sits just outside a ~0.11 m head radius
	const BAND_Y = 0.085;   // crown height above the head bone
	const GAP = 0.24;       // radians of bare band left open at the front (+Z)
	const LEAF_COUNT = 18;
	const LEAF = [0.012, 0.027, 0.0045]; // half-extents: narrow, long, near-flat
	const GOLD = [0.86, 0.71, 0.28];

	// Circlet: a torus is authored in the XY plane, so tip it into XZ to ride the
	// crown, then lift it to the band height.
	const band = transformGeom(
		torus({ r1: BAND_R, r2: 0.0042, segments: 40, tubeSegments: 8 }),
		{ rotation: quatAxis('x', -Math.PI / 2), translate: [0, BAND_Y, 0] },
	);

	// Leaves: one squashed sphere each, tipped outward from vertical and swept
	// around the band. Alternating tilt keeps the ring from reading as a machined
	// part. Each leaf is pushed along its own axis so its base meets the band
	// instead of its centre.
	const leafBase = sphere({ r: 1, segments: 8, rings: 5 });
	const leaves = [];
	for (let i = 0; i < LEAF_COUNT; i++) {
		const theta = GAP + (i / (LEAF_COUNT - 1)) * (Math.PI * 2 - GAP * 2);
		const tilt = i % 2 === 0 ? 0.46 : 0.64;
		const rotation = quatMul(quatAxis('y', theta), quatAxis('x', tilt));
		const stem = quatRotate(rotation, [0, LEAF[1] * 0.92, 0]);
		leaves.push(transformGeom(leafBase, {
			scale: LEAF,
			rotation,
			translate: [
				BAND_R * Math.sin(theta) + stem[0],
				BAND_Y + stem[1],
				BAND_R * Math.cos(theta) + stem[2],
			],
		}));
	}

	// Berries: three pearls clustered in the front gap.
	const berryBase = sphere({ r: 0.0055, segments: 10, rings: 6 });
	const berries = [
		[-0.011, BAND_Y + 0.002, BAND_R],
		[0.011, BAND_Y + 0.002, BAND_R],
		[0, BAND_Y + 0.017, BAND_R + 0.002],
	].map((translate) => transformGeom(berryBase, { translate }));

	return [
		{ name: 'circlet', geom: band, color: GOLD, metallic: 0.85, roughness: 0.28 },
		{ name: 'leaves', geom: mergeGeoms(leaves), color: GOLD, metallic: 0.8, roughness: 0.34 },
		{ name: 'berries', geom: mergeGeoms(berries), color: [0.95, 0.95, 0.97], metallic: 0.2, roughness: 0.14 },
	];
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
	// Optional filename arguments narrow the run to those files. Regenerating an
	// accessory that hasn't changed would rewrite a committed binary for nothing,
	// so adding one asset should touch exactly one file.
	const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
	const unknown = only.filter((f) => !ACCESSORIES[f]);
	if (unknown.length) {
		throw new Error(`Unknown accessory ${unknown.join(', ')} — known: ${Object.keys(ACCESSORIES).join(', ')}`);
	}
	const results = [];
	for (const [filename, spec] of Object.entries(ACCESSORIES)) {
		if (only.length && !only.includes(filename)) continue;
		const out = path.join(OUT_DIR, filename);
		const bytes = await writeGLB(out, spec.parts, { rootName: spec.rootName });
		results.push({ filename, bytes });
	}
	console.log('Wrote', results.length, 'accessory GLBs to', OUT_DIR);
	for (const r of results) {
		console.log(`  ${r.filename.padEnd(28)} ${r.bytes.toString().padStart(6)} bytes`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
