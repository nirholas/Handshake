// Default geometry cleanup for every finished /forge mesh.
//
// The self-host reconstruction workers (TRELLIS, Hunyuan3D) emit a Gaussian-
// splat-derived surface extracted by marching cubes: dense, unindexed triangle
// soup with duplicated vertices, orphaned accessors, per-primitive material
// splits, and no consistent normals. Rendered raw it's heavier than it needs to
// be and lights unevenly (missing/inconsistent normals read as flat facets).
//
// glb-compress.js already welds+prunes as a PREREQUISITE of the Draco/meshopt
// codecs, but only when a caller explicitly asks for a compressed output_format
// (the default `glb` delivery ships the raw soup untouched). This module runs a
// codec-independent cleanup on EVERY delivered mesh:
//
//   dedup      → collapse duplicate meshes/materials/textures/accessors
//   flatten    → bake node hierarchy so join can merge across the scene
//   join       → merge compatible primitives into single draw calls
//   weld       → index the mesh on shared vertices (also the simplifier's input)
//   simplify   → meshoptimizer edge-collapse decimation, border-locked and
//                error-bounded so the silhouette is preserved (tames the soup)
//   prune      → drop anything the above orphaned
//
// The workers' own vertex normals are carried through untouched: recomputing
// them here (`normals({overwrite:true})`) produces FLAT per-face normals, which
// de-indexes the mesh (3x the vertices, a larger file, a faceted look). Smooth-
// normal recompute is a deliberate, opt-in job for forge-remesh, not this
// always-on pass whose contract is "smaller and cleaner, never worse".
//
// It is CPU-only (no GPU, no `sharp`, textures untouched) and strictly
// best-effort: any failure returns the original bytes, so a cleanup problem can
// never block a delivery. The heavy simplifier wasm is imported lazily.

import { Buffer } from 'node:buffer';

// Keep this fraction of the original triangles at most (the simplifier removes
// down TOWARD this, never below the error bound). 0.75 clears the redundant
// coplanar triangles marching cubes over-produces while leaving the shape and
// its silhouette visually identical. Conservative on purpose: aggressive
// decimation is the opt-in job of forge-remesh / game-ready, not this pass.
const SIMPLIFY_RATIO = 0.75;
// Max positional error as a fraction of the mesh's bounding-sphere radius. At
// 0.1% the collapse is imperceptible on a viewer-scale model.
const SIMPLIFY_ERROR = 0.001;
// Below this triangle count a mesh is already light; skip the simplifier (its
// fixed wasm-load cost isn't worth shaving a few hundred triangles) but still
// run the topological cleanup, which is cheap.
const SIMPLIFY_MIN_TRIS = 20_000;

// Count triangles across every mesh primitive in the document (indexed or not).
function countTriangles(doc) {
	let tris = 0;
	let verts = 0;
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			const idx = prim.getIndices();
			const pos = prim.getAttribute('POSITION');
			if (idx) tris += Math.floor(idx.getCount() / 3);
			else if (pos) tris += Math.floor(pos.getCount() / 3);
			if (pos) verts += pos.getCount();
		}
	}
	return { tris, verts };
}

/**
 * Clean a GLB's geometry with a codec-independent glTF-Transform pass.
 * Returns the cleaned buffer plus before/after stats. Throws only on an
 * unparseable buffer; the caller treats any throw as "deliver the original".
 *
 * @param {Buffer|Uint8Array} buf - source GLB bytes
 * @param {{ simplify?: boolean, simplifyRatio?: number, simplifyError?: number }} [opts]
 * @returns {Promise<{
 *   buffer: Buffer,
 *   inputBytes: number,
 *   outputBytes: number,
 *   trisBefore: number,
 *   trisAfter: number,
 *   vertsBefore: number,
 *   vertsAfter: number,
 *   simplified: boolean,
 *   grew: boolean,
 * }>}
 */
export async function cleanupGlb(buf, opts = {}) {
	if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength < 20) {
		throw new Error('cleanupGlb: input is not a GLB buffer');
	}
	const input = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	const inputBytes = input.byteLength;

	const { NodeIO } = await import('@gltf-transform/core');
	const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
	const { dedup, prune, weld, join, flatten, simplify } = await import(
		'@gltf-transform/functions'
	);

	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
	const doc = await io.readBinary(input);

	const before = countTriangles(doc);
	const wantSimplify =
		opts.simplify !== false && before.tris >= (opts.simplifyMinTris ?? SIMPLIFY_MIN_TRIS);

	// Topological cleanup (cheap, always safe), then the optional error-bounded
	// decimation. The mesh stays indexed throughout, so the output is never
	// larger than the input in vertex terms.
	const steps = [dedup(), flatten(), join(), weld()];
	if (wantSimplify) {
		const { MeshoptSimplifier } = await import('meshoptimizer');
		await MeshoptSimplifier.ready;
		steps.push(
			simplify({
				simplifier: MeshoptSimplifier,
				ratio: opts.simplifyRatio ?? SIMPLIFY_RATIO,
				error: opts.simplifyError ?? SIMPLIFY_ERROR,
				lockBorder: true,
			}),
		);
	}
	steps.push(prune());

	await doc.transform(...steps);

	const after = countTriangles(doc);
	const out = await io.writeBinary(doc);
	const outputBytes = out.byteLength;

	return {
		buffer: Buffer.from(out),
		inputBytes,
		outputBytes,
		trisBefore: before.tris,
		trisAfter: after.tris,
		vertsBefore: before.verts,
		vertsAfter: after.verts,
		simplified: wantSimplify,
		grew: outputBytes >= inputBytes,
	};
}
