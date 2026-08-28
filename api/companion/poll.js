// POST /api/companion/poll - "check now" for every connected source.
//
// The cron already sweeps on a schedule (api/cron/companion-poll.js); this is
// the button on the setup page, so a user who just connected something sees it
// work in the same breath rather than waiting for the next tick.

import { getRequestUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { pollUser } from '../_lib/companion/poll.js';

export const maxDuration = 60;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.companionPoll(user.id);
	if (!rl.success) return rateLimited(res, rl);

	return json(res, 200, await pollUser(user.id));
});
