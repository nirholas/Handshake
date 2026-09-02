// Materialize mesh loader: GLB bytes in, a flat world-space triangle soup out.
//
// Every other module in api/_lib/print/ works on ONE representation: indexed
// Float64 positions in world space (meters, glTF's own unit), a Uint32 index
// buffer, and an optional per-vertex RGB sampled from the source material. The
// printability analyzer, the manifold repair, the STL writer and the 3MF writer
// all consume that and nothing else, so glTF's node hierarchy, primitive
// splits, compression codecs and texture indirection are decoded exactly once,
// here.
//
// Why per-vertex color is loaded at all: full-color sandstone and binder-jet
// printers take color per vertex, not per texture. 3MF's core spec carries a
// colorgroup keyed off vertices, so sampling the base-color texture at each
// vertex UV at LOAD time is what makes a colored print possible downstream. A
// GLB with a 2K albedo becomes a mesh a color printer can actually reproduce.
//
// Input is bounded twice (bytes, then triangles) because the two failure modes
// are different: a 400 MB download is a network/memory problem before anything
// parses, and a 5M-triangle scene parses fine and then melts the repair stage.
// Both raise a typed error naming the limit it hit, never a generic 500.

import { Buffer } from 'node:buffer';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { fetchModel, FetchModelError } from '../fetch-model.js';

// Hard ceilings for a single analyze/prepare call. 100 MB covers every real
// forge output (they land in the 2-30 MB band) plus hand-uploaded scan data;
// 2M triangles is roughly 40x a dense forge mesh and is the point where the
// manifold reconstruction stops being interactive.
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_TRIANGLES = 2_000_000;

// glTF primitive.mode: only triangles enclose a volume. Points, lines and the
// strip/fan modes are render aids; they are counted as skipped rather than
// folded into geometry that money is quoted against.
const MODE_TRIANGLES = 4;

export class MeshIoError extends Error {
	constructor(code, message, extra = {}) {
		super(message);
		this.name = 'MeshIoError';
		this.code = code;
		this.extra = extra;
	}
}

let ioPromise = null;

// One shared, fully-registered IO. Draco and meshopt are the two codecs our own
// forge emits, so a loader that could not read them would reject exactly the
// assets a user is most likely to want printed.
async function getIO() {
	if (!ioPromise) {
		ioPromise = (async () => {
			const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
			const dependencies = {};
			try {
				const draco = await import('draco3dgltf');
				const create = draco.default ?? draco;
				dependencies['draco3d.decoder'] = await create.createDecoderModule();
			} catch {
				// Only matters if the asset actually uses Draco; readBinary then
				// throws a precise "missing dependency" the caller maps to 400.
			}
			try {
				const { MeshoptDecoder } = await import('meshoptimizer');
				await MeshoptDecoder.ready;
				dependencies['meshopt.decoder'] = MeshoptDecoder;
			} catch {
				// Same reasoning as Draco above.
			}
			if (Object.keys(dependencies).length) io.registerDependencies(dependencies);
			return io;
		})();
	}
	return ioPromise;
}

// glTF world matrices are column-major (the spec's own convention), which is
// also what gltf-transform's getWorldMatrix returns.
function transformPoint(m, x, y, z) {
	const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
	return [
		(m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
		(m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
		(m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
	];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// glTF's default sampler wrap is REPEAT, so a UV outside [0,1] tiles.
const wrap01 = (v) => {
	const f = v - Math.floor(v);
	return f < 0 ? f + 1 : f;
};

// sRGB encode a linear channel. baseColorFactor and COLOR_0 are linear per the
// glTF spec; the base-color TEXTURE is already sRGB-encoded. 3MF and STL colors
// are display values, so the linear inputs are encoded on the way out and the
// texture sample is used as-is.
function linearToSrgb(c) {
	return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// Decode one glTF texture image to raw RGBA once, memoized per Texture object
// for the lifetime of a single load. sharp handles every image type glTF
// allows (PNG, JPEG, WebP via KHR_texture_basisu fallbacks). A texture that
// cannot be decoded degrades to the material's flat baseColorFactor rather
// than failing the load: a print without color still prints.
async function decodeTexture(texture, cache) {
	if (!texture) return null;
	if (cache.has(texture)) return cache.get(texture);
	const entry = (async () => {
		const image = texture.getImage();
		if (!image || image.byteLength === 0) return null;
		try {
			const sharp = (await import('sharp')).default;
			const { data, info } = await sharp(Buffer.from(image))
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });
			return { data, width: info.width, height: info.height, channels: info.channels };
		} catch {
			return null;
		}
	})();
	cache.set(texture, entry);
	return entry;
}

// Nearest-neighbour sample. Bilinear would buy nothing here: the consumer is a
// printer nozzle averaging over a voxel far larger than a texel, and nearest
// keeps the sample exactly reproducible for the determinism contract.
function sampleTexel(img, u, v) {
	const x = Math.min(img.width - 1, Math.floor(wrap01(u) * img.width));
	// glTF UV origin is top-left, image row 0 is top, so no V flip is needed.
	const y = Math.min(img.height - 1, Math.floor(wrap01(v) * img.height));
	const i = (y * img.width + x) * img.channels;
	return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

// Resolve the base-color texture + factor for a primitive's material, following
// KHR_materials_pbrSpecularGlossiness's diffuse channel when that is what the
// asset used instead of metallic-roughness.
function baseColorOf(material) {
	if (!material) return { texture: null, factor: [1, 1, 1] };
	const factor = material.getBaseColorFactor?.() || [1, 1, 1, 1];
	return {
		texture: material.getBaseColorTexture?.() || null,
		factor: [clamp01(factor[0]), clamp01(factor[1]), clamp01(factor[2])],
	};
}

/**
 * Walk the default scene, bake node transforms, merge every triangle primitive
 * into one indexed soup, and sample a per-vertex color where the source had
 * one. Returns the single representation the rest of the print pipeline reads.
 *
 * @param {Uint8Array|Buffer} bytes raw .glb bytes
 * @param {{ maxBytes?: number, maxTriangles?: number, color?: boolean }} [opts]
 */
export async function loadMesh(bytes, opts = {}) {
	const maxBytes = opts.maxBytes ?? MAX_INPUT_BYTES;
	const maxTriangles = opts.maxTriangles ?? MAX_TRIANGLES;
	const wantColor = opts.color !== false;

	if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 20) {
		throw new MeshIoError('invalid_model', 'input is not a glTF/GLB buffer');
	}
	if (bytes.byteLength > maxBytes) {
		throw new MeshIoError(
			'too_large',
			`model is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit for a print job`,
			{ limitBytes: maxBytes, actualBytes: bytes.byteLength },
		);
	}

	const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const io = await getIO();
	let doc;
	try {
		doc = await io.readBinary(input);
	} catch (err) {
		throw new MeshIoError('invalid_model', `not a valid GLB: ${err?.message || err}`);
	}

	const root = doc.getRoot();
	const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
	const roots = scene ? scene.listChildren() : root.listNodes();

	const positions = [];
	const indices = [];
	const colors = wantColor ? [] : null;
	const textureCache = new Map();
	let skippedPrimitives = 0;
	let texturedPrimitives = 0;
	let triangles = 0;

	// Node hierarchies can be re-entered through instancing; `seen` keeps a
	// shared subtree from being baked twice into the same soup.
	const seen = new Set();
	const stack = [...roots].reverse();
	const visited = [];
	while (stack.length) {
		const node = stack.pop();
		if (!node || seen.has(node)) continue;
		seen.add(node);
		visited.push(node);
		const children = node.listChildren();
		for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
	}

	for (const node of visited) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const matrix = node.getWorldMatrix();
		for (const prim of mesh.listPrimitives()) {
			if (prim.getMode() !== MODE_TRIANGLES) {
				skippedPrimitives += 1;
				continue;
			}
			const position = prim.getAttribute('POSITION');
			if (!position) {
				skippedPrimitives += 1;
				continue;
			}
			const count = position.getCount();
			const index = prim.getIndices();
			const primTris = index ? Math.floor(index.getCount() / 3) : Math.floor(count / 3);
			triangles += primTris;
			if (triangles > maxTriangles) {
				throw new MeshIoError(
					'too_complex',
					`model exceeds the ${maxTriangles}-triangle limit for a print job; decimate it first (POST /api/3d/inspect suggests how)`,
					{ limitTriangles: maxTriangles },
				);
			}

			const base = positions.length / 3;
			const p = [0, 0, 0];
			for (let i = 0; i < count; i += 1) {
				position.getElement(i, p);
				const [x, y, z] = transformPoint(matrix, p[0], p[1], p[2]);
				positions.push(x, y, z);
			}
			if (index) {
				const n = index.getCount();
				for (let i = 0; i + 2 < n; i += 3) {
					indices.push(base + index.getScalar(i), base + index.getScalar(i + 1), base + index.getScalar(i + 2));
				}
			} else {
				for (let i = 0; i + 2 < count; i += 3) indices.push(base + i, base + i + 1, base + i + 2);
			}

			if (!colors) continue;
			const { texture, factor } = baseColorOf(prim.getMaterial());
			const uv = prim.getAttribute('TEXCOORD_0');
			const vertexColor = prim.getAttribute('COLOR_0');
			const img = texture && uv ? await decodeTexture(texture, textureCache) : null;
			if (img) texturedPrimitives += 1;
			const uvEl = [0, 0];
			const cEl = [1, 1, 1, 1];
			for (let i = 0; i < count; i += 1) {
				let r;
				let g;
				let b;
				if (img) {
					uv.getElement(i, uvEl);
					const [tr, tg, tb] = sampleTexel(img, uvEl[0], uvEl[1]);
					// Texture is sRGB, factor is linear: encode the factor before
					// modulating so the product stays in one color space.
					r = (tr / 255) * linearToSrgb(factor[0]);
					g = (tg / 255) * linearToSrgb(factor[1]);
					b = (tb / 255) * linearToSrgb(factor[2]);
				} else {
					r = linearToSrgb(factor[0]);
					g = linearToSrgb(factor[1]);
					b = linearToSrgb(factor[2]);
				}
				if (vertexColor) {
					vertexColor.getElement(i, cEl);
					r *= linearToSrgb(clamp01(cEl[0]));
					g *= linearToSrgb(clamp01(cEl[1]));
					b *= linearToSrgb(clamp01(cEl[2]));
				}
				colors.push(
					Math.round(clamp01(r) * 255),
					Math.round(clamp01(g) * 255),
					Math.round(clamp01(b) * 255),
				);
			}
		}
	}

	if (indices.length < 3) {
		throw new MeshIoError('no_geometry', 'model contains no triangle geometry to print');
	}

	return {
		positions: Float64Array.from(positions),
		indices: Uint32Array.from(indices),
		colors: colors ? Uint8Array.from(colors) : null,
		vertexCount: positions.length / 3,
		triangleCount: indices.length / 3,
		skippedPrimitives,
		hasTextures: root.listTextures().length > 0,
		colorSource: texturedPrimitives > 0 ? 'texture' : colors ? 'material' : 'none',
		sizeBytes: input.byteLength,
		materials: root.listMaterials().length,
		document: doc,
	};
}

/**
 * Fetch a GLB by URL through the SSRF-hardened, size-capped fetcher and load
 * it. Fetch failures are re-thrown as MeshIoError so a caller has exactly one
 * error type to map onto HTTP.
 */
export async function loadMeshFromUrl(url, opts = {}) {
	const maxBytes = opts.maxBytes ?? MAX_INPUT_BYTES;
	let fetched;
	try {
		fetched = await fetchModel(url, { maxBytes, timeoutMs: opts.timeoutMs ?? 30_000 });
	} catch (err) {
		if (err instanceof FetchModelError) {
			if (err.code === 'file_too_large') {
				throw new MeshIoError('too_large', `model exceeds the ${maxBytes}-byte limit for a print job`, {
					limitBytes: maxBytes,
				});
			}
			if (['invalid_url', 'scheme_not_allowed', 'private_address', 'host_pin_mismatch'].includes(err.code)) {
				throw new MeshIoError('invalid_url', err.message);
			}
			throw new MeshIoError('fetch_failed', `could not fetch model: ${err.message}`);
		}
		throw new MeshIoError('fetch_failed', `could not fetch model: ${err?.message || err}`);
	}
	const mesh = await loadMesh(fetched.bytes, opts);
	return { ...mesh, sourceUrl: fetched.url, bytes: fetched.bytes };
}

/** Axis-aligned bounds of an indexed soup, in the mesh's own units (meters). */
export function boundsOf(positions) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < positions.length; i += 3) {
		for (let a = 0; a < 3; a += 1) {
			const v = positions[i + a];
			if (v < min[a]) min[a] = v;
			if (v > max[a]) max[a] = v;
		}
	}
	if (!Number.isFinite(min[0])) return null;
	const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	return {
		min,
		max,
		size,
		center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
		diagonal: Math.hypot(size[0], size[1], size[2]),
		longest: Math.max(size[0], size[1], size[2]),
	};
}

/**
 * Weld vertices by quantized position. Analysis and manifold reconstruction
 * both need topology, and UV/normal seams split vertices that are
 * geometrically identical. Counting those seams as boundary edges would
 * report a perfectly closed model as full of holes.
 */
export function weldPositions(positions, indices, tolerance) {
	const inv = 1 / tolerance;
	const map = new Map();
	const remap = new Uint32Array(positions.length / 3);
	const unique = [];
	for (let i = 0, v = 0; i < positions.length; i += 3, v += 1) {
		const key = `${Math.round(positions[i] * inv)},${Math.round(positions[i + 1] * inv)},${Math.round(positions[i + 2] * inv)}`;
		let id = map.get(key);
		if (id === undefined) {
			id = unique.length / 3;
			map.set(key, id);
			unique.push(positions[i], positions[i + 1], positions[i + 2]);
		}
		remap[v] = id;
	}
	const welded = new Uint32Array(indices.length);
	for (let i = 0; i < indices.length; i += 1) welded[i] = remap[indices[i]];
	return { positions: Float64Array.from(unique), indices: welded, remap };
}
