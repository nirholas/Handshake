// GLB container surgery: the step that lets three.js parse an avatar in Node.
//
// The renderer strips every image out of a glTF before GLTFLoader sees it,
// because the loader's texture path needs a DOM. These tests hold the contract
// that makes the re-attach step possible: images come out intact, materials
// keep an index marker, and the repacked container is still a valid GLB.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGlb, packGlb, extractImages, stripImages } from '../src/glb.js';

const AVATAR = 'public/avatars/default.glb';

function readAvatar() {
	const buf = readFileSync(AVATAR);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('parseGlb', () => {
	it('splits a real avatar into JSON and BIN chunks', () => {
		const { json, bin } = parseGlb(readAvatar());
		expect(json.asset.version).toBe('2.0');
		expect(json.meshes.length).toBeGreaterThan(0);
		expect(bin.byteLength).toBeGreaterThan(0);
	});

	it('refuses anything that is not a GLB', () => {
		const notGlb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer;
		expect(() => parseGlb(notGlb)).toThrow(/not a GLB/);
	});
});

describe('packGlb', () => {
	it('round-trips a parsed container', () => {
		const original = parseGlb(readAvatar());
		const repacked = parseGlb(packGlb(original.json, original.bin));
		expect(repacked.json.meshes.length).toBe(original.json.meshes.length);
		expect(repacked.bin.byteLength).toBe(original.bin.byteLength);
	});

	it('pads the JSON chunk with spaces, as the spec requires', () => {
		const packed = packGlb({ asset: { version: '2.0' }, x: 'pad' }, null);
		const bytes = new Uint8Array(packed);
		const length = new DataView(packed).getUint32(12, true);
		// Every byte of a chunk beyond the JSON text must be 0x20, never 0x00.
		const text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
		expect(text.trimEnd()).toBe(JSON.stringify({ asset: { version: '2.0' }, x: 'pad' }));
		expect(text.slice(text.trimEnd().length)).toMatch(/^ *$/);
	});

	it('keeps a bin-less container valid', () => {
		const { json } = parseGlb(packGlb({ asset: { version: '2.0' } }, null));
		expect(json.asset.version).toBe('2.0');
	});
});

describe('extractImages', () => {
	it('lifts every embedded texture out of the binary chunk', () => {
		const { json, bin } = parseGlb(readAvatar());
		const images = extractImages(json, bin);
		expect(images.size).toBe(json.images.length);
		for (const [, image] of images) {
			expect(image.bytes.byteLength).toBeGreaterThan(0);
			expect(image.mimeType).toMatch(/^image\//);
		}
	});

	it('decodes data-URI images', () => {
		const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
		const images = extractImages({ images: [{ uri: `data:image/png;base64,${png}` }] }, null);
		expect(images.get(0).mimeType).toBe('image/png');
		expect(images.get(0).bytes.length).toBe(8);
	});

	it('skips images that live behind an external URI', () => {
		const images = extractImages({ images: [{ uri: 'skin.png' }] }, null);
		expect(images.size).toBe(0);
	});
});

describe('stripImages', () => {
	it('removes every image, texture and sampler', () => {
		const { json } = parseGlb(readAvatar());
		const { json: stripped } = stripImages(json);
		expect(stripped.images).toBeUndefined();
		expect(stripped.textures).toBeUndefined();
		expect(stripped.samplers).toBeUndefined();
		for (const material of stripped.materials) {
			expect(material.pbrMetallicRoughness?.baseColorTexture).toBeUndefined();
			expect(material.normalTexture).toBeUndefined();
		}
	});

	it('marks each material with its index so textures can be re-attached', () => {
		const { json } = parseGlb(readAvatar());
		const { json: stripped } = stripImages(json);
		stripped.materials.forEach((material, index) => {
			expect(material.extras.__twsMaterial).toBe(index);
		});
	});

	it('records what each material was using', () => {
		const { json } = parseGlb(readAvatar());
		const { bindings } = stripImages(json);
		expect(bindings.size).toBe(json.materials.length);
		const textured = [...bindings.values()].filter((b) => b.baseColor);
		expect(textured.length).toBeGreaterThan(0);
		for (const binding of textured) {
			expect(typeof binding.baseColor.image).toBe('number');
			expect(['repeat', 'clamp', 'mirror']).toContain(binding.baseColor.wrapS);
		}
	});

	it('does not mutate the source JSON', () => {
		const { json } = parseGlb(readAvatar());
		const before = json.images.length;
		stripImages(json);
		expect(json.images.length).toBe(before);
		expect(json.materials[0].extras?.__twsMaterial).toBeUndefined();
	});

	it('drops extensions whose decoders this renderer does not ship', () => {
		const { json: stripped } = stripImages({
			extensionsUsed: ['KHR_texture_basisu', 'EXT_meshopt_compression'],
			materials: [],
		});
		expect(stripped.extensionsUsed).toEqual(['EXT_meshopt_compression']);
	});
});
