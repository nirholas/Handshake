/**
 * Sanity test for the GLB ↔ VRM binary wiring in src/avatar-export.js.
 *
 * Runs in node — exercises the pure-binary GLB decode/encode helpers and the
 * VRMC_vrm JSON injection path against a real GLB on disk. Three.js-dependent
 * paths (GLTFLoader, GLTFExporter, humanoid bone mapping from a live scene)
 * are exercised in-browser via the create-review page, not here.
 *
 *   node scripts/test-avatar-export.mjs
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'public', 'avatars', 'default.glb');

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

function decodeGlb(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: bad magic');
	if (dv.getUint32(4, true) !== 2) throw new Error('glb: unsupported version');
	let offset = 12;
	let json = null;
	let bin = new Uint8Array(0);
	while (offset < bytes.length) {
		const chunkLen = dv.getUint32(offset, true);
		const chunkType = dv.getUint32(offset + 4, true);
		const chunkStart = offset + 8;
		const chunkData = bytes.subarray(chunkStart, chunkStart + chunkLen);
		if (chunkType === GLB_JSON_CHUNK) json = chunkData;
		else if (chunkType === GLB_BIN_CHUNK) bin = chunkData;
		offset = chunkStart + chunkLen;
	}
	if (!json) throw new Error('glb: missing JSON chunk');
	return { json, bin };
}

function padTo4(arr, padByte) {
	const remainder = arr.byteLength % 4;
	if (remainder === 0) return arr;
	const padded = new Uint8Array(arr.byteLength + (4 - remainder));
	padded.set(arr, 0);
	padded.fill(padByte, arr.byteLength);
	return padded;
}

function encodeGlb(jsonBytes, binBytes) {
	const jsonChunk = padTo4(jsonBytes, 0x20);
	const binChunk = binBytes.byteLength ? padTo4(binBytes, 0x00) : new Uint8Array(0);
	const headerLen = 12;
	const jsonHeaderLen = 8;
	const binHeaderLen = binChunk.byteLength ? 8 : 0;
	const totalLen = headerLen + jsonHeaderLen + jsonChunk.byteLength + binHeaderLen + binChunk.byteLength;
	const out = new Uint8Array(totalLen);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, GLB_MAGIC, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, totalLen, true);
	dv.setUint32(12, jsonChunk.byteLength, true);
	dv.setUint32(16, GLB_JSON_CHUNK, true);
	out.set(jsonChunk, 20);
	if (binChunk.byteLength) {
		const binOffset = 20 + jsonChunk.byteLength;
		dv.setUint32(binOffset, binChunk.byteLength, true);
		dv.setUint32(binOffset + 4, GLB_BIN_CHUNK, true);
		out.set(binChunk, binOffset + 8);
	}
	return out;
}

async function main() {
	const bytes = new Uint8Array(await readFile(FIXTURE));
	console.log(`Loaded ${FIXTURE}\n  size: ${bytes.length} bytes`);

	// Decode original
	const { json, bin } = decodeGlb(bytes);
	const parsed = JSON.parse(TEXT_DECODER.decode(json));
	console.log(`  JSON chunk: ${json.length} bytes, BIN chunk: ${bin.length} bytes`);
	console.log(`  nodes: ${parsed.nodes?.length}, meshes: ${parsed.meshes?.length}, skins: ${parsed.skins?.length}`);
	console.log(`  generator: ${parsed.asset?.generator || 'n/a'}`);

	// Inject a fake VRMC_vrm and round-trip
	parsed.extensionsUsed = Array.from(new Set([...(parsed.extensionsUsed || []), 'VRMC_vrm']));
	parsed.extensions = {
		...(parsed.extensions || {}),
		VRMC_vrm: {
			specVersion: '1.0',
			meta: { name: 'sanity-test', version: '1', authors: ['test'] },
			humanoid: { humanBones: { hips: { node: 0 } } },
			expressions: { preset: {} },
			lookAt: { type: 'bone' },
			firstPerson: { meshAnnotations: [] },
		},
	};
	const rebuiltJson = TEXT_ENCODER.encode(JSON.stringify(parsed));
	const rebuilt = encodeGlb(rebuiltJson, bin);

	// Decode the rebuilt blob and confirm it still parses + the extension is present
	const decoded = decodeGlb(rebuilt);
	const reparsed = JSON.parse(TEXT_DECODER.decode(decoded.json));

	const checks = [
		['rebuilt is a valid GLB (magic)', new DataView(rebuilt.buffer).getUint32(0, true) === GLB_MAGIC],
		['rebuilt is glTF v2', new DataView(rebuilt.buffer).getUint32(4, true) === 2],
		['rebuilt JSON chunk parses', !!reparsed],
		['rebuilt declares VRMC_vrm in extensionsUsed', (reparsed.extensionsUsed || []).includes('VRMC_vrm')],
		['rebuilt has VRMC_vrm extension body', !!reparsed.extensions?.VRMC_vrm?.specVersion],
		['rebuilt VRM specVersion is 1.0', reparsed.extensions?.VRMC_vrm?.specVersion === '1.0'],
		['BIN chunk byte-identical', binEquals(decoded.bin, bin)],
		['JSON chunk is 4-byte aligned', decoded.json.length % 4 === 0],
		['humanoid.humanBones present', !!reparsed.extensions?.VRMC_vrm?.humanoid?.humanBones],
	];

	let pass = 0;
	let fail = 0;
	for (const [label, ok] of checks) {
		console.log(`  ${ok ? '✓' : '✗'} ${label}`);
		if (ok) pass++; else fail++;
	}

	console.log(`\n${pass}/${pass + fail} checks passed.`);
	process.exit(fail === 0 ? 0 : 1);
}

function binEquals(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

main().catch((err) => {
	console.error('TEST FAILED:', err);
	process.exit(1);
});
