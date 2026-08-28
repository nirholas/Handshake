import test from 'node:test';
import assert from 'node:assert/strict';

import { PREAMBLE_BYTES, decodePreamble, encodePreamble, encodeContainer, decodeHeader, rangeHeaderForLayer, VERSION_TAG, align4 } from '../src/format.js';

test('preamble round-trips through encode and decode', () => {
	const source = { headerOffset: 32, headerLength: 128, baseOffset: 160, baseLength: 2048, layerCount: 4, totalLength: 9000 };
	const decoded = decodePreamble(encodePreamble(source));
	for (const [key, value] of Object.entries(source)) assert.equal(decoded[key], value, key);
});

test('a non-A3S buffer is rejected rather than misread', () => {
	const bytes = new Uint8Array(PREAMBLE_BYTES);
	bytes.set([0x67, 0x6c, 0x54, 0x46], 0); // "glTF"
	assert.throws(() => decodePreamble(bytes), /not an A3S stream/);
});

test('a truncated head is rejected with a length hint', () => {
	assert.throws(() => decodePreamble(new Uint8Array(8)), /at least 32 bytes/);
});

test('align4 rounds up to the next word boundary', () => {
	assert.deepEqual([0, 1, 4, 5, 8].map(align4), [0, 4, 4, 8, 8]);
});

test('the encoder is the single source of truth for layer offsets', () => {
	const base = new Uint8Array(100).fill(1);
	const patch = new Uint8Array(50).fill(2);
	const header = {
		version: VERSION_TAG,
		generator: 'test',
		source: { name: 'x', sha256: 'a'.repeat(64), byteLength: 1 },
		geometry: { vertexCount: 1, triangleCount: 1, primitiveCount: 1 },
		levels: [0.5, 1],
		// Deliberately wrong: the encoder must overwrite these, not trust them.
		layers: [
			{ level: 0, kind: 'base', offset: 999999, length: 1 },
			{ level: 1, kind: 'patch', offset: 999999, length: 1 },
		],
	};
	const container = encodeContainer({ header, baseGlb: base, patches: [patch] });
	const preamble = decodePreamble(container);
	const decoded = decodeHeader(container, preamble);

	assert.equal(decoded.layers[0].offset, preamble.baseOffset);
	assert.equal(decoded.layers[0].length, base.byteLength);
	assert.equal(decoded.layers[1].length, patch.byteLength);
	assert.deepEqual(container.subarray(decoded.layers[0].offset, decoded.layers[0].offset + 100), base);
	assert.deepEqual(container.subarray(decoded.layers[1].offset, decoded.layers[1].offset + 50), patch);
	assert.equal(rangeHeaderForLayer(decoded, preamble, 0), `bytes=0-${preamble.baseOffset + preamble.baseLength - 1}`);
});
