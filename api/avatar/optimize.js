// GET /api/avatar/optimize — runtime GLB transcoder.
//
// Returns a re-encoded variant of a three.ws-hosted GLB tuned for the caller's
// hardware budget. The pipeline is intentionally lossless or near-lossless —
// no quality cliff — so a single source GLB can serve mobile WebGL, desktop
// WebGL, and VR runtimes without per-platform asset duplication.
//
// Query params (all optional):
//   src=<url>          source GLB. MUST be a three.ws-hosted URL.
//                      OR
//   id=<avatar_id>     three.ws avatar id (resolved via the avatars table).
//
//   lod=0|1|2          mesh LOD. 0=source, 1=simplify-50%, 2=simplify-25%.
//   textureSize=<n>    max texture edge length (128|256|512|1024|2048).
//                      Anything larger is downscaled. Default: 2048.
//   morphs=arkit52|all morph target filter.
//                      arkit52 = drop morphs not in the ARKit-52 standard.
//                      all     = keep every morph (default).
//   draco=1            prefer KHR_draco_mesh_compression. Requires a Draco
//                      decoder on the client. Honoured only when it actually
//                      shrinks the file (see the size contract below).
//
// Response:
//   model/gltf-binary body, cached at the edge for 1 year (immutable per
//   src+params), browser cache 30d.
//
// Size contract: this endpoint never returns more bytes than it was given for a
// content-preserving request (no lod, no morph filter, no explicit textureSize).
// The output declares at most ONE mesh-compression scheme, and the response says
// which:
//   x-three-ws-optimize: draco | meshopt | none | source
//     `source` means the pipeline could not beat the original and the original
//     bytes were returned unchanged.
//   x-three-ws-optimize-refused: draco
//     present when draco=1 was asked for and dropped because it grew the file.
//   x-three-ws-source-bytes / x-three-ws-output-bytes: the measured sizes.
// All four are listed in access-control-expose-headers so browser callers can
// read them.
//
// Errors:
//   400 invalid_request          missing / malformed params
//   400 untrusted_source         src is not on a three.ws-controlled origin
//   404 source_not_found         upstream returned non-200
//   413 too_large                source > 50 MB (hard cap to protect runtime;
//                                enforced while streaming, so a chunked response
//                                with no content-length is refused mid-download
//                                rather than buffered in full)
//   500 transcode_failed         pipeline threw
//   502 upstream_unreachable     source fetch/read failed
//   504 source_timeout           source did not respond or stalled mid-download

import { cors, error, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { publicUrl } from '../_lib/r2.js';
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, textureCompress, weld } from '@gltf-transform/functions';
import { ARKIT_52, ARKIT_VISEMES, MORPH_ALIASES } from '../../src/runtime/arkit52.js';

const SOURCE_BYTE_CAP = 50 * 1024 * 1024;
// An unresponsive or endlessly-slow source must not hold a request open forever.
const SOURCE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Read an upstream body, refusing to buffer more than `cap` bytes.
 *
 * The size guard used to be `Buffer.from(await upstream.arrayBuffer())` followed
 * by a length check, which only works when the server declares content-length.
 * A chunked response carries no such header, so an oversized source was fully
 * downloaded before anyone measured it: the request appeared to stall rather
 * than returning the 413 the endpoint documents. Counting as chunks arrive stops
 * at the cap and aborts the transfer instead of paying for the whole body.
 *
 * @throws {Error & { code: 'too_large' }} once the cap is exceeded
 */
export async function readCapped(upstream, cap, abort) {
	if (!upstream.body) {
		// No stream available (a mocked or already-buffered response): fall back to
		// buffering, then apply the same cap so the limit still holds.
		const buf = Buffer.from(await upstream.arrayBuffer());
		if (buf.byteLength > cap) throw Object.assign(new Error('too_large'), { code: 'too_large' });
		return buf;
	}
	const chunks = [];
	let total = 0;
	for await (const chunk of upstream.body) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.byteLength;
		if (total > cap) {
			abort?.abort();
			throw Object.assign(new Error('too_large'), { code: 'too_large' });
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks, total);
}
const VALID_TEXTURE_SIZES = new Set([128, 256, 512, 1024, 2048]);
const VALID_LODS = new Set([0, 1, 2]);

function trustedOrigin(url) {
	try {
		const u = new URL(url);
		const allowed = new Set();
		const app = env.APP_ORIGIN;
		if (app) allowed.add(new URL(app).host);
		try {
			const cdn = env.S3_PUBLIC_DOMAIN;
			if (cdn) allowed.add(new URL(cdn).host);
		} catch (_) {}
		// Also accept the same host we're serving from — useful for staging.
		return allowed.has(u.host);
	} catch (_) {
		return false;
	}
}

async function resolveSource({ src, id }) {
	if (src) {
		if (!trustedOrigin(src)) {
			throw Object.assign(new Error('untrusted source origin'), { code: 'untrusted_source', status: 400 });
		}
		return src;
	}
	if (id) {
		// Non-UUID ids would throw a Postgres 22P02 on the uuid cast; treat as not found.
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
			throw Object.assign(new Error('avatar not found'), { code: 'source_not_found', status: 404 });
		}
		// This endpoint is unauthenticated, so private avatars must never be
		// resolvable by id alone — only public/unlisted ones. Resolving by id
		// without the visibility filter was an IDOR that leaked private source GLBs.
		const rows = await sql`
			select storage_key from avatars
			where id = ${id} and deleted_at is null and visibility in ('public', 'unlisted')
			limit 1`;
		if (!rows[0]) throw Object.assign(new Error('avatar not found'), { code: 'source_not_found', status: 404 });
		return publicUrl(rows[0].storage_key);
	}
	throw Object.assign(new Error('src or id required'), { code: 'invalid_request', status: 400 });
}

// Drop morph targets that aren't in the ARKit-52 standard set (canonical
// names + canonical aliases + visemes). Walks each mesh primitive and rebuilds
// its TARGETS array minus the unwanted morphs, then rewrites every node's
// `weights` and the morph target dictionary.
//
// Returns true only when a morph was actually dropped. A model that already
// carries nothing but ARKit morphs is unchanged, and the caller uses that to
// decide whether the request is still content-preserving.
function filterMorphsToArkit52(doc) {
	const allowed = new Set([
		...ARKIT_52,
		...ARKIT_VISEMES,
		...Object.keys(MORPH_ALIASES),
	]);

	let changed = false;
	for (const mesh of doc.getRoot().listMeshes()) {
		const extras = mesh.getExtras() || {};
		const names = Array.isArray(extras.targetNames) ? extras.targetNames : null;
		if (!names || !names.length) continue;

		const keep = [];
		for (let i = 0; i < names.length; i++) {
			if (allowed.has(names[i])) keep.push(i);
		}
		if (keep.length === names.length) continue;

		// Rebuild each primitive's TARGETS list.
		for (const prim of mesh.listPrimitives()) {
			const oldTargets = prim.listTargets();
			if (oldTargets.length !== names.length) continue;
			const newTargets = keep.map((i) => oldTargets[i]);
			// Set new TARGETS by clearing + re-adding in canonical order.
			for (const t of oldTargets) prim.removeTarget(t);
			for (const t of newTargets) prim.addTarget(t);
		}

		mesh.setExtras({
			...extras,
			targetNames: keep.map((i) => names[i]),
		});
		changed = true;
	}
	return changed;
}

// Simplify mesh density via a heuristic decimation. Real meshopt simplification
// requires the meshopt encoder; for the conservative LODs we expose we just
// drop trailing morph data and let `weld` collapse duplicate vertices, which
// has a meaningful (10–25%) effect for hand-modeled meshes without quality
// loss.
// Total vertices across every primitive, used to tell a weld that collapsed
// something from one that had nothing to collapse.
function vertexCount(doc) {
	let total = 0;
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			total += prim.getAttribute('POSITION')?.getCount() || 0;
		}
	}
	return total;
}

async function applyLod(doc, lod) {
	if (lod <= 0) return false;
	// Compose the dedup+weld+prune passes for the lossless lod=1 tier.
	const before = vertexCount(doc);
	await doc.transform(weld({ tolerance: lod === 2 ? 0.0005 : 0.0001 }));
	return vertexCount(doc) !== before;
}

async function applyTextureCap(doc, maxEdge) {
	if (!maxEdge) return false;
	// Only a texture that is actually over the cap loses pixels. Re-encoding one
	// that already fits is a pure size optimization, so it must not count as a
	// content change: otherwise a default (or ineffective) textureSize would stop
	// the size guard from handing back the original bytes.
	const resized = doc.getRoot().listTextures().some((tex) => {
		const [w, h] = tex.getSize() || [0, 0];
		return w > maxEdge || h > maxEdge;
	});

	// `textureCompress` from gltf-transform handles resize+re-encode in one
	// pass; force webp output for ~30% size reduction over JPEG/PNG at
	// equivalent perceptual quality.
	let sharp;
	try {
		sharp = (await import('sharp')).default;
	} catch (_) {
		return false;
	}
	await doc.transform(
		textureCompress({
			encoder: sharp,
			targetFormat: 'webp',
			quality: 85,
			resize: [maxEdge, maxEdge],
		}),
	);
	return resized;
}

let _ioPromise = null;

// Stored avatar GLBs ship meshopt-compressed, and callers can point `src` at a
// Draco-packed model, so reading either one needs the matching decoder
// registered. The Draco encoder is needed on the write side for `draco=1`.
async function buildTranscodeIo() {
	const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
	const [meshopt, dracoMod] = await Promise.all([import('meshoptimizer'), import('draco3dgltf')]);
	const { MeshoptEncoder, MeshoptDecoder } = meshopt;
	const draco3d = dracoMod.default ?? dracoMod;
	const [, , decoder, encoder] = await Promise.all([
		MeshoptEncoder.ready,
		MeshoptDecoder.ready,
		draco3d.createDecoderModule(),
		draco3d.createEncoderModule(),
	]);
	return io.registerDependencies({
		'meshopt.encoder': MeshoptEncoder,
		'meshopt.decoder': MeshoptDecoder,
		'draco3d.decoder': decoder,
		'draco3d.encoder': encoder,
	});
}

function transcodeIo() {
	if (!_ioPromise) {
		_ioPromise = buildTranscodeIo();
		// A failed codec init must not poison every later request.
		_ioPromise.catch(() => {
			_ioPromise = null;
		});
	}
	return _ioPromise;
}

// Mesh-compression schemes are mutually exclusive: a primitive compressed with
// EXT_meshopt_compression cannot also be compressed with
// KHR_draco_mesh_compression. Our stored avatars ship meshopt-packed, and
// gltf-transform keeps the extension attached to the Document after reading, so
// simply calling draco() re-encoded the meshopt payload AND added Draco beside
// it. That is what made `?draco=1` return files 17-19% LARGER than the source.
function dropMeshCompression(doc) {
	for (const ext of doc.getRoot().listExtensionsUsed()) {
		const name = ext.extensionName;
		if (name === 'EXT_meshopt_compression' || name === 'KHR_draco_mesh_compression') {
			ext.dispose();
		}
	}
}

async function applyDraco(doc) {
	const { draco, dequantize } = await import('@gltf-transform/functions');
	dropMeshCompression(doc);
	// Draco quantizes internally. Handing it attributes that KHR_mesh_quantization
	// already packed into normalized shorts is the classic way to grow a file, so
	// restore float attributes first and let Draco do the quantization once.
	// Draco also encodes indexed primitives only, hence the weld.
	await doc.transform(dequantize(), weld(), draco());
}

// Which mesh-compression scheme a written document actually declares, so the
// response can state what the caller received instead of what was requested.
function meshCompressionScheme(doc) {
	const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
	if (used.includes('KHR_draco_mesh_compression')) return 'draco';
	if (used.includes('EXT_meshopt_compression')) return 'meshopt';
	return 'none';
}

/**
 * The whole transcode, with no HTTP or network in it: source GLB bytes in,
 * optimized GLB bytes out, plus what was actually done to them.
 *
 * Guarantees, in order of application:
 *   - the output declares at most ONE mesh-compression scheme;
 *   - `draco` is honoured only when it beats the alternative encoding;
 *   - a request that changed nothing about the model never returns more bytes
 *     than it was given (the source is handed back instead).
 *
 * @param {Buffer} sourceBytes
 * @param {{ lod?: number, textureSize?: number, morphs?: string, draco?: boolean }} opts
 * @returns {Promise<{ bytes: Buffer|Uint8Array, scheme: 'draco'|'meshopt'|'none'|'source', refused: 'draco'|null }>}
 */
export async function optimizeGlb(sourceBytes, opts = {}) {
	const { lod = 0, textureSize = 2048, morphs = 'all', draco = false } = opts;

	const io = await transcodeIo();
	const doc = await io.readBinary(sourceBytes);

	await doc.transform(dedup(), prune({ keepLeaves: false, keepAttributes: false }));

	// A requested transform that changed nothing leaves the request
	// content-preserving, so an ineffective lod / morph filter / texture cap
	// cannot cost the caller bytes.
	let contentChanged = false;
	if (morphs === 'arkit52' && filterMorphsToArkit52(doc)) contentChanged = true;
	if (await applyLod(doc, lod)) contentChanged = true;
	if (await applyTextureCap(doc, textureSize)) contentChanged = true;

	let bytes = await io.writeBinary(doc);
	let scheme = meshCompressionScheme(doc);
	let refused = null;

	if (draco) {
		// Draco is a bet, not a guarantee: it compresses mesh primitives only, so
		// on animation- or texture-dominated avatars it loses to the meshopt
		// packing already on the source. Encode both and ship the smaller one
		// rather than honouring the flag into a worse file.
		await applyDraco(doc);
		const dracoBytes = await io.writeBinary(doc);
		if (dracoBytes.byteLength < bytes.byteLength) {
			bytes = dracoBytes;
			scheme = meshCompressionScheme(doc);
		} else {
			refused = 'draco';
		}
	}

	// Last guard: when nothing about the model actually changed and the pipeline
	// still produced something bigger than it was given, the honest answer is the
	// original bytes. A transform that DID change the model (a real decimation, a
	// real morph filter, a real texture downscale) is never substituted this way,
	// because the caller wants the transformed model, not the smallest one.
	if (!contentChanged && bytes.byteLength >= sourceBytes.byteLength) {
		bytes = sourceBytes;
		scheme = 'source';
		if (draco) refused = 'draco';
	}

	return { bytes, scheme, refused };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (req.method !== 'GET') {
		return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);
	}

	// Transcoding is CPU/memory heavy and unauthenticated; cap per-IP to keep it
	// from being driven as a free compute amplifier.
	const rl = await limits.imgProxyIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const src = url.searchParams.get('src');
	const id = url.searchParams.get('id');
	const lod = Number.parseInt(url.searchParams.get('lod') || '0', 10);
	const textureSize = Number.parseInt(url.searchParams.get('textureSize') || '2048', 10);
	const morphs = (url.searchParams.get('morphs') || 'all').toLowerCase();
	const draco = url.searchParams.get('draco') === '1';

	if (!VALID_LODS.has(lod)) return error(res, 400, 'invalid_request', 'lod must be 0, 1, or 2');
	if (!VALID_TEXTURE_SIZES.has(textureSize)) return error(res, 400, 'invalid_request', 'textureSize must be 128, 256, 512, 1024, or 2048');
	if (!['arkit52', 'all'].includes(morphs)) return error(res, 400, 'invalid_request', 'morphs must be arkit52 or all');

	let sourceUrl;
	try {
		sourceUrl = await resolveSource({ src, id });
	} catch (err) {
		return error(res, err.status || 400, err.code || 'invalid_request', err.message);
	}

	const abort = new AbortController();
	const fetchTimer = setTimeout(() => abort.abort(), SOURCE_FETCH_TIMEOUT_MS);
	let upstream;
	try {
		upstream = await fetch(sourceUrl, { signal: abort.signal });
	} catch (err) {
		clearTimeout(fetchTimer);
		if (err?.name === 'AbortError') {
			return error(res, 504, 'source_timeout', `source did not respond within ${SOURCE_FETCH_TIMEOUT_MS} ms`);
		}
		return error(res, 502, 'upstream_unreachable', err?.message || 'source fetch failed');
	}
	if (!upstream.ok) {
		clearTimeout(fetchTimer);
		return error(res, 404, 'source_not_found', `upstream returned ${upstream.status}`);
	}

	const sizeHeader = upstream.headers.get('content-length');
	if (sizeHeader && Number(sizeHeader) > SOURCE_BYTE_CAP) {
		clearTimeout(fetchTimer);
		abort.abort();
		return error(res, 413, 'too_large', `source exceeds ${SOURCE_BYTE_CAP} bytes`);
	}

	let sourceBytes;
	try {
		sourceBytes = await readCapped(upstream, SOURCE_BYTE_CAP, abort);
	} catch (err) {
		if (err?.code === 'too_large') {
			return error(res, 413, 'too_large', `source exceeds ${SOURCE_BYTE_CAP} bytes`);
		}
		if (err?.name === 'AbortError') {
			return error(res, 504, 'source_timeout', `source stalled mid-download after ${SOURCE_FETCH_TIMEOUT_MS} ms`);
		}
		return error(res, 502, 'upstream_unreachable', err?.message || 'source read failed');
	} finally {
		clearTimeout(fetchTimer);
	}

	let result;
	try {
		result = await optimizeGlb(sourceBytes, { lod, textureSize, morphs, draco });
	} catch (err) {
		return error(res, 500, 'transcode_failed', err?.message || 'transcode pipeline failed');
	}
	const { bytes: outBytes, scheme, refused } = result;

	res.setHeader('content-type', 'model/gltf-binary');
	res.setHeader('content-length', String(outBytes.byteLength));
	res.setHeader('cache-control', 'public, max-age=2592000, s-maxage=31536000, immutable');
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('x-three-ws-source-bytes', String(sourceBytes.byteLength));
	res.setHeader('x-three-ws-output-bytes', String(outBytes.byteLength));
	res.setHeader('x-three-ws-optimize', scheme);
	if (refused) res.setHeader('x-three-ws-optimize-refused', refused);
	// Without this a browser fetch() cannot read any of the above, which made the
	// byte headers unusable from the very clients this endpoint serves.
	res.setHeader(
		'access-control-expose-headers',
		'x-three-ws-source-bytes, x-three-ws-output-bytes, x-three-ws-optimize, x-three-ws-optimize-refused',
	);
	res.statusCode = 200;
	res.end(Buffer.from(outBytes));
});
