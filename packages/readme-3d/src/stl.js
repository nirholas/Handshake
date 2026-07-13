/** Parse an STL file (ASCII or binary) into a triangle soup. */
export function parseStl(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return isAsciiStl(buf) ? parseAsciiStl(buf.toString('utf8')) : parseBinaryStl(buf);
}

/**
 * "solid" at byte 0 is not enough — some binary exporters write it into the
 * 80-byte header. Cross-check the binary facet-count math against file size.
 */
export function isAsciiStl(buf) {
  const head = buf.subarray(0, 5).toString('ascii');
  if (head !== 'solid') return false;
  if (buf.length >= 84) {
    const facets = buf.readUInt32LE(80);
    if (84 + facets * 50 === buf.length) return false;
  }
  return /facet\s+normal/.test(buf.subarray(0, 1024).toString('ascii'));
}

export function parseAsciiStl(text) {
  const triangles = [];
  const re = /vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
  const verts = [];
  let m;
  while ((m = re.exec(text))) {
    verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }
  for (let i = 0; i + 2 < verts.length; i += 3) {
    triangles.push([verts[i], verts[i + 1], verts[i + 2]]);
  }
  return triangles;
}

export function parseBinaryStl(buf) {
  if (buf.length < 84) throw new Error('binary STL too short');
  const facets = buf.readUInt32LE(80);
  if (84 + facets * 50 > buf.length) {
    throw new Error('binary STL truncated: header claims more facets than the file holds');
  }
  const triangles = [];
  let o = 84;
  for (let i = 0; i < facets; i++) {
    o += 12; // skip stored normal; recomputed on write
    const tri = [];
    for (let v = 0; v < 3; v++) {
      tri.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)]);
      o += 12;
    }
    triangles.push(tri);
    o += 2; // attribute byte count
  }
  return triangles;
}
