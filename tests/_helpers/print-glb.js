// Deterministic GLB fixtures for the Materialize print pipeline tests.
//
// The print engine's whole job is judging geometry, so its tests need meshes
// with known, exact properties: a solid whose volume is arithmetic, a shell
// with a hole of a known size, two bodies that must be counted as two. Binary
// fixtures are never committed (a .glb in git is an opaque blob nobody can
// review); these builders write the bytes at test time from plain arrays, so
// the expected numbers are visible right next to the assertion.

import { Document, NodeIO } from '@gltf-transform/core';

/** Corner positions of an axis-aligned box spanning [0,size] on every axis. */
function boxCorners(size, offset = [0, 0, 0]) {
	const [ox, oy, oz] = offset;
	const s = size;
	return [
		ox, oy, oz,
		ox + s, oy, oz,
		ox + s, oy + s, oz,
		ox, oy + s, oz,
		ox, oy, oz + s,
		ox + s, oy, oz + s,
		ox + s, oy + s, oz + s,
		ox, oy + s, oz + s,
	];
}

// Outward-facing (counter-clockwise from outside) winding for the eight corners
// above. The last two triangles are the -Y face; dropping them is what makes the
// open-bottom fixture.
const BOX_TRIANGLES = [
	0, 2, 1, 0, 3, 2, // -Z
	4, 5, 6, 4, 6, 7, // +Z
	0, 1, 5, 0, 5, 4, // -Y
	1, 2, 6, 1, 6, 5, // +X
	2, 3, 7, 2, 7, 6, // +Y
	3, 0, 4, 3, 4, 7, // -X
];

/**
 * Write a GLB from flat positions + indices.
 *
 * @param {number[][]} parts one entry per primitive: [positions, indices]
 * @param {{ color?: [number, number, number] }} [opts]
 */
export async function writeGlb(parts, opts = {}) {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const scene = doc.createScene();
	const material = doc
		.createMaterial('surface')
		.setBaseColorFactor([...(opts.color || [1, 1, 1]), 1])
		.setRoughnessFactor(1)
		.setMetallicFactor(0);

	parts.forEach(([positions, indices], i) => {
		const position = doc
			.createAccessor(`P${i}`)
			.setType('VEC3')
			.setArray(Float32Array.from(positions))
			.setBuffer(buffer);
		const index = doc
			.createAccessor(`I${i}`)
			.setType('SCALAR')
			.setArray(Uint32Array.from(indices))
			.setBuffer(buffer);
		const prim = doc
			.createPrimitive()
			.setAttribute('POSITION', position)
			.setIndices(index)
			.setMaterial(material);
		const mesh = doc.createMesh(`M${i}`).addPrimitive(prim);
		scene.addChild(doc.createNode(`N${i}`).setMesh(mesh));
	});

	doc.getRoot().setDefaultScene(scene);
	return new NodeIO().writeBinary(doc);
}

/** A closed axis-aligned cube. `size` is in meters (glTF's unit). */
export function cubeGlb(size = 0.05) {
	return writeGlb([[boxCorners(size), BOX_TRIANGLES]]);
}

/** The same cube with its -Y face removed: one hole, four boundary edges. */
export function openBoxGlb(size = 0.05) {
	return writeGlb([[boxCorners(size), BOX_TRIANGLES.slice(0, 24)]]);
}

/** Two disjoint closed cubes: two shells, twice the volume. */
export function twoShellGlb(size = 0.05) {
	return writeGlb([
		[boxCorners(size), BOX_TRIANGLES],
		[boxCorners(size, [size * 3, 0, 0]), BOX_TRIANGLES],
	]);
}

/**
 * A thin plate: 40 mm wide, 40 mm tall, 0.4 mm thick. Below every process's
 * minimum wall, which is what the thin-wall deduction and the material
 * constraint rejections are asserted against.
 */
export function thinPlateGlb() {
	const w = 0.04;
	const t = 0.0004;
	const positions = [
		0, 0, 0, w, 0, 0, w, w, 0, 0, w, 0,
		0, 0, t, w, 0, t, w, w, t, 0, w, t,
	];
	return writeGlb([[positions, BOX_TRIANGLES]]);
}
