import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStl, isAsciiStl, parseBinaryStl } from '../src/stl.js';
import { parseObj } from '../src/obj.js';
import { writeAsciiStl, facetNormal } from '../src/geometry.js';
import { cubeTriangles } from './helpers.js';

function binaryStl(triangles, header = 'binary') {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.write(header, 0, 'ascii');
  buf.writeUInt32LE(triangles.length, 80);
  let o = 84;
  for (const t of triangles) {
    const n = facetNormal(t);
    for (const v of [n, ...t]) {
      buf.writeFloatLE(v[0], o);
      buf.writeFloatLE(v[1], o + 4);
      buf.writeFloatLE(v[2], o + 8);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

test('parseStl handles ASCII input', () => {
  const tris = parseStl(Buffer.from(writeAsciiStl(cubeTriangles())));
  assert.equal(tris.length, 12);
});

test('parseStl handles binary input', () => {
  const tris = parseStl(binaryStl(cubeTriangles()));
  assert.equal(tris.length, 12);
  assert.deepEqual(tris[0][0], [0, 0, 0]);
});

test('binary STL whose header starts with "solid" is still detected as binary', () => {
  const buf = binaryStl(cubeTriangles(), 'solid part exported from cad');
  assert.equal(isAsciiStl(buf), false);
  assert.equal(parseStl(buf).length, 12);
});

test('truncated binary STL throws instead of returning garbage', () => {
  const buf = binaryStl(cubeTriangles()).subarray(0, 100);
  assert.throws(() => parseBinaryStl(Buffer.from(buf)), /truncated/);
});

test('parseObj triangulates quads and handles negative indices', () => {
  const obj = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
f 1 2 3 4
f -4 -3 -2
`;
  const tris = parseObj(obj);
  assert.equal(tris.length, 3); // quad -> 2 + one explicit tri
  assert.deepEqual(tris[2][1], [1, 0, 0]);
});
