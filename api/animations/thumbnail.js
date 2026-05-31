// POST /api/animations/thumbnail — upload a PNG poster for an animation clip.
// Body: { id: uuid, png_base64: "data:image/png;base64,..." | "<raw base64>" }
// Owner-only. Stored at anim-thumb/<id>.png in R2; the clip row's thumbnail_key
// is updated and served via publicUrl(). Mirrors api/avatars/thumbnail.js.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { putObject, deleteObject, publicUrl } from '../_lib/r2.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';

const MAX_PNG_BYTES = 1_500_000;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const rl = await limits.upload(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'thumbnail upload rate exceeded');

	const body = await readJson(req).catch(() => null);
	const id = body?.id;
	const pngB64 = body?.png_base64;

	if (!id || typeof id !== 'string' || !/^[0-9a-f-]{8,}$/i.test(id)) {
		return error(res, 400, 'invalid_request', 'id required');
	}
	if (!pngB64 || typeof pngB64 !== 'string') {
		return error(res, 400, 'invalid_request', 'png_base64 required');
	}

	const raw = pngB64.replace(/^data:image\/png;base64,/, '');
	let buf;
	try {
		buf = Buffer.from(raw, 'base64');
	} catch {
		return error(res, 400, 'invalid_request', 'png_base64 not valid base64');
	}
	if (buf.length === 0 || buf.length > MAX_PNG_BYTES) {
		return error(res, 413, 'too_large', `png must be 1..${MAX_PNG_BYTES} bytes`);
	}
	if (!buf.subarray(0, 8).equals(PNG_HEADER)) {
		return error(res, 400, 'invalid_request', 'body is not a PNG');
	}

	const [row] = await sql`
		SELECT id, owner_id, thumbnail_key
		FROM animation_clips
		WHERE id = ${id} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!row) return error(res, 404, 'not_found', 'animation not found');
	if (row.owner_id !== auth.userId) return error(res, 403, 'forbidden', 'not your animation');

	const key = `anim-thumb/${id}.png`;
	await putObject({
		key,
		body: buf,
		contentType: 'image/png',
		metadata: { 'animation-id': id, 'uploaded-by': auth.userId },
	});

	if (row.thumbnail_key && row.thumbnail_key !== key) {
		queueMicrotask(() => deleteObject(row.thumbnail_key).catch(() => {}));
	}

	await sql`UPDATE animation_clips SET thumbnail_key = ${key}, updated_at = now() WHERE id = ${id}`;

	return json(res, 200, {
		data: { id, thumbnail_key: key, thumbnail_url: publicUrl(key), bytes: buf.length },
	});
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, 'avatars:write')) return null;
	return { userId: bearer.userId };
}
