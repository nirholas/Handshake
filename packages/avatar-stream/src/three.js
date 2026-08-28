/**
 * three.js binding for A3S - progressive refinement of a live scene.
 *
 * `three` and `GLTFLoader` are injected rather than imported, so this package
 * never pins a renderer version or ships a second copy of three into a host
 * app's bundle. Pass whatever the host already has.
 *
 *   const player = await A3SPlayer.load('/api/avatar-stream?id=michelle', {
 *     THREE, GLTFLoader,
 *     onLayer: (l) => console.log('level', l.level, l.triangleCount, 'tris'),
 *   });
 *   scene.add(player.scene);
 *   await player.refine();
 *
 * Refinement mutates the geometry already on screen: attributes grow in place
 * and the index buffer is swapped. Nothing is re-parsed, no second scene graph
 * is built, and the camera, pose, and animation state all survive untouched.
 */

import { A3SStream } from './reader.js';

const COMPONENT_ARRAYS = {
	5120: Int8Array,
	5121: Uint8Array,
	5122: Int16Array,
	5123: Uint16Array,
	5125: Uint32Array,
	5126: Float32Array,
};

/** glTF attribute semantic to three.js BufferGeometry attribute name. */
const SEMANTIC_TO_ATTRIBUTE = {
	POSITION: 'position',
	NORMAL: 'normal',
	TANGENT: 'tangent',
	TEXCOORD_0: 'uv',
	TEXCOORD_1: 'uv1',
	TEXCOORD_2: 'uv2',
	TEXCOORD_3: 'uv3',
	COLOR_0: 'color',
	JOINTS_0: 'skinIndex',
	WEIGHTS_0: 'skinWeight',
};

/** glTF material texture slot to the three.js material property it feeds. */
const SLOT_TO_PROPERTIES = {
	baseColorTexture: ['map'],
	metallicRoughnessTexture: ['roughnessMap', 'metalnessMap'],
	normalTexture: ['normalMap'],
	occlusionTexture: ['aoMap'],
	emissiveTexture: ['emissiveMap'],
};

const SRGB_SLOTS = new Set(['baseColorTexture', 'emissiveTexture']);

function typedArrayFrom(bytes, componentType) {
	const TypedArray = COMPONENT_ARRAYS[componentType];
	if (!TypedArray) throw new Error(`a3s: unknown component type ${componentType}`);
	// Copy rather than view: a payload sliced out of a larger response can start
	// at a byte offset the typed array constructor will not accept.
	const copy = bytes.slice();
	return new TypedArray(copy.buffer, copy.byteOffset, copy.byteLength / TypedArray.BYTES_PER_ELEMENT);
}

/** Index every streamable primitive in a loaded scene by its packer ordinal. */
export function indexPrimitives(root) {
	const byOrdinal = new Map();
	const ordered = [];
	root.traverse((object) => {
		if (!object.isMesh && !object.isSkinnedMesh) return;
		ordered.push(object);
		const ordinal = object.userData?.a3sPrim;
		if (typeof ordinal === 'number') byOrdinal.set(ordinal, object);
	});
	// The packer tags every primitive it touched via glTF `extras`. If a loader
	// dropped those, fall back to document order, which three.js preserves.
	if (!byOrdinal.size) ordered.forEach((mesh, i) => byOrdinal.set(i, mesh));
	return byOrdinal;
}

/**
 * Grow one geometry attribute so it covers `newVertexStart + newVertexCount`
 * vertices, keeping the bytes the client already holds.
 */
function growAttribute(THREE, geometry, name, meta, bytes, start, count) {
	const TypedArray = COMPONENT_ARRAYS[meta.componentType];
	const stride = meta.elementSize;
	const incoming = typedArrayFrom(bytes, meta.componentType);
	const total = (start + count) * stride;
	const existing = geometry.getAttribute(name);
	const merged = new TypedArray(total);
	if (existing) merged.set(existing.array.subarray(0, Math.min(existing.array.length, start * stride)), 0);
	merged.set(incoming.subarray(0, count * stride), start * stride);
	geometry.setAttribute(name, new THREE.BufferAttribute(merged, stride, meta.normalized));
}

function growMorphAttribute(THREE, geometry, targetIndex, semantic, meta, bytes, start, count) {
	const slot = { POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent' }[semantic];
	if (!slot) return;
	const stride = meta.elementSize;
	const TypedArray = COMPONENT_ARRAYS[meta.componentType];
	const incoming = typedArrayFrom(bytes, meta.componentType);
	const list = (geometry.morphAttributes[slot] ||= []);
	const existing = list[targetIndex];
	const merged = new TypedArray((start + count) * stride);
	if (existing) merged.set(existing.array.subarray(0, Math.min(existing.array.length, start * stride)), 0);
	merged.set(incoming.subarray(0, count * stride), start * stride);
	list[targetIndex] = new THREE.BufferAttribute(merged, stride, meta.normalized);
}

/** Apply one primitive's patch to its geometry. */
export function applyPrimitivePatch(THREE, mesh, entry, payload) {
	const geometry = mesh.geometry;
	for (const [key, meta] of Object.entries(entry.attributes)) {
		const bytes = A3SStream.chunk(payload, meta);
		const morph = key.match(/^targets\/(\d+)\/(.+)$/);
		if (morph) {
			growMorphAttribute(THREE, geometry, Number(morph[1]), morph[2], meta, bytes, entry.newVertexStart, entry.newVertexCount);
			continue;
		}
		const name = SEMANTIC_TO_ATTRIBUTE[key] || key.toLowerCase();
		growAttribute(THREE, geometry, name, meta, bytes, entry.newVertexStart, entry.newVertexCount);
	}
	const indexBytes = A3SStream.chunk(payload, entry.indices);
	geometry.setIndex(new THREE.BufferAttribute(typedArrayFrom(indexBytes, entry.indices.componentType), 1));
	geometry.computeBoundingSphere();
	geometry.computeBoundingBox();
}

/** Decode a texture patch and bind it to every material slot that referenced it. */
export async function applyTexturePatch(THREE, materialsByName, entry, payload) {
	const bytes = A3SStream.chunk(payload, entry);
	if (typeof createImageBitmap !== 'function') return;
	const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: entry.mimeType }));
	for (const { material: name, slot } of entry.slots) {
		const properties = SLOT_TO_PROPERTIES[slot];
		if (!properties) continue;
		for (const material of materialsByName.get(name) || []) {
			for (const property of properties) {
				const previous = material[property];
				if (!previous) continue;
				const texture = new THREE.Texture(bitmap);
				texture.flipY = false;
				texture.wrapS = previous.wrapS;
				texture.wrapT = previous.wrapT;
				texture.magFilter = previous.magFilter;
				texture.minFilter = previous.minFilter;
				texture.channel = previous.channel;
				if (SRGB_SLOTS.has(slot) && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
				texture.needsUpdate = true;
				material[property] = texture;
				material.needsUpdate = true;
				previous.dispose?.();
			}
		}
	}
}

function collectMaterials(root) {
	const byName = new Map();
	root.traverse((object) => {
		const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
		for (const material of materials) {
			const list = byName.get(material.name) || [];
			list.push(material);
			byName.set(material.name, list);
		}
	});
	return byName;
}

export class A3SPlayer {
	constructor({ THREE, GLTFLoader, stream, gltf, onLayer }) {
		this.THREE = THREE;
		this.GLTFLoader = GLTFLoader;
		this.stream = stream;
		this.gltf = gltf;
		this.scene = gltf.scene;
		/** Clips available so far. The base layer ships none; the first patch adds them. */
		this.animations = gltf.animations || [];
		this.onLayer = onLayer || null;
		this.level = 0;
		this.primitives = indexPrimitives(this.scene);
		this.materials = collectMaterials(this.scene);
	}

	/**
	 * Open a stream and parse its base layer into a renderable scene.
	 * Resolves as soon as the coarse avatar is ready to add to a scene.
	 */
	static async load(target, options = {}) {
		const { THREE, GLTFLoader } = options;
		if (!THREE || !GLTFLoader) throw new Error('a3s: pass { THREE, GLTFLoader } from the host app');
		const stream = await A3SStream.open(target, options);
		const loader = new GLTFLoader();
		const gltf = await loader.parseAsync(stream.base.slice().buffer, '');
		const player = new A3SPlayer({ THREE, GLTFLoader, stream, gltf, onLayer: options.onLayer });
		player.onLayer?.({
			level: 0,
			triangleCount: stream.header.layers[0].triangleCount,
			bytes: stream.base.byteLength,
			clips: player.animations.length,
		});
		return player;
	}

	/** Total triangles once every layer has been applied. */
	get fullTriangleCount() {
		return this.stream.header.geometry.triangleCount;
	}

	/**
	 * Pull and apply every remaining layer, coarse to fine, yielding to the
	 * renderer between layers so the refinement is visible rather than a stall.
	 */
	async refine(options = {}) {
		for await (const { level, descriptor, payload } of this.stream.layers(options)) {
			await this.applyLayer(descriptor, payload);
			this.level = level;
			this.onLayer?.({
				level,
				triangleCount: descriptor.triangleCount,
				bytes: payload.byteLength,
				clips: this.animations.length,
			});
		}
		return this;
	}

	/** Apply a single decoded layer to the live scene. */
	async applyLayer(descriptor, payload) {
		for (const entry of descriptor.prims || []) {
			const mesh = this.primitives.get(entry.prim);
			if (mesh) applyPrimitivePatch(this.THREE, mesh, entry, payload);
		}
		if (descriptor.animations) {
			const bytes = A3SStream.chunk(payload, descriptor.animations);
			const loader = new this.GLTFLoader();
			const companion = await loader.parseAsync(bytes.slice().buffer, '');
			// Clip tracks address nodes by name, so they bind straight onto the
			// skeleton the base layer already put on screen.
			this.animations = [...this.animations, ...companion.animations];
			this.gltf.animations = this.animations;
		}
		for (const entry of descriptor.textures || []) {
			await applyTexturePatch(this.THREE, this.materials, entry, payload);
		}
	}
}
