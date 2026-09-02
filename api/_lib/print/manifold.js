// The Manifold kernel, wrapped for this pipeline.
//
// Manifold (github.com/elalish/manifold, Apache-2.0) is the geometry kernel
// behind manifoldCAD and OpenSCAD's fast backend: exact boolean operations on
// solids, guaranteed manifold output, and a volume that is a real volume rather
// than an estimate. It ships here as plain WebAssembly with no native binding,
// which is exactly why it was chosen over a CGAL binding: the API container is
// node-only, and a build that needs a compiler is a build that breaks.
//
// The kernel is instantiated once per process and reused. Instantiation is a
// few tens of milliseconds and the module is stateless between calls, so a warm
// Cloud Run instance pays it once.
//
// Memory discipline: Manifold objects live in WASM memory and are NOT
// garbage-collected by JavaScript. Every function here that creates one either
// deletes it before returning or hands ownership to the caller and says so in
// its doc comment. Leaking them leaks the whole heap of a long-lived instance.

let modulePromise = null;

/** The Manifold toplevel (Manifold, Mesh, CrossSection, triangulate). */
export async function getKernel() {
	if (!modulePromise) {
		modulePromise = (async () => {
			const factory = (await import('manifold-3d')).default;
			const wasm = await factory();
			wasm.setup();
			return wasm;
		})();
	}
	return modulePromise;
}

/**
 * Wrap an indexed triangle soup as a Manifold Mesh and merge coincident
 * vertices. `merge()` is the kernel's own crack-closer: it links vertices that
 * share a position but were split by a UV or normal seam, which is the single
 * most common reason an otherwise closed AI-generated mesh reads as full of
 * holes. The Mesh is a plain JS object; nothing needs deleting.
 */
export async function toKernelMesh(positions, indices) {
	const { Mesh } = await getKernel();
	const verts = new Float32Array(positions.length);
	for (let i = 0; i < positions.length; i += 1) verts[i] = positions[i];
	const mesh = new Mesh({
		numProp: 3,
		vertProperties: verts,
		triVerts: indices instanceof Uint32Array ? indices : Uint32Array.from(indices),
	});
	const merged = mesh.merge();
	return { mesh, merged };
}

/**
 * Read a solid back out as an indexed soup. The caller owns the returned
 * arrays; the Manifold is untouched.
 */
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

/**
 * Try to read a soup as a solid. Returns the Manifold on success (the caller
 * MUST delete it) or null when the kernel refuses the topology, which is not an
 * error: it is the signal that the mesh needs repair first.
 */
export async function trySolid(positions, indices) {
	const { Manifold } = await getKernel();
	const { mesh, merged } = await toKernelMesh(positions, indices);
	let solid = null;
	try {
		solid = Manifold.ofMesh(mesh);
	} catch {
		return { solid: null, merged, status: 'NotManifold' };
	}
	const status = solid.status();
	if (status !== 'NoError') {
		solid.delete();
		return { solid: null, merged, status };
	}
	return { solid, merged, status };
}

/**
 * Union a solid with itself through decompose: separating the disjoint pieces
 * and unioning them back resolves overlapping shells and self-intersections
 * into one clean boundary. Consumes `solid` and returns a new one the caller
 * owns. A kernel failure returns the original rather than losing the geometry.
 */
export async function unionShells(solid) {
	const { Manifold } = await getKernel();
	let parts = [];
	try {
		parts = solid.decompose();
	} catch {
		return solid;
	}
	if (parts.length <= 1) {
		for (const p of parts) p.delete();
		return solid;
	}
	try {
		const merged = Manifold.union(parts);
		if (merged.status() !== 'NoError') {
			merged.delete();
			return solid;
		}
		solid.delete();
		return merged;
	} catch {
		return solid;
	} finally {
		for (const p of parts) p.delete();
	}
}
