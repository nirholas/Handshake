/**
 * Oracle — global platform conviction stats.
 *
 *   GET /api/oracle/stats?network=mainnet
 *
 * Returns a fast summary of the oracle engine's current state:
 *   scored_24h       — coins scored in the last 24 h
 *   scored_total     — all-time scored coins, from the durable oracle_counters
 *                      ledger (oracle_conviction itself is retention-pruned, so
 *                      its row count is a rolling window, not a lifetime figure)
 *   prime_count      — coins currently sitting at prime tier (score ≥ 86)
 *   strong_count     — coins at strong tier
 *
 * Two win-rate scopes, kept deliberately separate so the dashboard can never
 * pass the market's base rate off as the engine's skill:
 *   win_rate / total_wins / total_resolved / best_ath
 *       — CALLS ONLY: resolved coins the oracle actually called (tier lean,
 *         strong, or prime). Null/0 until real calls resolve — that is the
 *         honest state, not a bug.
 *   market_base_rate / market_wins / market_resolved / market_best_ath
 *       — every scored coin with an outcome, i.e. what a blind buyer of every
 *         pump.fun launch would experience. This is the baseline the calls
 *         must beat.
 * A "win" is graduation, or a ≥2× ATH on a coin that did NOT rug — a coin that
 * spiked 2× and collapsed is not a win anyone could bank.
 *
 *   open_actions   — oracle_watch_actions rows still open (not yet settled)
 *   agents_armed   — distinct agent_ids currently armed (armed = true)
 *
 * Public, no auth, aggressively cached (60s). Used by the dashboard
 * overview card and the oracle landing-page hero.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { QUOTE_MINT_LIST } from '../_lib/quote-mints.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params  = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';

	const [convRow, actRow, outcomeRow, armedRow, counterRow] = await Promise.all([
		// Conviction table summary.
		sql`
			select
				count(*)                                                                   as scored_total,
				count(*) filter (where scored_at >= now() - interval '24 hours')           as scored_24h,
				count(*) filter (where tier = 'prime')                                     as prime_count,
				count(*) filter (where tier = 'strong')                                    as strong_count
			from oracle_conviction
			where network = ${network}
			  and mint <> all(${QUOTE_MINT_LIST}::text[])
		`.catch(() => [{}]),

		// Open oracle_watch_actions (not yet settled).
		sql`
			select count(*) as open_actions
			from oracle_watch_actions
			where network = ${network}
			  and outcome = 'open'
		`.catch(() => [{}]),

		// Outcome win-rates, both scopes in one pass. "Calls" = lean/strong/prime —
		// the tiers the oracle actually tells people to act on. Everything else it
		// scored is the market baseline. Win = graduated OR (ath ≥ 2 AND not rugged);
		// keep this definition in sync with backtest.js and wins.js.
		sql`
			select
				count(*) filter (where c.tier in ('prime','strong','lean'))                as total_resolved,
				count(*) filter (where c.tier in ('prime','strong','lean')
					and (o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))) as total_wins,
				round((max(o.ath_multiple) filter (where c.tier in ('prime','strong','lean')))::numeric, 2) as best_ath,
				count(*)                                                                    as market_resolved,
				count(*) filter (where o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false))) as market_wins,
				round(max(o.ath_multiple)::numeric, 2)                                      as market_best_ath
			from oracle_conviction c
			join pump_coin_outcomes o on o.mint = c.mint
			where c.network = ${network}
			  and (o.graduated or o.rugged or o.ath_multiple is not null)
			  and c.mint <> all(${QUOTE_MINT_LIST}::text[])
		`.catch(() => [{}]),

		// Distinct armed agents.
		sql`
			select count(distinct agent_id) as agents_armed
			from oracle_agent_watch
			where network = ${network}
			  and armed = true
		`.catch(() => [{}]),

		// Durable lifetime scored counter. oracle_conviction is retention-pruned
		// (db-retention firehose family), so its count(*) is a rolling-window
		// figure — this counter is the real all-time number.
		sql`
			select value as scored_lifetime
			from oracle_counters
			where network = ${network} and key = 'scored_lifetime'
		`.catch(() => [{}]),
	]);

	const c  = convRow[0]    || {};
	const a  = actRow[0]     || {};
	const o  = outcomeRow[0] || {};
	const ar = armedRow[0]   || {};
	const ct = counterRow[0] || {};

	// The counter can briefly trail the live cache (rows seeded before the
	// counter existed, counter write races) — the true lifetime figure is never
	// smaller than what is sitting in the cache right now.
	const scoredTotal = Math.max(Number(ct.scored_lifetime) || 0, Number(c.scored_total) || 0);

	const totalResolved  = Number(o.total_resolved)  || 0;
	const totalWins      = Number(o.total_wins)      || 0;
	const winRate        = totalResolved > 0 ? Math.round((totalWins / totalResolved) * 100) : null;
	const marketResolved = Number(o.market_resolved) || 0;
	const marketWins     = Number(o.market_wins)     || 0;
	const marketBaseRate = marketResolved > 0 ? Math.round((marketWins / marketResolved) * 100) : null;

	return json(res, 200, {
		network,
		scored_24h:       Number(c.scored_24h)    || 0,
		scored_total:     scoredTotal,
		prime_count:      Number(c.prime_count)   || 0,
		strong_count:     Number(c.strong_count)  || 0,
		open_actions:     Number(a.open_actions)  || 0,
		total_resolved:   totalResolved,
		total_wins:       totalWins,
		win_rate:         winRate,
		best_ath:         o.best_ath != null ? Number(o.best_ath) : null,
		market_resolved:  marketResolved,
		market_wins:      marketWins,
		market_base_rate: marketBaseRate,
		market_best_ath:  o.market_best_ath != null ? Number(o.market_best_ath) : null,
		agents_armed:     Number(ar.agents_armed) || 0,
	}, {
		'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=120',
	});
});
