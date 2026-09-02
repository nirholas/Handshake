// Mesh topology for print preparation: the questions a slicer will ask.
//
// A printer does not render triangles, it fills a volume, so every metric here
// is about whether the triangle soup encloses one. Four failures account for
// nearly every AI-generated mesh that a bureau rejects, and each one has a
// distinct fix, so each is measured separately rather than rolled into a single
// "bad mesh" verdict:
//
//   open edges          a hole in the surface: the solid has no inside
//   non-manifold edges  three or more faces on one edge: no consistent inside
//   inconsistent winding some faces point in, some out: the inside flips
//   self-intersections   the surface crosses itself: the inside is ambiguous
//
// Everything in this module is pure and index-based. It never touches glTF,
// never touches WASM, and never allocates a Manifold, so the analyzer can run
// the cheap topology pass before deciding whether the expensive reconstruction
// is worth attempting.
//
// Conventions shared with mesh-io.js: positions are a flat Float64Array of
// world-space triples, indices are a flat Uint32Array of triangle corners, and
// an "edge key" is the two welded vertex ids in ascending order.

// A directed half-edge is stored as one number so the maps below stay in the
// integer keyspace: pairing two 32-bit ids into a float loses precision above
// 2^53, so vertex ids are capped at 2^26 (67M) which is far past MAX_TRIANGLES.
const ID_BITS = 26;
const ID_LIMIT = 1 << ID_BITS;

function edgeKey(a, b) {
	return a < b ? a * ID_LIMIT + b : b * ID_LIMIT + a;
}

/**
 * Drop triangles that cannot contribute surface: a repeated corner (a sliver
 * collapsed by welding) or a zero-area face. Both are invisible to a renderer
 * and fatal to a manifold reconstruction, which reads them as a hole.
 */
export function dropDegenerate(positions, indices, areaEpsilon = 0) {
	const kept = [];
	// The two causes are counted apart because they mean different things about
	// the source: a repeated corner is a sliver the weld collapsed, a zero-area
	// face is geometry the generator emitted flat. A repair report that merges
	// them cannot tell a buyer which one happened to their model.
	let duplicate = 0;
	let degenerate = 0;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i];
		const b = indices[i + 1];
		const c = indices[i + 2];
		if (a === b || b === c || a === c) {
			duplicate += 1;
			continue;
		}
		if (areaEpsilon > 0 && triangleArea(positions, a, b, c) <= areaEpsilon) {
			degenerate += 1;
			continue;
		}
		kept.push(a, b, c);
	}
	return {
		indices: Uint32Array.from(kept),
		removed: duplicate + degenerate,
		duplicate,
		degenerate,
	};
}

/**
 * Whole-mesh winding agreement. Same propagation as orientShell, but it works
 * on the full index buffer and takes no positions, so it is the pass to run
 * before anything has been split into shells or measured for volume: it makes
 * neighbours agree, and leaves the question of which way is "out" to the caller
 * that has the geometry to answer it.
 *
 * Every connected patch is seeded independently, so a mesh whose parts do not
 * touch still comes back internally consistent within each part.
 */
export function orientConsistently(indices) {
	const out = Uint32Array.from(indices);
	const { edges } = edgeTopology(out);
	const triCount = out.length / 3;
	const visited = new Uint8Array(triCount);
	let flipped = 0;
	for (let seed = 0; seed < triCount; seed += 1) {
		if (visited[seed]) continue;
		visited[seed] = 1;
		const stack = [seed];
		while (stack.length) {
			const t = stack.pop();
			const a = out[t * 3];
			const b = out[t * 3 + 1];
			const c = out[t * 3 + 2];
			const corners = [
				[a, b],
				[b, c],
				[c, a],
			];
			for (const [u, v] of corners) {
				const list = edges.get(edgeKey(u, v));
				if (!list || list.length !== 2) continue;
				const other = list[0] === t ? list[1] : list[0];
				if (visited[other]) continue;
				visited[other] = 1;
				const oa = out[other * 3];
				const ob = out[other * 3 + 1];
				const oc = out[other * 3 + 2];
				const sameDirection =
					(oa === u && ob === v) || (ob === u && oc === v) || (oc === u && oa === v);
				if (sameDirection) {
					out[other * 3 + 1] = oc;
					out[other * 3 + 2] = ob;
					flipped += 1;
				}
				stack.push(other);
			}
		}
	}
	return { indices: out, flipped };
}

export function triangleArea(positions, a, b, c) {
	const ax = positions[a * 3];
	const ay = positions[a * 3 + 1];
	const az = positions[a * 3 + 2];
	const ux = positions[b * 3] - ax;
	const uy = positions[b * 3 + 1] - ay;
	const uz = positions[b * 3 + 2] - az;
	const vx = positions[c * 3] - ax;
	const vy = positions[c * 3 + 1] - ay;
	const vz = positions[c * 3 + 2] - az;
	const cx = uy * vz - uz * vy;
	const cy = uz * vx - ux * vz;
	const cz = ux * vy - uy * vx;
	return Math.hypot(cx, cy, cz) / 2;
}

/**
 * Build the undirected edge -> incident triangle map plus the directed
 * half-edge counts. One pass produces every topology number the report needs.
 *
 * Returns:
 *   edges              Map<edgeKey, number[]> triangle ids touching that edge
 *   openEdges          edges with exactly one incident triangle (a hole rim)
 *   nonManifoldEdges   edges with three or more incident triangles
 *   flippedEdges       edges whose two triangles traverse it the same way,
 *                      which means one of the pair is wound backwards
 */
export function edgeTopology(indices) {
	const edges = new Map();
	const directed = new Set();
	let flippedEdges = 0;
	const triCount = indices.length / 3;
	for (let t = 0; t < triCount; t += 1) {
		const a = indices[t * 3];
		const b = indices[t * 3 + 1];
		const c = indices[t * 3 + 2];
		const corners = [
			[a, b],
			[b, c],
			[c, a],
		];
		for (const [u, v] of corners) {
			const key = edgeKey(u, v);
			const list = edges.get(key);
			if (list) list.push(t);
			else edges.set(key, [t]);
			const dir = u * ID_LIMIT + v;
			if (directed.has(dir)) flippedEdges += 1;
			else directed.add(dir);
		}
	}
	let openEdges = 0;
	let nonManifoldEdges = 0;
	for (const list of edges.values()) {
		if (list.length === 1) openEdges += 1;
		else if (list.length > 2) nonManifoldEdges += 1;
	}
	return { edges, openEdges, nonManifoldEdges, flippedEdges, edgeCount: edges.size };
}

/**
 * Group triangles into connected shells. Adjacency is "shares a welded edge",
 * so two shells that merely touch at a point stay separate, which is what a
 * printer sees too. A figurine plus its base plate is two shells; the repair
 * step unions them into one solid.
 */
export function connectedShells(indices, edges) {
	const triCount = indices.length / 3;
	const parent = new Uint32Array(triCount);
	for (let i = 0; i < triCount; i += 1) parent[i] = i;
	const find = (x) => {
		let r = x;
		while (parent[r] !== r) r = parent[r];
		while (parent[x] !== r) {
			const next = parent[x];
			parent[x] = r;
			x = next;
		}
		return r;
	};
	const union = (a, b) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};
	for (const list of edges.values()) {
		for (let i = 1; i < list.length; i += 1) union(list[0], list[i]);
	}
	const groups = new Map();
	for (let t = 0; t < triCount; t += 1) {
		const root = find(t);
		const g = groups.get(root);
		if (g) g.push(t);
		else groups.set(root, [t]);
	}
	// Biggest shell first: it is the one a caller wants to keep when a repair
	// has to discard specks, and it makes the shell list stable to compare.
	return [...groups.values()].sort((a, b) => b.length - a.length);
}

/**
 * Make every triangle in a shell wind the same way, then make that way
 * outward. Winding is what defines "inside" for both the volume integral and
 * the manifold reconstruction; a mesh assembled from separately-authored parts
 * routinely has half its faces inverted and looks perfect in a renderer with
 * backface culling off.
 *
 * The traversal only crosses edges with exactly two faces, so a non-manifold
 * junction stops propagation rather than corrupting it. Outward is decided per
 * shell by the sign of its enclosed volume: a closed shell with inward normals
 * integrates negative.
 */
export function orientShell(positions, indices, tris) {
	const local = new Uint32Array(tris.length * 3);
	for (let i = 0; i < tris.length; i += 1) {
		local[i * 3] = indices[tris[i] * 3];
		local[i * 3 + 1] = indices[tris[i] * 3 + 1];
		local[i * 3 + 2] = indices[tris[i] * 3 + 2];
	}
	const { edges } = edgeTopology(local);
	const visited = new Uint8Array(tris.length);
	let flipped = 0;
	for (let seed = 0; seed < tris.length; seed += 1) {
		if (visited[seed]) continue;
		visited[seed] = 1;
		const stack = [seed];
		while (stack.length) {
			const t = stack.pop();
			const a = local[t * 3];
			const b = local[t * 3 + 1];
			const c = local[t * 3 + 2];
			const corners = [
				[a, b],
				[b, c],
				[c, a],
			];
			for (const [u, v] of corners) {
				const list = edges.get(edgeKey(u, v));
				if (!list || list.length !== 2) continue;
				const other = list[0] === t ? list[1] : list[0];
				if (visited[other]) continue;
				visited[other] = 1;
				// Neighbours agree when they traverse the shared edge in opposite
				// directions. Same direction means the neighbour is mirrored.
				const oa = local[other * 3];
				const ob = local[other * 3 + 1];
				const oc = local[other * 3 + 2];
				const sameDirection =
					(oa === u && ob === v) || (ob === u && oc === v) || (oc === u && oa === v);
				if (sameDirection) {
					local[other * 3 + 1] = oc;
					local[other * 3 + 2] = ob;
					flipped += 1;
				}
				stack.push(other);
			}
		}
	}
	if (signedVolume(positions, local) < 0) {
		for (let i = 0; i < local.length; i += 3) {
			const swap = local[i + 1];
			local[i + 1] = local[i + 2];
			local[i + 2] = swap;
		}
		flipped = tris.length - flipped;
	}
	return { indices: local, flipped };
}

/**
 * Signed volume by the divergence theorem: exact for a closed, consistently
 * wound surface, and the fastest correct answer there is. On an open surface it
 * is only an estimate, which is why the printability report takes its volume
 * from the reconstructed solid instead.
 */
export function signedVolume(positions, indices) {
	let total = 0;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i] * 3;
		const b = indices[i + 1] * 3;
		const c = indices[i + 2] * 3;
		const ax = positions[a];
		const ay = positions[a + 1];
		const az = positions[a + 2];
		const bx = positions[b];
		const by = positions[b + 1];
		const bz = positions[b + 2];
		const cx = positions[c];
		const cy = positions[c + 1];
		const cz = positions[c + 2];
		total +=
			(ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
	}
	return total;
}

export function surfaceArea(positions, indices) {
	let total = 0;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		total += triangleArea(positions, indices[i], indices[i + 1], indices[i + 2]);
	}
	return total;
}

/**
 * Walk the boundary half-edges into closed loops. An open edge in a
 * consistently wound surface is traversed exactly once, in the direction the
 * surviving face uses, so the loop is recovered by chaining each edge's end
 * vertex to the next edge that starts there.
 *
 * Loops that cannot be closed (a boundary vertex shared by two separate holes)
 * are returned as far as they were walked and flagged, so the caller can report
 * a partial fill rather than silently producing a bad patch.
 */
export function boundaryLoops(indices) {
	const count = new Map();
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const corners = [
			[indices[i], indices[i + 1]],
			[indices[i + 1], indices[i + 2]],
			[indices[i + 2], indices[i]],
		];
		for (const [u, v] of corners) {
			const key = edgeKey(u, v);
			const rec = count.get(key);
			if (rec) rec.n += 1;
			else count.set(key, { n: 1, u, v });
		}
	}
	// Only a strictly single-sided edge is a hole rim; a 3-face junction is a
	// different defect and is never patched here.
	const next = new Map();
	for (const rec of count.values()) {
		if (rec.n !== 1) continue;
		const from = rec.u;
		const to = rec.v;
		const bucket = next.get(from);
		if (bucket) bucket.push(to);
		else next.set(from, [to]);
	}
	const loops = [];
	let unclosed = 0;
	for (const [start, targets] of next) {
		while (targets.length) {
			const loop = [start];
			let current = targets.pop();
			let guard = 0;
			let closed = false;
			while (current !== undefined && guard < 1_000_000) {
				if (current === start) {
					closed = true;
					break;
				}
				loop.push(current);
				const bucket = next.get(current);
				current = bucket && bucket.length ? bucket.pop() : undefined;
				guard += 1;
			}
			if (closed && loop.length >= 3) loops.push(loop);
			else unclosed += 1;
		}
	}
	return { loops, unclosed };
}

/**
 * Close every hole with a fan to the loop centroid. A centroid fan beats ear
 * clipping here because hole rims on a generated mesh are rarely planar and
 * almost never convex, and the fan is guaranteed to produce exactly one patch
 * triangle per boundary edge, which is what makes the result manifold.
 *
 * A boundary half-edge (a to b) is missing the face that would traverse it as
 * (b to a), so each patch triangle is wound (b, a, centroid).
 */
export function fillHoles(positions, indices) {
	const { loops, unclosed } = boundaryLoops(indices);
	if (loops.length === 0) {
		return { positions, indices, filled: 0, addedTriangles: 0, unclosedLoops: unclosed };
	}
	const outPositions = Array.from(positions);
	const outIndices = Array.from(indices);
	let added = 0;
	for (const loop of loops) {
		let cx = 0;
		let cy = 0;
		let cz = 0;
		for (const v of loop) {
			cx += positions[v * 3];
			cy += positions[v * 3 + 1];
			cz += positions[v * 3 + 2];
		}
		const n = loop.length;
		const centroid = outPositions.length / 3;
		outPositions.push(cx / n, cy / n, cz / n);
		for (let i = 0; i < n; i += 1) {
			const a = loop[i];
			const b = loop[(i + 1) % n];
			outIndices.push(b, a, centroid);
			added += 1;
		}
	}
	return {
		positions: Float64Array.from(outPositions),
		indices: Uint32Array.from(outIndices),
		filled: loops.length,
		addedTriangles: added,
		unclosedLoops: unclosed,
	};
}

/**
 * Extract one shell as a standalone indexed mesh with its own compact vertex
 * range. Manifold reconstructs one shell at a time, and feeding it the whole
 * soup's vertex array would carry every other shell's unreferenced vertices
 * into the solid.
 */
export function extractShell(positions, indices) {
	const remap = new Map();
	const outPositions = [];
	const outIndices = new Uint32Array(indices.length);
	for (let i = 0; i < indices.length; i += 1) {
		const v = indices[i];
		let id = remap.get(v);
		if (id === undefined) {
			id = outPositions.length / 3;
			remap.set(v, id);
			outPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
		}
		outIndices[i] = id;
	}
	return { positions: Float64Array.from(outPositions), indices: outIndices };
}
