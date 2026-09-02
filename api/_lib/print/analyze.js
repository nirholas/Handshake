// The printability report: the one contract every downstream surface reads.
//
// Quotes multiply money by `volume_cm3`. The materialize page renders `score`
// and its named deductions. The fabrication gate reads the geometry summary.
// The operator console shows the frozen copy taken at order time. So this
// module has two hard properties:
//
//   1. DETERMINISTIC. The same bytes produce the same numbers. Every sample
//      below is a fixed stride, never a random draw, and every float that
//      reaches the wire is rounded at a declared precision.
//   2. HONEST ABOUT ITS LIMITS. A metric that was sampled rather than
//      exhaustively computed says so, and a volume the manifold kernel could
//      not vouch for is labelled with its source. A report that quietly
//      guesses is how a buyer pays solid-resin prices for a hollow shell.
//
// The geometry itself lives in the modules this composes: topology.js counts
// edges and shells, bvh.js probes walls and self-intersections, and
// manifold-kernel.js is the arbiter of "is this a closed solid, and what is
// its volume". Nothing is re-implemented here.
//
// Units: glTF geometry is meters. Everything published is millimeters, cubic
// centimeters, or square centimeters, because those are the units a print
// bureau quotes in.

import { boundsOf, weldPositions } from './mesh-io.js';
import { edgeTopology, connectedShells, dropDegenerate, signedVolume, surfaceArea } from './topology.js';
import { buildBvh, sampleWallThickness, countSelfIntersections } from './bvh.js';
import { toSolid } from './manifold-kernel.js';

export const REPORT_VERSION = 1;

// Weld tolerance in meters. 10 microns is far below any printable feature and
// far above the float32 rounding a GLB's POSITION accessor introduces, so it
// closes UV seams without merging genuinely distinct geometry. Without it a
// perfectly closed cube exported from any DCC tool reads as 24 vertices whose
// every edge is a hole.
const WELD_TOLERANCE_M = 1e-5;

// 2,000 BVH raycasts is single-digit milliseconds and dense enough that a thin
// feature covering more than a fraction of a percent of the surface cannot
// hide. Fixed rather than scaled so two analyses of one mesh agree exactly.
const WALL_SAMPLES = 2000;

// Minimum printable wall per material class, millimeters. These are process
// limits (what the machine can resolve), not vendor prices, which is why they
// live beside the analyzer rather than in the tunable price catalog. The
// catalog carries each material's own min wall for quoting; these drive the
// "how big must I print this" recommendation, which exists before any material
// has been chosen.
export const CLASS_MIN_WALL_MM = Object.freeze({
	resin: 0.6,
	sls_nylon: 0.8,
	full_color: 2.0,
	fdm_draft: 1.2,
	metal: 1.0,
});

const round = (v, places) => {
	if (v === null || !Number.isFinite(v)) return null;
	const f = 10 ** places;
	return Math.round(v * f) / f;
};

/**
 * Score 0-100 with named, individually explainable deductions. The UI renders
 * this list verbatim, so every `detail` string is buyer-readable and says what
 * the defect means for the printed object rather than naming a mesh property.
 */
function scoreReport(facts) {
	const deductions = [];
	const deduct = (id, points, detail) => {
		if (points > 0) deductions.push({ id, points: round(points, 1), detail });
	};

	if (!facts.manifold) {
		deduct('non_manifold', 30, 'The surface is not a closed solid, so it has to be reconstructed before it can be printed.');
	}
	if (facts.open_edges > 0) {
		// A handful of boundary edges is a small hole; thousands means the model
		// is really a surface, not an object. Scale by the share of the perimeter
		// that is open, capped so this alone can never dominate the score.
		const share = facts.edge_count > 0 ? facts.open_edges / facts.edge_count : 0;
		deduct('open_edges', Math.min(20, 4 + share * 200), `${facts.open_edges} boundary edges leave holes in the surface.`);
	}
	if (facts.non_manifold_edges > 0) {
		deduct('non_manifold_edges', Math.min(12, 3 + facts.non_manifold_edges / 50), `${facts.non_manifold_edges} edges are shared by more than two faces, so the surface has no single inside.`);
	}
	if (facts.self_intersections > 0) {
		deduct('self_intersections', Math.min(15, 5 + facts.self_intersections / 200), `${facts.self_intersections} pairs of faces pass through each other.`);
	}
	if (facts.shells > 1) {
		deduct('multiple_shells', Math.min(10, 3 + facts.shells), `The model is ${facts.shells} separate bodies, which arrive as ${facts.shells} loose pieces unless they are joined.`);
	}
	if (facts.degenerate_triangles > 0) {
		deduct('degenerate_triangles', Math.min(5, facts.degenerate_triangles / 100), `${facts.degenerate_triangles} triangles have no area and confuse a slicer.`);
	}
	if (facts.min_wall_mm !== null && facts.min_wall_mm < CLASS_MIN_WALL_MM.resin) {
		const ratio = facts.min_wall_mm / CLASS_MIN_WALL_MM.resin;
		deduct('thin_walls', Math.min(18, 6 + (1 - ratio) * 12), `The thinnest wall measures ${facts.min_wall_mm} mm at this size, under the ${CLASS_MIN_WALL_MM.resin} mm a resin printer can hold. Printing it larger fixes this.`);
	}
	if (facts.triangles > 1_000_000) {
		deduct('triangle_budget', 4, `${facts.triangles} triangles is heavier than any printer needs; preparation will decimate it.`);
	}

	const total = deductions.reduce((sum, d) => sum + d.points, 0);
	return { score: Math.max(0, Math.round(100 - total)), deductions };
}

/**
 * How tall the object must be printed for its thinnest wall to clear each
 * process's resolution. Null when no wall could be measured, which happens on
 * an open surface with nothing behind it.
 */
function recommendedHeights(minWallMm, heightMm) {
	if (!minWallMm || !heightMm || minWallMm <= 0) return null;
	const out = {};
	for (const [cls, minWall] of Object.entries(CLASS_MIN_WALL_MM)) {
		out[cls] = round(Math.max(heightMm, (heightMm * minWall) / minWallMm), 1);
	}
	return out;
}

/**
 * Produce the printability report for a mesh loaded by mesh-io.js.
 *
 * @param {object} mesh the loadMesh() result
 * @param {{ sourceUrl?: string|null, wallSamples?: number }} [opts]
 */
export async function analyzeMesh(mesh, opts = {}) {
	const welded = weldPositions(mesh.positions, mesh.indices, WELD_TOLERANCE_M);
	const cleaned = dropDegenerate(welded.positions, welded.indices);
	const positions = welded.positions;
	const indices = cleaned.indices;

	const bounds = boundsOf(positions);
	if (!bounds || indices.length < 3) {
		throw new Error('mesh has no printable geometry after welding');
	}

	const topology = edgeTopology(indices);
	const shellList = connectedShells(indices, topology.edges);
	const triangleCount = indices.length / 3;

	// The manifold kernel is the arbiter of "is this a solid". When it accepts
	// the mesh its volume is exact; when it refuses, the divergence-theorem sum
	// over the soup is the best number available and is labelled as such so no
	// downstream reader mistakes an estimate for a measurement.
	let manifoldSolid = false;
	let volumeM3;
	let volumeSource = 'signed_sum';
	let genus = null;
	const solid = await toSolid(positions, indices);
	if (solid) {
		manifoldSolid = true;
		volumeM3 = Math.abs(solid.volume());
		volumeSource = 'manifold';
		genus = solid.genus();
		solid.delete?.();
	} else {
		volumeM3 = Math.abs(signedVolume(positions, indices));
	}

	const { geometry, bvh } = buildBvh(positions, indices);
	const walls = sampleWallThickness(
		{ positions, indices, bvh },
		{ samples: opts.wallSamples ?? WALL_SAMPLES, diagonal: bounds.diagonal },
	);
	const selfIntersections = countSelfIntersections({ positions, indices, bvh, geometry });

	const heightMm = round(bounds.size[1] * 1000, 2);
	const minWallMm = round(walls.p05 === null ? null : walls.p05 * 1000, 3);
	const medianWallMm = round(walls.median === null ? null : walls.median * 1000, 3);

	const facts = {
		manifold: manifoldSolid,
		shells: shellList.length,
		open_edges: topology.openEdges,
		non_manifold_edges: topology.nonManifoldEdges,
		edge_count: topology.edgeCount,
		degenerate_triangles: cleaned.removed,
		self_intersections: selfIntersections.count,
		min_wall_mm: minWallMm,
		triangles: triangleCount,
	};
	const { score, deductions } = scoreReport(facts);

	return {
		version: REPORT_VERSION,
		manifold: manifoldSolid,
		watertight: manifoldSolid && topology.openEdges === 0,
		shells: shellList.length,
		open_edges: topology.openEdges,
		non_manifold_edges: topology.nonManifoldEdges,
		flipped_edges: topology.flippedEdges,
		degenerate_triangles: cleaned.removed,
		self_intersections: selfIntersections.count,
		self_intersections_scan: selfIntersections.scanned,
		genus,
		triangles: triangleCount,
		vertices: positions.length / 3,
		source_triangles: mesh.triangleCount,
		source_vertices: mesh.vertexCount,
		bbox_mm: {
			x: round(bounds.size[0] * 1000, 2),
			y: heightMm,
			z: round(bounds.size[2] * 1000, 2),
			diagonal: round(bounds.diagonal * 1000, 2),
		},
		volume_cm3: round(volumeM3 * 1e6, 4),
		volume_source: volumeSource,
		surface_area_cm2: round(surfaceArea(positions, indices) * 1e4, 3),
		min_wall_mm: minWallMm,
		median_wall_mm: medianWallMm,
		recommended_min_height_mm: recommendedHeights(minWallMm, heightMm),
		has_textures: Boolean(mesh.hasTextures),
		color_source: mesh.colorSource || 'none',
		materials: mesh.materials ?? null,
		skipped_primitives: mesh.skippedPrimitives ?? 0,
		size_bytes: mesh.sizeBytes ?? null,
		sampling: {
			weld_tolerance_mm: round(WELD_TOLERANCE_M * 1000, 4),
			wall_rays_cast: walls.samples,
			wall_rays_hit: walls.measured,
			wall_percentile: 5,
			self_intersection_triangles_tested: selfIntersections.tested,
			self_intersection_capped: selfIntersections.capped,
		},
		score,
		deductions,
		source_url: opts.sourceUrl ?? null,
	};
}
