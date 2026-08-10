// GET /api/crews/:tag
// Public view of a crew by its tag: identity + roster (public profile subset) +
// live presence per member. Used by the inspect card's crew link and any crew
// landing surface. Auth-optional — a crew roster is public, like the agent
// gallery, but never leaks private member state (handled in crews-store).

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { readPresence } from '../_lib/presence-store.js';
import { getCrewByTag, normalizeTag, isMissingRelation } from '../_lib/crews-store.js';

// The crew a request is asking for. Its identity is the path segment, never the
// query string: the router merges route params into req.query after the search
// params (route params win), so reading req.query.tag first is what stops
// `/api/crews/AAA?tag=BBB` from answering with BBB's roster at AAA's URL. The
// path fallback covers callers that invoke this handler directly, and drops
// empty segments so `/api/crews/AAA/` resolves like `/api/crews/AAA` instead of
// reading the trailing slash as an empty tag and rejecting a valid link.
export function crewTagFromRequest(req) {
	const fromRoute = req?.query?.tag;
	if (typeof fromRoute === 'string' && fromRoute) return normalizeTag(fromRoute);
	const { pathname } = new URL(req?.url || '/', 'http://x');
	const segments = pathname.split('/').filter(Boolean);
	const last = segments[segments.length - 1] || '';
	try {
		return normalizeTag(decodeURIComponent(last));
	} catch {
		// A malformed %-escape has no tag in it. Failing closed matters: stripping
		// the escape characters instead would turn `%E0%A4%A` into the plausible
		// tag E0A4A and answer for whichever crew happens to fly it.
		return '';
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const tag = crewTagFromRequest(req);
	if (!tag) return error(res, 400, 'bad_tag', 'invalid crew tag');

	let crew;
	try {
		crew = await getCrewByTag(tag);
	} catch (err) {
		if (isMissingRelation(err)) return error(res, 404, 'not_found', 'no such crew');
		throw err;
	}
	if (!crew) return error(res, 404, 'not_found', 'no such crew');

	const presence = await readPresence(crew.members.map((m) => m.id));
	crew.members = crew.members.map((m) => ({ ...m, ...(presence[m.id] || { online: false, realm: null, server: null }) }));
	return json(res, 200, { data: { crew } });
});
