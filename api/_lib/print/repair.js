// Turning a generated mesh into a solid a printer will accept.
//
// The order of operations is the whole design. Cheap topology first, because it
// fixes the failures forge output actually has (UV seams read as holes, mirrored
// duplicate shells, patches wound backwards, an open bottom where the generator
// never closed the base), and it preserves the artist's triangles exactly. Only
// when that is not enough does the voxel reconstruction run, which always
// produces a manifold but resamples the surface and therefore softens detail.
//
// Every stage records before/after metrics. A repair the buyer cannot see is a
// repair the buyer cannot trust, and the /materialize page renders these numbers
// as the "what changed" list next to the model.

import Module from 'manifold-3d';

import { boundsOf, weldPositions } from './mesh-io.js';
import {
	boundaryLoops,
	connectedShells,
	dropDegenerate,
	edgeTopology,
	orientConsistently,
	signedVolume,
	surfaceArea,
} from './topology.js';
import { buildSignedDistance, extractLevelSet } from './voxel-sdf.js';

// Weld tolerance as a fraction of the bounding-box diagonal. Loose enough to
// merge the duplicated vertices a UV seam creates, tight enough to leave two
// genuinely distinct surfaces a hair apart alone.
const WELD_FRACTION = 1e-5;

let wasmPromise = null;

/**
 * The Manifold WASM module, initialized once per process. It is plain
 * WebAssembly with no native binding, which is why it runs in the API container
 * at all; the same single-instance pattern the Draco decoders use.
 */
export async function getManifold() {
	if (!wasmPromise) {
		wasmPromise = (async () => {
			const wasm = await Module();
			wasm.setup();
			return wasm;
		})().catch((err) => {
			wasmPromise = null;
			throw err;
		});
	}
	return wasmPromise;
}

/** Flat arrays out of a Manifold solid, in the representation everything else here speaks. */
export function solidToArrays(solid) {
	const mesh = solid.getMesh();
	const stride = mesh.numProp;
	const count = mesh.vertProperties.length / stride;
	const positions = new Float64Array(count * 3);
	for (let i = 0; i < count; i += 1) {
		positions[i * 3] = mesh.vertProperties[i * stride];
		positions[i * 3 + 1] = mesh.vertProperties[i * stride + 1];
		positions[i * 3 + 2] = mesh.vertProperties[i * stride + 2];
	}
	return { positions, indices: Uint32Array.from(mesh.triVerts) };
}

/**
 * Hand a triangle soup to Manifold. Returns null rather than throwing when the
 * soup is not a closed, non-self-intersecting 2-manifold, because "not yet a
 * solid" is the normal case this pipeline exists to fix, not an error.
 */
export function toSolid(wasm, positions, indices) {
	try {
		const mesh = new wasm.Mesh({
			numProp: 3,
			vertProperties: Float32Array.from(positions),
			triVerts: Uint32Array.from(indices),
		});
		const solid = wasm.Manifold.ofMesh(mesh);
		if (solid.status() !== 'NoError' || solid.isEmpty()) return null;
		return solid;
	} catch {
		return null;
	}
}

/**
 * Fan-fill every boundary loop. Each hole gets one new vertex at the loop's
 * centroid and a triangle per rim edge, wound opposite to the rim so the patch
 * agrees with the surface it closes.
 *
 * A centroid fan is the right tool here specifically because these holes are
 * generator artifacts (a flat open base, a missing cap) rather than designed
 * openings; it is stable, needs no projection plane, and never produces a
 * self-intersecting patch on a convex rim.
 */
export function fillBoundaryLoops(positions, indices) {
	// `unclosed` counts rims that could not be walked into a cycle (one vertex
	// shared by two holes). They are reported, never patched: a fan across a
	// figure-eight rim would cross itself.
	const { loops, unclosed } = boundaryLoops(indices);
	if (!loops.length) return { positions, indices, filled: 0, addedTriangles: 0, unclosedLoops: unclosed };
	const pos = Array.from(positions);
	const tris = Array.from(indices);
	let addedTriangles = 0;
	for (const loop of loops) {
		if (loop.length === 3) {
			tris.push(loop[2], loop[1], loop[0]);
			addedTriangles += 1;
			continue;
		}
		let cx = 0, cy = 0, cz = 0;
		for (const v of loop) {
			cx += positions[v * 3];
			cy += positions[v * 3 + 1];
			cz += positions[v * 3 + 2];
		}
		const center = pos.length / 3;
		pos.push(cx / loop.length, cy / loop.length, cz / loop.length);
		for (let i = 0; i < loop.length; i += 1) {
			const u = loop[i];
			const v = loop[(i + 1) % loop.length];
			tris.push(v, u, center);
			addedTriangles += 1;
		}
	}
	return {
		positions: Float64Array.from(pos),
		indices: Uint32Array.from(tris),
		filled: loops.length,
		addedTriangles,
		unclosedLoops: unclosed,
	};
}

/**
 * The cheap repair: weld, drop what cannot hold volume, agree on a winding,
 * close the holes, and make the whole thing point outward. Pure topology, no
 * resampling, so the surface a buyer approved is the surface that prints.
 */
export function cleanTopology(mesh, opts = {}) {
	const bounds = boundsOf(mesh.positions);
	const tolerance = opts.weldTolerance ?? Math.max((bounds?.diagonal ?? 1) * WELD_FRACTION, Number.EPSILON);

	const welded = weldPositions(mesh.positions, mesh.indices, tolerance);
	const cleaned = dropDegenerate(welded.positions, welded.indices, (tolerance * tolerance) / 2);
	const oriented = orientConsistently(cleaned.indices);
	const before = edgeTopology(oriented.indices);
	const filled = fillBoundaryLoops(welded.positions, oriented.indices);
	const after = edgeTopology(filled.indices);

	// Winding is only consistent per component after orientConsistently; a
	// negative total signed volume means the biggest shell points inward.
	let indices = filled.indices;
	let volume = signedVolume(filled.positions, indices);
	let flippedAll = false;
	if (volume < 0) {
		const flipped = Uint32Array.from(indices);
		for (let i = 0; i + 2 < flipped.length; i += 3) {
			const b = flipped[i + 1];
			flipped[i + 1] = flipped[i + 2];
			flipped[i + 2] = b;
		}
		indices = flipped;
		volume = -volume;
		flippedAll = true;
	}

	return {
		positions: filled.positions,
		indices,
		metrics: {
			weldTolerance: tolerance,
			mergedVertices: mesh.positions.length / 3 - welded.positions.length / 3,
			degenerateRemoved: cleaned.degenerate,
			duplicateRemoved: cleaned.duplicate,
			trianglesFlipped: oriented.flipped,
			shellReversed: flippedAll,
			holesFilled: filled.filled,
			patchTriangles: filled.addedTriangles,
			unclosedLoops: filled.unclosedLoops ?? 0,
			openEdgesBefore: before.openEdges,
			openEdgesAfter: after.openEdges,
			nonManifoldEdgesAfter: after.nonManifoldEdges,
			signedVolume: volume,
		},
	};
}

/**
 * Uniform scale about the mesh's own centre, then a translation that puts the
 * base on z=0 of nothing in particular; callers that need a print bed origin
 * do that in the exporter, where the up-axis convention belongs.
 */
export function scaleMesh(positions, factor) {
	const out = new Float64Array(positions.length);
	for (let i = 0; i < positions.length; i += 1) out[i] = positions[i] * factor;
	return out;
}

/**
 * Full repair. Returns a solid whenever one can be produced, plus the metrics
 * describing how it was reached and which path ran.
 *
 * `strategy` is reported, never guessed at by the caller:
 *   'already-solid'  the input was already a closed manifold
 *   'topology'       welding, hole filling and re-winding were enough
 *   'reconstructed'  the voxel level set had to rebuild the surface
 */
export async function repairMesh(mesh, opts = {}) {
	const wasm = opts.wasm || (await getManifold());
	const started = Date.now();
	const cleaned = cleanTopology(mesh, opts);

	let solid = toSolid(wasm, cleaned.positions, cleaned.indices);
	let strategy = solid ? (cleaned.metrics.holesFilled === 0 && cleaned.metrics.degenerateRemoved === 0 ? 'already-solid' : 'topology') : null;
	let reconstruction = null;

	if (!solid) {
		// Topology could not save it: overlapping shells, edges shared by three
		// faces, or holes whose rims do not close. Resample instead. This always
		// produces a printable solid, at the cost of the original triangulation.
		const field = buildSignedDistance(cleaned.positions, cleaned.indices, {
			maxCells: opts.maxGridCells,
		});
		const extracted = extractLevelSet(wasm, field, { maxSamples: opts.maxSamples });
		if (extracted.solid.isEmpty()) {
			throw new Error('mesh could not be reconstructed into a printable solid');
		}
		solid = extracted.solid;
		strategy = 'reconstructed';
		reconstruction = { gridDims: field.dims, edgeLength: extracted.edgeLength };
	}

	const arrays = solidToArrays(solid);
	const components = connectedShells(arrays.indices, edgeTopology(arrays.indices).edges);
	return {
		wasm,
		solid,
		positions: arrays.positions,
		indices: arrays.indices,
		strategy,
		metrics: {
			...cleaned.metrics,
			strategy,
			reconstruction,
			trianglesBefore: mesh.indices.length / 3,
			trianglesAfter: arrays.indices.length / 3,
			shells: components.length,
			volume: solid.volume(),
			surfaceArea: solid.surfaceArea(),
			genus: solid.genus(),
			elapsedMs: Date.now() - started,
		},
	};
}

/**
 * Hollow a solid to a wall thickness, with drain holes.
 *
 * Resin is sold by volume, so a hollow print of a 10 cm figure can cost a third
 * of the solid one. The erosion is a level-set offset of the solid's own
 * distance field; the two drain holes are mandatory, not decorative, because a
 * sealed resin shell traps uncured liquid and can burst under the vat's suction.
 *
 * Returns `{ solid, hollowed: false, reason }` rather than throwing when the
 * geometry cannot take it: a thin ornament with no interior to remove is
 * printed solid, and the buyer is quoted for a solid.
 */
export function hollowSolid(wasm, solid, { wallThickness, drainRadius, maxSamples } = {}) {
	if (!(wallThickness > 0)) return { solid, hollowed: false, reason: 'no-wall-thickness' };
	const arrays = solidToArrays(solid);
	const bounds = boundsOf(arrays.positions);
	if (!bounds) return { solid, hollowed: false, reason: 'empty' };
	// Nothing to gain when the wall is most of the object.
	if (wallThickness * 6 > bounds.longest) {
		return { solid, hollowed: false, reason: 'too-small-to-hollow' };
	}

	const field = buildSignedDistance(arrays.positions, arrays.indices);
	const eroded = extractLevelSet(wasm, field, { level: wallThickness, maxSamples });
	if (eroded.solid.isEmpty()) {
		return { solid, hollowed: false, reason: 'no-interior-at-this-wall-thickness' };
	}

	const shell = solid.subtract(eroded.solid);
	if (shell.isEmpty() || shell.status() !== 'NoError') {
		return { solid, hollowed: false, reason: 'shell-subtraction-failed' };
	}

	// Two drain holes on the lowest face, offset from each other so the resin has
	// somewhere to leave and air somewhere to enter.
	const r = drainRadius ?? Math.max(wallThickness * 1.5, bounds.longest * 0.012);
	const depth = bounds.size[1] * 0.5;
	const punch = (x, z) =>
		wasm.Manifold.cylinder(depth, r, r, 24, true).translate([
			bounds.center[0] + x,
			bounds.min[1] + depth * 0.25,
			bounds.center[2] + z,
		]);
	const offset = Math.max(r * 2.5, bounds.longest * 0.05);
	const drained = shell.subtract(punch(-offset, 0)).subtract(punch(offset, 0));
	const finalSolid = drained.isEmpty() || drained.status() !== 'NoError' ? shell : drained;

	return {
		solid: finalSolid,
		hollowed: true,
		reason: null,
		metrics: {
			solidVolume: solid.volume(),
			hollowVolume: finalSolid.volume(),
			wallThickness,
			drainHoles: finalSolid === shell ? 0 : 2,
			drainRadius: r,
		},
	};
}

/** Analytic helpers the quote engine and the report share. */
export const geometry = { boundsOf, signedVolume, surfaceArea };
