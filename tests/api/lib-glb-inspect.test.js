// Tests for api/_lib/glb-inspect.js — deterministic parser of the GLB JSON
// chunk. Critical for the reconstruct materialize path: we tag every freshly
// generated avatar with is_rigged from this output, and the UI uses that to
// decide whether to badge "needs rigging".

import { describe, it, expect } from 'vitest';
import { inspectGlb, isValidGlbHeader, isRiggedGlb } from '../../api/_lib/glb-inspect.js';

// Build a minimum-viable GLB with a JSON chunk we control, optionally followed
// by an empty BIN chunk so we can exercise the BIN-chunk detection branch.
function makeGlb(gltfJson, { binBytes = null } = {}) {
	const jsonText = JSON.stringify(gltfJson);
	const padded = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
	const jsonBytes = Buffer.from(padded, 'utf8');

	const binChunk = binBytes
		? (() => {
			const padding = (4 - (binBytes.length % 4)) % 4;
			const padded = Buffer.concat([binBytes, Buffer.alloc(padding)]);
			return { header: padded.length, body: padded };
		})()
		: null;

	const binSize = binChunk ? 8 + binChunk.body.length : 0;
	const totalLength = 12 + 8 + jsonBytes.length + binSize;
	const buf = Buffer.alloc(totalLength);
	buf.writeUInt32LE(0x46546C67, 0);
	buf.writeUInt32LE(2, 4);
	buf.writeUInt32LE(totalLength, 8);
	buf.writeUInt32LE(jsonBytes.length, 12);
	buf.writeUInt32LE(0x4E4F534A, 16);
	jsonBytes.copy(buf, 20);
	if (binChunk) {
		const binStart = 20 + jsonBytes.length;
		buf.writeUInt32LE(binChunk.header, binStart);
		buf.writeUInt32LE(0x004E4942, binStart + 4); // 'BIN\0'
		binChunk.body.copy(buf, binStart + 8);
	}
	return buf;
}

describe('glb-inspect', () => {
	describe('isValidGlbHeader', () => {
		it('accepts a well-formed GLB', () => {
			expect(isValidGlbHeader(makeGlb({ asset: { version: '2.0' } }))).toBe(true);
		});

		it('rejects bytes that do not start with the magic', () => {
			const bad = Buffer.from('<html>not a glb</html>NOTNOT00NOT');
			expect(isValidGlbHeader(bad)).toBe(false);
		});

		it('rejects a buffer too small to hold a header', () => {
			expect(isValidGlbHeader(Buffer.alloc(8))).toBe(false);
		});

		it('rejects a header that lies about total length', () => {
			const buf = makeGlb({ asset: { version: '2.0' } });
			buf.writeUInt32LE(99999, 8);
			expect(isValidGlbHeader(buf)).toBe(false);
		});

		it('rejects glTF version 1', () => {
			const buf = makeGlb({ asset: { version: '1.0' } });
			buf.writeUInt32LE(1, 4);
			expect(isValidGlbHeader(buf)).toBe(false);
		});
	});

	describe('inspectGlb', () => {
		it('returns null for invalid GLB header', () => {
			expect(inspectGlb(Buffer.from('not a glb'))).toBeNull();
		});

		it('reports an unrigged mesh-only GLB (TRELLIS / TripoSR shape)', () => {
			const buf = makeGlb({
				asset: { version: '2.0', generator: 'TRELLIS-image-large' },
				meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
				nodes: [{ mesh: 0 }],
				scenes: [{ nodes: [0] }],
			});
			const info = inspectGlb(buf);
			expect(info).toMatchObject({
				valid: true,
				isRigged: false,
				skinCount: 0,
				skeletonJointCount: 0,
				meshCount: 1,
				nodeCount: 1,
				animationCount: 0,
				generator: 'TRELLIS-image-large',
			});
		});

		it('reports a rigged humanoid GLB (Hunyuan3D shape)', () => {
			const buf = makeGlb({
				asset: { version: '2.0', generator: 'Hunyuan3D-2 generation_all' },
				skins: [{ joints: [1, 2, 3, 4, 5, 6, 7, 8] }],
				nodes: [
					{ mesh: 0, skin: 0 },
					{ name: 'Hips' }, { name: 'Spine' }, { name: 'Neck' },
					{ name: 'Head' }, { name: 'LeftArm' }, { name: 'RightArm' },
					{ name: 'LeftLeg' }, { name: 'RightLeg' },
				],
				meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
				animations: [{ name: 'Idle', channels: [], samplers: [] }],
			});
			const info = inspectGlb(buf);
			expect(info.isRigged).toBe(true);
			expect(info.skinCount).toBe(1);
			expect(info.skeletonJointCount).toBe(8);
			expect(info.meshCount).toBe(1);
			expect(info.animationCount).toBe(1);
			expect(info.generator).toMatch(/Hunyuan3D-2/);
		});

		it('handles a skin with empty joints list as unrigged', () => {
			const buf = makeGlb({
				asset: { version: '2.0' },
				skins: [{ joints: [] }],
			});
			const info = inspectGlb(buf);
			expect(info.isRigged).toBe(false);
			expect(info.skinCount).toBe(1);
			expect(info.skeletonJointCount).toBe(0);
		});

		it('returns null on broken JSON chunk', () => {
			const garbage = Buffer.from('{nope:not json');
			const padded = Buffer.concat([garbage, Buffer.from(' '.repeat((4 - (garbage.length % 4)) % 4))]);
			const total = 12 + 8 + padded.length;
			const buf = Buffer.alloc(total);
			buf.writeUInt32LE(0x46546C67, 0);
			buf.writeUInt32LE(2, 4);
			buf.writeUInt32LE(total, 8);
			buf.writeUInt32LE(padded.length, 12);
			buf.writeUInt32LE(0x4E4F534A, 16);
			padded.copy(buf, 20);
			expect(inspectGlb(buf)).toBeNull();
		});

		it('exposes extensionsUsed when the asset declares them', () => {
			const buf = makeGlb({
				asset: { version: '2.0' },
				extensionsUsed: ['KHR_materials_pbrSpecularGlossiness', 'KHR_texture_basisu'],
			});
			expect(inspectGlb(buf).extensionsUsed).toEqual([
				'KHR_materials_pbrSpecularGlossiness',
				'KHR_texture_basisu',
			]);
		});

		it('detects an embedded BIN chunk and reports its byte length', () => {
			const buf = makeGlb(
				{ asset: { version: '2.0' }, buffers: [{ byteLength: 32 }] },
				{ binBytes: Buffer.alloc(32, 0xAB) },
			);
			const info = inspectGlb(buf);
			expect(info.hasBinChunk).toBe(true);
			expect(info.binChunkBytes).toBe(32);
		});

		it('reports no BIN chunk on a JSON-only GLB', () => {
			const buf = makeGlb({ asset: { version: '2.0' } });
			const info = inspectGlb(buf);
			expect(info.hasBinChunk).toBe(false);
			expect(info.binChunkBytes).toBe(0);
		});
	});

	describe('isRiggedGlb', () => {
		it('true for skinned GLB', () => {
			const buf = makeGlb({ asset: { version: '2.0' }, skins: [{ joints: [1, 2, 3] }] });
			expect(isRiggedGlb(buf)).toBe(true);
		});

		it('false for static mesh', () => {
			const buf = makeGlb({ asset: { version: '2.0' }, meshes: [{}] });
			expect(isRiggedGlb(buf)).toBe(false);
		});

		it('false for non-GLB bytes (defensive)', () => {
			expect(isRiggedGlb(Buffer.from('garbage'))).toBe(false);
		});
	});
});
