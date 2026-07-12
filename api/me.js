// GET /api/me — the authenticated caller's identity for the Walk Avatar
// extension (and any other first-party client). Resolves a browser session
// cookie OR a Bearer access token, and returns the minimal public profile the
// extension popup renders in its header pill.
//
// Distinct from /api/auth/me (full session bootstrap) and /api/threews/me
// (subdomain claim widget): this is a tiny, stable, CORS-friendly identity
// endpoint the extension can call with the token it minted at sign-in.
//
// Also carries onboarding-tour state (api/_lib/migrations/
// 20260712030000_onboarding_tour_state.sql): `show_onboarding_tour` is the
// single source of truth the site's homepage/dashboard bootstrap reads to
// decide whether to auto-offer the guided onboarding tour — true only for an
// account that has never been offered the tour (onboarding_tour_seen_at is
// null) AND has zero creations across every creation surface (avatars,
// agents, forge_creations, dioramas). POST this same route with
// { onboarding_tour: 'seen' | 'completed' } to record the corresponding
// timestamp (see src/feature-tour/onboarding.js, which drives both ends).

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { thumbnailUrl } from './_lib/r2.js';

function readRawBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (c) => {
			data += c;
			if (data.length > 16 * 1024) reject(new Error('request body too large'));
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'POST') {
		let body;
		try {
			body = typeof req.body === 'object' && req.body ? req.body : JSON.parse((await readRawBody(req)) || '{}');
		} catch {
			return error(res, 400, 'invalid_body', 'invalid JSON body');
		}
		const flag = body.onboarding_tour;
		if (flag !== 'seen' && flag !== 'completed') {
			return error(res, 400, 'validation_error', 'onboarding_tour must be "seen" or "completed"');
		}
		// "completed" implies "seen" — a completed tour was necessarily offered.
		const [row] = await sql`
			UPDATE users
			SET onboarding_tour_seen_at = COALESCE(onboarding_tour_seen_at, now()),
			    onboarding_tour_completed_at = CASE WHEN ${flag} = 'completed' THEN now() ELSE onboarding_tour_completed_at END,
			    updated_at = now()
			WHERE id = ${auth.userId} AND deleted_at IS NULL
			RETURNING onboarding_tour_seen_at, onboarding_tour_completed_at
		`;
		if (!row) return error(res, 404, 'not_found', 'user not found');
		return json(res, 200, {
			onboarding_tour_seen_at: row.onboarding_tour_seen_at,
			onboarding_tour_completed_at: row.onboarding_tour_completed_at,
		});
	}

	const [user] = await sql`
		SELECT u.id, u.username, u.display_name, u.created_at,
		       u.onboarding_tour_seen_at, u.onboarding_tour_completed_at,
		       a.thumbnail_key,
		       (SELECT count(*) FROM avatars WHERE owner_id = u.id AND deleted_at IS NULL) AS avatars_count,
		       (SELECT count(*) FROM agent_identities WHERE user_id = u.id AND deleted_at IS NULL) AS agents_count,
		       (SELECT count(*) FROM forge_creations WHERE user_id = u.id AND status = 'done') AS forge_count,
		       (SELECT count(*) FROM dioramas WHERE user_id = u.id) AS diorama_count
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
	const creationsCount =
		Number(user.avatars_count || 0) +
		Number(user.agents_count || 0) +
		Number(user.forge_count || 0) +
		Number(user.diorama_count || 0);
	const showOnboardingTour = !user.onboarding_tour_seen_at && creationsCount === 0;

	return json(res, 200, {
		user: {
			id: user.id,
			username: handle,
			display_name: user.display_name || handle || 'three.ws user',
			handle: handle ? `@${handle}` : (user.display_name || 'signed in'),
			avatar_url: thumbnailUrl(user.thumbnail_key),
			created_at: user.created_at,
			creations_count: creationsCount,
			onboarding_tour_seen_at: user.onboarding_tour_seen_at,
			onboarding_tour_completed_at: user.onboarding_tour_completed_at,
			show_onboarding_tour: showOnboardingTour,
		},
	});
});
