// POST /api/avatar/presign-glb
//
// Returns a presigned PUT URL for uploading a self-contained .glb avatar to R2,
// plus the public URL it will be readable at after upload. Used by the /play
// lobby's "bring your own avatar" drop zone: the player drops a .glb, the client
// uploads it directly to storage, then broadcasts the resulting public URL to the
// room — so every peer (not just the uploader) renders the custom avatar.
//
// /play is anonymous, so a session is OPTIONAL. Authenticated users get a stable
// per-user key namespace; anonymous players upload under a shared `anon` prefix.
//
// Request body (JSON):
//   filename      string? — original filename (only the .glb extension matters)
//   content_type  string? — MIME type (default + only sensible value: model/gltf-binary)
//   bytes         number? — declared file size, rejected early if over the cap
//
// Response 200:
//   {
//     upload_url:   string,   // PUT the .glb here (expires in 5 min)
//     public_url:   string,   // read from here after the PUT completes
//     storage_key:  string,   // R2 key, for reference
//   }

import { cors, error, json, wrap } from '../_lib/http.js';
import { getSessionUser } from '../_lib/auth.js';
import { presignUpload, publicUrl } from '../_lib/r2.js';
import { randomUUID } from 'crypto';

// 16 MB — generous for a single-mesh avatar, tight enough to keep the scene's
// per-peer download budget sane. Mirrored client-side in avatar-upload.js.
const MAX_GLB_BYTES = 16 * 1024 * 1024;

// glTF-binary is the only self-contained, single-file model format (a .gltf is
// JSON plus external .bin/texture refs, which a single PUT can't carry). Accept
// octet-stream too, since some browsers report .glb that way on drag-and-drop.
const ALLOWED_TYPES = new Set(['model/gltf-binary', 'application/octet-stream']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);

	let userId = 'anon';
	try {
		const session = await getSessionUser(req);
		if (session) userId = session.id ?? session.userId ?? 'anon';
	} catch { /* anonymous player — allowed */ }

	const body = req.body || {};
	const contentType = (body.content_type || 'model/gltf-binary').toLowerCase().trim();
	if (!ALLOWED_TYPES.has(contentType)) {
		return error(res, 415, 'unsupported_media_type', `content_type must be model/gltf-binary, got: ${contentType}`);
	}

	const bytes = Number(body.bytes);
	if (Number.isFinite(bytes) && bytes > MAX_GLB_BYTES) {
		return error(res, 413, 'payload_too_large', `glb is ${bytes} bytes; max is ${MAX_GLB_BYTES}`);
	}

	const key = `u/${userId}/avatar/${randomUUID()}.glb`;
	const uploadUrl = await presignUpload({ key, contentType });

	return json(res, 200, {
		upload_url: uploadUrl,
		public_url: publicUrl(key),
		storage_key: key,
	});
});
