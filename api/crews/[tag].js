// GET /api/crews/:tag
// Public view of a crew by its tag: identity + roster (public profile subset) +
// live presence per member. Used by the inspect card's crew link and any crew
// landing surface. Auth-optional — a crew roster is public, like the agent
// gallery, but never leaks private member state (handled in crews-store).

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { readPresence } from '../_lib/presence-store.js';
import { getCrewByTag, normalizeTag, isMissingRelation } from '../_lib/crews-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const raw = url.searchParams.get('tag') || url.pathname.split('/').pop() || '';
	const tag = normalizeTag(decodeURIComponent(raw));
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
