// @ts-check
// GET/POST /api/cron/launcher-tick — drives one tick of the autonomous coin
// launcher engine (api/_lib/launcher-engine.js). The seeded global row ships LIVE
// (enabled, real, with a standing dev buy), so pool agents mint pump.fun coins
// riding live cultural narratives on a cadence — the same real on-chain path a
// human owner uses. Still inert for any scope whose launcher_config row is
// disabled, and bounded by per-launch/daily SOL caps, an hourly ceiling, the
// cadence gate, and the circuit breaker. With no master wallet funded, each tick
// records a clean 'skipped' run instead of minting.

import { json, method, wrapCron } from '../_lib/http.js';
import { runLauncherTick } from '../_lib/launcher-engine.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const out = await runLauncherTick();
	return json(res, 200, out);
}, { requireWriteCapacity: true });
