// GET /api/cron/strategy-fanout — drive the Strategy Object runtime.
//
// For every active equip (a strategy bound to an agent), evaluate REAL pump.fun
// launches against the entry rules and manage open positions (re-quote, take-profit
// / stop-loss / trailing / timeout), executing every action through the task-05
// engine inside the agent's spend policy (api/_lib/agent-strategy-runtime.js).
//
// Idempotent end to end: the agent_strategy_positions unique (agent,mint,network)
// index and the custody idempotency key both prevent double-entry / double-spend,
// so re-running this cron (or overlapping with an owner "Run now") is always safe.
// The per-owner global kill switch halts all of an owner's strategies at once;
// exits still mark-to-market while killed but never initiate a trade.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { sweepStrategies } from '../_lib/agent-strategy-runtime.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORKS = ['mainnet', 'devnet'];

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const out = {};
	for (const network of NETWORKS) {
		try {
			out[network] = await sweepStrategies({ network, maxEquips: 200, maxEntriesPerEquip: 3 });
		} catch (err) {
			out[network] = { error: (err?.message || 'error').slice(0, 160) };
		}
	}
	return json(res, 200, { ok: true, ...out });
});
