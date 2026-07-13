/** Parse a Wavefront OBJ (positions + faces only) into a triangle soup. */
export function parseObj(text) {
  const verts = [];
  const triangles = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/);
      verts.push([parseFloat(x), parseFloat(y), parseFloat(z)]);
    } else if (line.startsWith('f ')) {
      const refs = line.slice(2).trim().split(/\s+/).map((tok) => {
        const i = parseInt(tok.split('/')[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      // fan-triangulate polygons
      for (let i = 1; i + 1 < refs.length; i++) {
        const a = verts[refs[0]];
        const b = verts[refs[i]];
        const c = verts[refs[i + 1]];
        if (a && b && c) triangles.push([a, b, c]);
      }
    }
  }
  return triangles;
}
