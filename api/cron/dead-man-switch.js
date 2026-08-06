// GET /api/cron/dead-man-switch — the inheritance heartbeat.
//
// Runs daily. For every agent with the dead-man's switch enabled it:
//   1. expires stalled recovery requests (and lifts their freeze),
//   2. ARMS an inheritance request when the owner's inactivity has crossed the
//      owner-set threshold (freezes the wallet, notifies all parties, opens the
//      grace + confirmation window) — it never transfers here,
//   3. reminds owners approaching the threshold to tap "I'm here",
//   4. COMPLETES inheritance requests whose grace window elapsed WITH the required
//      confirmation — the only place the switch actually fires, and only after a
//      generous, cancellable window.
//
// Nothing here decrypts or exports a key: an inheritance, like a recovery, only
// changes agent_identities.user_id. Owner activity (a login, a trade, an explicit
// check-in) cancels everything — the switch is always defeatable by being alive.

import { json, method, wrapCron } from '../_lib/http.js';
import { runDeadManSweep } from '../_lib/agent-recovery.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const startedAt = Date.now();
	const summary = await runDeadManSweep();
	const ms = Date.now() - startedAt;
	console.info(`[dead-man] sweep done in ${ms}ms`, summary);
	return json(res, 200, { data: { ...summary, took_ms: ms } });
});
