// Real glTF/GLB fetching and structural parsing, with no dependencies.
//
// Two jobs live here, and both are the paid tool's actual product:
//   1. fetchModel():  an SSRF-guarded, size-capped, timeout-bounded HTTPS fetch.
//   2. inspectModel(): parse the container (GLB binary or .gltf JSON) and report
//      what is inside it, plus optimization findings a caller can act on.
//
// The parser reads the glTF JSON chunk only. That is enough for every structural
// count, keeps the memory profile flat on large models, and never executes or
// trusts model content.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const GLB_MAGIC = 0x46546c67; // "glTF" little-endian
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export const MAX_BYTES = 32 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;

/** Errors this module throws carry a stable `code` so tools can map them to clean responses. */
export class ModelError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ModelError';
		this.code = code;
	}
}

function isPrivateAddress(address, family) {
	if (family === 6) {
		const a = address.toLowerCase();
		if (a === '::1' || a === '::') return true;
		if (a.startsWith('fc') || a.startsWith('fd')) return true; // unique local
		if (a.startsWith('fe80')) return true; // link local
		// IPv4-mapped IPv6, e.g. ::ffff:10.0.0.1
		const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return isPrivateAddress(mapped[1], 4);
		return false;
	}
	const [a, b] = address.split('.').map(Number);
	if (a === 10 || a === 127 || a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
	return false;
}

/**
 * Reject anything that is not a public HTTPS origin before a single byte moves.
 * A paid endpoint that fetches arbitrary URLs is an internal-network probe unless
 * it does exactly this.
 */
export async function assertPublicHttpsUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new ModelError('invalid_url', `Not a valid URL: ${rawUrl}`);
	}
	if (url.protocol !== 'https:') {
		throw new ModelError('insecure_url', 'Only https:// model URLs are accepted.');
	}
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const literalFamily = isIP(host);
	if (literalFamily) {
		if (isPrivateAddress(host, literalFamily)) {
			throw new ModelError('blocked_host', 'That address is not publicly routable.');
		}
		return url;
	}
	const records = await lookup(host, { all: true, verbatim: true });
	if (!records.length) throw new ModelError('dns_failed', `Could not resolve ${host}.`);
	for (const record of records) {
		if (isPrivateAddress(record.address, record.family)) {
			throw new ModelError('blocked_host', `${host} resolves to a private address.`);
		}
	}
	return url;
}

/** Fetch a model with a hard byte ceiling, so a hostile URL cannot exhaust memory. */
export async function fetchModel(rawUrl, { maxBytes = MAX_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
	const url = await assertPublicHttpsUrl(rawUrl);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			redirect: 'error',
			headers: { accept: 'model/gltf-binary, model/gltf+json, application/octet-stream, */*' },
		});
		if (!res.ok) {
			throw new ModelError('fetch_failed', `Model host answered ${res.status}.`);
		}
		const declared = Number(res.headers.get('content-length') || 0);
		if (declared > maxBytes) {
			throw new ModelError('too_large', `Model is ${declared} bytes; the ceiling is ${maxBytes}.`);
		}
		const buffer = Buffer.from(await res.arrayBuffer());
		if (buffer.byteLength > maxBytes) {
			throw new ModelError('too_large', `Model is ${buffer.byteLength} bytes; the ceiling is ${maxBytes}.`);
		}
		return buffer;
	} catch (err) {
		if (err instanceof ModelError) throw err;
		if (err?.name === 'AbortError') {
			throw new ModelError('timeout', `Model fetch exceeded ${timeoutMs}ms.`);
		}
		throw new ModelError('fetch_failed', err?.message || 'Model fetch failed.');
	} finally {
		clearTimeout(timer);
	}
}

/** Pull the glTF JSON document out of a GLB container, or parse a .gltf directly. */
export function readGltfDocument(buffer) {
	if (buffer.byteLength >= 12 && buffer.readUInt32LE(0) === GLB_MAGIC) {
		const version = buffer.readUInt32LE(4);
		if (version !== 2) {
			throw new ModelError('unsupported_version', `GLB container version ${version} is not supported (expected 2).`);
		}
		let offset = 12;
		let json = null;
		let binBytes = 0;
		while (offset + 8 <= buffer.byteLength) {
			const chunkLength = buffer.readUInt32LE(offset);
			const chunkType = buffer.readUInt32LE(offset + 4);
			const start = offset + 8;
			const end = start + chunkLength;
			if (end > buffer.byteLength) {
				throw new ModelError('corrupt', 'GLB chunk runs past the end of the file.');
			}
			if (chunkType === CHUNK_JSON) json = buffer.subarray(start, end).toString('utf8');
			else if (chunkType === CHUNK_BIN) binBytes = chunkLength;
			offset = end + ((4 - (chunkLength % 4)) % 4);
		}
		if (!json) throw new ModelError('corrupt', 'GLB container has no JSON chunk.');
		return { document: parseJson(json), container: 'glb', binBytes };
	}
	return { document: parseJson(buffer.toString('utf8')), container: 'gltf', binBytes: 0 };
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		throw new ModelError('corrupt', 'Model JSON could not be parsed.');
	}
}

const count = (value) => (Array.isArray(value) ? value.length : 0);

/** Sum every primitive across every mesh: the number that actually predicts draw calls. */
function primitiveStats(document) {
	let primitives = 0;
	let indexed = 0;
	let modes = new Set();
	for (const mesh of document.meshes || []) {
		for (const primitive of mesh.primitives || []) {
			primitives += 1;
			if (primitive.indices !== undefined) indexed += 1;
			modes.add(primitive.mode ?? 4);
		}
	}
	return { primitives, indexed, modes: [...modes].sort((a, b) => a - b) };
}

/** Vertex and triangle totals, read from accessor counts rather than estimated. */
function geometryStats(document) {
	const accessors = document.accessors || [];
	let vertices = 0;
	let triangles = 0;
	for (const mesh of document.meshes || []) {
		for (const primitive of mesh.primitives || []) {
			const position = primitive.attributes?.POSITION;
			if (position !== undefined && accessors[position]) vertices += accessors[position].count || 0;
			const mode = primitive.mode ?? 4;
			if (mode !== 4) continue;
			if (primitive.indices !== undefined && accessors[primitive.indices]) {
				triangles += Math.floor((accessors[primitive.indices].count || 0) / 3);
			} else if (position !== undefined && accessors[position]) {
				triangles += Math.floor((accessors[position].count || 0) / 3);
			}
		}
	}
	return { vertices, triangles };
}

/** Textures that ship as raw pixels inside the container, the usual size culprit. */
function imageStats(document) {
	let embedded = 0;
	let external = 0;
	let dataUri = 0;
	for (const image of document.images || []) {
		if (image.bufferView !== undefined) embedded += 1;
		else if (typeof image.uri === 'string' && image.uri.startsWith('data:')) dataUri += 1;
		else if (image.uri) external += 1;
	}
	return { embedded, external, dataUri };
}

function morphTargetCount(document) {
	let targets = 0;
	for (const mesh of document.meshes || []) {
		for (const primitive of mesh.primitives || []) {
			targets += count(primitive.targets);
		}
	}
	return targets;
}

/**
 * Turn the raw counts into findings worth paying for: each one names the problem,
 * the evidence, and the fix.
 */
function findings(stats) {
	const out = [];
	if (stats.geometry.triangles > 250_000) {
		out.push({
			severity: 'high',
			issue: 'Very high triangle count',
			detail: `${stats.geometry.triangles.toLocaleString()} triangles will stall low-end GPUs and mobile browsers.`,
			fix: 'Decimate the mesh or ship an LOD chain. Target 150k triangles or fewer for web delivery.',
		});
	}
	if (stats.images.embedded + stats.images.dataUri > 0 && stats.sizeBytes > 12 * 1024 * 1024) {
		out.push({
			severity: 'high',
			issue: 'Large file with embedded textures',
			detail: `${(stats.sizeBytes / 1024 / 1024).toFixed(1)} MB with ${stats.images.embedded + stats.images.dataUri} embedded image(s).`,
			fix: 'Compress textures to KTX2/Basis and enable Draco or Meshopt geometry compression.',
		});
	}
	if (!stats.extensionsUsed.some((e) => e.includes('draco') || e.includes('meshopt') || e.includes('EXT_meshopt'))) {
		out.push({
			severity: stats.sizeBytes > 4 * 1024 * 1024 ? 'medium' : 'low',
			issue: 'No geometry compression',
			detail: 'The model declares neither KHR_draco_mesh_compression nor EXT_meshopt_compression.',
			fix: 'Run gltf-transform with meshopt compression. Typical saving is 40 to 70 percent of the geometry payload.',
		});
	}
	if (stats.primitives.primitives > 0 && stats.primitives.indexed < stats.primitives.primitives) {
		out.push({
			severity: 'medium',
			issue: 'Unindexed primitives',
			detail: `${stats.primitives.primitives - stats.primitives.indexed} of ${stats.primitives.primitives} primitives ship without an index buffer.`,
			fix: 'Weld and index the geometry. Unindexed triangle soup wastes both bandwidth and vertex cache.',
		});
	}
	if (stats.materials > 24) {
		out.push({
			severity: 'medium',
			issue: 'High material count',
			detail: `${stats.materials} materials means at least ${stats.materials} draw calls per frame.`,
			fix: 'Atlas the textures and merge materials that differ only by base color.',
		});
	}
	if (stats.animations === 0 && stats.skins > 0) {
		out.push({
			severity: 'low',
			issue: 'Skinned mesh with no animation',
			detail: 'The model carries a skeleton but ships no animation clips.',
			fix: 'Retarget a clip onto the rig, or drop the skin if the model is meant to be static.',
		});
	}
	if (!out.length) {
		out.push({
			severity: 'none',
			issue: 'No structural problems found',
			detail: 'Counts, compression, and indexing all look healthy for web delivery.',
			fix: 'Ship it.',
		});
	}
	return out;
}

/** The paid tool's whole product: a structural report plus actionable findings. */
export function inspectModel(buffer, { sourceUrl } = {}) {
	const { document, container, binBytes } = readGltfDocument(buffer);
	const stats = {
		source: sourceUrl || null,
		container,
		sizeBytes: buffer.byteLength,
		binaryChunkBytes: binBytes,
		generator: document.asset?.generator || null,
		gltfVersion: document.asset?.version || null,
		scenes: count(document.scenes),
		nodes: count(document.nodes),
		meshes: count(document.meshes),
		materials: count(document.materials),
		textures: count(document.textures),
		images: imageStats(document),
		samplers: count(document.samplers),
		animations: count(document.animations),
		skins: count(document.skins),
		cameras: count(document.cameras),
		morphTargets: morphTargetCount(document),
		primitives: primitiveStats(document),
		geometry: geometryStats(document),
		extensionsUsed: document.extensionsUsed || [],
		extensionsRequired: document.extensionsRequired || [],
	};
	return { ...stats, findings: findings(stats) };
}
