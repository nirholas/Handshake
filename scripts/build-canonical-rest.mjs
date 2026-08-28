// Generate the canonical authoring rest pose for animation retargeting.
//
// The pre-baked clip library (public/animations/clips/*.json) stores ABSOLUTE
// local bone rotations authored against one reference rig: the Avaturn-rigged
// public/avatars/cz.glb (clips play on it verbatim with zero correction). To
// drive a rig with a different rest pose (e.g. a Mixamo T-pose vs cz's A-pose),
// src/animation-retarget.js replays each clip bone's deviation-from-rest in the
// target rig's own rest frame: Ta = Tr · Sr⁻¹ · Sa, where Sr is THIS file.
//
// We emit cz.glb's bone rotations VERBATIM (the exact JSON numbers) so that
// retargeting back onto cz yields C = Tr · Sr⁻¹ = identity (within FP noise) and
// the clip round-trips byte-for-byte — the absolute no-regression invariant.
//
// Run:  node scripts/build-canonical-rest.mjs
// Reads:  public/avatars/cz.glb
// Writes: src/animation-canonical-rest.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { canonicalizeBoneName } from '../src/glb-canonicalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_RIG = path.join(ROOT, 'public/avatars/cz.glb');
const OUT = path.join(ROOT, 'src/animation-canonical-rest.js');

// Parse the JSON chunk of a binary glTF (GLB) without three/DOM.
function readGlbJson(file) {
	const buf = fs.readFileSync(file);
	const magic = buf.readUInt32LE(0);
	if (magic !== 0x46546c67) throw new Error(`${file}: not a GLB (bad magic)`);
	const chunkLen = buf.readUInt32LE(12);
	const chunkType = buf.readUInt32LE(16);
	if (chunkType !== 0x4e4f534a) throw new Error(`${file}: first chunk is not JSON`);
	return JSON.parse(buf.slice(20, 20 + chunkLen).toString('utf8'));
}

const gltf = readGlbJson(REFERENCE_RIG);
const nodes = gltf.nodes || [];

// Each glTF node's local rotation (identity [0,0,0,1] when omitted).
const localQuat = (i) => {
	const r = Array.isArray(nodes[i]?.rotation) ? nodes[i].rotation : [0, 0, 0, 1];
	return new Quaternion(r[0], r[1], r[2], r[3]);
};

// child index → parent index, so we can compose each bone's WORLD bind rotation.
const parentOf = new Array(nodes.length).fill(-1);
for (let i = 0; i < nodes.length; i++) {
	for (const c of nodes[i]?.children || []) parentOf[c] = i;
}

// World bind rotation of node i = parentWorld · local, composed up the scene
// graph. Mirrors src/animation-retarget.js's runtime world composition (pure
// quaternion product of ancestor rotations), so source and target are measured
// in the same frame. Rotation-only — uniform-scale humanoid rigs carry no shear.
const worldCache = new Map();
function worldQuat(i) {
	if (worldCache.has(i)) return worldCache.get(i);
	const q = localQuat(i);
	if (parentOf[i] !== -1) q.premultiply(worldQuat(parentOf[i]));
	worldCache.set(i, q);
	return q;
}

// Each glTF node's local translation (zero when omitted).
const localPos = (i) => {
	const t = Array.isArray(nodes[i]?.translation) ? nodes[i].translation : [0, 0, 0];
	return new Vector3(t[0], t[1], t[2]);
};

// World bind POSITION of node i, composed the same way as worldQuat. Humanoid
// glTF rigs carry no per-node scale on the bone chain, so rotation+translation
// composition is exact.
const posCache = new Map();
function worldPos(i) {
	if (posCache.has(i)) return posCache.get(i);
	let p = localPos(i);
	const parent = parentOf[i];
	if (parent !== -1) p = p.clone().applyQuaternion(worldQuat(parent)).add(worldPos(parent));
	posCache.set(i, p);
	return p;
}

// First occurrence wins, matching canonicalRestMapFromObject's traversal order.
const rest = new Map();
const restWorld = new Map();
const restPosition = new Map();
const canonicalOf = new Map(); // node index → canonical name (first-wins)
for (let i = 0; i < nodes.length; i++) {
	const node = nodes[i];
	if (!node?.name) continue;
	const canonical = canonicalizeBoneName(node.name);
	if (!canonical || rest.has(canonical)) continue;
	canonicalOf.set(i, canonical);
	// glTF node rotation defaults to identity [0,0,0,1] when omitted.
	rest.set(canonical, Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1]);
	const w = worldQuat(i);
	restWorld.set(canonical, [w.x, w.y, w.z, w.w]);
	const p = worldPos(i);
	restPosition.set(canonical, [p.x, p.y, p.z]);
}

// Nearest CANONICAL ancestor of each canonical bone. Bones the canonicalizer
// doesn't name (helper/twist joints an artist inserted) are skipped, so the
// chain a pose solver walks is the canonical one the clips address.
const parent = new Map();
for (const [i, canonical] of canonicalOf) {
	let p = parentOf[i];
	while (p !== -1 && !canonicalOf.has(p)) p = parentOf[p];
	parent.set(canonical, p === -1 ? null : canonicalOf.get(p));
}

if (rest.size === 0) throw new Error(`${REFERENCE_RIG}: no canonical bones found`);

// Stable, human-diffable ordering.
const sorted = [...rest.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const body = sorted
	.map(([bone, q]) => `\t${bone}: [${q.map((n) => +n).join(', ')}],`)
	.join('\n');
const worldBody = sorted
	.map(([bone]) => `\t${bone}: [${restWorld.get(bone).map((n) => +n).join(', ')}],`)
	.join('\n');
const positionBody = sorted
	.map(([bone]) => `\t${bone}: [${restPosition.get(bone).map((n) => +n.toFixed(6)).join(', ')}],`)
	.join('\n');
const parentBody = sorted
	.map(([bone]) => `\t${bone}: ${parent.get(bone) ? `'${parent.get(bone)}'` : 'null'},`)
	.join('\n');

const out = `// GENERATED by scripts/build-canonical-rest.mjs from public/avatars/cz.glb.
// Do not edit by hand — re-run the generator instead.
//
// CANONICAL_REST — each canonical bone's LOCAL rest (bind-pose) quaternion
// [x,y,z,w] on the Avaturn reference rig the clip library is authored against.
// CANONICAL_REST_WORLD — the same bones' WORLD (model-space) bind rotations,
// composed up cz's scene graph. Both feed src/animation-retarget.js's bind
// correction q' = L·q·R (L = Rt·WT⁻¹·WS·Rs⁻¹, R = WS⁻¹·WT), which replays a
// clip bone's motion as the SAME world-space delta on a target rig of any rest
// pose — fixing the ~30° limb skew a local-only premultiply produced on
// non-cz rigs (A-pose vs T-pose), while still correcting the Hips up-axis
// convention. Local values are verbatim from cz.glb so retargeting onto cz is
// identity (L=R=I within FP noise) → byte-for-byte round-trip.

export const CANONICAL_REST = Object.freeze({
${body}
});

export const CANONICAL_REST_WORLD = Object.freeze({
${worldBody}
});

// CANONICAL_REST_POSITION — each bone's WORLD (model-space) bind position in
// metres, and CANONICAL_PARENT — its nearest canonical ancestor. Together with
// the rotations above they describe the reference skeleton completely enough to
// run forward and inverse kinematics in plain JS (src/sign-rig.js), which is how
// the signing lane authors poses by anatomical target instead of by hand-tuned
// joint angles.

export const CANONICAL_REST_POSITION = Object.freeze({
${positionBody}
});

export const CANONICAL_PARENT = Object.freeze({
${parentBody}
});
`;

fs.writeFileSync(OUT, out);
console.log(`wrote ${path.relative(ROOT, OUT)} — ${rest.size} canonical bones (local + world + position + parent)`);

// The published motion package carries its own copy of the same four tables,
// because it runs standalone on npm and cannot import out of src/. Writing both
// from this one measurement pass is what keeps them identical; the guard is
// tests/motion-skeleton-parity.test.js, which fails if they ever disagree.
const PACKAGE_OUT = path.join(ROOT, 'packages/motion/src/rig/skeleton-data.js');
const packageHeader = `// GENERATED by scripts/build-canonical-rest.mjs from public/avatars/cz.glb.
// Do not edit by hand: re-run the generator, which writes this file and its
// twin at src/animation-canonical-rest.js from the same measurement pass.
//
// The reference skeleton every three.ws motion is authored against: the
// Avaturn rig the platform's ~3,000 clip library was baked on. Four tables
// describe it completely enough to run forward and inverse kinematics in plain
// JS with no renderer attached, which is what lets this package synthesize
// motion in a Node script, a Cloud Run handler, or a browser tab from the same
// code path.
//
//   CANONICAL_REST          local (bind) rotation per bone, [x,y,z,w]
//   CANONICAL_REST_WORLD    the same rotations composed to model space
//   CANONICAL_REST_POSITION model-space bind position per bone, in metres
//   CANONICAL_PARENT        nearest canonical ancestor, null at the root
//
// tests/motion-skeleton-parity.test.js fails if this copy and the site copy
// ever disagree, so the published package can never drift from the rig the
// platform actually retargets onto.

`;
const packageBody = out.slice(out.indexOf('export const CANONICAL_REST = '))
	// Comments between the tables are the site copy's; the package restates them
	// in its own header, and the dash characters this repo bans cannot survive.
	.replace(/\n\/\/ CANONICAL_REST_POSITION[\s\S]*?joint angles\.\n/, `
// Positions and parentage. Together with the rotations above they close the
// skeleton: every bone knows where it starts, which way it points, and who
// carries it.
`);
fs.writeFileSync(PACKAGE_OUT, packageHeader + packageBody);
console.log(`wrote ${path.relative(ROOT, PACKAGE_OUT)} — the same tables for @three-ws/motion`);
console.log('bones:', sorted.map(([b]) => b).join(', '));
