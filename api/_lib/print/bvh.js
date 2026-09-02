// Materialize spatial queries: one BVH, three questions.
//
// The printability report needs to answer "how thin is the thinnest wall",
// "does the surface pass through itself", and (for repair and hollowing) "is
// this point inside the solid, and how far from its surface". All three are
// ray/proximity queries over the same triangles, so they share one
// three-mesh-bvh acceleration structure built once per call.
//
// Determinism is a contract of the report, so nothing here samples randomly:
// surface points are chosen by a fixed stride over the triangle list, and the
// probe ray directions are constants. The same bytes always produce the same
// numbers.

import { BufferGeometry, BufferAttribute, Ray, Vector3, DoubleSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

// Probe directions for the inside/outside parity test. Deliberately not
// axis-aligned: an axis ray through a box-modelled mesh grazes coplanar
// triangles and miscounts crossings. Three directions let an open shell (where
// a single ray can leak through a hole) resolve by majority vote.
const PROBE_DIRS = [
	[0.5227083, 0.3841105, 0.7607874],
	[-0.7071068, 0.6172134, 0.3454941],
	[0.2672612, -0.8017837, 0.5345225],
];

/** Build a BVH over an indexed Float64 soup. Returns { geometry, bvh }. */
export function buildBvh(positions, indices) {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
	geometry.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
	const bvh = new MeshBVH(geometry);
	return { geometry, bvh };
}

/** Unit outward normal of triangle `t`, from the winding of the welded soup. */
export function triangleNormal(positions, indices, t, out = [0, 0, 0]) {
	const a = indices[t * 3] * 3;
	const b = indices[t * 3 + 1] * 3;
	const c = indices[t * 3 + 2] * 3;
	const ax = positions[b] - positions[a];
	const ay = positions[b + 1] - positions[a + 1];
	const az = positions[b + 2] - positions[a + 2];
	const bx = positions[c] - positions[a];
	const by = positions[c + 1] - positions[a + 1];
	const bz = positions[c + 2] - positions[a + 2];
	const nx = ay * bz - az * by;
	const ny = az * bx - ax * bz;
	const nz = ax * by - ay * bx;
	const len = Math.hypot(nx, ny, nz) || 1;
	out[0] = nx / len;
	out[1] = ny / len;
	out[2] = nz / len;
	return out;
}

/** Centroid of triangle `t`. */
export function triangleCentroid(positions, indices, t, out = [0, 0, 0]) {
	const a = indices[t * 3] * 3;
	const b = indices[t * 3 + 1] * 3;
	const c = indices[t * 3 + 2] * 3;
	for (let k = 0; k < 3; k += 1) {
		out[k] = (positions[a + k] + positions[b + k] + positions[c + k]) / 3;
	}
	return out;
}

/**
 * Measure local wall thickness at a deterministic sample of surface points.
 *
 * At each sampled triangle we step just inside the surface and cast a ray along
 * the inward normal; the distance to the first surface it meets is the material
 * thickness at that point. This is the same measurement a slicer's thin-wall
 * warning uses, and it is the number that decides whether a printed detail
 * survives depowdering or snaps off.
 *
 * Sampling is a fixed stride over the triangle list rather than a random draw,
 * so a re-run over identical bytes returns identical numbers.
 *
 * @param {{ positions: Float64Array, indices: Uint32Array, bvh: MeshBVH }} mesh
 *   Positions MUST have consistent outward winding (feed the repaired solid),
 *   otherwise "inward" is meaningless on flipped faces.
 * @param {{ samples?: number, diagonal: number }} opts
 * @returns {{ min: number|null, median: number|null, p05: number|null, samples: number,
 *   measured: number }} distances in the mesh's own units
 */
export function sampleWallThickness({ positions, indices, bvh }, { samples = 2000, diagonal }) {
	const triCount = indices.length / 3;
	if (!triCount || !Number.isFinite(diagonal) || diagonal <= 0) {
		return { min: null, median: null, p05: null, samples: 0, measured: 0 };
	}
	const stride = Math.max(1, Math.floor(triCount / samples));
	// Step off the surface by a fraction of the model size so the ray does not
	// re-hit its own origin triangle, and cap the ray so a probe that escapes
	// through an opening is discarded instead of reporting the far wall.
	const epsilon = diagonal * 1e-6;
	const maxDistance = diagonal * 1.001;
	const ray = new Ray(new Vector3(), new Vector3());
	const normal = [0, 0, 0];
	const centroid = [0, 0, 0];
	const measured = [];
	let taken = 0;

	for (let t = 0; t < triCount; t += stride) {
		taken += 1;
		triangleNormal(positions, indices, t, normal);
		triangleCentroid(positions, indices, t, centroid);
		ray.origin.set(
			centroid[0] - normal[0] * epsilon,
			centroid[1] - normal[1] * epsilon,
			centroid[2] - normal[2] * epsilon,
		);
		ray.direction.set(-normal[0], -normal[1], -normal[2]);
		const hit = bvh.raycastFirst(ray, DoubleSide);
		if (!hit || hit.distance > maxDistance) continue;
		const thickness = hit.distance + epsilon;
		if (thickness > 0) measured.push(thickness);
	}

	if (!measured.length) {
		return { min: null, median: null, p05: null, samples: taken, measured: 0 };
	}
	measured.sort((a, b) => a - b);
	const at = (q) => measured[Math.min(measured.length - 1, Math.floor(q * measured.length))];
	return {
		min: measured[0],
		p05: at(0.05),
		median: at(0.5),
		samples: taken,
		measured: measured.length,
	};
}

/**
 * Count triangle pairs whose interiors intersect. Self-intersections are what
 * make a slicer produce interleaved inside/outside regions on a layer, which
 * prints as a hollow blob where a solid was expected.
 *
 * Triangles that merely share a vertex or an edge are neighbours, not
 * intersections, and are excluded. Above `fullScanLimit` triangles the scan
 * walks a fixed stride instead of every face and reports `scanned: 'sampled'`,
 * so a 2M-triangle upload cannot turn one free call into a minute of CPU.
 *
 * @returns {{ count: number, scanned: 'full'|'sampled', tested: number, capped: boolean }}
 */
export function countSelfIntersections(
	{ positions, indices, bvh, geometry },
	{ fullScanLimit = 120_000, maxReported = 5000 } = {},
) {
	const triCount = indices.length / 3;
	const stride = triCount > fullScanLimit ? Math.ceil(triCount / fullScanLimit) : 1;
	const pos = geometry.attributes.position.array;
	const idx = geometry.index.array;

	const a = new Vector3();
	const b = new Vector3();
	const c = new Vector3();
	let count = 0;
	let tested = 0;
	let capped = false;

	const box = { min: new Vector3(), max: new Vector3() };
	for (let t = 0; t < triCount && !capped; t += stride) {
		tested += 1;
		const i0 = idx[t * 3];
		const i1 = idx[t * 3 + 1];
		const i2 = idx[t * 3 + 2];
		a.set(pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]);
		b.set(pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]);
		c.set(pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]);
		box.min.set(Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.min(a.z, b.z, c.z));
		box.max.set(Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y), Math.max(a.z, b.z, c.z));

		bvh.shapecast({
			intersectsBounds: (bounds) =>
				bounds.max.x >= box.min.x &&
				bounds.min.x <= box.max.x &&
				bounds.max.y >= box.min.y &&
				bounds.min.y <= box.max.y &&
				bounds.max.z >= box.min.z &&
				bounds.min.z <= box.max.z,
			intersectsTriangle: (tri, other) => {
				// Count each unordered pair once, and never a triangle against
				// itself or a neighbour it legitimately touches.
				if (other <= t) return false;
				const j0 = idx[other * 3];
				const j1 = idx[other * 3 + 1];
				const j2 = idx[other * 3 + 2];
				if (
					j0 === i0 || j0 === i1 || j0 === i2 ||
					j1 === i0 || j1 === i1 || j1 === i2 ||
					j2 === i0 || j2 === i1 || j2 === i2
				) {
					return false;
				}
				if (trianglesIntersect(a, b, c, tri.a, tri.b, tri.c)) {
					count += 1;
					if (count >= maxReported) {
						capped = true;
						return true;
					}
				}
				return false;
			},
		});
	}

	return {
		count,
		scanned: stride === 1 ? 'full' : 'sampled',
		tested,
		capped,
	};
}

// Moller's interval-overlap triangle/triangle test, reduced to the boolean the
// caller needs. Coplanar pairs are treated as non-intersecting: coincident
// coplanar faces are a duplicate-geometry artifact the manifold boolean merges
// away, and counting them would flood the report with thousands of "errors" a
// user cannot act on.
function trianglesIntersect(a0, a1, a2, b0, b1, b2) {
	const n1 = planeNormal(a0, a1, a2);
	if (!n1) return false;
	const d1 = -(n1.x * a0.x + n1.y * a0.y + n1.z * a0.z);
	const db = [
		n1.x * b0.x + n1.y * b0.y + n1.z * b0.z + d1,
		n1.x * b1.x + n1.y * b1.y + n1.z * b1.z + d1,
		n1.x * b2.x + n1.y * b2.y + n1.z * b2.z + d1,
	];
	const eps = 1e-12;
	for (let i = 0; i < 3; i += 1) if (Math.abs(db[i]) < eps) db[i] = 0;
	if ((db[0] > 0 && db[1] > 0 && db[2] > 0) || (db[0] < 0 && db[1] < 0 && db[2] < 0)) return false;
	if (db[0] === 0 && db[1] === 0 && db[2] === 0) return false;

	const n2 = planeNormal(b0, b1, b2);
	if (!n2) return false;
	const d2 = -(n2.x * b0.x + n2.y * b0.y + n2.z * b0.z);
	const da = [
		n2.x * a0.x + n2.y * a0.y + n2.z * a0.z + d2,
		n2.x * a1.x + n2.y * a1.y + n2.z * a1.z + d2,
		n2.x * a2.x + n2.y * a2.y + n2.z * a2.z + d2,
	];
	for (let i = 0; i < 3; i += 1) if (Math.abs(da[i]) < eps) da[i] = 0;
	if ((da[0] > 0 && da[1] > 0 && da[2] > 0) || (da[0] < 0 && da[1] < 0 && da[2] < 0)) return false;

	// Project both triangles onto the intersection line of the two planes and
	// compare the resulting intervals.
	const dir = [
		n1.y * n2.z - n1.z * n2.y,
		n1.z * n2.x - n1.x * n2.z,
		n1.x * n2.y - n1.y * n2.x,
	];
	const axis = Math.abs(dir[0]) > Math.abs(dir[1])
		? (Math.abs(dir[0]) > Math.abs(dir[2]) ? 0 : 2)
		: (Math.abs(dir[1]) > Math.abs(dir[2]) ? 1 : 2);
	const proj = (v) => (axis === 0 ? v.x : axis === 1 ? v.y : v.z);
	const ia = lineInterval([proj(a0), proj(a1), proj(a2)], da);
	const ib = lineInterval([proj(b0), proj(b1), proj(b2)], db);
	if (!ia || !ib) return false;
	return ia[0] <= ib[1] && ib[0] <= ia[1];
}

function planeNormal(p0, p1, p2) {
	const ax = p1.x - p0.x;
	const ay = p1.y - p0.y;
	const az = p1.z - p0.z;
	const bx = p2.x - p0.x;
	const by = p2.y - p0.y;
	const bz = p2.z - p0.z;
	const x = ay * bz - az * by;
	const y = az * bx - ax * bz;
	const z = ax * by - ay * bx;
	if (x === 0 && y === 0 && z === 0) return null;
	return { x, y, z };
}

// The two edges of a triangle that cross the other plane give the segment the
// triangle carves out of the intersection line.
function lineInterval(p, d) {
	const out = [];
	for (let i = 0; i < 3; i += 1) {
		const j = (i + 1) % 3;
		if (d[i] === 0) out.push(p[i]);
		if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) {
			out.push(p[i] + ((p[j] - p[i]) * d[i]) / (d[i] - d[j]));
		}
	}
	if (out.length < 2) return null;
	return [Math.min(...out), Math.max(...out)];
}

/**
 * Build a signed-distance function over a triangle soup for manifold's
 * levelSet reconstruction: positive inside, negative outside, in the mesh's
 * own units.
 *
 * Distance is clamped to a narrow band around the surface. Marching only reads
 * the zero crossing, so clamping is behaviour-preserving and lets the BVH
 * abandon the vast majority of grid points (which sit far from any triangle)
 * after a single node test.
 *
 * @param {{ bvh: MeshBVH }} mesh
 * @param {{ band: number, votes?: number }} opts `votes` 3 for open shells,
 *   where a single probe ray can escape through a hole and misjudge the sign.
 */
export function signedDistanceFunction({ bvh }, { band, votes = 1 }) {
	const point = new Vector3();
	const ray = new Ray(new Vector3(), new Vector3());
	const target = {};
	const dirs = PROBE_DIRS.slice(0, Math.max(1, Math.min(3, votes)));
	return (p) => {
		point.set(p[0], p[1], p[2]);
		const hit = bvh.closestPointToPoint(point, target, 0, band);
		const distance = hit ? Math.min(hit.distance, band) : band;
		let inside = 0;
		for (const d of dirs) {
			ray.origin.copy(point);
			ray.direction.set(d[0], d[1], d[2]);
			if (bvh.raycast(ray, DoubleSide).length % 2 === 1) inside += 1;
		}
		return (inside * 2 > dirs.length ? 1 : -1) * distance;
	};
}
