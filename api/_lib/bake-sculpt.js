// Server-side free-sculpt baker.
//
// The runtime counterpart is src/avatar-sculpt-brush.js: it records a brush
// stroke into an extra morph target named `customSculpt` on the live mesh and
// serializes it, sparse and quantised, into `appearance.sculpt`. This module
// writes that same target into a @gltf-transform Document inside
// bakeAppearance(), which is what carries a free-sculpt edit through the
// /avatars/:id/edit path, where the server renders the GLB from the pristine
// base and never sees the browser's scene.
//
// Recorded as a morph target rather than folded into POSITION for two reasons
// that both matter downstream: the edit stays additive with every library
// slider, and it stays reversible, so re-baking the same base with the sculpt
// removed returns the catalogue body exactly.
//
// A document whose vertex counts do not match the base it is baked onto is a
// sculpt from a different topology. Those meshes are skipped and reported, not
// force-fitted: a delta applied to the wrong vertices is a disfigured avatar,
// which is worse than an un-sculpted one.

// The pure document module, not the brush: the server has no three.js scene to
// paint into and should not drag the renderer into its import graph.
import {
	decodeSculptMesh,
	SCULPT_TARGET_NAME,
	SCULPT_VERSION,
} from '../../src/avatar-sculpt-doc.js';

/** True when this appearance carries a free-sculpt document worth baking. */
export function hasSculpt(appearance) {
	const doc = appearance?.sculpt;
	return !!(doc && doc.version === SCULPT_VERSION && doc.meshes && Object.keys(doc.meshes).length);
}

/**
 * Index of `name` in a mesh's target-name list, or -1.
 * glTF keeps morph names in `mesh.extras.targetNames` by convention (three.js,
 * Blender and gltf-transform all read it); the target's own name is a
 * gltf-transform nicety that does not survive every writer, so the extras list
 * is the authority.
 */
function targetNames(mesh) {
	const extras = mesh.getExtras() || {};
	const names = Array.isArray(extras.targetNames) ? [...extras.targetNames] : [];
	const declared = mesh.listPrimitives()[0]?.listTargets().length || 0;
	while (names.length < declared) names.push(`morph_${names.length}`);
	return names;
}

/**
 * Apply a serialized free-sculpt document to `doc` in place.
 *
 * @param {import('@gltf-transform/core').Document} doc
 * @param {{version:number, meshes:Record<string, object>}} sculpt
 * @returns {{ applied: string[], skipped: Array<{mesh:string, reason:string}> }}
 */
export function applySculpt(doc, sculpt) {
	const applied = [];
	const skipped = [];
	if (!sculpt || sculpt.version !== SCULPT_VERSION || !sculpt.meshes) return { applied, skipped };

	const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer('sculpt');
	const meshesByName = new Map();
	for (const mesh of doc.getRoot().listMeshes()) {
		if (!meshesByName.has(mesh.getName())) meshesByName.set(mesh.getName(), mesh);
	}

	for (const [name, entry] of Object.entries(sculpt.meshes)) {
		const mesh = meshesByName.get(name);
		if (!mesh) {
			skipped.push({ mesh: name, reason: 'no mesh with that name' });
			continue;
		}
		const decoded = decodeSculptMesh(entry);
		if (!decoded) {
			skipped.push({ mesh: name, reason: 'unreadable delta block' });
			continue;
		}

		const prims = mesh.listPrimitives();
		const target = prims.find(
			(p) => p.getAttribute('POSITION')?.getCount() === decoded.vertexCount,
		);
		if (!target) {
			skipped.push({
				mesh: name,
				reason: `vertex count ${decoded.vertexCount} matches no primitive`,
			});
			continue;
		}

		const names = targetNames(mesh);
		const existing = names.indexOf(SCULPT_TARGET_NAME);

		// Every primitive of a glTF mesh must declare the same number of morph
		// targets, so a mesh with several primitives gets a zero target on the
		// ones the sculpt does not touch.
		for (const prim of prims) {
			const count = prim.getAttribute('POSITION').getCount();
			const array = new Float32Array(count * 3);
			if (prim === target) {
				for (let k = 0; k < decoded.indices.length; k++) {
					const i = decoded.indices[k];
					if (i >= count) continue;
					array[i * 3] = decoded.deltas[k * 3];
					array[i * 3 + 1] = decoded.deltas[k * 3 + 1];
					array[i * 3 + 2] = decoded.deltas[k * 3 + 2];
				}
			}
			const accessor = doc
				.createAccessor(`${name}-${SCULPT_TARGET_NAME}`)
				.setType('VEC3')
				.setArray(array)
				.setBuffer(buffer)
				.setSparse(true);

			if (existing >= 0) {
				const prior = prim.listTargets()[existing];
				if (prior) {
					prior.setAttribute('POSITION', accessor);
					continue;
				}
			}
			const morphTarget = doc.createPrimitiveTarget(SCULPT_TARGET_NAME);
			morphTarget.setAttribute('POSITION', accessor);
			prim.addTarget(morphTarget);
		}

		const index = existing >= 0 ? existing : names.length;
		if (existing < 0) names.push(SCULPT_TARGET_NAME);
		mesh.setExtras({ ...(mesh.getExtras() || {}), targetNames: names });

		// Weight 1: the sculpt is not a slider, it IS the shape. Written on the
		// mesh so a viewer with no node override still sees it, and on every
		// node that already carries its own weight list so the mesh default
		// cannot be shadowed by a stale array.
		const meshWeights = padWeights(mesh.getWeights(), names.length);
		meshWeights[index] = 1;
		mesh.setWeights(meshWeights);
		for (const node of doc.getRoot().listNodes()) {
			if (node.getMesh() !== mesh) continue;
			const nodeWeights = node.getWeights();
			if (!nodeWeights?.length) continue;
			const padded = padWeights(nodeWeights, names.length);
			padded[index] = 1;
			node.setWeights(padded);
		}

		applied.push(name);
	}
	return { applied, skipped };
}

function padWeights(weights, length) {
	const out = new Array(length).fill(0);
	const src = weights || [];
	for (let i = 0; i < Math.min(src.length, length); i++) out[i] = src[i] ?? 0;
	return out;
}
