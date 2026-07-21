// GET/POST /api/cron/oracle-realized-labels (Bridge 1): give the Oracle real
// money to learn from.
//
// The Oracle/intel learner (workers/agent-sniper/intel/learn.js) trains its
// signal weights on coarse chart labels: a coin "won" if it hit ATH >= 3x at any
// point (pump_coin_outcomes). But a coin can spike 3x and the sniper still LOSE
// (bought late, timed-out exit). The fleet's REALIZED entry->exit PnL is scarcer
// but far higher-fidelity ground truth.
//
// This cron derives, per mint the fleet actually traded, the realized result
// (net win/loss + avg PnL%) from agent_sniper_positions and upserts it into
// oracle_realized_outcomes. trainWeights LEFT JOINs that table and PREFERS the
// realized label when present, so Oracle learns what actually makes money. A
// closed trade's PnL never changes, so re-deriving is cheap and idempotent.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) { error(res, 401, 'unauthorized', 'invalid cron secret'); return false; }
	return true;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const network = 'mainnet';
	const rows = await sql`
		insert into oracle_realized_outcomes (mint, network, realized_win, realized_pnl_pct, samples)
		select p.mint, p.network,
			case when sum(p.realized_pnl_lamports) > 0 then 1 else 0 end,
			round(avg(p.realized_pnl_pct)::numeric, 4),
			count(*)
		from agent_sniper_positions p
		where p.network = ${network}
		  and p.status = 'closed' and p.buy_sig <> 'SIMULATED'
		  and p.realized_pnl_lamports is not null
		group by p.mint, p.network
		on conflict (mint, network) do update set
			realized_win = excluded.realized_win,
			realized_pnl_pct = excluded.realized_pnl_pct,
			samples = excluded.samples,
			updated_at = now()
		returning mint, realized_win
	`;

	const wins = rows.filter((r) => Number(r.realized_win) === 1).length;
	return json(res, 200, { ok: true, labeled: rows.length, wins, losses: rows.length - wins });
});
