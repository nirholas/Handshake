// Optimization and comparison run on committed avatars, so what is measured is
// the real pipeline on real bytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRESETS, describeSavings, optimizeGlb } from '../src/optimize.js';
import { committedBytes, compareModels } from '../src/compare.js';

const CZ = new URL('../../../public/avatars/cz.glb', import.meta.url);
const MICHELLE = new URL('../../../public/avatars/michelle.glb', import.meta.url);

test('the balanced preset keeps geometry precision and writes meshopt', async () => {
	const bytes = new Uint8Array(readFileSync(CZ));
	const result = await optimizeGlb(bytes, { preset: 'balanced' });
	assert.ok(result.bytes.byteLength > 1000);
	assert.equal(result.before.fileSize, bytes.byteLength);
	assert.equal(result.after.fileSize, result.bytes.byteLength);
	assert.ok(result.after.extensions.includes('EXT_meshopt_compression'));
	assert.ok(result.after.triangles > 0);
	// cz.glb is already pipeline-optimized, so the pass must not bloat it much.
	assert.ok(result.after.fileSize < result.before.fileSize * 1.15, `${result.after.fileSize} vs ${result.before.fileSize}`);
});

test('the compact preset quantizes and every preset is described', async () => {
	const bytes = new Uint8Array(readFileSync(CZ));
	const result = await optimizeGlb(bytes, { preset: 'compact' });
	assert.ok(result.after.extensions.includes('KHR_mesh_quantization'));
	for (const p of Object.values(PRESETS)) assert.ok(p.label && p.detail);
});

test('describeSavings reads as a sentence', () => {
	assert.equal(
		describeSavings({ fileSize: 12 * 1024 * 1024, vertices: 210_000 }, { fileSize: 3 * 1024 * 1024, vertices: 98_000 }),
		'12.0 MB → 3.0 MB (−75%), 210k → 98.0k vertices',
	);
	assert.equal(describeSavings({ fileSize: 500 * 1024, vertices: 10 }, { fileSize: 500 * 1024, vertices: 10 }), '500 KB → 500 KB (−0%)');
});

test('compareModels reports a structural diff as Markdown', async () => {
	const a = new Uint8Array(readFileSync(CZ));
	const b = new Uint8Array(readFileSync(MICHELLE));
	const { changeset, markdown } = await compareModels(a, b, { nameA: 'cz', nameB: 'michelle' });
	assert.ok(changeset.severity);
	assert.match(markdown, /\|/);
	assert.ok(markdown.length > 200);
});

test('committedBytes reads the file straight out of git', async () => {
	const path = fileURLToPath(CZ);
	const bytes = await committedBytes(path);
	assert.equal(bytes.byteLength, readFileSync(path).byteLength);
	await assert.rejects(committedBytes(fileURLToPath(new URL('../../../public/avatars/does-not-exist.glb', import.meta.url))), /not committed|does not exist|exists on disk/);
});
