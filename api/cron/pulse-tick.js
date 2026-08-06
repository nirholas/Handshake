// @ts-check
// GET/POST /api/cron/pulse-tick — drives one tick of the autonomous agent
// activity engine (api/_lib/circulation.js). Fully inert unless CIRCULATION_ENABLED
// is set and a treasury secret is configured; in that case it grows the operated
// agent pool and has those agents transact with one another on-chain, so the live
// money feed reflects real wallet activity.

import { json, method, wrapCron } from '../_lib/http.js';
import { runCirculationTick } from '../_lib/circulation.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const out = await runCirculationTick();
	return json(res, 200, out);
});
