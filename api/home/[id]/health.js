// GET /api/home/:id/health: is my house all right, and if not, whose fault is it.
//
// The counterpart to the `home` subsystem in /api/healthz. That block is scored
// across tenants so an operator is paged for a correlated outage and never for
// one person's unplugged router. This route is where that one person is told
// what happened to their router, because a failure nobody alerts on still has to
// reach the human it belongs to.
//
// It answers the correlation question from the user's side too. "Are other homes
// failing right now" is the difference between an evening spent power-cycling a
// working access point and a sentence saying we are already on it. Only a count
// and a flag cross the boundary: whose homes, or how many exist, is nobody
// else's business.
//
// Open to a bearer as well as a session, unlike /log. The log is a record of
// when a person was home and which doors opened when; this is coarse counters
// and a reachability verdict, and an agent that can act on a house has a real
// need to ask "am I failing because the house is down".

import { resolveHomeAccess } from '../../_lib/home/access.js';
import { gatherTenantHealth } from '../../_lib/home/health.js';
import { cors, error, json, method, rateLimited, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const access = await resolveHomeAccess(req, res, req.query?.id, 'read');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	const rl = await limits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	const health = await gatherTenantHealth(home);

	// 200 even when the house is down. The house being unreachable is the
	// successful answer to this question, not a failure to answer it; a 503 here
	// would make the panel render its own error state instead of the explanation
	// it was built to show.
	return json(res, 200, { home_id: home.id, health });
});
