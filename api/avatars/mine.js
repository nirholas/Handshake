// GET /api/avatars/mine — the signed-in caller's own avatars, slimmed to what
// a picker needs (id, name, thumbnail, visibility). Powers the "My Avatars" tab
// of the Walk Avatar extension. Auth: session cookie OR Bearer (avatars:read).
//
// Thumbnails are served through /api/avatars/:id/thumb so a plain <img src> in
// any first-party client (extension popup, embed) renders without juggling auth
// headers — the poster PNG is a public CDN object regardless of avatar
// visibility, while the GLB itself stays gated.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { listAvatars } from '../_lib/avatars.js';
import { readStorageModes } from '../_lib/storage-mode.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer && hasScope(bearer.scope, 'avatars:read')) return { userId: bearer.userId };
	return null;
}

export function slimAvatar(av, storageMode) {
	return {
		id: av.id,
		name: av.name || 'Untitled avatar',
		slug: av.slug || null,
		visibility: av.visibility,
		has_thumbnail: !!av.thumbnail_url,
		thumb_url: `${env.APP_ORIGIN}/api/avatars/${av.id}/thumb`,
		created_at: av.created_at,
		size_bytes: av.size_bytes ?? null,
		// Flattened storage state, so the dashboard settings page can render an
		// R2-vs-IPFS row per avatar without a per-avatar /storage-mode request.
		// The attestation block stays out: it is chain provenance, not storage,
		// and /api/avatars/:id/storage-mode already serves the full record.
		storage: storageMode
			? {
					primary: storageMode.primary,
					r2_present: !!storageMode.r2?.present,
					ipfs_pinned: !!storageMode.ipfs?.pinned,
					ipfs_cid: storageMode.ipfs?.cid ?? null,
					ipfs_pinned_at: storageMode.ipfs?.pinned_at ?? null,
				}
			: null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a token with avatars:read');

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200);

	const { avatars, next_cursor } = await listAvatars({
		userId: auth.userId,
		limit,
		cursor: url.searchParams.get('cursor'),
	});

	const modes = await readStorageModes(avatars.map((a) => a.id));

	return json(res, 200, {
		avatars: avatars.map((a) => slimAvatar(a, modes.get(a.id) || null)),
		next_cursor,
	});
});
