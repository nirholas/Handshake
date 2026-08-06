// GET/POST /api/cron/oracle-score — serverless driver for the Oracle engine.
//
// The Oracle ships a long-lived worker (workers/oracle) with two loops: a score
// loop that keeps oracle_conviction warm from the data brain, and an agent loop
// that acts on fresh verdicts for every armed watch. This platform deploys on
// Vercel (no host for a long-lived process), so this cron drives the same two
// passes serverlessly — exactly the pattern the intel-learn / smart-money-rollup
// crons use. With it scheduled, the /oracle feed warms up and armed agents act
// without anything else running.
//
// Reuses the worker's real code paths (no duplicated logic):
//   1. runScorePass            — score recent brain coins missing/stale in the cache.
//   2. actOnFreshCoins         — every armed watch acts on the just-scored window.
//   3. runSettlePass           — grade resolved actions against real outcomes.
//   4. alertNewHighConviction  — fire Telegram signals for new prime/strong coins.
//
// Simulate-default and idempotent: scoring upserts by (mint, network); each
// (agent, mint) acts at most once. Live trading only happens when an operator
// sets ORACLE_MODE=live (gated again by a hard per-trade SOL cap in the
// executor) and a watch is itself armed in live mode.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { loadConfig } from '../../workers/oracle/config.js';
import { runScorePass } from '../../workers/oracle/score-loop.js';
import { actOnFreshCoins, freshlyScored } from '../../workers/oracle/agent-loop.js';
import { runSettlePass } from '../../workers/oracle/settle-loop.js';
import { alertNewHighConviction } from '../_lib/oracle/alerts.js';
import { purgeOldHistory, purgeQuoteMints } from '../_lib/oracle/store.js';
import { requireCron } from '../_lib/cron-auth.js';

// How far back the agent pass looks for scored coins. Wider than the cron
// cadence so a missed tick still catches up; the per-(agent,mint) dedup makes
// the overlap harmless.
const AGENT_WINDOW_SEC = 15 * 60;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();

	// loadConfig validates env once and resolves mode/network the same way the
	// worker does — a single source of config truth shared by both deploys.
	let cfg;
	try {
		cfg = loadConfig();
	} catch (e) {
		return error(res, 503, 'not_configured', e.message);
	}

	// 1) Warm the conviction cache from the brain (bounded by ORACLE_SCORE_BATCH).
	const scored = await runScorePass(cfg);

	// 2) Act on a recent window of scored coins for every armed watch. Driven by
	// an explicit window (not the worker's in-memory cursor) so it works across
	// stateless invocations.
	const sinceIso = new Date(Date.now() - AGENT_WINDOW_SEC * 1000).toISOString();
	const coins = await freshlyScored(cfg.network, sinceIso, 100);
	const acted = await actOnFreshCoins(cfg, coins);

	// 3) Close the learning loop: grade any acted-on coin that has since resolved
	// to a ground-truth outcome (graduated / rugged / ATH). Idempotent — only
	// open actions whose outcome is known get settled.
	const settled = await runSettlePass(cfg);

	// 4) Fire Telegram signals for any coins in this window that newly crossed
	// prime/strong threshold and haven't been alerted before. Fire-and-forget
	// inside the alert module — never delays or fails this cron response.
	// We pass the full coin objects from freshlyScored (score, tier, pillars
	// are all present in oracle_conviction rows).
	const alerted = await alertNewHighConviction(coins, cfg.network);

	// 5) Prune conviction history older than 72 hours — fire-and-forget so a
	// slow delete never extends the cron response time.
	purgeOldHistory(cfg.network).catch(() => {});

	// 6) Self-heal: evict any quote/stablecoin/LST mints (USDC, USDT, wSOL, …)
	// cached before the ingestion guard existed. Fire-and-forget.
	purgeQuoteMints(cfg.network).catch(() => {});

	return json(res, 200, {
		ok: true,
		network: cfg.network,
		mode: cfg.mode,
		global_kill: cfg.globalKill,
		scored,
		window_coins: coins.length,
		acted,
		settled,
		alerted,
		ms: Date.now() - started,
	});
});
