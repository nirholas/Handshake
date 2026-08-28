// @ts-check
// A Portal world as a real glTF 2.0 binary.
//
// The browser renders the world from JSON, which is the right shape for a live,
// navigable page. This is the other half of the promise: the same world as a
// file you can open in Blender, drop into Unity, view in AR on a phone, or hand
// to any glTF tool on earth. It reads the SAME world document the renderer
// reads (src/portal/layout.js), so what downloads is what was walked.
//
// Built with @gltf-transform, the library already used for avatar baking and
// diorama scene export, so the output travels the same validated path as every
// other GLB the platform emits. Two geometries (a unit box and a unit cylinder)
// are authored once and instanced by every node, and materials are deduplicated
// by colour, which keeps a 24-district city in the tens of kilobytes rather
// than the tens of megabytes a naive per-node mesh would produce.

import { Document, NodeIO } from '@gltf-transform/core';
import { KHRLightsPunctual, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';

/** Cube vertices, one face at a time so each face keeps its own normal. */
function boxPrimitive(doc, buffer) {
	const p = [];
	const n = [];
	const idx = [];
	/** @type {[number[], number[]][]} */
	const faces = [
		[[0, 0, 1], [-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5]],
		[[0, 0, -1], [0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5]],
		[[1, 0, 0], [0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5]],
		[[-1, 0, 0], [-0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5]],
		[[0, 1, 0], [-0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5]],
		[[0, -1, 0], [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5]],
	];
	faces.forEach(([normal, verts], f) => {
		for (let v = 0; v < 4; v++) {
			p.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
			n.push(normal[0], normal[1], normal[2]);
		}
		const base = f * 4;
		idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
	});
	return doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer))
		.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(n)).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer));
}

/** A unit-radius, unit-height cylinder: the plaza disc and the ground plate. */
function cylinderPrimitive(doc, buffer, segments = 48) {
	const p = [];
	const n = [];
	const idx = [];
	p.push(0, 0.5, 0);
	n.push(0, 1, 0);
	for (let i = 0; i <= segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		p.push(Math.cos(a), 0.5, Math.sin(a));
		n.push(0, 1, 0);
	}
	for (let i = 1; i <= segments; i++) idx.push(0, i + 1, i);
	const sideStart = p.length / 3;
	for (let i = 0; i <= segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		const cx = Math.cos(a);
		const cz = Math.sin(a);
		p.push(cx, 0.5, cz, cx, -0.5, cz);
		n.push(cx, 0, cz, cx, 0, cz);
	}
	for (let i = 0; i < segments; i++) {
		const a = sideStart + i * 2;
		idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
	}
	return doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer))
		.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(n)).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer));
}

function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** '#rrggbb' to the linear float RGBA glTF base colours are authored in. */
export function hexToLinear(hex, alpha = 1) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')) || [null, '888888'];
	const int = parseInt(m[1], 16);
	return [
		srgbToLinear(((int >> 16) & 255) / 255),
		srgbToLinear(((int >> 8) & 255) / 255),
		srgbToLinear((int & 255) / 255),
		alpha,
	];
}

/**
 * Compose a world document into a single GLB.
 * @param {object} world a PortalWorld from src/portal/layout.js
 * @returns {Promise<Uint8Array>}
 */
export async function worldToGlb(world) {
	const doc = new Document();
	doc.createBuffer();
	const buffer = doc.getRoot().listBuffers()[0];
	const lightsExt = doc.createExtension(KHRLightsPunctual);
	doc.createExtension(KHRMaterialsEmissiveStrength);

	const scene = doc.createScene(`portal:${world.meta.host}`);
	doc.getRoot().setDefaultScene(scene);
	// The asset block travels with the file, so anyone who opens it later can see
	// what made it and which page its structure came from.
	Object.assign(doc.getRoot().getAsset(), {
		generator: 'three.ws Portal',
		copyright: `Structure derived from ${world.meta.canonical || world.meta.url}`,
	});

	const box = boxPrimitive(doc, buffer);
	const cyl = cylinderPrimitive(doc, buffer);
	/** @type {Map<string, any>} */
	const materials = new Map();
	/** @type {Map<string, any>} */
	const meshes = new Map();

	const materialFor = (hex, { metallic = 0.1, rough = 0.72, emissive = 0 } = {}) => {
		const key = `${hex}|${metallic}|${rough}|${emissive}`;
		if (materials.has(key)) return materials.get(key);
		const mat = doc
			.createMaterial(`m${materials.size}`)
			.setBaseColorFactor(hexToLinear(hex))
			.setMetallicFactor(metallic)
			.setRoughnessFactor(rough);
		if (emissive > 0) mat.setEmissiveFactor(hexToLinear(hex).slice(0, 3).map((c) => c * emissive));
		materials.set(key, mat);
		return mat;
	};

	// One mesh per (shape, material) pair, instanced by every node that needs it.
	const meshFor = (shape, hex, opts) => {
		const mat = materialFor(hex, opts);
		const key = `${shape}|${mat.getName()}`;
		if (meshes.has(key)) return meshes.get(key);
		const prim = (shape === 'box' ? box : cyl).clone().setMaterial(mat);
		const mesh = doc.createMesh(key).addPrimitive(prim);
		meshes.set(key, mesh);
		return mesh;
	};

	const place = (name, mesh, { x, y, z, sx, sy, sz, yaw = 0 }) => {
		const node = doc
			.createNode(name)
			.setMesh(mesh)
			.setTranslation([x, y, z])
			.setScale([sx, sy, sz])
			.setRotation([0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)]);
		scene.addChild(node);
		return node;
	};

	// Ground and plaza.
	place('ground', meshFor('cyl', world.ground.color, { rough: 0.95 }), {
		x: 0, y: -0.25, z: 0, sx: world.ground.radius, sy: 0.5, sz: world.ground.radius,
	});
	place('plaza', meshFor('cyl', world.palette.accent, { rough: 0.5, metallic: 0.2 }), {
		x: 0, y: 0.02, z: 0, sx: world.plaza.radius, sy: 0.08, sz: world.plaza.radius,
	});
	place('monument', meshFor('box', world.palette.primary, { metallic: 0.35, rough: 0.35, emissive: 0.25 }), {
		x: 0, y: world.plaza.monument.h / 2, z: 0, sx: 1.6, sy: world.plaza.monument.h, sz: 1.6,
	});

	for (const b of world.buildings) {
		place(`building:${b.sectionId}`, meshFor('box', b.color, { metallic: 0.15, rough: 0.6 }), {
			x: b.x, y: b.h / 2, z: b.z, sx: b.w, sy: b.h, sz: b.d, yaw: b.rot,
		});
	}
	for (const d of world.doors) {
		place(`door:${d.id}`, meshFor('box', d.color, { emissive: 0.9, rough: 0.3 }), {
			x: d.x, y: d.h / 2, z: d.z, sx: d.w, sy: d.h, sz: 0.22, yaw: d.yaw,
		});
	}
	for (const p of world.props) {
		if (p.kind === 'billboard') {
			place(`billboard:${p.id}`, meshFor('box', p.color, { emissive: 0.35, rough: 0.4 }), {
				x: p.x, y: p.h / 2 + 1.2, z: p.z, sx: p.w, sy: p.h, sz: 0.16, yaw: p.yaw,
			});
			place(`billboard-post:${p.id}`, meshFor('box', world.palette.monolith, {}), {
				x: p.x, y: 0.6, z: p.z, sx: 0.18, sy: 1.2, sz: 0.18, yaw: p.yaw,
			});
		} else if (p.kind === 'monolith') {
			place(`monolith:${p.id}`, meshFor('box', p.color, { metallic: 0.55, rough: 0.25, emissive: 0.12 }), {
				x: p.x, y: p.h / 2, z: p.z, sx: p.w, sy: p.h, sz: p.w, yaw: p.yaw,
			});
		}
	}

	// A sun aimed down the world's diagonal, and a soft fill, so the file looks
	// like the page rather than like a flat viewer default.
	const sun = lightsExt.createLight('sun').setType('directional').setIntensity(3.2).setColor([1, 0.97, 0.9]);
	const sunNode = doc.createNode('sun').setRotation([-0.36, 0.24, 0.1, 0.9]);
	sunNode.setExtension('KHR_lights_punctual', sun);
	scene.addChild(sunNode);
	const fill = lightsExt.createLight('fill').setType('directional').setIntensity(0.8).setColor(hexToLinear(world.palette.accent).slice(0, 3));
	const fillNode = doc.createNode('fill').setRotation([0.3, -0.5, 0, 0.81]);
	fillNode.setExtension('KHR_lights_punctual', fill);
	scene.addChild(fillNode);

	const io = new NodeIO().registerExtensions([KHRLightsPunctual, KHRMaterialsEmissiveStrength]);
	return io.writeBinary(doc);
}
