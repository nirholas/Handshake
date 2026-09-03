/**
 * The free-sculpt document: `appearance.sculpt`, on the wire.
 *
 * Dependency-free on purpose. The same encode/decode/validate runs in the
 * browser (src/avatar-sculpt-brush.js, while the user is painting), on the
 * server (api/_lib/bake-sculpt.js, writing the target into the served GLB) and
 * in the pure appearance helpers (src/avatar-studio-utils.js, which must not
 * pull three.js into its unit tests). Field-by-field contract:
 * specs/PARAMETRIC_AVATAR.md.
 *
 * Shape:
 *   { version: 1, meshes: { "<three.js mesh name>": {
 *       count,        number of recorded vertices
 *       vertexCount,  the mesh's vertex count, so a stale topology is caught
 *       scale,        metres per quantisation step
 *       indices,      base64 of Uint32Array[count], little-endian
 *       deltas        base64 of Int16Array[count * 3], little-endian
 *   } } }
 */

/** Name of the morph target every free-sculpt edit is recorded into. */
export const SCULPT_TARGET_NAME = 'customSculpt';

/** Document version. Bump on any wire-format change; readers reject mismatches. */
export const SCULPT_VERSION = 1;

/** Per-mesh ceiling on recorded vertices, so an appearance record stays small. */
export const SCULPT_MAX_VERTS = 20000;

/** Hard cap on how far one vertex can travel, in metres of bind space. */
export const SCULPT_MAX_DISPLACEMENT = 0.12;

export function clampDisplacement(v) {
	if (!Number.isFinite(v)) return 0;
	return Math.max(-SCULPT_MAX_DISPLACEMENT, Math.min(SCULPT_MAX_DISPLACEMENT, v));
}

/* ── base64 for typed arrays ─────────────────────────────────────────────── *
 * Twenty lines rather than a dependency, and chunked because btoa is fed
 * through String.fromCharCode.apply, which blows the argument limit on a
 * megabyte of deltas.
 * ────────────────────────────────────────────────────────────────────────── */

const B64_CHUNK = 0x8000;

export function bytesToBase64(bytes) {
	if (typeof btoa === 'function') {
		let bin = '';
		for (let i = 0; i < bytes.length; i += B64_CHUNK) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
		}
		return btoa(bin);
	}
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function base64ToBytes(b64) {
	if (typeof atob === 'function') {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	const buf = Buffer.from(b64, 'base64');
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Decode one mesh entry into plain typed arrays.
 *
 * @returns {{indices: Uint32Array, deltas: Float32Array, vertexCount: number}|null}
 */
export function decodeSculptMesh(entry) {
	if (!entry || typeof entry !== 'object') return null;
	const scale = Number(entry.scale);
	if (!Number.isFinite(scale) || scale <= 0) return null;
	let idxBytes;
	let deltaBytes;
	try {
		idxBytes = base64ToBytes(String(entry.indices || ''));
		deltaBytes = base64ToBytes(String(entry.deltas || ''));
	} catch {
		return null;
	}
	if (idxBytes.byteLength % 4 !== 0 || deltaBytes.byteLength % 2 !== 0) return null;
	const count = idxBytes.byteLength / 4;
	if (!count || count > SCULPT_MAX_VERTS || deltaBytes.byteLength / 2 !== count * 3) return null;

	// A base64 decoder can hand back a view whose byteOffset is not a multiple
	// of the element size, which the typed-array constructors reject outright.
	// DataView has no such alignment rule, so read through it.
	const indices = new Uint32Array(count);
	const dv = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
	for (let i = 0; i < count; i++) indices[i] = dv.getUint32(i * 4, true);

	const deltas = new Float32Array(count * 3);
	const dd = new DataView(deltaBytes.buffer, deltaBytes.byteOffset, deltaBytes.byteLength);
	for (let i = 0; i < count * 3; i++) deltas[i] = clampDisplacement(dd.getInt16(i * 2, true) * scale);

	return { indices, deltas, vertexCount: Number(entry.vertexCount) || 0 };
}

/**
 * Validate an incoming document, dropping mesh entries that cannot be decoded.
 * Returns null when nothing usable survives, which is the canonical "no free
 * sculpt" value and lets `collapseAppearance` omit the field entirely.
 */
export function sanitizeSculptDoc(raw) {
	if (!raw || typeof raw !== 'object') return null;
	if (raw.version !== SCULPT_VERSION) return null;
	if (!raw.meshes || typeof raw.meshes !== 'object') return null;

	const meshes = {};
	for (const [name, entry] of Object.entries(raw.meshes)) {
		if (typeof name !== 'string' || !name) continue;
		const decoded = decodeSculptMesh(entry);
		if (!decoded) continue;
		meshes[name] = {
			count: decoded.indices.length,
			vertexCount: decoded.vertexCount,
			scale: Number(entry.scale),
			indices: String(entry.indices),
			deltas: String(entry.deltas),
		};
	}
	return Object.keys(meshes).length ? { version: SCULPT_VERSION, meshes } : null;
}

/** Total recorded vertices across every mesh in a document. */
export function sculptVertexCount(doc) {
	if (!doc?.meshes) return 0;
	return Object.values(doc.meshes).reduce((n, m) => n + (Number(m?.count) || 0), 0);
}

/** True when two sculpt documents mean the same shape. */
export function sculptEqual(a, b) {
	return JSON.stringify(sanitizeSculptDoc(a)) === JSON.stringify(sanitizeSculptDoc(b));
}
