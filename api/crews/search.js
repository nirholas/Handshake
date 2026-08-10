// GET /api/crews/search?q=<term>
// Find accounts to invite to my crew. Each hit is annotated with what the
// inviter needs to decide before clicking: the crew they already belong to (a
// person can only be in one, so inviting them would fail) and whether my crew
// already has an invite out to them. The Crew HQ renders those as a disabled
// row with the real reason instead of letting the click 409.
//
// Auth required, and the caller must be in a crew. Searching people to invite
// when you have no crew to invite them to is a dead path, so it is closed here
// rather than rendered and then rejected on submit.

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { getMyCrew, searchInvitees, isMissingRelation } from '../_lib/crews-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await resolveAccount(req, res);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	// A search term is a UI input, not a payload: bound it at the boundary so a
	// pathological query string can never reach the store as a giant ILIKE pattern.
	const q = (url.searchParams.get('q') || '').slice(0, 64);

	try {
		const crew = await getMyCrew(auth.userId);
		if (!crew) return error(res, 400, 'no_crew', 'found or join a crew before inviting');
		// Hand the crew we just resolved to the store rather than letting it look the
		// same row up again: this endpoint runs on every keystroke of the invite box.
		return json(res, 200, { data: { results: await searchInvitees(auth.userId, q, { crew }) } });
	} catch (err) {
		if (isMissingRelation(err)) return json(res, 200, { data: { results: [] } });
		throw err;
	}
});
