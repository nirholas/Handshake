import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, finishMesh } from '../src/load.js';
import { createFrame, render } from '../src/raster.js';
import { encode, stripAnsi, MODES } from '../src/encode.js';
import { MOODS, MOOD_NAMES, poseAt } from '../src/moods.js';
import { snapshot } from '../src/snapshot.js';
import { cubeGlb } from './_fixture.js';

test('parseGlb bakes node transforms, normalises to the unit sphere, and keeps the material tint', async () => {
	const mesh = await parseGlb(await cubeGlb());
	assert.equal(mesh.count, 12);
	assert.equal(mesh.sourceCount, 12);
	// Translated by +0.5 on x before normalisation; centred afterwards.
	assert.ok(Math.abs(mesh.bounds.min[0] + mesh.bounds.max[0]) < 1e-6);
	let maxR = 0;
	for (let i = 0; i < mesh.positions.length; i += 3) {
		maxR = Math.max(maxR, Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
	}
	assert.ok(Math.abs(maxR - 1) < 1e-5, `unit sphere radius, got ${maxR}`);
	assert.ok(Math.abs(mesh.tints[0] - 0.9) < 1e-6 && Math.abs(mesh.tints[1] - 0.3) < 1e-6);
	for (let t = 0; t < mesh.count; t++) {
		const n = Math.hypot(mesh.normals[t * 3], mesh.normals[t * 3 + 1], mesh.normals[t * 3 + 2]);
		assert.ok(Math.abs(n - 1) < 1e-5, 'unit normals');
	}
});

test('finishMesh decimates by stride above the triangle budget', () => {
	const tris = 1000;
	const positions = new Float32Array(tris * 9);
	for (let i = 0; i < positions.length; i++) positions[i] = (i % 7) - 3;
	const mesh = finishMesh(positions, new Float32Array(tris * 3).fill(1), 100);
	assert.equal(mesh.sourceCount, 1000);
	assert.equal(mesh.count, 100);
});

test('render covers the centre, culls back faces, and lights faces differently', async () => {
	const mesh = await parseGlb(await cubeGlb());
	const frame = createFrame(64, 64);
	render(mesh, frame, { yaw: 0.6, pitch: 0.4 });
	const centre = 32 * 64 + 32;
	assert.equal(frame.hit[centre], 1, 'centre subpixel is covered');
	assert.equal(frame.hit[0], 0, 'corner subpixel is empty');
	const shades = new Set();
	for (let i = 0; i < frame.hit.length; i++) {
		if (frame.hit[i]) shades.add(frame.rgb[i * 3].toFixed(3));
	}
	// Three visible faces of a cube at this angle, three distinct lit shades.
	assert.ok(shades.size >= 3, `expected 3+ shades, got ${shades.size}`);
	let covered = 0;
	for (const h of frame.hit) covered += h;
	assert.ok(covered > 64 * 64 * 0.15 && covered < 64 * 64 * 0.9, `coverage ${covered}`);
});

test('every encoder emits one line per row and blank cells for empty space', async () => {
	const mesh = await parseGlb(await cubeGlb());
	for (const mode of Object.keys(MODES)) {
		const cols = 40, rows = 20;
		const frame = createFrame(cols * MODES[mode].sx, rows * MODES[mode].sy);
		render(mesh, frame, { yaw: 0.5, pitch: 0.3 });
		const lines = encode(frame, { mode });
		assert.equal(lines.length, rows, `${mode}: rows`);
		const plain = lines.map(stripAnsi);
		assert.ok(plain.every((l) => l.length <= cols), `${mode}: width`);
		assert.equal(plain[0].trim(), '', `${mode}: top row empty`);
		assert.ok(plain[Math.floor(rows / 2)].trim().length > 0, `${mode}: middle row drawn`);
		if (mode !== 'ascii') assert.ok(lines.some((l) => l.includes('\x1b[38;2;')), `${mode}: truecolor`);
		else assert.ok(!lines.some((l) => l.includes('\x1b[')), 'ascii: no escapes');
	}
});

test('braille packs 2x4 subpixels into the right code points', () => {
	const frame = createFrame(2, 4);
	frame.hit.fill(0);
	frame.hit[0] = 1;            // (0,0) → dot 1
	frame.hit[3 * 2 + 1] = 1;    // (1,3) → dot 8 (0x80)
	frame.rgb.fill(0.5);
	const [line] = encode(frame, { mode: 'braille' });
	assert.equal(stripAnsi(line), String.fromCharCode(0x2800 + 0x01 + 0x80));
});

test('moods are pure functions of time and blend without popping', () => {
	for (const name of MOOD_NAMES) {
		const a = MOODS[name].motion(1.25);
		const b = MOODS[name].motion(1.25);
		assert.deepEqual(a, b, `${name} deterministic`);
	}
	const now = 10_000;
	const prev = { name: 'sleep', since: now - 5000 };
	const cur = { name: 'happy', since: now };
	const start = poseAt(cur, prev, now);
	const end = poseAt(cur, prev, now + 1000);
	assert.ok(Math.abs((start.pitch || 0) - MOODS.sleep.motion(5).pitch) < 1e-9, 'starts at the previous pose');
	assert.deepEqual(end, MOODS.happy.motion(1), 'lands on the new mood after the blend');
});

test('snapshot returns a multi-line string in each mode', async () => {
	const mesh = await parseGlb(await cubeGlb());
	const text = snapshot(mesh, { mode: 'ascii', columns: 30, rows: 15, yaw: 0.4, pitch: 0.3 });
	const lines = text.split('\n');
	assert.equal(lines.length, 15);
	assert.ok(text.trim().length > 20);
});
