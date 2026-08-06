// Model inspection + optimization suggestions using glTF-Transform.
//
// Isomorphic: works in the browser (Vite-bundled, used by /validation page) and
// in Node (re-exported by api/_lib/model-inspect.js for Vercel functions and the
// MCP tool). Input is raw bytes (Uint8Array) of either a binary GLB or a JSON
// glTF; output is a structured summary.

import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const GLB_MAGIC = 0x46546c67; // "glTF"

function isGLB(bytes) {
	if (!bytes || bytes.byteLength < 4) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(4, bytes.byteLength));
	return view.getUint32(0, true) === GLB_MAGIC;
}

// EXT_meshopt_compression is registered by ALL_EXTENSIONS but cannot DECODE
// without its wasm decoder wired in as a glTF-Transform dependency. Every
// three.ws avatar optimized by the GLB pipeline ships meshopt-compressed, so
// without this the inspector threw
//   [EXT_meshopt_compression] Please install extension dependency, "meshopt.decoder"
// on the majority of real models (the paid /api/x402/model-check route turned
// that into a 422 on michelle/xbot/cz/realistic-male/dancing-twerk).
// Loaded lazily so the browser /validation bundle only pays for the decoder
// when a compressed model actually arrives, and memoized per process.
let _meshoptDecoderPromise = null;
function loadMeshoptDecoder() {
	if (!_meshoptDecoderPromise) {
		_meshoptDecoderPromise = import('meshoptimizer')
			.then(async (mod) => {
				const decoder = mod.MeshoptDecoder;
				if (!decoder) return null;
				if (decoder.ready) await decoder.ready;
				return decoder;
			})
			.catch(() => null);
	}
	return _meshoptDecoderPromise;
}

async function createIO() {
	const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
	const decoder = await loadMeshoptDecoder();
	if (decoder) io.registerDependencies({ 'meshopt.decoder': decoder });
	return io;
}

async function readDocument(bytes) {
	const io = await createIO();
	if (isGLB(bytes)) return io.readBinary(bytes);
	// Fall back to JSON glTF (rare, usually requires external buffers we don't have).
	const text = new TextDecoder().decode(bytes);
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error('input is not a valid GLB or JSON glTF');
	}
	return io.readJSON({ json, resources: {} });
}

/**
 * Inspect a model's structure. Pure stats — no optimization advice.
 * @param {Uint8Array} bytes
 * @param {{ fileSize?: number }} opts
 */
export async function inspectModel(bytes, opts = {}) {
	const doc = await readDocument(bytes);
	const root = doc.getRoot();
	const asset = root.getAsset();

	const meshes = root.listMeshes();
	const materials = root.listMaterials();
	const textures = root.listTextures();
	const animations = root.listAnimations();
	const nodes = root.listNodes();
	const scenes = root.listScenes();
	const skins = root.listSkins();

	let totalVertices = 0;
	let totalTriangles = 0;
	let indexedPrimitives = 0;
	let nonIndexedPrimitives = 0;
	const primitiveModes = new Set();

	// Bone count = total skin joints across every skin. The honest measure of rig
	// weight (skins.length only says "is it rigged"), consumed by the rig
	// complexity scorer to tier marketplace pricing and flag heavy avatars.
	let totalJoints = 0;
	for (const skin of skins) totalJoints += skin.listJoints().length;

	for (const mesh of meshes) {
		for (const prim of mesh.listPrimitives()) {
			const pos = prim.getAttribute('POSITION');
			const verts = pos ? pos.getCount() : 0;
			totalVertices += verts;
			const idx = prim.getIndices();
			if (idx) {
				indexedPrimitives++;
				totalTriangles += Math.floor(idx.getCount() / 3);
			} else {
				nonIndexedPrimitives++;
				totalTriangles += Math.floor(verts / 3);
			}
			primitiveModes.add(prim.getMode());
		}
	}

	const textureDetails = textures.map((tex) => {
		const img = tex.getImage();
		const size = tex.getSize();
		const [w, h] = size || [0, 0];
		return {
			name: tex.getName() || null,
			mimeType: tex.getMimeType(),
			width: w,
			height: h,
			byteSize: img ? img.byteLength : 0,
		};
	});

	const materialSummary = materials.map((m) => ({
		name: m.getName() || null,
		alphaMode: m.getAlphaMode(),
		doubleSided: m.getDoubleSided(),
		hasBaseColorTexture: !!m.getBaseColorTexture(),
		hasNormalTexture: !!m.getNormalTexture(),
		hasMetallicRoughnessTexture: !!m.getMetallicRoughnessTexture(),
		hasEmissiveTexture: !!m.getEmissiveTexture(),
		hasOcclusionTexture: !!m.getOcclusionTexture(),
	}));

	return {
		fileSize: opts.fileSize ?? bytes.byteLength,
		container: isGLB(bytes) ? 'glb' : 'gltf',
		generator: asset.generator || null,
		version: asset.version || null,
		copyright: asset.copyright || null,
		extensionsUsed: root.listExtensionsUsed().map((x) => x.extensionName),
		extensionsRequired: root.listExtensionsRequired().map((x) => x.extensionName),
		counts: {
			scenes: scenes.length,
			nodes: nodes.length,
			meshes: meshes.length,
			materials: materials.length,
			textures: textures.length,
			animations: animations.length,
			skins: skins.length,
			totalJoints,
			totalVertices,
			totalTriangles,
			indexedPrimitives,
			nonIndexedPrimitives,
		},
		primitiveModes: [...primitiveModes],
		textures: textureDetails,
		materials: materialSummary,
	};
}

/**
 * Offer optimization suggestions based on structural analysis.
 * Each suggestion has a severity (info|warn|critical), id, message, and
 * optional estimate of impact.
 *
 * @param {Awaited<ReturnType<typeof inspectModel>>} info
 * @returns {Array<{ id: string, severity: 'info'|'warn'|'critical', message: string, estimate?: string }>}
 */
export function suggestOptimizations(info) {
	const out = [];
	const c = info.counts;

	if (c.totalTriangles > 500_000) {
		out.push({
			id: 'tri_budget',
			severity: 'warn',
			message: `Model has ${c.totalTriangles.toLocaleString()} triangles — consider mesh decimation or LODs for web delivery.`,
		});
	}

	if (!info.extensionsUsed.includes('KHR_draco_mesh_compression') && c.totalVertices > 50_000) {
		out.push({
			id: 'draco',
			severity: 'info',
			message: 'Apply Draco compression to geometry for ~60-80% smaller vertex buffers.',
			estimate: `~${Math.round((c.totalVertices * 12) / 1024)} KB potential savings`,
		});
	}

	if (!info.extensionsUsed.includes('EXT_meshopt_compression') && c.totalVertices > 50_000) {
		out.push({
			id: 'meshopt',
			severity: 'info',
			message:
				'Meshopt compression can reduce vertex+index size with faster decode than Draco.',
		});
	}

	const bigTextures = info.textures.filter((t) => Math.max(t.width, t.height) >= 4096);
	if (bigTextures.length > 0) {
		out.push({
			id: 'texture_oversized',
			severity: 'warn',
			message: `${bigTextures.length} texture(s) at ≥4K. Resize to 2048px for web unless hero detail is required.`,
		});
	}

	const pngTextures = info.textures.filter((t) => t.mimeType === 'image/png');
	if (pngTextures.length > 0 && !info.extensionsUsed.includes('KHR_texture_basisu')) {
		out.push({
			id: 'texture_basisu',
			severity: 'info',
			message:
				'Transcode PNG textures to KTX2 (Basis Universal) for GPU-direct upload and smaller download.',
		});
	}

	if (c.nonIndexedPrimitives > 0) {
		out.push({
			id: 'non_indexed',
			severity: 'info',
			message: `${c.nonIndexedPrimitives} primitive(s) are non-indexed — re-indexing typically reduces vertex count by 2-3×.`,
		});
	}

	if (info.materials.length > c.meshes * 2 && c.meshes > 0) {
		out.push({
			id: 'too_many_materials',
			severity: 'info',
			message: `${info.materials.length} materials for ${c.meshes} meshes. Merging identical materials can reduce draw calls.`,
		});
	}

	const totalTextureBytes = info.textures.reduce((a, t) => a + t.byteSize, 0);
	if (totalTextureBytes > 20 * 1024 * 1024) {
		out.push({
			id: 'texture_weight',
			severity: 'warn',
			message: `Textures alone weigh ${(totalTextureBytes / 1024 / 1024).toFixed(1)} MB — combine with KTX2 compression and resize for web.`,
		});
	}

	if (info.fileSize > 25 * 1024 * 1024) {
		out.push({
			id: 'file_size',
			severity: 'warn',
			message: `Overall file size ${(info.fileSize / 1024 / 1024).toFixed(1)} MB is heavy for web delivery; target <10 MB.`,
		});
	}

	if (c.animations > 0 && c.skins === 0) {
		out.push({
			id: 'anim_without_skin',
			severity: 'info',
			message: `${c.animations} animation(s) without skins — confirm these are node-level and not orphan data.`,
		});
	}

	if (out.length === 0) {
		out.push({
			id: 'ok',
			severity: 'info',
			message: 'Model looks well-optimized for web delivery — no suggestions flagged.',
		});
	}

	return out;
}
