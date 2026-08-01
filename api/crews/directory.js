// GET /api/crews/directory?limit=24
// The public crew directory: every crew that has members, biggest first. This
// is what a visitor with no crew sees: somewhere to look before deciding to
// found one, and the only way a crew is discoverable without knowing its tag.
//
// Public and cacheable: a roster is public exactly like the agent gallery, and
// nothing here is caller-specific, so it answers for anonymous visitors too.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { listCrewDirectory, isMissingRelation } from '../_lib/crews-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const limit = Number(url.searchParams.get('limit')) || 24;

	let crews;
	try {
		crews = await listCrewDirectory(limit);
	} catch (err) {
		// Before the crews migration lands there are no crews, which is an empty
		// directory rather than an outage.
		if (isMissingRelation(err)) crews = [];
		else throw err;
	}

	res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { data: { crews } });
});
