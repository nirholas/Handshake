// Bake the body-region occlusion mask for the canonical parametric base.
//
//   node scripts/build-body-region-mask.mjs
//
// Output: public/avatars/parametric-base.regions.png — a 1024² grayscale map
// in the body's UV space where each pixel holds the REGION_MASK_VALUES code of
// the body region that owns that patch of skin (0 = unassigned).
//
// Why: the additive wardrobe hides the body under a worn garment. The
// fallback is bone-region triangle culling (works on any avatar, but leaves
// stair-step seams on low-poly bodies). With this mask, the closet drives the
// skin material's alphaMap instead and the cut is pixel-exact at the garment
// edge. See applySkinOcclusion() in src/avatar-garment.js and the sampler in
// src/garment-region-mask.js.
//
// Region assignment: a vertex belongs to the region of its dominant joint
// (REGION_BONES); each UV triangle is rasterized with per-pixel nearest-corner
// region (barycentric max), which keeps region boundaries on edge midlines.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalizeBoneName } from '../src/glb-canonicalize.js';
import { REGION_BONES, REGION_MASK_VALUES } from '../src/garment-taxonomy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB = path.join(ROOT, 'public/avatars/parametric-base.glb');
const OUT = path.join(ROOT, 'public/avatars/parametric-base.regions.png');
const SIZE = 1024;

await MeshoptDecoder.ready;
const io = new NodeIO()
	.registerExtensions(ALL_EXTENSIONS)
	.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(GLB);

// The body: the skinned mesh with the most vertices (Eyes/Teeth/Tongue are
// never occluded by garments and stay out of the mask).
let body = null;
for (const node of doc.getRoot().listNodes()) {
	if (!node.getSkin() || !node.getMesh()) continue;
	const count = node.getMesh().listPrimitives()
		.reduce((n, p) => n + (p.getAttribute('POSITION')?.getCount() || 0), 0);
	if (!body || count > body.count) body = { node, count };
}
if (!body) throw new Error('no skinned mesh in the base GLB');

const skin = body.node.getSkin();
const jointRegion = skin.listJoints().map((j) => {
	const canonical = canonicalizeBoneName(j.getName() || '');
	for (const [region, bones] of Object.entries(REGION_BONES)) {
		if (bones.includes(canonical)) return REGION_MASK_VALUES[region];
	}
	return 0;
});

const mask = new Uint8Array(SIZE * SIZE); // 0 = unassigned

for (const prim of body.node.getMesh().listPrimitives()) {
	const uv = prim.getAttribute('TEXCOORD_0')?.getArray();
	const joints = prim.getAttribute('JOINTS_0')?.getArray();
	const weights = prim.getAttribute('WEIGHTS_0')?.getArray();
	const index = prim.getIndices()?.getArray();
	if (!uv || !joints || !weights || !index) continue;

	// Per-vertex region: the region of the dominant joint.
	const vertCount = uv.length / 2;
	const vertRegion = new Uint8Array(vertCount);
	for (let v = 0; v < vertCount; v++) {
		let bestC = 0;
		for (let c = 1; c < 4; c++) {
			if (weights[v * 4 + c] > weights[v * 4 + bestC]) bestC = c;
		}
		vertRegion[v] = jointRegion[joints[v * 4 + bestC]] || 0;
	}

	// Rasterize each UV triangle; per pixel take the corner with max barycentric.
	for (let t = 0; t < index.length; t += 3) {
		const i0 = index[t];
		const i1 = index[t + 1];
		const i2 = index[t + 2];
		const x0 = uv[i0 * 2] * SIZE, y0 = uv[i0 * 2 + 1] * SIZE;
		const x1 = uv[i1 * 2] * SIZE, y1 = uv[i1 * 2 + 1] * SIZE;
		const x2 = uv[i2 * 2] * SIZE, y2 = uv[i2 * 2 + 1] * SIZE;
		const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - 1);
		const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(x0, x1, x2)) + 1);
		const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)) - 1);
		const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(y0, y1, y2)) + 1);
		const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
		if (Math.abs(area) < 1e-9) continue;
		for (let py = minY; py <= maxY; py++) {
			for (let px = minX; px <= maxX; px++) {
				const cx = px + 0.5, cy = py + 0.5;
				const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
				const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
				const w2 = 1 - w0 - w1;
				// Half-pixel tolerance keeps seams covered at UV island borders.
				const eps = -0.02;
				if (w0 < eps || w1 < eps || w2 < eps) continue;
				const corner = w0 >= w1 && w0 >= w2 ? i0 : w1 >= w2 ? i1 : i2;
				mask[py * SIZE + px] = vertRegion[corner];
			}
		}
	}
}

const assigned = mask.reduce((n, v) => n + (v ? 1 : 0), 0);
if (assigned < SIZE * SIZE * 0.05) {
	throw new Error(`mask nearly empty (${assigned} px) — UV or weight read is broken`);
}

await sharp(Buffer.from(mask), { raw: { width: SIZE, height: SIZE, channels: 1 } })
	// PNG must stay lossless and unfiltered-friendly; grayscale 8-bit is exact.
	.png({ compressionLevel: 9 })
	.toFile(OUT);

const perRegion = {};
for (const v of mask) {
	if (!v) continue;
	perRegion[v] = (perRegion[v] || 0) + 1;
}
console.log(`wrote ${path.relative(ROOT, OUT)} — ${assigned} px assigned`);
for (const [region, value] of Object.entries(REGION_MASK_VALUES)) {
	console.log(`  ${region.padEnd(10)} code ${String(value).padStart(3)}  ${perRegion[value] || 0} px`);
}
