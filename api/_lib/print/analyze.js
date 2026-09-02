// The printability report: the one contract every downstream surface reads.
//
// Quotes multiply money by `volume_cm3`. The materialize page renders `score`
// and its named deductions. The fabrication gate reads the geometry summary.
// The operator console shows the frozen copy taken at order time. So this
// module has two hard properties, and both are tested:
//
//   1. DETERMINISTIC. The same bytes produce byte-identical numbers. Every
//      sample here is taken on a fixed stride, never a random draw, and every
//      float that reaches the wire is rounded at a declared precision.
//   2. HONEST ABOUT ITS LIMITS. A metric that was sampled rather than
//      exhaustively computed says so in `sampling`, and a number the manifold
//      kernel could not vouch for is labelled with its `source`. A print
//      report that quietly guesses is how a buyer gets a hollow shell they
//      paid solid-resin prices for.
//
// Units: glTF geometry is in meters. Everything the report publishes is in
// millimeters, cubic centimeters, or square centimeters, because those are
// the units a print bureau quotes in.

import * as THREE from 'three';
import { MeshBVH, ExtendedTriangle } from 'three-mesh-bvh';
import { boundsOf, weldPositions } from './mesh-io.js';
import { edgeTopology, connectedShells, signedVolume, surfaceArea } from './topology.js';
import { toSolid } from './manifold-kernel.js';

export const REPORT_VERSION = 1;

// Weld tolerance in meters. 10 microns is far below any printable feature and
// far above the float32 rounding a GLB's POSITION accessor introduces, so it
// closes seams without merging genuinely distinct geometry.
const WELD_TOLERANCE_M = 1e-5;

// How many surface points the wall-thickness probe casts from. 2,000 BVH
// raycasts is single-digit milliseconds and is dense enough that a thin
// feature larger than a few percent of the surface cannot hide from it. The
// number is fixed rather than scaled so two analyses of the same mesh agree.
const WALL_SAMPLES = 2000;

// Triangle budget for the exhaustive self-intersection scan. Above it the scan
// runs on a deterministic stride and the report says so, because an O(n log n)
// pass over a million triangles is not a request-time operation.
const SELF_INTERSECTION_FULL_LIMIT = 120_000;
const SELF_INTERSECTION_SAMPLES = 40_000;

// Minimum printable wall per material class, millimeters. These are process
// limits (what the machine can resolve), not vendor prices, which is why they
// live beside the analyzer rather than in the tunable price catalog. The
// catalog carries each material's own min wall for quoting; these drive the
// "how big must I print this" recommendation, which exists before any
// material is chosen.
export const CLASS_MIN_WALL_MM = {
	resin: 0.6,
	sls_nylon: 0.8,
	full_color: 2.0,
	fdm_draft: 1.2,
	metal: 1.0,
};

const round = (v, places) => {
	const f = 10 ** places;
	return Math.round(v * f) / f;
};

/**
 * Deterministic surface sampling: walk triangles on a fixed stride and probe
 * the barycentric point that is offset from the centroid, so a ray never
 * leaves exactly along a shared edge (which returns a doubled hit and a
 * meaningless distance).
 */
function sampleTriangles(triangleCount, wanted) {
	const n = Math.min(triangleCount, wanted);
	if (n <= 0) return [];
	const stride = Math.max(1, Math.floor(triangleCount / n));
	const out = [];
	for (let t = 0; t < triangleCount && out.length < n; t += stride) out.push(t);
	return out;
}

/**
 * Wall thickness at a surface point: fire a ray along the inward normal and
 * measure the distance to the first back-facing surface it meets. A hit at
 * effectively zero distance is the origin triangle itself and is discarded.
 *
 * Returns the sorted thickness samples in meters.
 */
function sampleWallThickness(bvh, positions, indices, triangleIds, diagonal) {
	const ray = new THREE.Ray();
	const origin = new THREE.Vector3();
	const dir = new THREE.Vector3();
	const ab = new THREE.Vector3();
	const ac = new THREE.Vector3();
	const va = new THREE.Vector3();
	const vb = new THREE.Vector3();
	const vc = new THREE.Vector3();
	// Push the ray origin just under the surface so the source triangle is
	// behind it. One part in 100,000 of the model diagonal is well below any
	// printable feature and well above float precision.
	const epsilon = diagonal * 1e-5;
	const samples = [];

	for (const t of triangleIds) {
		const a = indices[t * 3] * 3;
		const b = indices[t * 3 + 1] * 3;
		const c = indices[t * 3 + 2] * 3;
		va.set(positions[a], positions[a + 1], positions[a + 2]);
		vb.set(positions[b], positions[b + 1], positions[b + 2]);
		vc.set(positions[c], positions[c + 1], positions[c + 2]);
		ab.subVectors(vb, va);
		ac.subVectors(vc, va);
		dir.crossVectors(ab, ac);
		if (dir.lengthSq() === 0) continue;
		dir.normalize().negate();
		// Barycentric (0.4, 0.35, 0.25): interior, and never the centroid, so a
		// symmetric mesh does not concentrate every probe on one axis.
		origin
			.copy(va)
			.multiplyScalar(0.4)
			.addScaledVector(vb, 0.35)
			.addScaledVector(vc, 0.25)
			.addScaledVector(dir, epsilon);
		ray.set(origin, dir);
		const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, diagonal * 2);
		if (!hit) continue;
		const thickness = hit.distance + epsilon;
		if (thickness > epsilon * 2) samples.push(thickness);
	}
	samples.sort((x, y) => x - y);
	return samples;
}

/** Value at a percentile of an ascending sample array. */
function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
	return sorted[i];
}

/**
 * Count triangle pairs that pass through each other. Adjacent triangles (any
 * shared welded vertex) are skipped: they meet by construction and are not a
 * defect.
 */
function countSelfIntersections(bvh, positions, indices, triangleIds) {
	const query = new ExtendedTriangle();
	const box = new THREE.Box3();
	let count = 0;
	const seen = new Set();

	for (const t of triangleIds) {
		const ia = indices[t * 3];
		const ib = indices[t * 3 + 1];
		const ic = indices[t * 3 + 2];
		query.a.set(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]);
		query.b.set(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]);
		query.c.set(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]);
		query.needsUpdate = true;
		box.makeEmpty().expandByPoint(query.a).expandByPoint(query.b).expandByPoint(query.c);

		bvh.shapecast({
			intersectsBounds: (bounds) => bounds.intersectsBox(box),
			intersectsTriangle: (other, otherIndex) => {
				if (otherIndex === t) return false;
				const oa = indices[otherIndex * 3];
				const ob = indices[otherIndex * 3 + 1];
				const oc = indices[otherIndex * 3 + 2];
				if (
					oa === ia || oa === ib || oa === ic ||
					ob === ia || ob === ib || ob === ic ||
					oc === ia || oc === ib || oc === ic
				) {
					return false;
				}
				const key = t < otherIndex ? `${t}:${otherIndex}` : `${otherIndex}:${t}`;
				if (seen.has(key)) return false;
				if (other.intersectsTriangle(query)) {
					seen.add(key);
					count += 1;
				}
				return false;
			},
		});
	}
	return count;
}

/**
 * Build a BVH over a welded soup. three-mesh-bvh wants a BufferGeometry, and
 * its raycasts run in float32, which is why every distance it returns is
 * treated as a sample rather than an exact measurement.
 */
function buildBvh(positions, indices) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3));
	geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1));
	return new MeshBVH(geometry);
}

/**
 * Score the mesh 0-100 with named, individually explainable deductions. The UI
 * renders this list verbatim, so every `detail` string is buyer-readable.
 */
function scoreReport(facts) {
	const deductions = [];
	const deduct = (id, points, detail) => {
		if (points > 0) deductions.push({ id, points: round(points, 1), detail });
	};

	if (!facts.manifold) {
		deduct('non_manifold', 30, 'The surface is not a closed solid, so it has to be reconstructed before printing.');
	}
	if (facts.open_edges > 0) {
		// A handful of boundary edges is a small hole; thousands is a mesh that
		// is really a surface. Scale the penalty by how much of the perimeter is
		// open, capped so it can never dominate the whole score on its own.
		const share = facts.edge_count > 0 ? facts.open_edges / facts.edge_count : 0;
		deduct('open_edges', Math.min(20, 4 + share * 200), `${facts.open_edges} boundary edges form holes in the surface.`);
	}
	if (facts.non_manifold_edges > 0) {
		deduct('non_manifold_edges', Math.min(12, 3 + facts.non_manifold_edges / 50), `${facts.non_manifold_edges} edges are shared by more than two faces.`);
	}
	if (facts.self_intersections > 0) {
		deduct('self_intersections', Math.min(15, 5 + facts.self_intersections / 200), `${facts.self_intersections} pairs of faces pass through each other.`);
	}
	if (facts.shells > 1) {
		deduct('multiple_shells', Math.min(10, 3 + facts.shells), `The model is ${facts.shells} separate bodies, which print as ${facts.shells} loose pieces.`);
	}
	if (facts.degenerate_triangles > 0) {
		deduct('degenerate_triangles', Math.min(5, facts.degenerate_triangles / 100), `${facts.degenerate_triangles} triangles have zero area.`);
	}
	if (facts.min_wall_mm !== null && facts.min_wall_mm < CLASS_MIN_WALL_MM.resin) {
		const ratio = facts.min_wall_mm / CLASS_MIN_WALL_MM.resin;
		deduct('thin_walls', Math.min(18, 6 + (1 - ratio) * 12), `The thinnest measured wall is ${facts.min_wall_mm} mm, below the ${CLASS_MIN_WALL_MM.resin} mm a resin printer can hold at this size.`);
	}
	if (facts.triangles > 1_000_000) {
		deduct('triangle_budget', 4, `${facts.triangles} triangles is heavier than any printer needs; it will be decimated during preparation.`);
	}

	const total = deductions.reduce((sum, d) => sum + d.points, 0);
	return { score: Math.max(0, Math.round(100 - total)), deductions };
}

/**
 * Recommended minimum print height per material class: how tall the object has
 * to be printed for its thinnest wall to clear that process's resolution.
 * Null when no wall could be measured (an open surface with nothing behind it).
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
 * Produce the printability report for a loaded mesh.
 *
 * @param {{ positions: Float64Array, indices: Uint32Array, triangleCount: number,
 *   vertexCount: number, hasTextures: boolean, colorSource: string, sizeBytes: number,
 *   materials: number, skippedPrimitives: number }} mesh from loadMesh()
 * @param {{ sourceUrl?: string|null }} [opts]
 */
export async function analyzeMesh(mesh, opts = {}) {
	const welded = weldPositions(mesh.positions, mesh.indices, WELD_TOLERANCE_M);
	const bounds = boundsOf(welded.positions);
	if (!bounds) {
		throw new Error('mesh has no finite bounds');
	}

	const topology = edgeTopology(welded.indices);
	const shellList = connectedShells(welded.indices, topology.edges);
	const census = {
		openEdges: topology.openEdges,
		nonManifoldEdges: topology.nonManifoldEdges,
		edgeCount: topology.edgeCount,
		degenerateTriangles: 0,
	};
	const shellInfo = { count: shellList.length };
	const triangleCount = welded.indices.length / 3;

	// The manifold kernel is the arbiter of "is this a solid". When it accepts
	// the mesh its volume is exact; when it refuses, the divergence-theorem sum
	// over the soup is the best available number and is labelled as such.
	let manifold = false;
	let volumeM3 = null;
	let volumeSource = 'signed_sum';
	let genus = null;
	const solid = await toSolid(welded.positions, welded.indices);
	if (solid) {
		manifold = true;
		volumeM3 = Math.abs(solid.volume());
		volumeSource = 'manifold';
		genus = solid.genus();
		solid.delete?.();
	} else {
		volumeM3 = Math.abs(signedVolume(welded.positions, welded.indices));
	}

	const bvh = buildBvh(welded.positions, welded.indices);
	const wallIds = sampleTriangles(triangleCount, WALL_SAMPLES);
	const wallSamples = sampleWallThickness(bvh, welded.positions, welded.indices, wallIds, bounds.diagonal);

	const fullScan = triangleCount <= SELF_INTERSECTION_FULL_LIMIT;
	const siIds = fullScan
		? sampleTriangles(triangleCount, triangleCount)
		: sampleTriangles(triangleCount, SELF_INTERSECTION_SAMPLES);
	const selfIntersections = countSelfIntersections(bvh, welded.positions, welded.indices, siIds);

	const areaM2 = surfaceArea(welded.positions, welded.indices);
	const heightMm = round(bounds.size[1] * 1000, 2);
	const minWallM = percentile(wallSamples, 1);
	const minWallMm = minWallM === null ? null : round(minWallM * 1000, 3);
	const medianWallMm = wallSamples.length ? round(percentile(wallSamples, 50) * 1000, 3) : null;

	const facts = {
		manifold,
		shells: shellInfo.count,
		open_edges: census.openEdges,
		non_manifold_edges: census.nonManifoldEdges,
		edge_count: census.edgeCount,
		degenerate_triangles: census.degenerateTriangles,
		self_intersections: selfIntersections,
		min_wall_mm: minWallMm,
		triangles: triangleCount,
	};
	const { score, deductions } = scoreReport(facts);

	return {
		version: REPORT_VERSION,
		manifold,
		watertight: manifold && census.openEdges === 0,
		shells: shellInfo.count,
		open_edges: census.openEdges,
		non_manifold_edges: census.nonManifoldEdges,
		degenerate_triangles: census.degenerateTriangles,
		self_intersections: selfIntersections,
		self_intersections_exhaustive: fullScan,
		genus,
		triangles: triangleCount,
		vertices: welded.positions.length / 3,
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
		surface_area_cm2: round(areaM2 * 1e4, 3),
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
			wall_rays_requested: WALL_SAMPLES,
			wall_rays_hit: wallSamples.length,
			wall_percentile: 1,
			self_intersection_triangles_scanned: siIds.length,
		},
		score,
		deductions,
		source_url: opts.sourceUrl ?? null,
	};
}
