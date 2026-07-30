import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicHttpsUrl, inspectModel, ModelError, readGltfDocument } from '../src/gltf.js';

/** Build a real GLB container around a glTF JSON document, the way an exporter would. */
function makeGlb(document, binBytes = 0) {
	const json = Buffer.from(JSON.stringify(document), 'utf8');
	const jsonPad = (4 - (json.length % 4)) % 4;
	const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
	const binChunk = Buffer.alloc(binBytes, 0);
	const total = 12 + 8 + jsonChunk.length + (binBytes ? 8 + binChunk.length : 0);

	const out = Buffer.alloc(total);
	out.writeUInt32LE(0x46546c67, 0); // magic "glTF"
	out.writeUInt32LE(2, 4); // version
	out.writeUInt32LE(total, 8);
	out.writeUInt32LE(jsonChunk.length, 12);
	out.writeUInt32LE(0x4e4f534a, 16); // "JSON"
	jsonChunk.copy(out, 20);
	if (binBytes) {
		const offset = 20 + jsonChunk.length;
		out.writeUInt32LE(binChunk.length, offset);
		out.writeUInt32LE(0x004e4942, offset + 4); // "BIN\0"
		binChunk.copy(out, offset + 8);
	}
	return out;
}

const SIMPLE = {
	asset: { version: '2.0', generator: 'test-fixture' },
	scenes: [{ nodes: [0] }],
	nodes: [{ mesh: 0 }],
	meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4, material: 0 }] }],
	materials: [{ name: 'base' }],
	accessors: [
		{ count: 24, type: 'VEC3', componentType: 5126 },
		{ count: 36, type: 'SCALAR', componentType: 5123 },
	],
	extensionsUsed: ['EXT_meshopt_compression'],
};

test('reads a GLB container and reports its chunks', () => {
	const { document, container, binBytes } = readGltfDocument(makeGlb(SIMPLE, 64));
	assert.equal(container, 'glb');
	assert.equal(binBytes, 64);
	assert.equal(document.asset.generator, 'test-fixture');
});

test('reads a plain .gltf JSON document', () => {
	const { container, binBytes } = readGltfDocument(Buffer.from(JSON.stringify(SIMPLE), 'utf8'));
	assert.equal(container, 'gltf');
	assert.equal(binBytes, 0);
});

test('counts geometry from accessors rather than estimating', () => {
	const report = inspectModel(makeGlb(SIMPLE, 64), { sourceUrl: 'https://example.com/a.glb' });
	assert.equal(report.geometry.vertices, 24);
	assert.equal(report.geometry.triangles, 12); // 36 indices / 3
	assert.equal(report.primitives.primitives, 1);
	assert.equal(report.primitives.indexed, 1);
	assert.equal(report.materials, 1);
	assert.equal(report.source, 'https://example.com/a.glb');
});

test('flags unindexed primitives with a fix', () => {
	const unindexed = structuredClone(SIMPLE);
	delete unindexed.meshes[0].primitives[0].indices;
	const report = inspectModel(makeGlb(unindexed));
	const finding = report.findings.find((f) => f.issue === 'Unindexed primitives');
	assert.ok(finding, 'expected an unindexed-primitive finding');
	assert.equal(finding.severity, 'medium');
	assert.match(finding.fix, /index/i);
	// Without an index buffer, triangles fall back to the position count.
	assert.equal(report.geometry.triangles, 8);
});

test('flags a model that declares no geometry compression', () => {
	const raw = structuredClone(SIMPLE);
	raw.extensionsUsed = [];
	const report = inspectModel(makeGlb(raw));
	assert.ok(report.findings.some((f) => f.issue === 'No geometry compression'));
});

test('reports a clean model as healthy', () => {
	const report = inspectModel(makeGlb(SIMPLE, 64));
	assert.deepEqual(
		report.findings.map((f) => f.severity),
		['none'],
	);
});

test('rejects a truncated GLB chunk instead of guessing', () => {
	const glb = makeGlb(SIMPLE, 64);
	glb.writeUInt32LE(glb.length * 4, 12); // JSON chunk claims more bytes than exist
	assert.throws(() => readGltfDocument(glb), (err) => err instanceof ModelError && err.code === 'corrupt');
});

test('rejects a GLB container version it cannot parse', () => {
	const glb = makeGlb(SIMPLE);
	glb.writeUInt32LE(3, 4);
	assert.throws(() => readGltfDocument(glb), (err) => err.code === 'unsupported_version');
});

test('refuses plaintext http URLs', async () => {
	await assert.rejects(() => assertPublicHttpsUrl('http://example.com/a.glb'), (err) => err.code === 'insecure_url');
});

test('refuses URLs that are not URLs', async () => {
	await assert.rejects(() => assertPublicHttpsUrl('not a url'), (err) => err.code === 'invalid_url');
});

test('refuses private and loopback addresses', async () => {
	for (const host of ['https://127.0.0.1/a.glb', 'https://10.0.0.5/a.glb', 'https://192.168.1.9/a.glb', 'https://169.254.169.254/latest/meta-data']) {
		await assert.rejects(() => assertPublicHttpsUrl(host), (err) => err.code === 'blocked_host', `expected ${host} to be blocked`);
	}
});

test('allows a public https URL', async () => {
	const url = await assertPublicHttpsUrl('https://three.ws/avatars/cesium-man.glb');
	assert.equal(url.host, 'three.ws');
});
