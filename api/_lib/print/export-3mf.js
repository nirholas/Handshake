// 3MF: the format that carries the print, not just the shape.
//
// STL is what every bureau accepts; 3MF is what makes a print worth ordering.
// It is an OPC package (a zip with a relationship graph) holding one XML model
// that declares real units, indexed vertices, and per-vertex color through the
// Materials and Properties extension. That last part is the whole reason this
// writer exists: full-color sandstone and binder-jet machines reproduce color
// per vertex, so a generated model whose color lives in a 2K albedo texture can
// only be printed in color if something samples that texture per vertex and
// writes it into the manufacturing file. mesh-io.js does the sampling; this
// module writes it out. A download button that hands over a GLB leaves the
// color behind.
//
// Spec subset, deliberately small and deliberately exact:
//   [Content_Types].xml   default parts for .rels and .model
//   _rels/.rels           one 3D-model start-part relationship
//   3D/3dmodel.model      unit="millimeter", resources, one build item
//
// The color group is declared in the material namespace but NOT listed in
// `requiredextensions`. A color-capable slicer reads it; a mono slicer ignores
// the attributes and still prints the geometry. Requiring the extension would
// make a monochrome printer reject a file it could have printed.
//
// The 3MF spec puts the build volume in the positive octant, so the mesh is
// translated to sit at the origin corner before it is written.

import { Buffer } from 'node:buffer';
import { zipSync, strToU8 } from 'fflate';

const MM_PER_METER = 1000;

export const CONTENT_TYPES_PART = '[Content_Types].xml';
export const RELS_PART = '_rels/.rels';
export const MODEL_PART = '3D/3dmodel.model';

export const CORE_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const MATERIAL_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const MODEL_RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';

// Resource ids. 3MF requires them unique within the model; two constants are
// clearer than a counter for a package that always holds exactly one object.
const COLOR_GROUP_ID = 1;
const OBJECT_ID = 2;

// Coordinates are written at micron resolution. Finer is noise no printer can
// hit, and it keeps the XML (the dominant cost of a 3MF) roughly a third
// smaller than full float printing on a large mesh.
const COORD_DECIMALS = 3;

// The earliest instant a zip's DOS timestamp can express. Used as a constant so
// two exports of one mesh differ in no byte at all.
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

export class ThreeMfExportError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ThreeMfExportError';
		this.code = code;
	}
}

function xmlEscape(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Trim the trailing zeros a fixed-decimal render leaves behind: on a 200k
// triangle mesh that is megabytes of "000".
function coord(value) {
	const fixed = value.toFixed(COORD_DECIMALS);
	return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
}

function hex2(v) {
	return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Collapse per-vertex RGB into the palette a 3MF colorgroup holds, plus the
 * per-vertex index into it. Identical colors share one entry, which is what
 * keeps a flat-shaded model's group at a handful of colors instead of one per
 * vertex.
 */
export function buildColorGroup(colors, vertexCount) {
	if (!colors || colors.length < vertexCount * 3) return null;
	const palette = [];
	const seen = new Map();
	const indexOf = new Uint32Array(vertexCount);
	for (let v = 0; v < vertexCount; v += 1) {
		const key = `${hex2(colors[v * 3])}${hex2(colors[v * 3 + 1])}${hex2(colors[v * 3 + 2])}`;
		let id = seen.get(key);
		if (id === undefined) {
			id = palette.length;
			seen.set(key, id);
			palette.push(key);
		}
		indexOf[v] = id;
	}
	return { palette, indexOf };
}

function buildModelXml({ positions, indices, colorGroup, scale, metadata }) {
	const vertexCount = positions.length / 3;
	// The positive-octant shift the spec asks for.
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	for (let i = 0; i < positions.length; i += 3) {
		if (positions[i] < minX) minX = positions[i];
		if (positions[i + 1] < minY) minY = positions[i + 1];
		if (positions[i + 2] < minZ) minZ = positions[i + 2];
	}

	const parts = [];
	parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
	parts.push(
		`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}" xmlns:m="${MATERIAL_NAMESPACE}">`,
	);
	for (const [name, value] of Object.entries(metadata)) {
		if (value === null || value === undefined || value === '') continue;
		parts.push(`<metadata name="${xmlEscape(name)}">${xmlEscape(value)}</metadata>`);
	}
	parts.push('<resources>');
	if (colorGroup) {
		parts.push(`<m:colorgroup id="${COLOR_GROUP_ID}">`);
		for (const hex of colorGroup.palette) parts.push(`<m:color color="#${hex}FF"/>`);
		parts.push('</m:colorgroup>');
	}
	// pid/pindex give the object a default color, so a reader that ignores the
	// per-triangle indices still shows something rather than untextured grey.
	const objectAttrs = colorGroup
		? `id="${OBJECT_ID}" type="model" pid="${COLOR_GROUP_ID}" pindex="0"`
		: `id="${OBJECT_ID}" type="model"`;
	parts.push(`<object ${objectAttrs}><mesh><vertices>`);
	for (let v = 0; v < vertexCount; v += 1) {
		const x = coord((positions[v * 3] - minX) * scale);
		const y = coord((positions[v * 3 + 1] - minY) * scale);
		const z = coord((positions[v * 3 + 2] - minZ) * scale);
		parts.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
	}
	parts.push('</vertices><triangles>');
	for (let t = 0; t < indices.length; t += 3) {
		const a = indices[t];
		const b = indices[t + 1];
		const c = indices[t + 2];
		if (colorGroup) {
			parts.push(
				`<triangle v1="${a}" v2="${b}" v3="${c}" p1="${colorGroup.indexOf[a]}" p2="${colorGroup.indexOf[b]}" p3="${colorGroup.indexOf[c]}"/>`,
			);
		} else {
			parts.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
		}
	}
	parts.push('</triangles></mesh></object>');
	parts.push('</resources>');
	parts.push(`<build><item objectid="${OBJECT_ID}"/></build>`);
	parts.push('</model>');
	return parts.join('');
}

const CONTENT_TYPES_XML =
	'<?xml version="1.0" encoding="UTF-8"?>\n' +
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
	`<Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>` +
	`<Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>` +
	'</Types>';

const RELS_XML =
	'<?xml version="1.0" encoding="UTF-8"?>\n' +
	'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
	`<Relationship Id="rel0" Target="/${MODEL_PART}" Type="${MODEL_RELATIONSHIP}"/>` +
	'</Relationships>';

/**
 * Write a 3MF package.
 *
 * @param {{positions: Float64Array|number[], indices: Uint32Array|number[], colors?: Uint8Array|null}} mesh
 *   Indexed triangles in glTF meters; `colors` is per-vertex RGB bytes as
 *   mesh-io.js samples them.
 * @param {{scale?: number, color?: boolean, title?: string, designer?: string,
 *   description?: string, license?: string}} [opts]
 * @returns {Buffer} the .3mf bytes
 */
export function export3mf(mesh, opts = {}) {
	const positions = mesh?.positions;
	const indices = mesh?.indices;
	if (!positions || !indices || indices.length < 3) {
		throw new ThreeMfExportError('empty_mesh', 'no triangles to export');
	}
	if (indices.length % 3 !== 0) {
		throw new ThreeMfExportError('bad_indices', 'index buffer is not a whole number of triangles');
	}
	const vertexCount = positions.length / 3;
	for (let i = 0; i < indices.length; i += 1) {
		if (indices[i] >= vertexCount) {
			throw new ThreeMfExportError('bad_indices', 'index buffer references a vertex that does not exist');
		}
	}

	const colorGroup = opts.color === false ? null : buildColorGroup(mesh.colors, vertexCount);
	const modelXml = buildModelXml({
		positions,
		indices,
		colorGroup,
		scale: opts.scale ?? MM_PER_METER,
		metadata: {
			Application: 'three.ws Materialize',
			Title: opts.title ?? '',
			Designer: opts.designer ?? '',
			Description: opts.description ?? '',
			LicenseTerms: opts.license ?? '',
		},
	});

	// Deterministic package: a fixed timestamp, one compression level, parts in
	// a fixed order. Two prepares of the same mesh must produce the same bytes,
	// because the print certificate hashes exactly this file. The zip clock only
	// spans 1980-2099, so the DOS epoch stands in for "no time".
	const zipped = zipSync(
		{
			[CONTENT_TYPES_PART]: strToU8(CONTENT_TYPES_XML),
			[RELS_PART]: strToU8(RELS_XML),
			[MODEL_PART]: strToU8(modelXml),
		},
		{ level: 6, mtime: ZIP_EPOCH },
	);
	return Buffer.from(zipped);
}

/** Colors survived the round trip only if the group was actually written. */
export function threeMfHasColor(modelXml) {
	return modelXml.includes('<m:colorgroup') && modelXml.includes('<m:color color="#');
}
