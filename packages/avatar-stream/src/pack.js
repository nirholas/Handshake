/**
 * A3S packer - turns one GLB into a progressive A3S stream. Node only.
 *
 * The packer's whole job is to earn the format's central promise: that a prefix
 * of the file is a complete asset. It does that in four moves.
 *
 *   1. Build a level-of-detail chain by simplifying *successively*, finest to
 *      coarsest. Each step collapses edges of the previous step's index buffer,
 *      so the vertices surviving at level k are a strict subset of those at
 *      level k+1. That nesting is not incidental, it is the property the whole
 *      format rests on, and `verifyNesting` asserts it rather than assuming it.
 *   2. Rank every vertex by the coarsest level it survives into, then reorder
 *      the vertex buffer by that rank. Now level k's vertices are exactly the
 *      first V(k) entries, and a patch can append instead of rewrite.
 *   3. Emit level 0 as a standalone, spec-valid GLB carrying the full node
 *      hierarchy and skin, so the coarse mesh is already skinned and posed.
 *   4. Emit each finer level as a patch: the newly revealed vertex bytes plus a
 *      replacement index buffer.
 *
 * Skinning survives all of this for free: meshopt's simplifier only ever emits a
 * new index buffer over the original vertex array, so JOINTS_0 and WEIGHTS_0
 * ride along untouched. Morph targets are carried explicitly, reordered and
 * sliced in lockstep with the base attributes they deform.
 */

import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { cloneDocument, dequantize, prune, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

import { VERSION_TAG, encodeContainer, decodeHeader, decodePreamble, align4 } from './format.js';

/** Default level ratios, coarsest first. The trailing 1.0 level is the original mesh. */
export const DEFAULT_LEVELS = [0.03, 0.1, 0.3, 1.0];

/** Longest edge, in pixels, of the textures baked into the base layer. */
export const DEFAULT_BASE_TEXTURE_SIZE = 64;

/** glTF primitive mode for triangles; the only mode a mesh simplifier can reason about. */
const MODE_TRIANGLES = 4;

/** Compression extensions the base layer deliberately does not depend on. */
const COMPRESSION_EXTENSIONS = new Set(['EXT_meshopt_compression', 'KHR_draco_mesh_compression']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

let ioPromise = null;
/** Build (once) a NodeIO wired for every extension the platform's avatars use. */
export async function getIO() {
	if (!ioPromise) {
		ioPromise = (async () => {
			await MeshoptDecoder.ready;
			await MeshoptEncoder.ready;
			return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
				'draco3d.decoder': await draco3d.createDecoderModule(),
				'draco3d.encoder': await draco3d.createEncoderModule(),
				'meshopt.decoder': MeshoptDecoder,
				'meshopt.encoder': MeshoptEncoder,
			});
		})();
	}
	return ioPromise;
}

/**
 * Assert that a chain of index buffers has strictly nested vertex sets, coarsest
 * first. A packer that skipped this could still produce a plausible-looking file
 * whose patches silently reference vertices the client was never sent.
 */
export function verifyNesting(chain) {
	const sets = chain.map((indices) => new Set(indices));
	for (let i = 0; i < sets.length - 1; i++) {
		for (const v of sets[i]) {
			if (!sets[i + 1].has(v)) {
				throw new Error(`a3s: level ${i} is not nested inside level ${i + 1}; cannot pack progressively`);
			}
		}
	}
	return sets;
}

/**
 * Build the coarse-to-fine index chain for one primitive.
 * @returns {Uint32Array[]} index buffers, coarsest first, finest (original) last
 */
export function buildLodChain(indices, positions, levels) {
	const original = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
	const triangles = original.length / 3;
	// Walk fine -> coarse so each simplification consumes the previous result,
	// which is what makes the surviving vertex sets nest.
	const descending = levels.filter((r) => r < 1).sort((a, b) => b - a);
	const coarseToFine = [];
	let current = original;
	for (const ratio of descending) {
		const target = Math.max(1, Math.floor(triangles * ratio)) * 3;
		if (target >= current.length) continue;
		const [simplified] = MeshoptSimplifier.simplify(current, positions, 3, target, 1.0, ['LockBorder']);
		const next = simplified instanceof Uint32Array ? simplified : new Uint32Array(simplified);
		// A tiny primitive can collapse to nothing. An empty level would slice its
		// accessors to count 0, which is invalid glTF, so keep the finer buffer
		// rather than emitting a level that renders as a hole.
		if (next.length < 3) continue;
		current = next;
		coarseToFine.unshift(current);
	}
	// Pad so every primitive reports the same number of levels even when a small
	// mesh could not be decimated further; readers index layers positionally.
	while (coarseToFine.length < levels.length - 1) coarseToFine.unshift(coarseToFine[0] || original);
	coarseToFine.push(original);
	return coarseToFine;
}

/**
 * Rank vertices by the coarsest level they appear in, then produce the
 * old->new remap that groups each level's vertices into a contiguous prefix.
 */
export function computeVertexOrder(chain, vertexCount) {
	const RANK_UNUSED = chain.length; // vertices no level references sort last
	const rank = new Uint32Array(vertexCount).fill(RANK_UNUSED);
	for (let level = chain.length - 1; level >= 0; level--) {
		for (const v of chain[level]) rank[v] = level;
	}
	const sorted = Array.from({ length: vertexCount }, (_, i) => i).sort((a, b) => rank[a] - rank[b] || a - b);
	const remap = new Uint32Array(vertexCount);
	sorted.forEach((oldIndex, newIndex) => {
		remap[oldIndex] = newIndex;
	});
	const levelVertexCounts = [];
	let seen = 0;
	for (let level = 0; level < chain.length; level++) {
		while (seen < vertexCount && rank[sorted[seen]] <= level) seen++;
		levelVertexCounts.push(seen);
	}
	return { remap, order: Uint32Array.from(sorted), levelVertexCounts };
}

/** Reorder a flat typed array of `order.length` elements of `stride` components. */
function reorderArray(array, order, stride) {
	const out = new array.constructor(order.length * stride);
	for (let i = 0; i < order.length; i++) {
		const src = order[i] * stride;
		const dst = i * stride;
		for (let c = 0; c < stride; c++) out[dst + c] = array[src + c];
	}
	return out;
}

function indexArrayFor(vertexCount, indices) {
	return vertexCount <= 0xffff ? Uint16Array.from(indices) : Uint32Array.from(indices);
}

/**
 * Every per-vertex accessor a primitive owns, including morph target deltas.
 *
 * Accessors are routinely shared between primitives in a real GLB, so each one
 * is cloned into sole ownership first. Without that, reordering the vertices of
 * one primitive silently scrambles every sibling that pointed at the same
 * buffer, which surfaces much later as "all accessors of the same primitive must
 * have the same count".
 */
function claimVertexAccessors(prim) {
	const entries = [];
	for (const semantic of prim.listSemantics()) {
		const owned = prim.getAttribute(semantic).clone();
		prim.setAttribute(semantic, owned);
		entries.push({ key: semantic, accessor: owned });
	}
	prim.listTargets().forEach((target, t) => {
		for (const semantic of target.listSemantics()) {
			const owned = target.getAttribute(semantic).clone();
			target.setAttribute(semantic, owned);
			entries.push({ key: `targets/${t}/${semantic}`, accessor: owned });
		}
	});
	return entries;
}

async function resizeTexture(bytes, mimeType, maxSize) {
	const image = sharp(Buffer.from(bytes), { failOn: 'none' });
	const meta = await image.metadata();
	const longest = Math.max(meta.width || 0, meta.height || 0);
	if (!longest) return null;
	const pipeline = longest > maxSize ? image.resize({ width: maxSize, height: maxSize, fit: 'inside' }) : image;
	// Re-encode into the source container so the base layer stays loadable in
	// every glTF viewer, not just the ones that negotiated a newer image codec.
	let out;
	if (mimeType === 'image/jpeg') out = await pipeline.jpeg({ quality: 80 }).toBuffer();
	else if (mimeType === 'image/webp') out = await pipeline.webp({ quality: 80 }).toBuffer();
	else out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
	const outMeta = await sharp(out).metadata();
	return { bytes: new Uint8Array(out), width: outMeta.width, height: outMeta.height };
}

/**
 * Pack a GLB into an A3S container.
 *
 * @param {Uint8Array|Buffer} glbBytes
 * @param {object} [options]
 * @param {number[]} [options.levels] LOD ratios, coarsest first, ending at 1.0
 * @param {number} [options.baseTextureSize] longest texture edge in the base layer
 * @param {string} [options.name] source name recorded in the header
 * @returns {Promise<{ container: Uint8Array, header: object, stats: object }>}
 */
export async function pack(glbBytes, options = {}) {
	const levels = options.levels || DEFAULT_LEVELS;
	const baseTextureSize = options.baseTextureSize || DEFAULT_BASE_TEXTURE_SIZE;
	const source = glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes);
	const levelCount = levels.length;

	await MeshoptSimplifier.ready;
	const io = await getIO();
	const doc = await io.readBinary(new Uint8Array(source));
	const root = doc.getRoot();
	// Positions arrive quantized on most platform avatars; the simplifier needs
	// real floats, and the base layer is small enough that the trade is cheap.
	await doc.transform(dequantize());
	// Layer 0's whole promise is that it opens anywhere, so it must not require a
	// decoder the reader may not have installed. Dropping the compression
	// extensions the source declared costs a few kilobytes and buys a base layer
	// that loads in a stock GLTFLoader, in Blender, and in the Khronos validator.
	for (const extension of root.listExtensionsUsed()) {
		if (COMPRESSION_EXTENSIONS.has(extension.extensionName)) extension.dispose();
	}

	const primPlans = [];
	let skipped = 0;

	let primOrdinal = 0;
	for (const mesh of root.listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			const ordinal = primOrdinal++;
			const position = prim.getAttribute('POSITION');
			// Points, lines and strips have no triangles to collapse. They ride in
			// the base layer at full detail rather than being dropped.
			if (!position || prim.getMode() !== MODE_TRIANGLES) {
				skipped++;
				continue;
			}
			if (!prim.getIndices()) {
				// A non-indexed triangle soup shares no vertices between triangles, so
				// every edge reads as a border and the simplifier can collapse nothing.
				// Welding restores the shared topology the format needs.
				weldPrimitive(prim);
			}
			const vertexCount = prim.getAttribute('POSITION').getCount();
			let sourceIndices = prim.getIndices()?.getArray();
			if (!sourceIndices) {
				sourceIndices = new Uint32Array(vertexCount);
				for (let i = 0; i < vertexCount; i++) sourceIndices[i] = i;
			}
			if (sourceIndices.length < 3) {
				skipped++;
				continue;
			}

			const entries = claimVertexAccessors(prim);
			const positions = prim.getAttribute('POSITION').getArray();
			const chain = buildLodChain(new Uint32Array(sourceIndices), positions, levels);
			verifyNesting(chain);
			const { remap, order, levelVertexCounts } = computeVertexOrder(chain, vertexCount);

			const snapshot = {};
			for (const { key, accessor } of entries) {
				const stride = accessor.getElementSize();
				const reordered = reorderArray(accessor.getArray(), order, stride);
				accessor.setArray(reordered);
				snapshot[key] = {
					array: reordered,
					elementSize: stride,
					componentType: accessor.getComponentType(),
					type: accessor.getType(),
					normalized: accessor.getNormalized(),
				};
			}
			const remapped = chain.map((indices) => {
				const out = new Uint32Array(indices.length);
				for (let i = 0; i < indices.length; i++) out[i] = remap[indices[i]];
				return out;
			});

			// An indexed primitive is required from here on, since every level ships
			// its own index buffer.
			if (!prim.getIndices()) {
				prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(sourceIndices)));
			} else {
				prim.setIndices(prim.getIndices().clone());
			}

			prim.setExtras({ ...(prim.getExtras() || {}), a3sPrim: ordinal });
			primPlans.push({ ordinal, prim, entries, snapshot, chain: remapped, levelVertexCounts, vertexCount });
		}
	}

	if (!primPlans.length) {
		throw new Error('a3s: no triangle primitives found; nothing to stream progressively');
	}

	// --- Texture pyramid ------------------------------------------------------
	// The base layer carries thumbnails so it stays tiny; the final layer carries
	// the originals. The format permits more steps; the packer emits two.
	const texturePlans = [];
	const textures = root.listTextures();
	for (let i = 0; i < textures.length; i++) {
		const texture = textures[i];
		const image = texture.getImage();
		const mimeType = texture.getMimeType();
		if (!image || !/^image\/(png|jpeg|webp)$/.test(mimeType || '')) continue;
		const small = await resizeTexture(image, mimeType, baseTextureSize);
		if (!small) continue;
		texturePlans.push({
			index: i,
			mimeType,
			full: new Uint8Array(image),
			small: small.bytes,
			slots: describeTextureSlots(root, texture),
		});
		texture.setImage(small.bytes);
	}

	// --- Layer 0: a standalone, valid GLB ------------------------------------
	for (const plan of primPlans) sliceToLevel(plan, 0);

	// Animation tracks are the heaviest thing in a rigged avatar: on a 65-joint
	// character they routinely outweigh the mesh several times over, and they are
	// the one part nobody can see in the first frame. The base layer keeps the
	// skeleton and sheds the clips, which ship as a geometry-free companion GLB
	// in the first patch. Clip tracks bind to nodes by name, so they drop onto
	// the base skeleton the moment they land.
	let animationGlb = null;
	const animationNames = root.listAnimations().map((a) => a.getName() || null);
	if (animationNames.length) {
		const animDoc = cloneDocument(doc);
		const animRoot = animDoc.getRoot();
		// A node may not keep a `skin` once its `mesh` is gone: that pairing is a
		// hard glTF constraint, and the companion carries clips, not geometry.
		for (const node of animRoot.listNodes()) {
			node.setMesh(null);
			node.setSkin(null);
		}
		for (const skin of animRoot.listSkins()) skin.dispose();
		for (const mesh of animRoot.listMeshes()) mesh.dispose();
		for (const material of animRoot.listMaterials()) material.dispose();
		for (const texture of animRoot.listTextures()) texture.dispose();
		disposeAccessorsExcept(animRoot, collectAnimationAccessors(animRoot));
		await animDoc.transform(prune({ keepAttributes: false, keepLeaves: true }));
		animationGlb = new Uint8Array(await io.writeBinary(animDoc));

		for (const animation of root.listAnimations()) {
			// Disposing an Animation orphans its sampler accessors rather than
			// deleting them, and they are the heaviest thing in the file.
			for (const sampler of animation.listSamplers()) {
				sampler.getInput()?.dispose();
				sampler.getOutput()?.dispose();
			}
			animation.dispose();
		}
	}
	await doc.transform(prune({ keepAttributes: false, keepLeaves: true }));
	const baseGlb = new Uint8Array(await io.writeBinary(doc));

	// --- Layers 1..N: patches -------------------------------------------------
	const patches = [];
	const layerDescriptors = [];
	for (let level = 1; level < levelCount; level++) {
		const chunks = [];
		let cursor = 0;
		const prims = [];
		for (const plan of primPlans) {
			const from = plan.levelVertexCounts[level - 1];
			const to = plan.levelVertexCounts[level];
			const attributes = {};
			for (const [key, meta] of Object.entries(plan.snapshot)) {
				const stride = meta.elementSize;
				const slice = meta.array.subarray(from * stride, to * stride);
				const bytes = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
				attributes[key] = {
					offset: cursor,
					length: bytes.byteLength,
					componentType: meta.componentType,
					type: meta.type,
					normalized: meta.normalized,
					elementSize: stride,
				};
				chunks.push(bytes);
				cursor = align4(cursor + bytes.byteLength);
			}
			const indices = indexArrayFor(to, plan.chain[level]);
			const indexBytes = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
			prims.push({
				prim: plan.ordinal,
				newVertexStart: from,
				newVertexCount: to - from,
				vertexCount: to,
				attributes,
				indices: {
					offset: cursor,
					length: indexBytes.byteLength,
					componentType: indices.BYTES_PER_ELEMENT === 2 ? 5123 : 5125,
					count: indices.length,
				},
			});
			chunks.push(indexBytes);
			cursor = align4(cursor + indexBytes.byteLength);
		}

		// The first patch carries the animation bundle: clips matter to a viewer
		// long before the finest triangles do.
		let animationChunk = null;
		if (level === 1 && animationGlb) {
			animationChunk = { offset: cursor, length: animationGlb.byteLength, clips: animationNames };
			chunks.push(animationGlb);
			cursor = align4(cursor + animationGlb.byteLength);
		}

		// The finest level also delivers the full-resolution textures.
		const texturePatches = [];
		if (level === levelCount - 1) {
			for (const plan of texturePlans) {
				texturePatches.push({
					texture: plan.index,
					offset: cursor,
					length: plan.full.byteLength,
					mimeType: plan.mimeType,
					slots: plan.slots,
				});
				chunks.push(plan.full);
				cursor = align4(cursor + plan.full.byteLength);
			}
		}

		const payload = new Uint8Array(cursor);
		let write = 0;
		for (const chunk of chunks) {
			payload.set(chunk, write);
			write = align4(write + chunk.byteLength);
		}
		patches.push(payload);
		layerDescriptors.push({
			level,
			kind: 'patch',
			sha256: sha256(payload),
			triangleCount: primPlans.reduce((n, p) => n + p.chain[level].length / 3, 0),
			vertexCount: primPlans.reduce((n, p) => n + p.levelVertexCounts[level], 0),
			prims,
			textures: texturePatches,
			animations: animationChunk,
		});
	}

	const header = {
		version: VERSION_TAG,
		generator: '@three-ws/avatar-stream',
		source: {
			name: options.name || null,
			sha256: sha256(source),
			byteLength: source.byteLength,
		},
		geometry: {
			vertexCount: primPlans.reduce((n, p) => n + p.vertexCount, 0),
			triangleCount: primPlans.reduce((n, p) => n + p.chain[levelCount - 1].length / 3, 0),
			primitiveCount: primPlans.length,
			passthroughPrimitiveCount: skipped,
		},
		levels,
		layers: [
			{
				level: 0,
				kind: 'base',
				sha256: sha256(baseGlb),
				triangleCount: primPlans.reduce((n, p) => n + p.chain[0].length / 3, 0),
				vertexCount: primPlans.reduce((n, p) => n + p.levelVertexCounts[0], 0),
			},
			...layerDescriptors,
		],
	};

	const container = encodeContainer({ header, baseGlb, patches });
	// Read the offsets straight back out of the encoded bytes, so what the caller
	// inspects is exactly what a client will parse, never a hopeful copy.
	const encodedHeader = decodeHeader(container, decodePreamble(container));
	return {
		container,
		header: encodedHeader,
		stats: {
			sourceBytes: source.byteLength,
			containerBytes: container.byteLength,
			baseBytes: baseGlb.byteLength,
			baseTriangles: header.layers[0].triangleCount,
			fullTriangles: header.geometry.triangleCount,
			layerCount: levelCount,
		},
	};
}

/** Every accessor an animation clip needs in order to play. */
function collectAnimationAccessors(root) {
	const keep = new Set();
	for (const animation of root.listAnimations()) {
		for (const sampler of animation.listSamplers()) {
			const input = sampler.getInput();
			const output = sampler.getOutput();
			if (input) keep.add(input);
			if (output) keep.add(output);
		}
	}
	return keep;
}

/** Drop every accessor the document owns that is not in `keep`. */
function disposeAccessorsExcept(root, keep) {
	for (const accessor of root.listAccessors()) {
		if (!keep.has(accessor)) accessor.dispose();
	}
}

/** Map a texture to the material slots that reference it, for client-side swap-in. */
function describeTextureSlots(root, texture) {
	const slots = [];
	for (const material of root.listMaterials()) {
		const pairs = [
			['baseColorTexture', material.getBaseColorTexture()],
			['metallicRoughnessTexture', material.getMetallicRoughnessTexture()],
			['normalTexture', material.getNormalTexture()],
			['occlusionTexture', material.getOcclusionTexture()],
			['emissiveTexture', material.getEmissiveTexture()],
		];
		for (const [slot, tex] of pairs) {
			if (tex === texture) slots.push({ material: material.getName() || null, slot });
		}
	}
	return slots;
}

/** Slice one primitive's accessors, morph targets included, down to a level. */
function sliceToLevel(plan, level) {
	const keep = plan.levelVertexCounts[level];
	for (const { key, accessor } of plan.entries) {
		const meta = plan.snapshot[key];
		accessor.setArray(meta.array.slice(0, keep * meta.elementSize));
	}
	plan.prim.getIndices().setArray(indexArrayFor(keep, plan.chain[level]));
}
