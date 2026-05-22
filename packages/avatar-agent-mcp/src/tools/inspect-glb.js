// `inspect_glb` — fetch any GLB URL and return its full structural
// breakdown: meshes, materials, textures, animations, file size, vertex
// + triangle counts, bounding box, and skinning info.
//
// Pure parse via @gltf-transform/core. No network calls beyond the GLB
// fetch itself.

import { z } from 'zod';

import { fetchGlbBytes, getIo } from '../lib/glb-io.js';

function arrayLen(prim, semantic) {
	const acc = prim.getAttribute(semantic);
	return acc ? acc.getCount() : 0;
}

function primitiveTriangleCount(prim) {
	const mode = prim.getMode();
	const idx = prim.getIndices();
	const count = idx ? idx.getCount() : arrayLen(prim, 'POSITION');
	// glTF primitive modes: 0=POINTS, 1=LINES, 4=TRIANGLES, 5=TRIANGLE_STRIP, 6=TRIANGLE_FAN.
	switch (mode) {
		case 4:
			return Math.floor(count / 3);
		case 5:
		case 6:
			return Math.max(0, count - 2);
		default:
			return 0;
	}
}

function computeWorldBbox(scene) {
	let min = [Infinity, Infinity, Infinity];
	let max = [-Infinity, -Infinity, -Infinity];
	const visit = (node, mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) => {
		// Compose: world = parent * local. Keep mat as a 16-element column-major
		// transform; we only need translate + axis-aligned vertex check so
		// the full matrix multiplication suffices.
		const t = node.getMatrix();
		const world = mul(mat, t);
		const mesh = node.getMesh();
		if (mesh) {
			for (const prim of mesh.listPrimitives()) {
				const pos = prim.getAttribute('POSITION');
				if (!pos) continue;
				const arr = pos.getArray();
				const stride = pos.getElementSize();
				for (let i = 0; i < arr.length; i += stride) {
					const v = transform([arr[i], arr[i + 1], arr[i + 2]], world);
					if (v[0] < min[0]) min[0] = v[0];
					if (v[1] < min[1]) min[1] = v[1];
					if (v[2] < min[2]) min[2] = v[2];
					if (v[0] > max[0]) max[0] = v[0];
					if (v[1] > max[1]) max[1] = v[1];
					if (v[2] > max[2]) max[2] = v[2];
				}
			}
		}
		for (const child of node.listChildren()) visit(child, world);
	};
	for (const root of scene.listChildren()) visit(root);
	if (!Number.isFinite(min[0])) return null;
	return {
		min,
		max,
		center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
		size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
	};
}

function mul(a, b) {
	const r = new Array(16).fill(0);
	for (let i = 0; i < 4; i++) {
		for (let j = 0; j < 4; j++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[i + k * 4] * b[k + j * 4];
			r[i + j * 4] = s;
		}
	}
	return r;
}

function transform(v, m) {
	return [
		m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
		m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
		m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
	];
}

export const def = {
	name: 'inspect_glb',
	title: 'Inspect a GLB / glTF 3D model',
	description:
		'Fetch any GLB URL (or data: URL) and return a full structural breakdown: meshes, primitives, materials, textures, animations, skins, vertex + triangle counts, world-space bounding box, and file size. Pure local parse via @gltf-transform/core — no third-party services.',
	inputSchema: {
		url: z.string().describe('Public URL or data: URL of a .glb file.'),
	},
	async handler(args) {
		const { url } = args || {};
		if (!url) return { ok: false, error: 'invalid_input', message: 'url is required' };
		let bytes;
		let doc;
		try {
			bytes = await fetchGlbBytes(url);
			const io = await getIo();
			doc = await io.readBinary(bytes);
		} catch (err) {
			return { ok: false, error: 'parse_failed', message: err.message };
		}
		const root = doc.getRoot();
		const asset = root.getAsset();

		let totalVertices = 0;
		let totalTriangles = 0;
		const meshes = root.listMeshes().map((mesh) => {
			const prims = mesh.listPrimitives().map((p) => {
				const v = arrayLen(p, 'POSITION');
				const tri = primitiveTriangleCount(p);
				totalVertices += v;
				totalTriangles += tri;
				return {
					mode: p.getMode(),
					vertices: v,
					triangles: tri,
					indexed: !!p.getIndices(),
					attributes: p.listSemantics(),
					material: p.getMaterial()?.getName() || null,
					morphTargets: p.listTargets().length,
				};
			});
			return {
				name: mesh.getName() || null,
				primitiveCount: prims.length,
				primitives: prims,
			};
		});

		const materials = root.listMaterials().map((m) => ({
			name: m.getName() || null,
			alphaMode: m.getAlphaMode(),
			doubleSided: m.getDoubleSided(),
			baseColorFactor: m.getBaseColorFactor(),
			metallicFactor: m.getMetallicFactor(),
			roughnessFactor: m.getRoughnessFactor(),
			hasBaseColorTexture: !!m.getBaseColorTexture(),
			hasMetallicRoughnessTexture: !!m.getMetallicRoughnessTexture(),
			hasNormalTexture: !!m.getNormalTexture(),
			hasOcclusionTexture: !!m.getOcclusionTexture(),
			hasEmissiveTexture: !!m.getEmissiveTexture(),
		}));

		const textures = root.listTextures().map((t) => ({
			name: t.getName() || null,
			mimeType: t.getMimeType(),
			sizeBytes: t.getImage()?.byteLength ?? null,
			uri: t.getURI() || null,
		}));

		const animations = root.listAnimations().map((a) => {
			let maxTime = 0;
			for (const ch of a.listChannels()) {
				const sampler = ch.getSampler();
				const input = sampler?.getInput();
				if (input) {
					const arr = input.getArray();
					const last = arr[arr.length - 1];
					if (last > maxTime) maxTime = last;
				}
			}
			return {
				name: a.getName() || null,
				channelCount: a.listChannels().length,
				samplerCount: a.listSamplers().length,
				durationSeconds: maxTime,
			};
		});

		const skins = root.listSkins().map((s) => ({
			name: s.getName() || null,
			jointCount: s.listJoints().length,
			hasInverseBindMatrices: !!s.getInverseBindMatrices(),
		}));

		const scenes = root.listScenes().map((s) => ({
			name: s.getName() || null,
			rootNodeCount: s.listChildren().length,
		}));

		const defaultScene = root.getDefaultScene() || root.listScenes()[0] || null;
		const bbox = defaultScene ? computeWorldBbox(defaultScene) : null;

		return {
			ok: true,
			url,
			sizeBytes: bytes.byteLength,
			generator: asset.generator || null,
			version: asset.version || null,
			counts: {
				meshes: meshes.length,
				materials: materials.length,
				textures: textures.length,
				animations: animations.length,
				skins: skins.length,
				scenes: scenes.length,
				totalVertices,
				totalTriangles,
			},
			boundingBox: bbox,
			meshes,
			materials,
			textures,
			animations,
			skins,
			scenes,
		};
	},
};
