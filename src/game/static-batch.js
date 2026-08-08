// Static geometry batcher for the /play world dressing.
//
// The biome builders in world-env.js already share geometry and materials
// across everything they scatter: 46 conifers are 46 Groups drawn from the same
// two buffers, a frontier town's 13 storefronts are ~200 boxes cut from one
// BoxGeometry. Sharing the buffers saves memory but not draw calls, and the
// renderer submitted every one of those meshes individually, twice over once
// the sun's shadow pass ran. In the flagship $THREE town that was the single
// largest per-frame cost in the scene.
//
// Nothing in that dressing ever moves. So instead of adding the built Groups to
// the scene, hand them here: the batcher records each mesh's world matrix,
// buckets by (geometry, material, shadow flags), and emits one InstancedMesh
// per bucket. Same pixels, a fraction of the draw calls.
//
//   const batch = createStaticBatcher();
//   for (const tree of trees) batch.add(tree);   // already positioned/scaled
//   batch.flush(root);                           // one InstancedMesh per bucket
//
// Anything that has to animate individually (the tumbleweeds, the market ring)
// must NOT go through here, add it to the scene the ordinary way.

import { InstancedMesh, Matrix4, StaticDrawUsage } from 'three';

// A single-instance bucket is a plain mesh with extra bookkeeping, so those are
// re-emitted as ordinary meshes. Two is already a win: one draw call instead of
// two, for one Float32Array of 32 numbers.
const MIN_INSTANCES = 2;

export function createStaticBatcher() {
	// key → { geometry, material, castShadow, receiveShadow, renderOrder, matrices[] }
	const buckets = new Map();
	// Meshes that can't be instanced (multi-material) keep their world transform
	// and are re-parented as-is.
	const passthrough = [];
	let sourceMeshes = 0;

	/**
	 * Record every mesh under `object` for batching. The object must already
	 * carry its final transform; it is never added to the scene itself.
	 */
	function add(object) {
		if (!object) return;
		object.updateMatrixWorld(true);
		object.traverse((n) => {
			if (!n.isMesh || n.isInstancedMesh || n.isSkinnedMesh) return;
			sourceMeshes++;
			if (Array.isArray(n.material) || !n.geometry || !n.material) {
				n.matrix.copy(n.matrixWorld);
				n.matrix.decompose(n.position, n.quaternion, n.scale);
				passthrough.push(n);
				return;
			}
			const key = `${n.geometry.uuid}|${n.material.uuid}|${n.castShadow ? 1 : 0}${n.receiveShadow ? 1 : 0}|${n.renderOrder}`;
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = {
					geometry: n.geometry,
					material: n.material,
					castShadow: n.castShadow,
					receiveShadow: n.receiveShadow,
					renderOrder: n.renderOrder,
					matrices: [],
				};
				buckets.set(key, bucket);
			}
			bucket.matrices.push(n.matrixWorld.clone());
		});
	}

	/**
	 * Emit the batched meshes into `root` and reset the batcher. Returns the
	 * before/after mesh counts so callers (and the perf audit) can see the win.
	 */
	function flush(root) {
		let emitted = 0;
		for (const b of buckets.values()) {
			if (b.matrices.length < MIN_INSTANCES) {
				// Rebuild the lone mesh rather than instancing a crowd of one.
				const m = new InstancedMesh(b.geometry, b.material, 1);
				m.setMatrixAt(0, b.matrices[0]);
				m.instanceMatrix.setUsage(StaticDrawUsage);
				m.castShadow = b.castShadow;
				m.receiveShadow = b.receiveShadow;
				m.renderOrder = b.renderOrder;
				m.computeBoundingSphere();
				root.add(m);
				emitted++;
				continue;
			}
			const mesh = new InstancedMesh(b.geometry, b.material, b.matrices.length);
			for (let i = 0; i < b.matrices.length; i++) mesh.setMatrixAt(i, b.matrices[i]);
			// The dressing never moves, so the driver can keep the buffer on the GPU.
			mesh.instanceMatrix.setUsage(StaticDrawUsage);
			mesh.instanceMatrix.needsUpdate = true;
			mesh.castShadow = b.castShadow;
			mesh.receiveShadow = b.receiveShadow;
			mesh.renderOrder = b.renderOrder;
			// Without this the batch inherits the source geometry's bounds (one
			// tree at the origin) and frustum culling pops the whole treeline out
			// the moment the camera looks away from world centre.
			mesh.computeBoundingSphere();
			root.add(mesh);
			emitted++;
		}
		for (const m of passthrough) { root.add(m); emitted++; }
		const stats = { meshes: sourceMeshes, batches: emitted, saved: Math.max(0, sourceMeshes - emitted) };
		buckets.clear();
		passthrough.length = 0;
		sourceMeshes = 0;
		return stats;
	}

	return { add, flush };
}

/**
 * Free an InstancedMesh's per-instance buffers. Geometry and materials are
 * shared with the builders that own them, so they are left alone; the caller's
 * own dispose sweep handles those.
 */
export function disposeInstanced(root) {
	root.traverse((n) => { if (n.isInstancedMesh) n.dispose(); });
}
