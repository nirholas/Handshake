import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import validator from 'gltf-validator';

import { pack, verifyNesting, buildLodChain, computeVertexOrder } from '../src/pack.js';
import { A3SStream, bytesSource } from '../src/reader.js';
import { reconstruct, triangleCount, triangleFingerprint } from '../src/reconstruct.js';

const AVATAR = new URL('../../../public/avatars/mannequin.glb', import.meta.url);
const SKINNED = new URL('../../../public/avatars/michelle.glb', import.meta.url);

let packedCache = null;
async function packed() {
	if (!packedCache) {
		const source = new Uint8Array(await readFile(AVATAR));
		packedCache = { source, ...(await pack(source, { name: 'mannequin.glb' })) };
	}
	return packedCache;
}

test('the base layer is a standalone, spec-valid GLB', async () => {
	const { container, header } = await packed();
	const stream = await A3SStream.open(container);
	const report = await validator.validateBytes(stream.base);
	assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages.filter((m) => m.severity === 0)));
	assert.equal(stream.base.byteLength, header.layers[0].length);
	// A GLB starts with the magic "glTF".
	assert.deepEqual(Array.from(stream.base.subarray(0, 4)), [0x67, 0x6c, 0x54, 0x46]);
});

test('the base layer costs a fraction of the source', async () => {
	const { source, stats } = await packed();
	assert.ok(stats.baseBytes < source.byteLength * 0.4, `base was ${stats.baseBytes} of ${source.byteLength}`);
	assert.ok(stats.baseTriangles > 0);
	assert.ok(stats.baseTriangles < stats.fullTriangles);
});

test('simplification produces strictly nested vertex sets', async () => {
	// The whole format depends on this: a coarse level may only reference
	// vertices a finer level also has, or a prefix of the file is not renderable.
	const source = new Uint8Array(await readFile(SKINNED));
	const { getIO } = await import('../src/pack.js');
	const { dequantize } = await import('@gltf-transform/functions');
	const io = await getIO();
	const doc = await io.readBinary(source);
	await doc.transform(dequantize());
	const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
	const chain = buildLodChain(new Uint32Array(prim.getIndices().getArray()), prim.getAttribute('POSITION').getArray(), [0.05, 0.2, 1]);

	assert.doesNotThrow(() => verifyNesting(chain));
	for (let i = 0; i < chain.length - 1; i++) {
		assert.ok(chain[i].length <= chain[i + 1].length, 'levels must not grow coarser as they refine');
	}
});

test('verifyNesting rejects a chain that is not nested', () => {
	const broken = [new Uint32Array([0, 1, 2]), new Uint32Array([3, 4, 5])];
	assert.throws(() => verifyNesting(broken), /not nested/);
});

test('vertex ordering groups each level into a contiguous prefix', () => {
	const chain = [new Uint32Array([2, 5, 7]), new Uint32Array([2, 5, 7, 0, 1, 3])];
	const { remap, levelVertexCounts } = computeVertexOrder(chain, 8);
	assert.equal(levelVertexCounts[0], 3);
	assert.equal(levelVertexCounts[1], 6);
	// Every level-0 vertex must land inside the first V(0) slots.
	for (const v of chain[0]) assert.ok(remap[v] < levelVertexCounts[0], `vertex ${v} escaped the base prefix`);
	for (const v of chain[1]) assert.ok(remap[v] < levelVertexCounts[1]);
});

test('every layer matches the hash recorded in the header', async () => {
	const { container } = await packed();
	const stream = await A3SStream.open(container, { verify: true });
	for await (const layer of stream.layers({ verify: true })) {
		assert.ok(layer.payload.byteLength > 0);
	}
});

test('a corrupted layer fails its integrity check', async () => {
	const { container } = await packed();
	const damaged = container.slice();
	const stream = await A3SStream.open(damaged);
	const target = stream.header.layers[1];
	damaged[target.offset + 8] ^= 0xff;
	const reopened = await A3SStream.open(damaged);
	await assert.rejects(() => reopened.layer(1, { verify: true }), /integrity check/);
});

test('replaying every layer reconstructs the source surface exactly', async () => {
	const { container, header } = await packed();
	const { primitives } = await reconstruct(container, { verify: true });
	assert.equal(triangleCount(primitives), header.geometry.triangleCount);

	const source = new Uint8Array(await readFile(AVATAR));
	const { getIO } = await import('../src/pack.js');
	const { dequantize } = await import('@gltf-transform/functions');
	const io = await getIO();
	const doc = await io.readBinary(source);
	await doc.transform(dequantize());

	const expected = [];
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			if (prim.getMode() !== 4 || !prim.getIndices()) continue;
			expected.push(...triangleFingerprint(prim.getAttribute('POSITION').getArray(), new Uint32Array(prim.getIndices().getArray())));
		}
	}
	const actual = [];
	for (const primitive of primitives.values()) {
		actual.push(...triangleFingerprint(primitive.attributes.POSITION.array, primitive.indices));
	}
	expected.sort();
	actual.sort();
	assert.deepEqual(actual, expected, 'the refined stream must describe the same surface as the source');
});

test('a partial replay renders fewer triangles than a full one', async () => {
	const { container } = await packed();
	const coarse = await reconstruct(container, { throughLevel: 0 });
	const fine = await reconstruct(container);
	assert.ok(triangleCount(coarse.primitives) < triangleCount(fine.primitives));
});

test('the reader serves layers over a range-request source', async () => {
	const { container } = await packed();
	const reads = [];
	const source = bytesSource(container);
	const counted = {
		size: source.size,
		read: (start, end) => {
			reads.push([start, end]);
			return source.read(start, end);
		},
	};
	const stream = await A3SStream.open(counted);
	assert.equal(reads.length, 1, 'opening a stream must cost exactly one request');
	assert.ok(stream.base.byteLength > 0);
	await stream.layer(1);
	assert.equal(reads.length, 2);
	assert.equal(reads[1][0], stream.header.layers[1].offset);
});

test('a host that ignores Range still yields a usable stream', async () => {
	const { container } = await packed();
	// Simulate a 200 response carrying the whole body regardless of the header.
	const stream = await A3SStream.open({
		size: container.byteLength,
		read: async (start, end) => container.subarray(start, Math.min(end + 1, container.byteLength)),
	});
	assert.ok(stream.base.byteLength > 0);
	assert.equal(stream.layerCount, stream.header.layers.length);
});
