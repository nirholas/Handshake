// Builds a small real GLB in memory with @gltf-transform so the tests exercise
// the actual loader, not a hand-made triangle array.

import { Document, NodeIO } from '@gltf-transform/core';

/** A unit cube (12 triangles) with a coloured material, as GLB bytes. */
export async function cubeGlb({ color = [0.9, 0.3, 0.2, 1] } = {}) {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const p = [];
	const faces = [
		[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],     // +z
		[[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], // -z
		[[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],     // +x
		[[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], // -x
		[[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],     // +y
		[[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], // -y
	];
	for (const [a, b, c, d] of faces) p.push(...a, ...b, ...c, ...a, ...c, ...d);
	const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer);
	const material = doc.createMaterial('paint').setBaseColorFactor(color);
	const prim = doc.createPrimitive().setAttribute('POSITION', position).setMaterial(material);
	const mesh = doc.createMesh('cube').addPrimitive(prim);
	const node = doc.createNode('cube').setMesh(mesh).setTranslation([0.5, 0, 0]);
	doc.createScene('scene').addChild(node);
	return new NodeIO().writeBinary(doc);
}
