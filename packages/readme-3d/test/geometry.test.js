import test from 'node:test';
import assert from 'node:assert/strict';
import {
  facetNormal,
  bounds,
  normalize,
  simplifyTriangles,
  writeAsciiStl,
  yUpToZUp,
} from '../src/geometry.js';
import { parseAsciiStl } from '../src/stl.js';
import { cubeTriangles, gridTriangles } from './helpers.js';

test('facetNormal computes unit normals', () => {
  const n = facetNormal([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
  assert.deepEqual(n, [0, 0, 1]);
  const deg = facetNormal([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.equal(Math.hypot(...deg), 1);
});

test('yUpToZUp maps Y-up to Z-up', () => {
  const [tri] = yUpToZUp([[[1, 2, 3], [0, 0, 0], [0, 0, 0]]]);
  assert.deepEqual(tri[0], [1, -3, 2]);
});

test('normalize grounds at z=0, centers x/y, scales to size', () => {
  const out = normalize(cubeTriangles(), { size: 100 });
  const { min, max } = bounds(out);
  assert.equal(min[2], 0);
  assert.equal(max[2], 100);
  assert.ok(Math.abs(min[0] + max[0]) < 1e-9);
  assert.ok(Math.abs(min[1] + max[1]) < 1e-9);
});

test('writeAsciiStl emits GitHub-renderable ASCII STL', () => {
  const stl = writeAsciiStl(cubeTriangles(), { name: 'cube' });
  assert.ok(stl.startsWith('solid cube\n'));
  assert.ok(stl.trimEnd().endsWith('endsolid cube'));
  assert.equal((stl.match(/facet normal/g) || []).length, 12);
  assert.ok(!stl.includes('-0.00 '), 'negative zero must be normalized');
  const roundtrip = parseAsciiStl(stl);
  assert.equal(roundtrip.length, 12);
});

test('simplifyTriangles reduces facet count near the target', async () => {
  const dense = gridTriangles(32); // 2048 facets
  const out = await simplifyTriangles(dense, 200);
  assert.ok(out.length <= 220, `expected <=220, got ${out.length}`);
  assert.ok(out.length >= 2, 'mesh must not vanish');
  // area must be preserved on a flat grid regardless of triangulation
  const area = (tris) =>
    tris.reduce((s, [a, b, c]) => {
      const u = [b[0] - a[0], b[1] - a[1]];
      const v = [c[0] - a[0], c[1] - a[1]];
      return s + Math.abs(u[0] * v[1] - u[1] * v[0]) / 2;
    }, 0);
  assert.ok(Math.abs(area(out) - area(dense)) < 1, 'surface area preserved');
});

test('simplifyTriangles is a no-op below target', async () => {
  const tris = cubeTriangles();
  const out = await simplifyTriangles(tris, 100);
  assert.equal(out.length, 12);
});

test('simplifyTriangles hits the target on heavily-disconnected meshes (sloppy fallback)', async () => {
  // 200 separate far-apart cubes: topology-preserving simplification cannot
  // merge components, so only the sloppy fallback can reach the budget.
  const tris = [];
  for (let i = 0; i < 200; i++) {
    const ox = (i % 20) * 3, oy = Math.floor(i / 20) * 3;
    for (const t of cubeTriangles()) {
      tris.push(t.map(([x, y, z]) => [x + ox, y + oy, z]));
    }
  }
  const out = await simplifyTriangles(tris, 300); // 2400 -> 300
  assert.ok(out.length <= 330, `expected <=330, got ${out.length}`);
  assert.ok(out.length >= 3, 'mesh must not vanish');
});

test('simplifyTriangles prunes tiny floaters but keeps the main body', async () => {
  const tris = gridTriangles(24); // 1152 facets, 24x24 units
  // add 20 microscopic distant triangles (debris typical of AI meshes)
  for (let i = 0; i < 20; i++) {
    const o = 100 + i;
    tris.push([[o, o, 0], [o + 0.01, o, 0], [o, o + 0.01, 0]]);
  }
  const out = await simplifyTriangles(tris, 400);
  const { max } = bounds(out);
  assert.ok(max[0] < 50, `floaters should be pruned, max x = ${max[0]}`);
});
