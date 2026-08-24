#!/usr/bin/env node
/**
 * GLB decimation for the web.
 *
 * The sibling of scripts/optimize-glb.mjs, and a different job. That one is
 * lossless: it welds, prunes and re-encodes textures, and never touches the
 * triangle budget. This one spends triangles. Generated and photogrammetry
 * assets routinely arrive at 200k-500k triangles for a shape a tenth of that
 * describes exactly -- the pump.fun pill mascot landed at 297k triangles and
 * 12.6 MB for a smooth capsule with four nubs -- and no amount of lossless
 * packing fixes a mesh that dense. Quadric simplification does, at no visible
 * cost on smooth organic shapes whose detail lives in the texture.
 *
 * Like optimize-glb.mjs, output stays inside the standard glTF 2.0 feature set
 * (no EXT_meshopt_compression, no Draco), so it loads in a bare GLTFLoader with
 * no decoder wiring. Textures are re-encoded to WebP, which three.js decodes
 * natively.
 *
 * Run it BEFORE rigging, never after: simplification rewrites the vertex list,
 * and skin weights are per-vertex.
 *
 *   node scripts/decimate-glb.mjs <in.glb> <out.glb> [--ratio=0.15] [--error=0.003]
 *   node scripts/decimate-glb.mjs in.glb out.glb --dry     # report, write nothing
 *
 * --ratio is the target fraction of the original triangle count; --error is the
 * simplifier's absolute error budget in model units, which caps how far the
 * surface may move and will stop it short of --ratio when the shape needs the
 * triangles. Check the result in a viewer: a silhouette that reads as faceted
 * wants a higher ratio, not a bigger error budget.
 */
import { statSync } from 'node:fs';
import { NodeIO, VertexLayout } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? Number(hit.split('=')[1]) : fallback;
};

if (files.length !== 2) {
	console.error('usage: node scripts/decimate-glb.mjs <in.glb> <out.glb> [--ratio=] [--error=]');
	process.exit(1);
}

const [src, out] = files;
const ratio = flag('ratio', 0.15);
const error = flag('error', 0.003);
const dry = args.includes('--dry');

// Separate, not interleaved: an interleaved vertex block cannot have a single
// attribute rewritten in place, which is exactly what the rigger does when it
// bakes a rest pose back into POSITION and NORMAL.
const io = new NodeIO().setVertexLayout(VertexLayout.SEPARATE)
	.registerExtensions(ALL_EXTENSIONS).registerDependencies({
	'meshopt.decoder': MeshoptDecoder,
	'meshopt.encoder': MeshoptEncoder,
	'draco3d.decoder': await draco3d.createDecoderModule(),
	'draco3d.encoder': await draco3d.createEncoderModule(),
});
await MeshoptSimplifier.ready;

const doc = await io.read(src);
const primitives = () => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
const triangles = () => primitives().reduce(
	(n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);
const vertices = () => primitives().reduce((n, p) => n + p.getAttribute('POSITION').getCount(), 0);

if (primitives().some((p) => p.getAttribute('JOINTS_0'))) {
	console.error('refusing to decimate a skinned mesh: simplification rewrites the vertex list '
		+ 'and would invalidate its skin weights. Decimate the static model, then rig it.');
	process.exit(2);
}

const before = { tris: triangles(), verts: vertices(), bytes: statSync(src).size };
await doc.transform(
	dedup(),
	weld(),
	simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
	prune(),
	textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 88 }),
);
const after = { tris: triangles(), verts: vertices() };

if (dry) {
	console.log(`${src}: ${before.tris} -> ${after.tris} triangles (dry run, nothing written)`);
	process.exit(0);
}
await io.write(out, doc);
const bytes = statSync(out).size;
console.log(`${src} -> ${out}`);
console.log(`  ${before.tris} -> ${after.tris} triangles, ${before.verts} -> ${after.verts} vertices`);
console.log(`  ${(before.bytes / 1e6).toFixed(2)} MB -> ${(bytes / 1e6).toFixed(2)} MB`
	+ `  (-${(100 - (bytes / before.bytes) * 100).toFixed(1)}%)`);
