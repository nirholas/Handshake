// GET /api/me — the authenticated caller's identity for the Walk Avatar
// extension (and any other first-party client). Resolves a browser session
// cookie OR a Bearer access token, and returns the minimal public profile the
// extension popup renders in its header pill.
//
// Distinct from /api/auth/me (full session bootstrap) and /api/threews/me
// (subdomain claim widget): this is a tiny, stable, CORS-friendly identity
// endpoint the extension can call with the token it minted at sign-in.

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { publicUrl } from './_lib/r2.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const [user] = await sql`
		SELECT u.id, u.username, u.display_name, u.created_at,
		       a.thumbnail_key
		FROM users u
		LEFT JOIN LATERAL (
			SELECT thumbnail_key
			FROM avatars
			WHERE owner_id = u.id AND deleted_at IS NULL AND thumbnail_key IS NOT NULL
			ORDER BY created_at DESC
			LIMIT 1
		) a ON true
		WHERE u.id = ${auth.userId} AND u.deleted_at IS NULL
		LIMIT 1
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');

	const handle = user.username || null;
	return json(res, 200, {
		user: {
			id: user.id,
			username: handle,
			display_name: user.display_name || handle || 'three.ws user',
			handle: handle ? `@${handle}` : (user.display_name || 'signed in'),
			avatar_url: user.thumbnail_key ? publicUrl(user.thumbnail_key) : null,
			created_at: user.created_at,
		},
	});
});
