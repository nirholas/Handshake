// Geometric sampling over an accelerated mesh: wall thickness, self-crossings,
// and the signed distance field the reconstruction falls back on.
//
// All three questions are "what else is near this point", which is exactly what
// a BVH answers, so one tree built from the welded soup serves all of them.
// three-mesh-bvh is the accelerator; three's BufferGeometry is only the
// container it wants, and no renderer, scene or material is ever constructed.
//
// Determinism is a contract of the printability report: the same bytes must
// produce the same numbers, so every sample position comes from a seeded
// generator with a fixed stream order, never from Math.random.

import { BufferGeometry, BufferAttribute, Vector3, Ray, FrontSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

// A 32-bit xorshift. Small, fast, and reproducible across engines, which is
// what the determinism contract needs; the statistical quality demanded of it
// (spread points over a surface) is far below what it delivers.
export function seededRandom(seed = 0x9e3779b9) {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 4294967296;
	};
}

/** Wrap an indexed soup in the BufferGeometry + BVH that the samplers need. */
export function buildBvh(positions, indices) {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
	geometry.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
	return { geometry, bvh: new MeshBVH(geometry) };
}

function triangleNormal(positions, a, b, c, out) {
	const ax = positions[a * 3];
	const ay = positions[a * 3 + 1];
	const az = positions[a * 3 + 2];
	const ux = positions[b * 3] - ax;
	const uy = positions[b * 3 + 1] - ay;
	const uz = positions[b * 3 + 2] - az;
	const vx = positions[c * 3] - ax;
	const vy = positions[c * 3 + 1] - ay;
	const vz = positions[c * 3 + 2] - az;
	out.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
	const len = out.length();
	if (len > 0) out.multiplyScalar(1 / len);
	return len;
}

/**
 * Minimum wall thickness, sampled by casting each sample point's inward normal
 * back into the solid and measuring the distance to the first surface it hits.
 *
 * This is the metric that decides whether a print survives handling. A cape, a
 * sword blade or a hair strand on a generated character is routinely 0.2 mm at
 * the size a buyer wants, which snaps in the wash tank; knowing the thinnest
 * wall as a FRACTION of the model's height is what lets the quote engine say
 * "print this at 140 mm or taller" instead of shipping a broken object.
 *
 * Sampling is area-weighted (a big flat face is not over-sampled relative to a
 * thin fin) via a cumulative-area table with a seeded uniform draw, and the
 * result carries the sample count so the report can state its own resolution.
 * Percentiles are reported alongside the minimum because a single 0.05 mm
 * spike on a stray triangle should not condemn an otherwise printable model:
 * `min` is the worst point, `p01` is the thinness that actually characterizes
 * the mesh.
 */
export function sampleWallThickness(positions, indices, { samples = 2000, seed = 0x5eed1234 } = {}) {
	const triCount = indices.length / 3;
	if (triCount === 0) return null;

	const { bvh } = buildBvh(positions, indices);
	const areas = new Float64Array(triCount);
	let totalArea = 0;
	const normal = new Vector3();
	for (let t = 0; t < triCount; t += 1) {
		const len = triangleNormal(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2], normal);
		areas[t] = len / 2;
		totalArea += areas[t];
	}
	if (totalArea <= 0) return null;
	const cumulative = new Float64Array(triCount);
	let running = 0;
	for (let t = 0; t < triCount; t += 1) {
		running += areas[t];
		cumulative[t] = running;
	}

	const random = seededRandom(seed);
	const ray = new Ray();
	const origin = new Vector3();
	const thicknesses = [];
	// Nudge the ray origin off the surface so it cannot re-hit its own face.
	// Scaled to the model, not absolute, so it holds at any authoring unit.
	const epsilon = Math.max(1e-9, Math.sqrt(totalArea) * 1e-6);
	const wanted = Math.min(samples, triCount * 8);

	for (let i = 0; i < wanted; i += 1) {
		const pick = random() * totalArea;
		let lo = 0;
		let hi = triCount - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cumulative[mid] < pick) lo = mid + 1;
			else hi = mid;
		}
		const t = lo;
		let u = random();
		let v = random();
		if (u + v > 1) {
			u = 1 - u;
			v = 1 - v;
		}
		const a = indices[t * 3];
		const b = indices[t * 3 + 1];
		const c = indices[t * 3 + 2];
		if (triangleNormal(positions, a, b, c, normal) <= 0) continue;
		const w = 1 - u - v;
		origin.set(
			positions[a * 3] * w + positions[b * 3] * u + positions[c * 3] * v,
			positions[a * 3 + 1] * w + positions[b * 3 + 1] * u + positions[c * 3 + 1] * v,
			positions[a * 3 + 2] * w + positions[b * 3 + 2] * u + positions[c * 3 + 2] * v,
		);
		ray.direction.copy(normal).multiplyScalar(-1);
		ray.origin.copy(origin).addScaledVector(ray.direction, epsilon);
		const hit = bvh.raycastFirst(ray, FrontSide);
		if (!hit) continue;
		const thickness = hit.distance + epsilon;
		if (thickness > 0 && Number.isFinite(thickness)) thicknesses.push(thickness);
	}

	if (thicknesses.length === 0) return { samples: wanted, hits: 0, min: null, p01: null, median: null };
	thicknesses.sort((a, b) => a - b);
	const at = (q) => thicknesses[Math.min(thicknesses.length - 1, Math.floor(q * thicknesses.length))];
	return {
		samples: wanted,
		hits: thicknesses.length,
		min: thicknesses[0],
		p01: at(0.01),
		median: at(0.5),
	};
}

// Moller's triangle-triangle overlap test, interval form. Returns false for the
// coplanar case: two coplanar triangles that merely share an edge or a vertex
// are normal topology, and treating every such pair as a defect would report a
// clean mesh as thousands of intersections.
function trianglesIntersect(p, ia, ib) {
	const v = (i, k) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]][k];
	const sub = (a, b) => [v(a, 0) - v(b, 0), v(a, 1) - v(b, 1), v(a, 2) - v(b, 2)];
	const cross = (a, b) => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

	const n2 = cross(sub(ib[1], ib[0]), sub(ib[2], ib[0]));
	const d2 = -dot(n2, [v(ib[0], 0), v(ib[0], 1), v(ib[0], 2)]);
	const dist1 = ia.map((i) => dot(n2, [v(i, 0), v(i, 1), v(i, 2)]) + d2);
	const scale = Math.max(Math.abs(n2[0]), Math.abs(n2[1]), Math.abs(n2[2])) || 1;
	const eps = scale * 1e-12;
	if (dist1.every((d) => d > eps) || dist1.every((d) => d < -eps)) return false;
	if (dist1.every((d) => Math.abs(d) <= eps)) return false;

	const n1 = cross(sub(ia[1], ia[0]), sub(ia[2], ia[0]));
	const d1 = -dot(n1, [v(ia[0], 0), v(ia[0], 1), v(ia[0], 2)]);
	const dist2 = ib.map((i) => dot(n1, [v(i, 0), v(i, 1), v(i, 2)]) + d1);
	const scale1 = Math.max(Math.abs(n1[0]), Math.abs(n1[1]), Math.abs(n1[2])) || 1;
	const eps1 = scale1 * 1e-12;
	if (dist2.every((d) => d > eps1) || dist2.every((d) => d < -eps1)) return false;

	// Project onto the intersection line's dominant axis and compare intervals.
	const dir = cross(n1, n2);
	let axis = 0;
	let best = Math.abs(dir[0]);
	if (Math.abs(dir[1]) > best) {
		axis = 1;
		best = Math.abs(dir[1]);
	}
	if (Math.abs(dir[2]) > best) axis = 2;

	const interval = (tri, dists) => {
		// The lone vertex on its own side of the other plane bridges to each of
		// the other two, giving the segment where this triangle crosses the line.
		let lone = 0;
		for (let i = 0; i < 3; i += 1) {
			const others = [0, 1, 2].filter((k) => k !== i);
			if (dists[i] * dists[others[0]] <= 0 && dists[i] * dists[others[1]] <= 0) lone = i;
		}
		const o1 = (lone + 1) % 3;
		const o2 = (lone + 2) % 3;
		const proj = (i) => v(tri[i], axis);
		const cut = (i) => proj(lone) + (proj(i) - proj(lone)) * (dists[lone] / (dists[lone] - dists[i]));
		const t1 = dists[lone] === dists[o1] ? proj(lone) : cut(o1);
		const t2 = dists[lone] === dists[o2] ? proj(lone) : cut(o2);
		return t1 <= t2 ? [t1, t2] : [t2, t1];
	};

	const [aMin, aMax] = interval(ia, dist1);
	const [bMin, bMax] = interval(ib, dist2);
	return aMax >= bMin && bMax >= aMin;
}

/**
 * Count pairs of triangles that pass through each other. Faces sharing a vertex
 * are skipped: they touch by construction, and a shared-vertex pair is never
 * the defect a slicer chokes on.
 *
 * Bounded on purpose. A pathological mesh can have millions of crossing pairs,
 * and the caller needs a usable signal in bounded time, not an exact census, so
 * the sweep stops at `maxPairs` findings or `budgetMs` and says which happened.
 */
export function countSelfIntersections(
	positions,
	indices,
	{ maxPairs = 2000, budgetMs = 4000 } = {},
) {
	const triCount = indices.length / 3;
	const { bvh } = buildBvh(positions, indices);
	const started = Date.now();
	let pairs = 0;
	let truncated = false;
	const box = { min: new Vector3(), max: new Vector3() };

	for (let t = 0; t < triCount; t += 1) {
		if (pairs >= maxPairs || Date.now() - started > budgetMs) {
			truncated = t < triCount - 1;
			break;
		}
		const ia = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
		box.min.set(Infinity, Infinity, Infinity);
		box.max.set(-Infinity, -Infinity, -Infinity);
		for (const i of ia) {
			box.min.min(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
			box.max.max(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
		}
		bvh.shapecast({
			intersectsBounds: (bounds) =>
				bounds.min.x <= box.max.x &&
				bounds.max.x >= box.min.x &&
				bounds.min.y <= box.max.y &&
				bounds.max.y >= box.min.y &&
				bounds.min.z <= box.max.z &&
				bounds.max.z >= box.min.z,
			intersectsTriangle: (_tri, other) => {
				// Each unordered pair is tested once, from the lower index.
				if (other <= t) return false;
				const ib = [indices[other * 3], indices[other * 3 + 1], indices[other * 3 + 2]];
				if (ia.some((x) => ib.includes(x))) return false;
				if (trianglesIntersect(positions, ia, ib)) {
					pairs += 1;
					if (pairs >= maxPairs) return true;
				}
				return false;
			},
		});
	}
	return { pairs, truncated, budgetMs, maxPairs };
}

/**
 * A signed distance field over a closed surface: unsigned distance from the
 * BVH, sign from ray parity. Parity is exact on a closed mesh and cheap (a
 * single all-hits cast), which beats a closest-point pseudonormal sign that
 * misreads concave creases exactly where hollowing needs it most.
 *
 * Used for two things: eroding a solid into a shell (hollowing), and rebuilding
 * a surface that no amount of hole filling could make manifold.
 */
export function makeSignedDistance(positions, indices) {
	const { bvh } = buildBvh(positions, indices);
	const point = new Vector3();
	const target = {};
	const ray = new Ray(new Vector3(), new Vector3(1, 0, 0).normalize());
	// An axis-aligned probe direction grazes axis-aligned geometry, which is
	// most of it; an irrational direction hits nothing edge-on.
	ray.direction.set(0.5773502691896258, 0.5567764362830022, 0.5972015665748936).normalize();
	return (x, y, z) => {
		point.set(x, y, z);
		bvh.closestPointToPoint(point, target);
		const distance = target.distance ?? point.distanceTo(target.point);
		ray.origin.copy(point);
		const hits = bvh.raycast(ray, FrontSide);
		return hits.length % 2 === 1 ? -distance : distance;
	};
}

/** Unsigned distance only: the offset-shell repair never needs a sign. */
export function makeUnsignedDistance(positions, indices) {
	const { bvh } = buildBvh(positions, indices);
	const point = new Vector3();
	const target = {};
	return (x, y, z) => {
		point.set(x, y, z);
		bvh.closestPointToPoint(point, target);
		return target.distance ?? point.distanceTo(target.point);
	};
}
