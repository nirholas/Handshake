// GET /api/cron/arena-tick - the heartbeat of the Social Trading Arena.
//
// Before this existed, nothing in the codebase advanced a tournament's
// lifecycle. Rows were created by hand, ranked live while their window was
// open, and then sat at 'ended' forever: never frozen, never attested, never
// paid. And because the route only ever showed what a human had created, the
// live Arena was one stale card. Both problems are lifecycle problems, so they
// are fixed in one place.
//
// Each tick:
//   1. ensures today's house arena is live and tomorrow's is queued
//   2. enters every agent with a real trading mandate into the live one
//   3. finalizes, attests and settles every window the clock has closed
//      (user-created tournaments included, which is the half nobody ran)
//
// Every stage reports honestly and independently; a failure in one is recorded
// in the response and does not starve the others. Idempotent by construction,
// so the 5-minute cadence is a safety net rather than a requirement.

import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { arenaTick } from '../_lib/arena-house.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const summary = await arenaTick({ network: 'mainnet', now: Date.now() });
	return json(res, 200, { ok: true, ...summary }, { 'cache-control': 'no-store' });
});
