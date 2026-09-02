// POST /api/print/upload: a short-lived presigned slot for a model you want printed.
//
// The printability analyzer reads a model by URL, so a .glb sitting on someone's
// laptop needs somewhere to be first. This hands back a presigned PUT straight to
// object storage; the browser sends the bytes there and then passes the returned
// public URL to /api/print/quote. Multi-megabyte meshes never travel through this
// function.
//
// Mirrors api/forge-upload.js, which does the same for /forge reference images:
// same presign helper, same degrade-to-503 when storage is unconfigured, same
// anonymous client scoping so uploads land under a stable prefix without an
// account. The difference is the accepted type (a glTF binary, not an image) and
// the size ceiling, which matches what the analyzer will agree to read.

import { randomUUID } from 'node:crypto';

import { cors, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { objectStorageConfigured, presignUpload, publicUrl } from '../_lib/r2.js';
import { hashClient } from '../_lib/forge-store.js';
import { MAX_INPUT_BYTES } from '../_lib/print/mesh-io.js';

// The one type a print pipeline can read. A .gltf with external buffers would
// need its siblings uploaded too, which is a worse experience than telling the
// caller to export a self-contained binary.
const ACCEPTED = Object.freeze({
	'model/gltf-binary': 'glb',
	'application/octet-stream': 'glb',
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	if (!objectStorageConfigured()) {
		return json(res, 503, {
			error: 'unconfigured',
			message:
				'Model upload is not configured on this deployment (object storage missing). ' +
				'Pass a public .glb URL to /api/print/quote instead.',
		});
	}

	const rl = await limits.upload(`print:${clientIp(req)}`);
	if (!rl.success) return rateLimited(res, rl, 'Upload limit reached. Try again shortly.');

	const body = await readJson(req, 2_000).catch(() => null);
	const contentType = typeof body?.content_type === 'string' ? body.content_type.trim().toLowerCase() : '';
	// Object.hasOwn rather than a truthy lookup: a frozen map still has its
	// prototype, so "constructor" would otherwise resolve to a function and pass.
	const ext = Object.hasOwn(ACCEPTED, contentType) ? ACCEPTED[contentType] : null;
	if (!ext) {
		return json(res, 400, {
			error: 'invalid_content_type',
			message: 'content_type must be model/gltf-binary. Export a self-contained .glb.',
		});
	}

	const size = Number(body?.size_bytes);
	if (!Number.isFinite(size) || size <= 0 || size > MAX_INPUT_BYTES) {
		return json(res, 400, {
			error: 'invalid_size',
			message: `size_bytes must be between 1 and ${MAX_INPUT_BYTES} bytes, the ceiling the analyzer will read.`,
		});
	}

	const checksum =
		typeof body?.checksum_sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.checksum_sha256)
			? body.checksum_sha256
			: undefined;

	const rawClient = req.headers['x-forge-client'];
	const clientKey = hashClient(Array.isArray(rawClient) ? rawClient[0] : rawClient);
	const key = `print/uploads/${clientKey.slice(0, 12)}/${randomUUID()}.${ext}`;

	let uploadUrl;
	try {
		uploadUrl = await presignUpload({ key, contentType, ...(checksum ? { checksumSha256: checksum } : {}) });
	} catch (err) {
		return json(res, 502, {
			error: 'presign_failed',
			message: `Could not open an upload slot: ${err?.message || 'storage unavailable'}`,
		});
	}

	return json(
		res,
		200,
		{
			storage_key: key,
			upload_url: uploadUrl,
			public_url: publicUrl(key),
			method: 'PUT',
			headers: { 'content-type': contentType },
			expires_in: 600,
		},
		{ 'cache-control': 'no-store' },
	);
});
