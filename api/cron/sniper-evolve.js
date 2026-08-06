// GET/POST /api/cron/sniper-evolve: the autonomous PORTFOLIO layer of the sniper
// fleet's self-improvement loop. On a schedule it scores every labeled arm's
// fitness against the ground-truth base rate (what fraction of launches actually
// win) and mutates the fleet's ALLOCATION: reallocate the fixed daily budget
// toward higher-fitness arms, retire an arm proven worse than a coin flip, revive
// a retired arm after a cooldown to re-test it.
//
// It is the complement to the intra-arm optimizer (api/cron/sniper-optimize.js):
// evolve moves budget/on-off across arms and never touches a per-arm entry/exit
// knob; the optimizer tunes each arm's knobs inward and never moves budget.
// Neither can write a safety field. The shared engine lives in
// scripts/sniper-evolve.mjs (runEvolve), the single source of truth for both the
// CLI and this cron.
//
// Controls:
//   SNIPER_EVOLVE_APPLY = 1   enact mutations (default: dry-run, log only)
//   plus the EVOLVE_* tunables read by runEvolve (fleet budget, floors, samples).

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { runEvolve } from '../../scripts/sniper-evolve.mjs';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const apply = String(process.env.SNIPER_EVOLVE_APPLY || '') === '1';
	const lines = [];
	try {
		const result = await runEvolve({ apply, log: (m) => lines.push(String(m)) });
		return json(res, 200, {
			ok: true,
			mode: apply ? 'apply' : 'dry-run',
			run_id: result.runId,
			base_rate: result.baseRate,
			active_arms: result.activeArms,
			proposals: result.proposals.map((p) => ({ action: p.action, label: p.label, field: p.field, before: p.before, after: p.after })),
			applied: result.applied,
		});
	} catch (err) {
		return json(res, 200, { ok: false, error: err.message, log: lines.slice(-8) });
	}
});
