// GET/POST /api/cron/radar-watchlist — recurate the Pre-Launch Radar watchlist.
//
// The radar worker (workers/agent-sniper/prelaunch-radar.js) recurates its own
// watchlist on an interval, but that only runs when the worker is up. This cron
// keeps radar_watchlist fresh independently — from the SAME real sources (proven
// creators via pump_coin_intel ⋈ pump_coin_outcomes, top smart_wallet_reputation
// wallets) — so the Radar UI always has a current, honest watchlist even when the
// worker is in simulate mode, paused, or between deploys.
//
// Idempotent + bounded. Mainnet-only (pump.fun). Reads the graph, writes only the
// radar's own table.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { recomputeWatchlist } from '../../workers/agent-sniper/radar-watchlist.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORK = 'mainnet';

// The worker's config defaults — mirrored here so the cron curates with the same
// thresholds the radar uses. Env overrides apply in both places.
function radarCfg() {
	const num = (name, def) => {
		const v = Number(process.env[name]);
		return Number.isFinite(v) ? v : def;
	};
	return {
		radarMinCreatorGraduated: Math.max(1, num('SNIPER_RADAR_MIN_GRADUATED', 2)),
		radarSmartMoneyMinScore: Math.max(0, Math.min(100, num('SNIPER_RADAR_SM_MIN_SCORE', 70))),
		radarMaxWatch: Math.max(20, num('SNIPER_RADAR_MAX_WATCH', 500)),
		radarWatchlistRefreshMs: Math.max(60_000, num('SNIPER_RADAR_WATCHLIST_REFRESH_MS', 300_000)),
	};
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	const result = await recomputeWatchlist({ network: NETWORK, cfg: radarCfg() });

	return json(res, 200, {
		ok: result.ok,
		watched: result.watched,
		creators: result.creators,
		smartMoney: result.smartMoney,
		evicted: result.evicted,
		reason: result.reason || null,
		ms: Date.now() - started,
	});
});
