// Simulation-readiness grading for generated 3D assets.
//
// glb-inspect.js answers "is this valid glTF and does it have a rig?".
// glb-quality.js answers "is this a good-looking mesh or a degenerate blob?".
// This module answers the question a physics simulator asks, which neither of
// them touches: "can I drop this asset into MuJoCo / Isaac / Bullet and get
// correct dynamics without a human editing it first?".
//
// A renderer forgives almost everything. A rigid-body solver does not. It needs
// a closed surface to integrate a volume over, consistent winding so that volume
// is positive, a real-world size so gravity and friction mean anything, and a
// convex proxy so collision queries stay cheap. Generated meshes routinely fail
// every one of those while looking perfect on screen, and the failure only shows
// up as an object that sinks through a floor or spins like it is hollow.
//
// Everything here is deterministic and derived from the mesh itself: no model
// call, no heuristic dressed up as a measurement. Where a value cannot be known
// from the geometry (true physical scale, material density) the report says
// `unknown` rather than inventing one, because a fabricated mass is worse than
// an absent one.
//
// Math, all standard and all exact for a closed triangle soup:
//   volume, centroid   divergence theorem over signed tetrahedra (0, a, b, c)
//   inertia            tetrahedron covariance accumulation, C = det(J) J Ĉ Jᵀ
//                      with Ĉ = (1/120)·[[2,1,1],[1,2,1],[1,1,2]], then
//                      I = tr(C)·1 - C after the parallel-axis shift to the
//                      centroid. Reported at unit density, so mass properties
//                      scale linearly with whatever density a caller assigns.
//   manifoldness       every undirected edge shared by exactly two triangles,
//                      every directed edge traversed exactly once (consistent
//                      winding). Vertices are welded by quantized position
//                      first, because UV/normal seams split vertices that are
//                      geometrically identical and would fake a boundary.
//
// glTF 2.0 defines one unit as one meter, so extents are read as meters. That
// makes "the generator normalized this into a unit box" a detectable, reportable
// condition rather than a silent lie: see `scale.normalizedGuess`.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

// glTF primitive.mode. Only triangles carry a volume; anything else is a
// rendering aid (points, lines, strips we do not de-index here) and is counted
// as a skipped primitive rather than silently folded into the mass properties.
const MODE_TRIANGLES = 4;

// Hull inputs are capped so a million-vertex scan stays interactive; the stride
// is deterministic (every Nth welded point) so the same asset always produces
// the same hull, which matters because the hull volume feeds a published grade.
const HULL_POINT_CAP = 20000;

// The contract string every report carries and every stored grade is keyed by.
// A grade is a claim about what a SPECIFIC grader measured, so the version rides
// with the numbers: a consumer selects behaviour by it, a signed credential
// preserves it permanently, and `where grader_version <> $current` is the
// backfill sweep after a bump. Additive fields, new blocker values, and any
// threshold change other than the two documented in SCALE_BOUNDS all require a
// new string here. Spec: specs/SIM_READINESS.md.
export const SIM_READINESS_VERSION = 'threews.sim.readiness.v1';

// Physical-plausibility window for a rigid-body prop, in meters along the
// longest axis. Below the floor the solver hits its contact epsilon; above the
// ceiling the asset is a set piece, not a prop, and wants a different lane.
export const SCALE_BOUNDS = Object.freeze({ minMeters: 0.005, maxMeters: 20 });

// A normalization signature: generative lanes (TRELLIS, Hunyuan3D, TripoSR)
// emit meshes fitted to a unit or two-unit box centred on the origin. Hitting
// this window means the numbers are real but the units are not the object's.
const NORMALIZED_TARGETS = [1, 2];
const NORMALIZED_TOLERANCE = 0.02;

let ioPromise = null;

// One shared, fully-registered IO. Draco and meshopt are the two compressions
// our own pipeline emits, so a grader that cannot read them would report a
// false failure on our best assets.
async function getIO() {
	if (!ioPromise) {
		ioPromise = (async () => {
			const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
			const dependencies = {};
			try {
				const draco = await import('draco3dgltf');
				const create = draco.default ?? draco;
				dependencies['draco3d.decoder'] = await create.createDecoderModule();
			} catch { /* asset is only ungradeable if it actually uses Draco */ }
			try {
				const { MeshoptDecoder } = await import('meshoptimizer');
				await MeshoptDecoder.ready;
				dependencies['meshopt.decoder'] = MeshoptDecoder;
			} catch { /* same: absence only matters for meshopt-compressed input */ }
			if (Object.keys(dependencies).length) io.registerDependencies(dependencies);
			return io;
		})();
	}
	return ioPromise;
}

function transformPoint(m, x, y, z) {
	// gltf-transform world matrices are column-major, glTF's own convention.
	const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
	return [
		(m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
		(m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
		(m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
	];
}

// Flatten every triangle in the default scene into world space. Returns a flat
// Float64Array of positions plus a Uint32Array of triangle indices, which is the
// only representation the rest of this module needs.
function collectTriangles(document) {
	const positions = [];
	const indices = [];
	let skippedPrimitives = 0;
	let skinnedPrimitives = 0;

	const root = document.getRoot();
	const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
	const nodes = scene ? scene.listChildren() : root.listNodes();
	const seen = new Set();

	const visit = (node) => {
		if (seen.has(node)) return;
		seen.add(node);
		const mesh = node.getMesh();
		if (mesh) {
			const matrix = node.getWorldMatrix();
			const skinned = Boolean(node.getSkin());
			for (const prim of mesh.listPrimitives()) {
				if (prim.getMode() !== MODE_TRIANGLES) { skippedPrimitives += 1; continue; }
				const position = prim.getAttribute('POSITION');
				if (!position) { skippedPrimitives += 1; continue; }
				if (skinned) skinnedPrimitives += 1;
				const base = positions.length / 3;
				const count = position.getCount();
				const p = [0, 0, 0];
				for (let i = 0; i < count; i += 1) {
					position.getElement(i, p);
					const [x, y, z] = transformPoint(matrix, p[0], p[1], p[2]);
					positions.push(x, y, z);
				}
				const index = prim.getIndices();
				if (index) {
					const n = index.getCount();
					for (let i = 0; i + 2 < n; i += 3) {
						indices.push(
							base + index.getScalar(i),
							base + index.getScalar(i + 1),
							base + index.getScalar(i + 2),
						);
					}
				} else {
					for (let i = 0; i + 2 < count; i += 3) indices.push(base + i, base + i + 1, base + i + 2);
				}
			}
		}
		for (const child of node.listChildren()) visit(child);
	};
	for (const node of nodes) visit(node);

	return {
		positions: Float64Array.from(positions),
		indices: Uint32Array.from(indices),
		skippedPrimitives,
		skinnedPrimitives,
	};
}

function boundsOf(positions) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < positions.length; i += 3) {
		for (let a = 0; a < 3; a += 1) {
			const v = positions[i + a];
			if (v < min[a]) min[a] = v;
			if (v > max[a]) max[a] = v;
		}
	}
	if (!Number.isFinite(min[0])) return null;
	const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	return {
		min, max, size,
		diagonal: Math.hypot(size[0], size[1], size[2]),
		longestAxisMeters: Math.max(size[0], size[1], size[2]),
		center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
	};
}

// Weld by quantized position. The tolerance is relative to the model's own size
// so it behaves the same on a 2 cm bolt and a 4 m vehicle.
function weld(positions, indices, tolerance) {
	const inv = 1 / tolerance;
	const map = new Map();
	const remap = new Uint32Array(positions.length / 3);
	const unique = [];
	for (let i = 0, v = 0; i < positions.length; i += 3, v += 1) {
		const key = `${Math.round(positions[i] * inv)},${Math.round(positions[i + 1] * inv)},${Math.round(positions[i + 2] * inv)}`;
		let id = map.get(key);
		if (id === undefined) {
			id = unique.length / 3;
			map.set(key, id);
			unique.push(positions[i], positions[i + 1], positions[i + 2]);
		}
		remap[v] = id;
	}
	const welded = new Uint32Array(indices.length);
	for (let i = 0; i < indices.length; i += 1) welded[i] = remap[indices[i]];
	return { points: Float64Array.from(unique), indices: welded };
}

// Edge-manifold and winding analysis over welded topology. Degenerate triangles
// (two or more identical corners after welding) are excluded from the edge
// counts and reported separately, because counting them turns one authoring
// artifact into a cascade of phantom boundary edges.
function analyzeTopology(indices) {
	const directed = new Map();
	const undirected = new Map();
	let degenerate = 0;
	let triangles = 0;

	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i], b = indices[i + 1], c = indices[i + 2];
		if (a === b || b === c || a === c) { degenerate += 1; continue; }
		triangles += 1;
		const corners = [[a, b], [b, c], [c, a]];
		for (const [u, v] of corners) {
			const dk = `${u}>${v}`;
			directed.set(dk, (directed.get(dk) ?? 0) + 1);
			const uk = u < v ? `${u}|${v}` : `${v}|${u}`;
			undirected.set(uk, (undirected.get(uk) ?? 0) + 1);
		}
	}

	let boundaryEdges = 0;
	let nonManifoldEdges = 0;
	for (const count of undirected.values()) {
		if (count === 1) boundaryEdges += 1;
		else if (count > 2) nonManifoldEdges += 1;
	}
	let reversedEdges = 0;
	for (const count of directed.values()) if (count > 1) reversedEdges += count - 1;

	return {
		triangles,
		degenerateTriangles: degenerate,
		edges: undirected.size,
		boundaryEdges,
		nonManifoldEdges,
		inconsistentWindingEdges: reversedEdges,
		edgeManifold: boundaryEdges === 0 && nonManifoldEdges === 0,
		windingConsistent: reversedEdges === 0,
		watertight: boundaryEdges === 0 && nonManifoldEdges === 0 && reversedEdges === 0,
	};
}

// Volume, centroid and the unit-density inertia tensor about the centroid.
// Exact for a closed, consistently wound surface; on an open one the numbers are
// still returned but the report marks them unreliable via `watertight: false`.
function massProperties(points, indices) {
	let volume = 0;
	const centroidAcc = [0, 0, 0];
	const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	let area = 0;
	// ∫ x xᵀ dV over the canonical tetrahedron (0, e1, e2, e3).
	const CANON = [2 / 120, 1 / 120, 1 / 120, 1 / 120, 2 / 120, 1 / 120, 1 / 120, 1 / 120, 2 / 120];

	for (let i = 0; i + 2 < indices.length; i += 3) {
		const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
		const ax = points[ia], ay = points[ia + 1], az = points[ia + 2];
		const bx = points[ib], by = points[ib + 1], bz = points[ib + 2];
		const cx = points[ic], cy = points[ic + 1], cz = points[ic + 2];

		const nx = by * cz - bz * cy;
		const ny = bz * cx - bx * cz;
		const nz = bx * cy - by * cx;
		const det = ax * nx + ay * ny + az * nz;   // 6 · signed tetra volume
		volume += det / 6;
		centroidAcc[0] += det * (ax + bx + cx) / 24;
		centroidAcc[1] += det * (ay + by + cy) / 24;
		centroidAcc[2] += det * (az + bz + cz) / 24;

		// C_tet = det(J) · J · Ĉ · Jᵀ with J the column matrix [a b c].
		const J = [ax, bx, cx, ay, by, cy, az, bz, cz];
		const JC = new Array(9).fill(0);
		for (let r = 0; r < 3; r += 1) {
			for (let c = 0; c < 3; c += 1) {
				let s = 0;
				for (let k = 0; k < 3; k += 1) s += J[r * 3 + k] * CANON[k * 3 + c];
				JC[r * 3 + c] = s;
			}
		}
		for (let r = 0; r < 3; r += 1) {
			for (let c = 0; c < 3; c += 1) {
				let s = 0;
				for (let k = 0; k < 3; k += 1) s += JC[r * 3 + k] * J[c * 3 + k];  // Jᵀ
				cov[r * 3 + c] += det * s;
			}
		}

		const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
		const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
		const crx = e1y * e2z - e1z * e2y;
		const cry = e1z * e2x - e1x * e2z;
		const crz = e1x * e2y - e1y * e2x;
		area += Math.hypot(crx, cry, crz) / 2;
	}

	const surfaceArea = area;
	if (!Number.isFinite(volume) || Math.abs(volume) < 1e-18) {
		return { volumeM3: volume, surfaceAreaM2: surfaceArea, centroid: null, inertiaUnitDensity: null };
	}
	const centroid = [centroidAcc[0] / volume, centroidAcc[1] / volume, centroidAcc[2] / volume];

	// Shift the covariance to the centroid, then I = tr(C)·1 - C.
	const shifted = cov.slice();
	for (let r = 0; r < 3; r += 1) {
		for (let c = 0; c < 3; c += 1) shifted[r * 3 + c] -= volume * centroid[r] * centroid[c];
	}
	const trace = shifted[0] + shifted[4] + shifted[8];
	const inertia = [];
	for (let r = 0; r < 3; r += 1) {
		for (let c = 0; c < 3; c += 1) inertia.push((r === c ? trace : 0) - shifted[r * 3 + c]);
	}

	return {
		volumeM3: volume,
		surfaceAreaM2: surfaceArea,
		centroid,
		inertiaUnitDensity: inertia,
	};
}

async function convexProxy(points) {
	const stride = Math.max(1, Math.ceil(points.length / 3 / HULL_POINT_CAP));
	const { Vector3 } = await import('three');
	const { ConvexHull } = await import('three/examples/jsm/math/ConvexHull.js');
	const sample = [];
	for (let i = 0; i < points.length; i += 3 * stride) sample.push(new Vector3(points[i], points[i + 1], points[i + 2]));
	if (sample.length < 4) return null;

	const hull = new ConvexHull().setFromPoints(sample);
	const faces = hull.faces ?? [];
	let volume = 0;
	let triangles = 0;
	const vertices = new Set();
	for (const face of faces) {
		// Every hull face is a convex polygon; fan-triangulate it from its first
		// vertex so the same signed-tetra sum gives the hull volume.
		const loop = [];
		let edge = face.edge;
		do { loop.push(edge.head().point); edge = edge.next; } while (edge !== face.edge);
		for (const p of loop) vertices.add(`${p.x},${p.y},${p.z}`);
		for (let i = 1; i + 1 < loop.length; i += 1) {
			const a = loop[0], b = loop[i], c = loop[i + 1];
			volume += (a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x)) / 6;
			triangles += 1;
		}
	}
	return {
		sampledPoints: sample.length,
		hullVertices: vertices.size,
		hullFaces: faces.length,
		hullTriangles: triangles,
		hullVolumeM3: Math.abs(volume),
	};
}

function scaleReport(bounds) {
	const longest = bounds.longestAxisMeters;
	const centered = Math.hypot(bounds.center[0], bounds.center[1], bounds.center[2]) < longest * 0.08;
	const normalizedGuess = centered && NORMALIZED_TARGETS.some((t) => Math.abs(longest - t) <= NORMALIZED_TOLERANCE * t);
	return {
		longestAxisMeters: longest,
		sizeMeters: bounds.size,
		centerOffsetMeters: bounds.center,
		withinPhysicalWindow: longest >= SCALE_BOUNDS.minMeters && longest <= SCALE_BOUNDS.maxMeters,
		// True means the geometry was fitted to a unit box by the generator, so
		// the numbers are internally consistent but say nothing about the real
		// object's size. Nothing downstream may treat them as meters.
		normalizedGuess,
	};
}

/**
 * Grade a GLB for simulation readiness.
 *
 * @param {Buffer|Uint8Array} buffer  binary glTF 2.0
 * @param {{ weldToleranceRatio?: number, convexHull?: boolean }} [options]
 * @returns {Promise<object>} the report (never throws on bad input; an
 *   unreadable buffer returns `{ readable: false, error }`)
 */
export async function gradeSimReadiness(buffer, options = {}) {
	const weldToleranceRatio = options.weldToleranceRatio ?? 1e-5;
	const wantHull = options.convexHull !== false;

	let document;
	try {
		const io = await getIO();
		document = await io.readBinary(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
	} catch (err) {
		return { grader: SIM_READINESS_VERSION, readable: false, error: String(err?.message || err), verdict: 'unreadable', blockers: ['unreadable_glb'] };
	}

	const soup = collectTriangles(document);
	if (!soup.indices.length) {
		return {
			grader: SIM_READINESS_VERSION,
			readable: true, verdict: 'unusable', blockers: ['no_triangles'],
			geometry: { triangles: 0, vertices: soup.positions.length / 3, skippedPrimitives: soup.skippedPrimitives },
		};
	}

	const bounds = boundsOf(soup.positions);
	const tolerance = Math.max(bounds.diagonal * weldToleranceRatio, Number.MIN_VALUE);
	const welded = weld(soup.positions, soup.indices, tolerance);
	const topology = analyzeTopology(welded.indices);
	const mass = massProperties(welded.points, welded.indices);
	const hull = wantHull ? await convexProxy(welded.points) : null;
	const scale = scaleReport(bounds);

	const volume = Math.abs(mass.volumeM3);
	const convexity = hull && hull.hullVolumeM3 > 0 ? volume / hull.hullVolumeM3 : null;

	const blockers = [];
	const warnings = [];
	if (!topology.edgeManifold) blockers.push(topology.boundaryEdges ? 'open_surface' : 'non_manifold_edges');
	if (!topology.windingConsistent) blockers.push('inconsistent_winding');
	if (mass.volumeM3 < 0) blockers.push('inverted_winding');
	if (volume <= 0) blockers.push('zero_volume');
	if (scale.normalizedGuess) blockers.push('scale_normalized');
	else if (!scale.withinPhysicalWindow) warnings.push('scale_outside_physical_window');
	if (topology.degenerateTriangles > 0) warnings.push('degenerate_triangles');
	if (soup.skippedPrimitives > 0) warnings.push('non_triangle_primitives_skipped');
	if (soup.skinnedPrimitives > 0) warnings.push('skinned_geometry_graded_at_bind_pose');

	// simulation_ready  drops in as a rigid body with correct dynamics, as is.
	// needs_scale       geometry is solid, only the unit anchoring is missing.
	// needs_repair      the surface itself has to be closed before it can be one.
	// unusable          no volume to simulate at all.
	const geometrySound = topology.watertight && volume > 0 && mass.volumeM3 > 0;
	let verdict;
	if (!geometrySound) verdict = volume > 0 ? 'needs_repair' : 'unusable';
	else if (scale.normalizedGuess) verdict = 'needs_scale';
	else verdict = 'simulation_ready';

	return {
		grader: SIM_READINESS_VERSION,
		readable: true,
		verdict,
		blockers,
		warnings,
		geometry: {
			triangles: topology.triangles,
			verticesRaw: soup.positions.length / 3,
			verticesWelded: welded.points.length / 3,
			weldToleranceMeters: tolerance,
			skippedPrimitives: soup.skippedPrimitives,
			skinnedPrimitives: soup.skinnedPrimitives,
			generator: document.getRoot().getAsset()?.generator ?? null,
		},
		topology,
		scale,
		mass: {
			volumeM3: mass.volumeM3,
			surfaceAreaM2: mass.surfaceAreaM2,
			centroid: mass.centroid,
			// Unit density: multiply by kg/m³ for the real tensor and mass.
			inertiaUnitDensity: mass.inertiaUnitDensity,
			massAtWaterDensityKg: mass.volumeM3 > 0 ? mass.volumeM3 * 1000 : null,
		},
		collision: hull ? { ...hull, convexityRatio: convexity, convexEnough: convexity != null && convexity >= 0.9 } : null,
		bounds,
	};
}

/**
 * The subset of a grade that rides inside a signed content credential.
 *
 * The full report deliberately stays out: a credential's canonical bytes must
 * be small and stable, and every signed field is a field a future grader could
 * contradict. These seven are the ones a consumer acts on: the version that
 * made the claim, the verdict, why it is not better, and the four numbers a
 * simulator needs to place the object and integrate it. Spec:
 * specs/SIM_READINESS.md ("In the content credential").
 *
 * Returns null for a report with nothing worth signing (an unreadable buffer),
 * because omitting the field is honest and signing a null is not.
 *
 * @param {object} report a report from gradeSimReadiness
 * @returns {object|null}
 */
export function signedGradeSubset(report) {
	if (!report || typeof report !== 'object' || !report.verdict) return null;
	if (report.readable === false) return null;
	const subset = {
		grader: String(report.grader || SIM_READINESS_VERSION),
		verdict: String(report.verdict),
		blockers: Array.isArray(report.blockers) ? report.blockers.map(String) : [],
	};
	const volume = Number(report.mass?.volumeM3);
	if (Number.isFinite(volume)) subset.volumeM3 = volume;
	const axis = Number(report.scale?.longestAxisMeters);
	if (Number.isFinite(axis)) subset.longestAxisMeters = axis;
	const inertia = report.mass?.inertiaUnitDensity;
	if (Array.isArray(inertia) && inertia.length === 9 && inertia.every((n) => Number.isFinite(Number(n)))) {
		subset.inertiaUnitDensity = inertia.map(Number);
	}
	const convexity = Number(report.collision?.convexityRatio);
	if (Number.isFinite(convexity)) subset.convexityRatio = convexity;
	return subset;
}

export default { gradeSimReadiness, SCALE_BOUNDS, SIM_READINESS_VERSION, signedGradeSubset };
