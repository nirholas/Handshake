import { MeshoptSimplifier } from 'meshoptimizer';

/** A triangle is [[x,y,z],[x,y,z],[x,y,z]]; a mesh is an array of triangles (Z-up). */

export function facetNormal([a, b, c]) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    u[1] * w[2] - u[2] * w[1],
    u[2] * w[0] - u[0] * w[2],
    u[0] * w[1] - u[1] * w[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]);
  return len > 1e-12 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 0, 1];
}

export function bounds(triangles) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) {
    for (const p of t) {
      for (let a = 0; a < 3; a++) {
        if (p[a] < min[a]) min[a] = p[a];
        if (p[a] > max[a]) max[a] = p[a];
      }
    }
  }
  return { min, max };
}

/** glTF/three.js are Y-up; STL viewers (GitHub included) treat models as Z-up. */
export function yUpToZUp(triangles) {
  return triangles.map((t) => t.map(([x, y, z]) => [x, -z, y]));
}

/**
 * Scale the mesh so its largest dimension is `size`, ground it at z=0, and
 * center it in x/y. Small coordinates + fixed precision keep the ASCII output
 * compact, and grounding gives GitHub's viewer a sensible default orbit.
 */
export function normalize(triangles, { size = 100 } = {}) {
  const { min, max } = bounds(triangles);
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!isFinite(extent) || extent <= 0) return triangles;
  const s = size / extent;
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const gz = min[2];
  return triangles.map((t) =>
    t.map(([x, y, z]) => [(x - cx) * s, (y - cy) * s, (z - gz) * s])
  );
}

/**
 * Weld exact-duplicate vertices into an indexed mesh, run meshoptimizer's
 * simplifier down to ~targetFacets, and return a triangle soup again.
 * The error tolerance is loosened progressively when the simplifier stalls,
 * which is what lets heavily-disconnected AI-generated meshes collapse.
 */
export async function simplifyTriangles(triangles, targetFacets) {
  if (triangles.length <= targetFacets) return triangles;
  await MeshoptSimplifier.ready;

  const key = (p) => `${p[0]},${p[1]},${p[2]}`;
  const vertexIndex = new Map();
  const positions = [];
  let indices = new Uint32Array(triangles.length * 3);
  let n = 0;
  for (const t of triangles) {
    for (const p of t) {
      let i = vertexIndex.get(key(p));
      if (i === undefined) {
        i = positions.length / 3;
        vertexIndex.set(key(p), i);
        positions.push(p[0], p[1], p[2]);
      }
      indices[n++] = i;
    }
  }
  const pos = new Float32Array(positions);

  let error = 1e-4;
  while (indices.length / 3 > targetFacets && error <= 0.5) {
    const [next] = MeshoptSimplifier.simplify(
      indices,
      pos,
      3,
      targetFacets * 3,
      error,
      []
    );
    if (next.length >= indices.length * 0.98) error *= 4;
    indices = next;
    if (next.length / 3 <= targetFacets) break;
  }

  const out = [];
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [];
    for (let j = 0; j < 3; j++) {
      const vi = indices[i + j] * 3;
      tri.push([pos[vi], pos[vi + 1], pos[vi + 2]]);
    }
    out.push(tri);
  }
  return out;
}

/** Serialize triangles as ASCII STL - the exact dialect GitHub markdown renders. */
export function writeAsciiStl(triangles, { name = 'model', precision = 2 } = {}) {
  const f = (v) => {
    let s = v.toFixed(precision);
    if (parseFloat(s) === 0) s = (0).toFixed(precision);
    return s;
  };
  const lines = [`solid ${name}`];
  for (const t of triangles) {
    const n = facetNormal(t);
    lines.push(
      ` facet normal ${f(n[0])} ${f(n[1])} ${f(n[2])}`,
      '  outer loop',
      `   vertex ${f(t[0][0])} ${f(t[0][1])} ${f(t[0][2])}`,
      `   vertex ${f(t[1][0])} ${f(t[1][1])} ${f(t[1][2])}`,
      `   vertex ${f(t[2][0])} ${f(t[2][1])} ${f(t[2][2])}`,
      '  endloop',
      ' endfacet'
    );
  }
  lines.push(`endsolid ${name}`, '');
  return lines.join('\n');
}
