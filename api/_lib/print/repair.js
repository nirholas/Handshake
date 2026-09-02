// Turn a triangle soup into a solid a printer can fill, then put it at the size
// and wall thickness the buyer paid for.
//
// The pipeline has a strict order because each stage removes a class of defect
// the next one cannot survive:
//
//   1. weld          seams split by UV/normal authoring read as holes
//   2. de-degenerate a zero-area face is a hole the reconstruction cannot close
//   3. orient        a mirrored face inverts "inside" for half the shell
//   4. fill holes    a centroid fan closes every boundary loop
//   5. reconstruct   Manifold takes each closed shell, union merges them
//   6. offset shell  the fallback when a shell is still not 2-manifold
//
// Stage 6 exists because "we could not fix it" is not an answer a buyer can
// act on. When a shell has non-manifold junctions that filling cannot resolve
// (self-touching hair, a fan of coincident faces, a Klein-bottle artefact of
// generation), the surface is rebuilt from its distance field as a closed shell
// at a bounded voxel resolution. It costs fidelity and says so in the metrics;
// it never fails.
//
// Every stage returns before/after numbers so the surface can show the buyer
// exactly what the platform changed about their model before they pay for it.

import { weldPositions, boundsOf } from './mesh-io.js';
import {
	dropDegenerate,
	edgeTopology,
	connectedShells,
	orientShell,
	fillHoles,
	extractShell,
	signedVolume,
	triangleArea,
} from './topology.js';
import { makeSignedDistance, makeUnsignedDistance } from './sampling.js';

// glTF is metres by the spec; every print number a human reads is millimetres.
export const MM_PER_UNIT = 1000;

// Voxel budget for the level-set stages. 250k samples is roughly 2.5 s of BVH
// closest-point work on this runtime, which keeps a fallback repair inside a
// request while still resolving features around 1/60th of the model's height.
const LEVEL_SET_SAMPLES = 250_000;

// A shell smaller than this fraction of the largest shell's triangle count is
// generation debris (a stray quad, an orphaned eyelash) and is dropped rather
// than unioned, which keeps the solid's bounding box honest.
const DEBRIS_SHELL_RATIO = 0.0005;

let modulePromise = null;

/**
 * One initialised Manifold WASM module per process. The library ships plain
 * WASM with no native binding, so it loads in the API container exactly as it
 * does locally; the async setup is memoised because instantiating the module
 * per request would dominate the cost of a small mesh.
 */
export async function manifoldModule() {
	if (!modulePromise) {
		modulePromise = (async () => {
			const mod = await import('manifold-3d');
			const factory = mod.default ?? mod;
			const wasm = await factory();
			wasm.setup();
			return wasm;
		})();
	}
	return modulePromise;
}

export class RepairError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'RepairError';
		this.code = code;
	}
}

function toManifoldMesh(wasm, positions, indices) {
	return new wasm.Mesh({
		numProp: 3,
		vertProperties: Float32Array.from(positions),
		triVerts: Uint32Array.from(indices),
	});
}

/**
 * Rebuild a closed surface from the distance field of an arbitrary soup.
 *
 * `level` is what makes it work on open geometry: sampling the UNSIGNED
 * distance and extracting the surface at a small positive level produces the
 * offset shell around whatever was there, so a single open plane becomes a thin
 * closed slab rather than nothing. On geometry that is already closed the
 * signed field is used instead, which reproduces the original surface without
 * the offset's thickening.
 */
function levelSetSolid(wasm, positions, indices, { closed, bounds, offset }) {
	const sample = closed
		? makeSignedDistance(positions, indices)
		: makeUnsignedDistance(positions, indices);
	const pad = offset * 3;
	const min = [bounds.min[0] - pad, bounds.min[1] - pad, bounds.min[2] - pad];
	const max = [bounds.max[0] + pad, bounds.max[1] + pad, bounds.max[2] + pad];
	const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	const volume = Math.max(span[0] * span[1] * span[2], Number.MIN_VALUE);
	// Solve for the edge length that spends the sample budget on this box.
	let edge = Math.cbrt(volume / LEVEL_SET_SAMPLES);
	edge = Math.min(edge, Math.max(span[0], span[1], span[2]) / 8);
	// Manifold's level set takes the field as "positive inside", so an unsigned
	// distance is negated and shifted by the offset to give the shell.
	const field = closed
		? (p) => -sample(p[0], p[1], p[2])
		: (p) => offset - sample(p[0], p[1], p[2]);
	const solid = wasm.Manifold.levelSet(field, { min, max }, edge, 0);
	return { solid, edge, offset: closed ? 0 : offset };
}

/**
 * Reconstruct a printable solid from a loaded mesh.
 *
 * Returns the Manifold solid plus a metrics record describing every change
 * made. The caller owns the solid and must delete() it; every intermediate is
 * released here.
 *
 * @param {{positions: Float64Array, indices: Uint32Array}} mesh
 * @param {{weldTolerance?: number, fillHoles?: boolean}} [opts]
 */
export async function reconstruct(mesh, opts = {}) {
	const wasm = await manifoldModule();
	const sourceBounds = boundsOf(mesh.positions);
	if (!sourceBounds || !(sourceBounds.diagonal > 0)) {
		throw new RepairError('degenerate_input', 'model has no measurable extent');
	}

	// Weld tolerance scales with the model so it behaves the same whether the
	// asset was authored in metres, centimetres or arbitrary units.
	const tolerance = opts.weldTolerance ?? sourceBounds.diagonal * 1e-6;
	const welded = weldPositions(mesh.positions, mesh.indices, tolerance);
	const areaEpsilon = (sourceBounds.diagonal * 1e-7) ** 2;
	const cleaned = dropDegenerate(welded.positions, welded.indices, areaEpsilon);

	const metrics = {
		method: null,
		tolerance,
		welded_vertices: mesh.positions.length / 3 - welded.positions.length / 3,
		degenerate_removed: cleaned.removed,
		shells_in: 0,
		shells_used: 0,
		shells_dropped: 0,
		holes_filled: 0,
		patch_triangles: 0,
		unclosed_loops: 0,
		faces_reoriented: 0,
		level_set_shells: 0,
		level_set_edge_mm: null,
		triangles_in: mesh.indices.length / 3,
		triangles_out: 0,
	};

	if (cleaned.indices.length < 12) {
		throw new RepairError('degenerate_input', 'model has no triangles left after cleanup');
	}

	const topology = edgeTopology(cleaned.indices);
	const shells = connectedShells(cleaned.indices, topology.edges);
	metrics.shells_in = shells.length;
	const largest = shells[0]?.length ?? 0;

	const solids = [];
	for (const tris of shells) {
		if (tris.length < largest * DEBRIS_SHELL_RATIO || tris.length < 4) {
			metrics.shells_dropped += 1;
			continue;
		}
		const oriented = orientShell(welded.positions, cleaned.indices, tris);
		metrics.faces_reoriented += oriented.flipped;
		let shell = extractShell(welded.positions, oriented.indices);
		if (opts.fillHoles !== false) {
			const filled = fillHoles(shell.positions, shell.indices);
			metrics.holes_filled += filled.filled;
			metrics.patch_triangles += filled.addedTriangles;
			metrics.unclosed_loops += filled.unclosedLoops;
			shell = { positions: filled.positions, indices: filled.indices };
		}
		let solid = null;
		try {
			const mm = toManifoldMesh(wasm, shell.positions, shell.indices);
			mm.merge();
			solid = wasm.Manifold.ofMesh(mm);
			if (solid.status() !== 0 || solid.isEmpty()) {
				solid.delete();
				solid = null;
			}
		} catch {
			solid = null;
		}
		if (!solid) {
			// Still not 2-manifold after filling: rebuild it from its distance
			// field. Never a failure path, only a lower-fidelity one.
			const shellBounds = boundsOf(shell.positions);
			const closed = signedVolume(shell.positions, shell.indices) !== 0 && edgeTopology(shell.indices).openEdges === 0;
			const offset = shellBounds.diagonal * 0.004;
			const built = levelSetSolid(wasm, shell.positions, shell.indices, {
				closed,
				bounds: shellBounds,
				offset,
			});
			metrics.level_set_shells += 1;
			metrics.level_set_edge_mm = Math.max(
				metrics.level_set_edge_mm ?? 0,
				built.edge * MM_PER_UNIT,
			);
			solid = built.solid;
			if (solid.isEmpty()) {
				solid.delete();
				metrics.shells_dropped += 1;
				continue;
			}
		}
		solids.push(solid);
		metrics.shells_used += 1;
	}

	if (solids.length === 0) {
		throw new RepairError('unrepairable', 'no shell of this model could be closed into a solid');
	}

	// Union rather than compose: two shells that overlap in space are one object
	// to a printer, and the boolean is what removes the internal wall between
	// them. A single shell skips the boolean entirely.
	let solid = solids[0];
	if (solids.length > 1) {
		solid = wasm.Manifold.union(solids);
		for (const s of solids) s.delete();
	}
	metrics.method = metrics.level_set_shells > 0 ? 'level_set' : 'manifold_union';
	metrics.triangles_out = solid.numTri();
	return { solid, metrics, wasm };
}

/**
 * Uniformly scale a solid so its Y extent (glTF is Y-up) matches the requested
 * print height. Returns the new solid and the scale that was applied; the
 * caller keeps the factor because every wall-thickness number measured before
 * the scale must be multiplied by it.
 */
export function scaleToHeight(wasm, solid, targetHeightMm) {
	const box = solid.boundingBox();
	const heightUnits = box.max[1] - box.min[1];
	if (!(heightUnits > 0)) {
		throw new RepairError('degenerate_input', 'model has zero height and cannot be scaled');
	}
	const factor = targetHeightMm / (heightUnits * MM_PER_UNIT);
	const scaled = solid.scale([factor, factor, factor]);
	return { solid: scaled, factor };
}

/**
 * Hollow a solid into a shell of `wallMm`, with drain holes.
 *
 * Resin is sold by volume, so hollowing a 150 mm figurine typically removes 80%
 * of its material cost. It is only safe when the wall survives the erosion
 * everywhere, so the caller passes the measured minimum wall and this refuses
 * (with a reason, never silently) when the model is already thinner than twice
 * the requested wall.
 *
 * Drain holes are mandatory, not optional: a sealed resin shell traps uncured
 * liquid, which is both a print failure and a chemical hazard in the box. Two
 * holes are cut on the underside so the cavity can vent as it drains.
 */
export function hollowSolid(wasm, solid, { wallMm, minWallMm, drainHoleMm = 3.5 }) {
	const box = solid.boundingBox();
	const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
	const sizeMm = size.map((v) => v * MM_PER_UNIT);
	const reason = (code, message) => ({ solid: null, applied: false, code, message });

	if (!(wallMm > 0)) return reason('invalid_wall', 'hollow wall thickness must be positive');
	if (Math.min(...sizeMm) < wallMm * 6) {
		return reason(
			'too_small',
			`model is ${Math.min(...sizeMm).toFixed(1)} mm across its thinnest axis, too small to hollow at a ${wallMm} mm wall`,
		);
	}
	if (Number.isFinite(minWallMm) && minWallMm > 0 && minWallMm < wallMm * 2) {
		return reason(
			'too_thin',
			`thinnest wall is ${minWallMm.toFixed(2)} mm, so a ${wallMm} mm hollow would break through it`,
		);
	}

	const wallUnits = wallMm / MM_PER_UNIT;
	const mesh = solid.getMesh();
	const positions = Float64Array.from(mesh.vertProperties);
	const indices = Uint32Array.from(mesh.triVerts);
	// Strip the extra properties Manifold may carry per vertex: the distance
	// field only reads positions.
	const stride = mesh.numProp;
	let plain = positions;
	if (stride !== 3) {
		plain = new Float64Array((positions.length / stride) * 3);
		for (let i = 0, o = 0; i < positions.length; i += stride, o += 3) {
			plain[o] = positions[i];
			plain[o + 1] = positions[i + 1];
			plain[o + 2] = positions[i + 2];
		}
	}

	const sample = makeSignedDistance(plain, indices);
	const min = [box.min[0], box.min[1], box.min[2]];
	const max = [box.max[0], box.max[1], box.max[2]];
	const volume = Math.max(size[0] * size[1] * size[2], Number.MIN_VALUE);
	let edge = Math.cbrt(volume / LEVEL_SET_SAMPLES);
	// The cavity wall must be resolvable by the grid or the erosion tears.
	edge = Math.min(edge, wallUnits / 1.5);
	const core = wasm.Manifold.levelSet(
		(p) => -(sample(p[0], p[1], p[2]) + wallUnits),
		{ min, max },
		edge,
		0,
	);
	if (core.isEmpty()) {
		core.delete();
		return reason('no_cavity', `a ${wallMm} mm wall leaves no cavity to remove in this model`);
	}

	// Two drains through the base: a single hole airlocks and will not drain.
	const holeRadius = drainHoleMm / 2 / MM_PER_UNIT;
	const holeDepth = size[1] * 0.5;
	const offsets = [
		[box.min[0] + size[0] * 0.3, box.min[2] + size[2] * 0.5],
		[box.min[0] + size[0] * 0.7, box.min[2] + size[2] * 0.5],
	];
	const drains = offsets.map(([x, z]) => {
		const cyl = wasm.Manifold.cylinder(holeDepth, holeRadius, holeRadius, 24, false);
		return cyl.translate([x, box.min[1] - holeDepth * 0.05, z]);
	});
	const cavity = wasm.Manifold.union([core, ...drains]);
	const shell = solid.subtract(cavity);
	const solidVolume = solid.volume();
	const shellVolume = shell.volume();
	core.delete();
	for (const d of drains) d.delete();
	cavity.delete();

	if (!(shellVolume > 0) || shell.isEmpty()) {
		shell.delete();
		return reason('hollow_failed', 'hollowing produced no printable shell');
	}
	return {
		solid: shell,
		applied: true,
		wall_mm: wallMm,
		drain_holes: drains.length,
		drain_hole_mm: drainHoleMm,
		volume_saved_ratio: solidVolume > 0 ? 1 - shellVolume / solidVolume : 0,
		voxel_mm: edge * MM_PER_UNIT,
	};
}

/**
 * Reduce a solid to a triangle budget. Manifold's own simplify is tolerance
 * based, so the tolerance is searched (a handful of doublings) until the mesh
 * fits, which keeps the geometric error the smallest one that meets the budget
 * rather than an arbitrary constant.
 */
export function decimateSolid(solid, budget) {
	const before = solid.numTri();
	if (!Number.isFinite(budget) || budget <= 0 || before <= budget) {
		return { solid, applied: false, triangles_before: before, triangles_after: before };
	}
	const box = solid.boundingBox();
	const diagonal = Math.hypot(
		box.max[0] - box.min[0],
		box.max[1] - box.min[1],
		box.max[2] - box.min[2],
	);
	let tolerance = diagonal * 1e-5;
	let current = solid;
	let applied = false;
	for (let step = 0; step < 12; step += 1) {
		const next = current.simplify(tolerance);
		if (applied) current.delete();
		current = next;
		applied = true;
		if (current.numTri() <= budget) break;
		tolerance *= 2;
	}
	return {
		solid: current,
		applied,
		tolerance,
		triangles_before: before,
		triangles_after: current.numTri(),
	};
}

/** Manifold solid to the plain indexed soup every exporter in this directory reads. */
export function solidToMesh(solid) {
	const mesh = solid.getMesh();
	const stride = mesh.numProp;
	const source = mesh.vertProperties;
	const count = source.length / stride;
	const positions = new Float64Array(count * 3);
	for (let i = 0; i < count; i += 1) {
		positions[i * 3] = source[i * stride];
		positions[i * 3 + 1] = source[i * stride + 1];
		positions[i * 3 + 2] = source[i * stride + 2];
	}
	return { positions, indices: Uint32Array.from(mesh.triVerts) };
}

/** Total area of an indexed soup, used for the print-time surface estimate. */
export function meshArea(positions, indices) {
	let total = 0;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		total += triangleArea(positions, indices[i], indices[i + 1], indices[i + 2]);
	}
	return total;
}
