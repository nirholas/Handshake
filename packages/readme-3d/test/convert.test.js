import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  convert,
  toMarkdown,
  checkMarkdownFile,
  parseByteSize,
} from '../src/index.js';
import { writeAsciiStl } from '../src/geometry.js';
import { cubeTriangles, gridTriangles } from './helpers.js';

const exec = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin/readme3d.js');

async function tmp() {
  return mkdtemp(join(tmpdir(), 'readme3d-'));
}

/** Build a real indexed-cube GLB with @gltf-transform. */
async function writeCubeGlb(path) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const tris = cubeTriangles();
  const positions = new Float32Array(tris.flat(2));
  const indices = new Uint32Array(positions.length / 3).map((_, i) => i);
  const prim = doc
    .createPrimitive()
    .setMode(4)
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer)
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer)
    );
  const mesh = doc.createMesh().addPrimitive(prim);
  const node = doc.createNode('cube').setMesh(mesh).setScale([2, 2, 2]);
  doc.createScene().addChild(node);
  await writeFile(path, Buffer.from(await new NodeIO().writeBinary(doc)));
}

test('parseByteSize', () => {
  assert.equal(parseByteSize('200kb'), 204800);
  assert.equal(parseByteSize('1.5MB'), 1572864);
  assert.equal(parseByteSize(4096), 4096);
  assert.throws(() => parseByteSize('huge'));
});

test('convert() GLB end-to-end: real glTF in, GitHub STL out', async () => {
  const dir = await tmp();
  const glb = join(dir, 'cube.glb');
  await writeCubeGlb(glb);
  const result = await convert(glb, { name: 'cube' });
  assert.equal(result.facets, 12);
  assert.ok(result.stl.startsWith('solid cube'));
  // node scale [2,2,2] baked in, then normalized to 100 units and grounded
  assert.ok(result.stl.includes('vertex 50.00 50.00 100.00'));
});

test('convert() honors a byte budget', async () => {
  const dir = await tmp();
  const stlPath = join(dir, 'grid.stl');
  await writeFile(stlPath, writeAsciiStl(gridTriangles(32))); // 2048 facets
  const result = await convert(stlPath, { budget: '20kb', facets: 100000 });
  assert.ok(result.bytes <= 20 * 1024, `got ${result.bytes}`);
  assert.ok(result.facets < 2048);
});

test('toMarkdown wraps in ```stl fence and optional <details>', () => {
  const md = toMarkdown('solid x\nendsolid x');
  assert.ok(md.startsWith('```stl\n'));
  assert.ok(md.endsWith('```\n'));
  const det = toMarkdown('solid x\nendsolid x', { details: true, summary: 'spin me' });
  assert.ok(det.includes('<summary>spin me</summary>'));
});

test('checkMarkdownFile reports stl blocks and headroom', async () => {
  const dir = await tmp();
  const md = join(dir, 'demo.md');
  await writeFile(md, '# hi\n\n' + toMarkdown(writeAsciiStl(cubeTriangles())));
  const report = await checkMarkdownFile(md);
  assert.equal(report.ok, true);
  assert.equal(report.stlBlocks.length, 1);
  assert.equal(report.stlBlocks[0].facets, 12);
});

test('CLI converts a model and writes markdown', async () => {
  const dir = await tmp();
  const stlPath = join(dir, 'cube.stl');
  const out = join(dir, 'cube.md');
  await writeFile(stlPath, writeAsciiStl(cubeTriangles()));
  const { stderr } = await exec(process.execPath, [BIN, stlPath, '-o', out]);
  assert.match(stderr, /12 facets/);
  const md = await readFile(out, 'utf8');
  assert.ok(md.startsWith('```stl\n'));
  assert.match(md, /endsolid/);
});

test('CLI check flags oversized files with exit code 2', async () => {
  const dir = await tmp();
  const md = join(dir, 'big.md');
  await writeFile(md, '#'.repeat(600 * 1024));
  await assert.rejects(
    () => exec(process.execPath, [BIN, 'check', md]),
    (err) => err.code === 2 && /TOO BIG/.test(err.stderr)
  );
});

test('CLI errors cleanly on unsupported input', async () => {
  await assert.rejects(
    () => exec(process.execPath, [BIN, 'model.xyz']),
    (err) => err.code === 1 && /unsupported input format/.test(err.stderr)
  );
});
