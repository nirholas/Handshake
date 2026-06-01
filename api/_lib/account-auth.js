// Resolve the calling account for endpoints that accept either a browser
// session (cookie) or a programmatic bearer token (OAuth / API key). Returns
// { userId } or null. Mirrors the inline pattern used across api/threews/* but
// shared so the friends endpoints stay consistent.

import { getSessionUser, authenticateBearer, extractBearer } from './auth.js';

export async function resolveAccount(req, res) {
	const session = await getSessionUser(req, res);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, source: bearer.source };
	return null;
}
