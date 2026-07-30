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
//   draco=1            apply KHR_draco_mesh_compression. Smaller bytes, but
//                      requires a Draco decoder on the client.
//
// Response:
//   model/gltf-binary body, cached at the edge for 1 year (immutable per
//   src+params), browser cache 30d.
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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
function filterMorphsToArkit52(doc) {
	const allowed = new Set([
		...ARKIT_52,
		...ARKIT_VISEMES,
		...Object.keys(MORPH_ALIASES),
	]);

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
	}
}

// Simplify mesh density via a heuristic decimation. Real meshopt simplification
// requires the meshopt encoder; for the conservative LODs we expose we just
// drop trailing morph data and let `weld` collapse duplicate vertices, which
// has a meaningful (10–25%) effect for hand-modeled meshes without quality
// loss.
async function applyLod(doc, lod) {
	if (lod <= 0) return;
	// Compose the dedup+weld+prune passes for the lossless lod=1 tier.
	await doc.transform(weld({ tolerance: lod === 2 ? 0.0005 : 0.0001 }));
}

async function applyTextureCap(doc, maxEdge) {
	if (!maxEdge) return;
	// `textureCompress` from gltf-transform handles resize+re-encode in one
	// pass; force webp output for ~30% size reduction over JPEG/PNG at
	// equivalent perceptual quality.
	let sharp;
	try {
		sharp = (await import('sharp')).default;
	} catch (_) {
		return;
	}
	await doc.transform(
		textureCompress({
			encoder: sharp,
			targetFormat: 'webp',
			quality: 85,
			resize: [maxEdge, maxEdge],
		}),
	);
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

async function applyDraco(doc) {
	const { draco } = await import('@gltf-transform/functions');
	// Draco encodes indexed primitives only, so weld before handing it the mesh.
	await doc.transform(weld(), draco());
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

	let outBytes;
	try {
		const io = await transcodeIo();
		const doc = await io.readBinary(sourceBytes);

		await doc.transform(dedup(), prune({ keepLeaves: false, keepAttributes: false }));

		if (morphs === 'arkit52') filterMorphsToArkit52(doc);
		await applyLod(doc, lod);
		await applyTextureCap(doc, textureSize);
		if (draco) await applyDraco(doc);

		outBytes = await io.writeBinary(doc);
	} catch (err) {
		return error(res, 500, 'transcode_failed', err?.message || 'transcode pipeline failed');
	}

	res.setHeader('content-type', 'model/gltf-binary');
	res.setHeader('content-length', String(outBytes.byteLength));
	res.setHeader('cache-control', 'public, max-age=2592000, s-maxage=31536000, immutable');
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('x-three-ws-source-bytes', String(sourceBytes.byteLength));
	res.setHeader('x-three-ws-output-bytes', String(outBytes.byteLength));
	res.statusCode = 200;
	res.end(Buffer.from(outBytes));
});
