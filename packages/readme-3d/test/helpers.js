/** 12-triangle unit cube (0..1), Z-up, CCW winding outward. */
export function cubeTriangles() {
  const quads = [
    // [corner, edge1, edge2] with outward normal = edge1 x edge2
    [[0, 0, 0], [0, 1, 0], [1, 0, 0]], // bottom (z=0)
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], // top (z=1)
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]], // front (y=0)
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], // back (y=1)
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]], // left (x=0)
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], // right (x=1)
  ];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const tris = [];
  for (const [o, e1, e2] of quads) {
    const a = o;
    const b = add(o, e1);
    const c = add(add(o, e1), e2);
    const d = add(o, e2);
    tris.push([a, b, c], [a, c, d]);
  }
  return tris;
}

/** Subdivided plane with many facets, for simplification tests. */
export function gridTriangles(n = 32) {
  const tris = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = (x, y) => [x, y, 0];
      tris.push(
        [p(i, j), p(i + 1, j), p(i + 1, j + 1)],
        [p(i, j), p(i + 1, j + 1), p(i, j + 1)]
      );
    }
  }
  return tris;
}
