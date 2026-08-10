// POST /api/animations/presign
// Returns a short-lived R2 presigned PUT URL for direct browser upload of animation .glb files.
// Storage key is scoped per-user: u/{userId}/animations/{slug}-{ts}.glb
// After upload, the client registers the clip via PATCH /api/agents/:id with meta.animations.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { presignUpload } from '../_lib/r2.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { z } from 'zod';

const bodySchema = z.object({
	size_bytes: z
		.number()
		.int()
		.positive()
		.max(100 * 1024 * 1024), // 100 MB cap for animation clips
	content_type: z.enum(['model/gltf-binary', 'model/gltf+json']).default('model/gltf-binary'),
	checksum_sha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	slug: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug must be lowercase alphanumeric with - or _')
		.optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const userId = await resolveUser(req, 'avatars:write');
	if (!userId) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const rl = await limits.upload(userId);
	if (!rl.success) return rateLimited(res, rl, 'upload rate exceeded');

	const raw = await readJson(req);
	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		const msg = parsed.error.issues
			.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
			.join('; ');
		return error(res, 400, 'validation_error', msg);
	}
	const body = parsed.data;

	const slug = body.slug || `anim-${Math.random().toString(36).slice(2, 8)}`;
	const key = `u/${userId}/animations/${slug}-${Date.now()}.glb`;

	const url = await presignUpload({
		key,
		contentType: body.content_type,
		...(body.checksum_sha256 ? { checksumSha256: body.checksum_sha256 } : {}),
	});

	return json(res, 200, {
		storage_key: key,
		upload_url: url,
		method: 'PUT',
		headers: { 'content-type': body.content_type },
		expires_in: 300,
	});
});

async function resolveUser(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer.userId;
}
