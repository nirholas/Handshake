// Materialize's geometry kernel: one lazily-initialised manifold-3d instance.
//
// manifold-3d is the Manifold library compiled to WebAssembly. It is the only
// dependency in this pipeline that owns memory outside the JS heap, so it gets
// its own module: one instance per process, initialised on first use, with the
// mesh conversions that every caller would otherwise re-write.
//
// Why a WASM kernel rather than a native binding: the API container is a
// node-only image (see CLAUDE.md, Stack notes). A CGAL or OpenVDB binding would
// need a compiler in the image and would break the moment the base image moved.
// A .wasm file is just bytes the runtime already knows how to load.
//
// Every Manifold object holds WASM memory that the JS garbage collector cannot
// see, so callers must delete() what they create. The helpers here return plain
// JS soups precisely so that ownership stays short and local.

let kernelPromise = null;

/** The initialised manifold-3d module (Manifold, Mesh, and friends). */
export async function getKernel() {
	if (!kernelPromise) {
		kernelPromise = (async () => {
			const factory = (await import('manifold-3d')).default;
			const wasm = await factory();
			wasm.setup();
			return wasm;
		})();
	}
	return kernelPromise;
}

/**
 * Wrap an indexed soup as a manifold-3d Mesh and merge vertices that sit within
 * the kernel's tolerance of each other. `merge()` is what turns a glTF's
 * seam-split vertices back into shared topology; without it every UV seam reads
 * as an open boundary.
 */
export async function toKernelMesh(positions, indices) {
	const { Mesh } = await getKernel();
	const mesh = new Mesh({
		numProp: 3,
		vertProperties: Float32Array.from(positions),
		triVerts: Uint32Array.from(indices),
	});
	mesh.merge();
	return mesh;
}

/**
 * Build a Manifold solid from an indexed soup, or return null when the soup is
 * not a valid 2-manifold. Never throws: "this input is not a solid" is the
 * normal case this whole pipeline exists to handle, not an exception.
 */
export async function toSolid(positions, indices) {
	const { Manifold } = await getKernel();
	const mesh = await toKernelMesh(positions, indices);
	try {
		const solid = Manifold.ofMesh(mesh);
		if (solid.isEmpty()) {
			solid.delete();
			return null;
		}
		return solid;
	} catch {
		return null;
	}
}

/** Read a Manifold solid back out as the indexed soup the exporters consume. */
export function fromSolid(solid) {
	const mesh = solid.getMesh();
	const stride = mesh.numProp;
	const vertexCount = mesh.vertProperties.length / stride;
	const positions = new Float64Array(vertexCount * 3);
	for (let v = 0; v < vertexCount; v += 1) {
		positions[v * 3] = mesh.vertProperties[v * stride];
		positions[v * 3 + 1] = mesh.vertProperties[v * stride + 1];
		positions[v * 3 + 2] = mesh.vertProperties[v * stride + 2];
	}
	return { positions, indices: Uint32Array.from(mesh.triVerts) };
}

/** Axis-aligned bounds of a solid as a plain { min, max } box. */
export function solidBounds(solid) {
	const box = solid.boundingBox();
	return { min: [...box.min], max: [...box.max] };
}

/**
 * Collapse edges until the solid fits a triangle budget, by binary search on
 * manifold's geometric tolerance. Searching on tolerance rather than driving a
 * general-purpose decimator matters because manifold's simplify is
 * manifoldness-preserving: the result is still a solid, which a mesh
 * decimator's output is not guaranteed to be. A mesh that cannot reach the
 * budget within `maxTolerance` is returned at the best reduction found rather
 * than degraded further.
 *
 * Caller owns `solid`; the returned solid is a new object (or `solid` itself
 * when no reduction was needed, flagged by `reduced: false`).
 */
export function simplifyToBudget(solid, budget, { maxTolerance, iterations = 12 } = {}) {
	const before = solid.numTri();
	if (!budget || before <= budget) return { solid, reduced: false, before, after: before, tolerance: 0 };
	const box = solid.boundingBox();
	const diagonal = Math.hypot(
		box.max[0] - box.min[0],
		box.max[1] - box.min[1],
		box.max[2] - box.min[2],
	);
	let lo = 0;
	let hi = maxTolerance ?? diagonal * 0.02;
	let best = null;
	let bestTolerance = 0;
	for (let i = 0; i < iterations; i += 1) {
		const mid = (lo + hi) / 2;
		const candidate = solid.simplify(mid);
		const tris = candidate.numTri();
		if (tris <= budget) {
			if (best) best.delete();
			best = candidate;
			bestTolerance = mid;
			hi = mid;
		} else {
			candidate.delete();
			lo = mid;
		}
	}
	if (!best) {
		// Budget unreachable inside the tolerance ceiling: take the strongest
		// legal reduction rather than pretending the budget was met.
		best = solid.simplify(hi);
		bestTolerance = hi;
	}
	return { solid: best, reduced: true, before, after: best.numTri(), tolerance: bestTolerance };
}
