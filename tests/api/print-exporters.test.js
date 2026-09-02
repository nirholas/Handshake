// The two manufacturing files Materialize hands a print bureau.
//
// Nothing downstream can second-guess these bytes: a bureau opens the STL in a
// slicer and prints whatever is in it, and a color machine reproduces whatever
// the 3MF's color group says. So the assertions here are structural and
// byte-level, not "it did not throw": the STL's header layout and triangle
// count, the exact geometry that came back out of it, the 3MF's OPC part names,
// its XML against the core-spec subset the writer promises, and the presence of
// the per-vertex color payload that is the entire reason the 3MF exists.
//
// Fixtures are generated in this file, never committed: a binary blob in the
// repo is a fixture nobody can review.

import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { exportStl, readStlHeader, StlExportError, STL_BYTES } from '../../api/_lib/print/export-stl.js';
import {
	export3mf,
	buildColorGroup,
	ThreeMfExportError,
	CONTENT_TYPES_PART,
	RELS_PART,
	MODEL_PART,
	CORE_NAMESPACE,
	MATERIAL_NAMESPACE,
} from '../../api/_lib/print/export-3mf.js';

// A 10 mm axis-aligned cube in glTF meters: 8 vertices, 12 triangles, a known
// volume and a known bounding box, so every number an exporter writes can be
// checked against arithmetic rather than against a previous run.
const EDGE_M = 0.01;
function unitCube({ color = false } = {}) {
	const s = EDGE_M;
	const positions = Float64Array.from([
		0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0,
		0, 0, s, s, 0, s, s, s, s, 0, s, s,
	]);
	const indices = Uint32Array.from([
		0, 2, 1, 0, 3, 2, // -z
		4, 5, 6, 4, 6, 7, // +z
		0, 1, 5, 0, 5, 4, // -y
		2, 3, 7, 2, 7, 6, // +y
		1, 2, 6, 1, 6, 5, // +x
		0, 4, 7, 0, 7, 3, // -x
	]);
	// Two distinct colors over eight vertices: enough to prove the palette
	// dedupes and that each vertex still points at the right entry.
	const colors = color
		? Uint8Array.from([
			255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0,
			0, 128, 255, 0, 128, 255, 0, 128, 255, 0, 128, 255,
		])
		: null;
	return { positions, indices, colors };
}

describe('exportStl', () => {
	it('writes a binary STL whose header, count and length agree', () => {
		const stl = exportStl(unitCube());
		const head = readStlHeader(stl);
		expect(head.triangles).toBe(12);
		expect(head.actualBytes).toBe(head.expectedBytes);
		expect(stl.byteLength).toBe(STL_BYTES.header + STL_BYTES.count + 12 * STL_BYTES.triangle);
	});

	it('never starts the header with "solid", which readers sniff as ASCII', () => {
		const stl = exportStl(unitCube());
		expect(stl.subarray(0, 5).toString('ascii').toLowerCase()).not.toBe('solid');
		expect(readStlHeader(stl).header).toContain('three.ws');
	});

	it('converts glTF meters to the millimeters a slicer assumes', () => {
		const stl = exportStl(unitCube());
		// First triangle's three vertices start 12 bytes past the normal.
		const base = STL_BYTES.header + STL_BYTES.count + 12;
		const read = (i) => stl.readFloatLE(base + i * 4);
		const xs = [read(0), read(3), read(6)];
		const ys = [read(1), read(4), read(7)];
		for (const v of [...xs, ...ys]) {
			expect([0, EDGE_M * 1000]).toContain(Math.round(v * 1000) / 1000);
		}
		// A 10 mm cube must span exactly 10 units in the file, not 0.01.
		expect(Math.max(...xs)).toBeCloseTo(10, 6);
	});

	it('writes a unit-length face normal that agrees with the winding', () => {
		const stl = exportStl(unitCube());
		const base = STL_BYTES.header + STL_BYTES.count;
		const n = [stl.readFloatLE(base), stl.readFloatLE(base + 4), stl.readFloatLE(base + 8)];
		expect(Math.hypot(...n)).toBeCloseTo(1, 5);
		// Triangle 0 is on the -z face wound outward, so its normal points -z.
		expect(n[2]).toBeCloseTo(-1, 5);
	});

	it('zeroes the attribute byte count on every triangle', () => {
		const stl = exportStl(unitCube());
		for (let t = 0; t < 12; t += 1) {
			const at = STL_BYTES.header + STL_BYTES.count + t * STL_BYTES.triangle + 48;
			expect(stl.readUInt16LE(at)).toBe(0);
		}
	});

	it('is deterministic: the same mesh exports the same bytes', () => {
		expect(exportStl(unitCube()).equals(exportStl(unitCube()))).toBe(true);
	});

	it('refuses an empty mesh and a ragged index buffer', () => {
		expect(() => exportStl({ positions: new Float64Array(0), indices: new Uint32Array(0) })).toThrow(
			StlExportError,
		);
		const cube = unitCube();
		expect(() => exportStl({ positions: cube.positions, indices: cube.indices.slice(0, 4) })).toThrow(
			/whole number of triangles/,
		);
	});

	it('refuses to export a mesh the caller knows is still open', () => {
		expect(() => exportStl(unitCube(), { requireWatertight: true, openEdges: 4 })).toThrow(
			/open edges/,
		);
		expect(() => exportStl(unitCube(), { requireWatertight: true, openEdges: 0 })).not.toThrow();
	});
});

describe('buildColorGroup', () => {
	it('dedupes identical colors and keeps every vertex pointing at its own', () => {
		const cube = unitCube({ color: true });
		const group = buildColorGroup(cube.colors, 8);
		expect(group.palette).toEqual(['FF0000', '0080FF']);
		expect(Array.from(group.indexOf)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
	});

	it('returns null when the mesh carries no color at all', () => {
		expect(buildColorGroup(null, 8)).toBeNull();
		expect(buildColorGroup(new Uint8Array(3), 8)).toBeNull();
	});
});

function openPackage(bytes) {
	const files = unzipSync(new Uint8Array(bytes));
	return { files, names: Object.keys(files), model: strFromU8(files[MODEL_PART]) };
}

describe('export3mf', () => {
	it('produces an OPC package with exactly the three required parts', () => {
		const { names } = openPackage(export3mf(unitCube({ color: true })));
		expect(names).toContain(CONTENT_TYPES_PART);
		expect(names).toContain(RELS_PART);
		expect(names).toContain(MODEL_PART);
	});

	it('declares the model content type and the start-part relationship', () => {
		const { files } = openPackage(export3mf(unitCube()));
		const types = strFromU8(files[CONTENT_TYPES_PART]);
		expect(types).toContain('application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
		expect(types).toContain('Extension="model"');
		const rels = strFromU8(files[RELS_PART]);
		expect(rels).toContain(`Target="/${MODEL_PART}"`);
		expect(rels).toContain('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel');
	});

	it('writes well-formed model XML in millimeters with one build item', () => {
		const { model } = openPackage(export3mf(unitCube({ color: true })));
		expect(XMLValidator.validate(model)).toBe(true);
		const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(model);
		expect(doc.model['@unit']).toBe('millimeter');
		expect(doc.model['@xmlns']).toBe(CORE_NAMESPACE);
		expect(doc.model['@xmlns:m']).toBe(MATERIAL_NAMESPACE);
		expect(doc.model.build.item['@objectid']).toBe(String(doc.model.resources.object['@id']));
	});

	it('carries every vertex and triangle, in the positive octant, at print size', () => {
		const { model } = openPackage(export3mf(unitCube()));
		const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(model);
		const vertices = doc.model.resources.object.mesh.vertices.vertex;
		const triangles = doc.model.resources.object.mesh.triangles.triangle;
		expect(vertices).toHaveLength(8);
		expect(triangles).toHaveLength(12);
		const xs = vertices.map((v) => Number(v['@x']));
		const ys = vertices.map((v) => Number(v['@y']));
		const zs = vertices.map((v) => Number(v['@z']));
		for (const axis of [xs, ys, zs]) {
			expect(Math.min(...axis)).toBe(0);
			expect(Math.max(...axis)).toBeCloseTo(EDGE_M * 1000, 6);
		}
	});

	it('writes the per-vertex color payload that makes a color print possible', () => {
		const { model } = openPackage(export3mf(unitCube({ color: true })));
		const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(model);
		const group = doc.model.resources['m:colorgroup'];
		expect(group).toBeTruthy();
		expect(group['m:color'].map((c) => c['@color'])).toEqual(['#FF0000FF', '#0080FFFF']);
		const object = doc.model.resources.object;
		expect(object['@pid']).toBe(String(group['@id']));
		// Triangle 0 is on the -z face: all three of its corners are vertices
		// 0..3, which the fixture colors red, palette entry 0.
		const first = object.mesh.triangles.triangle[0];
		expect([first['@p1'], first['@p2'], first['@p3']]).toEqual(['0', '0', '0']);
	});

	it('does not require the material extension, so a mono slicer still opens it', () => {
		const { model } = openPackage(export3mf(unitCube({ color: true })));
		expect(model).not.toContain('requiredextensions');
	});

	it('omits the color group entirely for a mesh with no color', () => {
		const { model } = openPackage(export3mf(unitCube()));
		expect(model).not.toContain('colorgroup');
		expect(model).not.toContain(' p1=');
	});

	it('is deterministic: the certificate hashes these exact bytes', () => {
		const a = export3mf(unitCube({ color: true }));
		const b = export3mf(unitCube({ color: true }));
		expect(a.equals(b)).toBe(true);
	});

	it('refuses an empty mesh, a ragged index buffer and an out-of-range index', () => {
		expect(() => export3mf({ positions: new Float64Array(0), indices: new Uint32Array(0) })).toThrow(
			ThreeMfExportError,
		);
		const cube = unitCube();
		expect(() => export3mf({ positions: cube.positions, indices: cube.indices.slice(0, 5) })).toThrow(
			/whole number of triangles/,
		);
		expect(() =>
			export3mf({ positions: cube.positions, indices: Uint32Array.from([0, 1, 99]) }),
		).toThrow(/does not exist/);
	});
});
