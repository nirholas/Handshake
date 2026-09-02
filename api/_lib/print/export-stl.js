// Binary STL: the format every print bureau on earth accepts.
//
// STL is the lowest common denominator of manufacturing. It carries no units,
// no color, no metadata and no vertex sharing; it is a bare list of triangles
// with a normal each. That poverty is exactly why it is the format that always
// works, so it is what the operator console hands a bureau and what a partner
// adapter uploads.
//
// Binary only. ASCII STL is roughly five times the bytes for the same mesh and
// loses precision in the float formatting, and every slicer written since 1990
// reads binary. A writer that emits ASCII is offering the caller a worse file
// for no benefit.
//
// Units: STL has none, and the entire industry's convention is that one STL
// unit is one millimeter. glTF geometry arrives in meters, so it is scaled here
// once and the exported numbers are millimeters, which is what a slicer will
// assume when it opens the file.

import { Buffer } from 'node:buffer';

// Meters (glTF) to millimeters (the STL convention every slicer assumes).
const MM_PER_METER = 1000;

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const TRIANGLE_BYTES = 50;

export class StlExportError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'StlExportError';
		this.code = code;
	}
}

/**
 * Write a binary STL.
 *
 * @param {{positions: Float64Array|number[], indices: Uint32Array|number[]}} mesh
 *   Indexed triangles in glTF meters, as every module in this directory speaks.
 * @param {{scale?: number, header?: string, requireWatertight?: boolean, openEdges?: number}} [opts]
 *   `scale` overrides the meter-to-millimeter conversion for a mesh already in
 *   another unit. `requireWatertight` refuses to write a mesh the caller knows
 *   still has boundary edges, so a hole cannot reach a printer as a silently
 *   accepted file.
 * @returns {Buffer} the .stl bytes
 */
export function exportStl(mesh, opts = {}) {
	const positions = mesh?.positions;
	const indices = mesh?.indices;
	if (!positions || !indices || indices.length < 3) {
		throw new StlExportError('empty_mesh', 'no triangles to export');
	}
	if (indices.length % 3 !== 0) {
		throw new StlExportError('bad_indices', 'index buffer is not a whole number of triangles');
	}
	if (opts.requireWatertight && (opts.openEdges ?? 0) > 0) {
		throw new StlExportError(
			'not_watertight',
			`mesh still has ${opts.openEdges} open edges; repair it before export`,
		);
	}

	const scale = opts.scale ?? MM_PER_METER;
	const triangles = indices.length / 3;
	const out = Buffer.alloc(HEADER_BYTES + COUNT_BYTES + triangles * TRIANGLE_BYTES);

	// The header must not begin with "solid": some readers sniff that prefix and
	// then try to parse the file as ASCII. A banner naming the producer is the
	// conventional payload and helps an operator identify a file on a bureau's
	// intake queue.
	const banner = (opts.header ?? 'three.ws Materialize binary STL, millimeters').slice(0, HEADER_BYTES - 1);
	out.write(banner, 0, 'ascii');
	out.writeUInt32LE(triangles, HEADER_BYTES);

	let offset = HEADER_BYTES + COUNT_BYTES;
	for (let t = 0; t < triangles; t += 1) {
		const a = indices[t * 3] * 3;
		const b = indices[t * 3 + 1] * 3;
		const c = indices[t * 3 + 2] * 3;
		const ax = positions[a] * scale;
		const ay = positions[a + 1] * scale;
		const az = positions[a + 2] * scale;
		const bx = positions[b] * scale;
		const by = positions[b + 1] * scale;
		const bz = positions[b + 2] * scale;
		const cx = positions[c] * scale;
		const cy = positions[c + 1] * scale;
		const cz = positions[c + 2] * scale;

		// Face normal from the winding. Slicers re-derive orientation from the
		// vertex order anyway, but a zero normal trips validators, so a
		// degenerate triangle is written with a unit-Z placeholder rather than
		// NaNs from a divide by zero.
		const ux = bx - ax;
		const uy = by - ay;
		const uz = bz - az;
		const vx = cx - ax;
		const vy = cy - ay;
		const vz = cz - az;
		let nx = uy * vz - uz * vy;
		let ny = uz * vx - ux * vz;
		let nz = ux * vy - uy * vx;
		const len = Math.hypot(nx, ny, nz);
		if (len > 0) {
			nx /= len;
			ny /= len;
			nz /= len;
		} else {
			nx = 0;
			ny = 0;
			nz = 1;
		}

		out.writeFloatLE(nx, offset);
		out.writeFloatLE(ny, offset + 4);
		out.writeFloatLE(nz, offset + 8);
		out.writeFloatLE(ax, offset + 12);
		out.writeFloatLE(ay, offset + 16);
		out.writeFloatLE(az, offset + 20);
		out.writeFloatLE(bx, offset + 24);
		out.writeFloatLE(by, offset + 28);
		out.writeFloatLE(bz, offset + 32);
		out.writeFloatLE(cx, offset + 36);
		out.writeFloatLE(cy, offset + 40);
		out.writeFloatLE(cz, offset + 44);
		// Attribute byte count. Zero is the only portable value; the color
		// encodings some vendors hide here are mutually incompatible, and color
		// travels in the 3MF instead.
		out.writeUInt16LE(0, offset + 48);
		offset += TRIANGLE_BYTES;
	}

	return out;
}

/**
 * Read back the header and triangle count of a binary STL without parsing the
 * whole body. The operator console and the export tests both need to confirm a
 * stored file is the mesh they expect, and a 84-byte read answers that.
 */
export function readStlHeader(bytes) {
	if (!bytes || bytes.byteLength < HEADER_BYTES + COUNT_BYTES) {
		throw new StlExportError('truncated', 'buffer is too short to be a binary STL');
	}
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
	const triangles = buf.readUInt32LE(HEADER_BYTES);
	return {
		header: buf.subarray(0, HEADER_BYTES).toString('ascii').replace(/\0+$/, ''),
		triangles,
		expectedBytes: HEADER_BYTES + COUNT_BYTES + triangles * TRIANGLE_BYTES,
		actualBytes: buf.byteLength,
	};
}

export const STL_BYTES = Object.freeze({
	header: HEADER_BYTES,
	count: COUNT_BYTES,
	triangle: TRIANGLE_BYTES,
});
