// GET /api/cron/smart-money-rollup — build the pump.fun wallet reputation graph.
//
// The Smart Money Radar's engine. Three phases, all first-party — no external
// price oracle:
//
//   A. JUDGE & FOLD. Take coins old enough to judge that we haven't scored yet.
//      Outcome is unambiguous: in pumpfun_graduations → 'graduated' (a win),
//      else 'dud'. Fold every buyer's footprint on that coin into its running
//      reputation record. Each coin is folded exactly once (smart_money_scored).
//   B. RECOMPUTE. Re-derive score + label for every wallet we just touched.
//   C. SCORE LIVE. For coins launched in the last few hours, rank them by the
//      pedigree of the money buying them right now (coin_smart_money) — that is
//      what the radar feed and a follow-the-smart-money sniper read.
//
// Reads the engine's tables (pump_coin_intel / pump_coin_wallets) and the
// graduation feed read-only; writes only this system's own tables. Mainnet-only
// (pump_coin_wallets / pumpfun_graduations are mainnet). Idempotent + bounded so
// a 5-minute cron can never run away.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { attributeCoin, computeReputation } from '../../src/pump/wallet-reputation.js';
import { computeCoinSmartMoney } from '../../src/pump/smart-money-score.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORK = 'mainnet';
const JUDGE_AFTER_HOURS = 6; // a coin must be this old before "never graduated" = dud
const MAX_AGE_DAYS = 14; // don't reach back further than this
const COINS_PER_RUN = 80; // judge+fold at most this many coins per run
const TOP_WALLETS = 60; // per coin, cap wallets folded/scored
const LIVE_WINDOW_HOURS = 3; // score coins launched within this window
const LIVE_COINS = 150;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	const folded = await judgeAndFold();
	const recomputed = await recomputeTouched(folded.touchedWallets);
	const live = await scoreLiveCoins();

	return json(res, 200, {
		ok: true,
		network: NETWORK,
		coins_judged: folded.coinsJudged,
		graduates: folded.graduates,
		wallets_touched: folded.touchedWallets.length,
		wallets_recomputed: recomputed,
		live_coins_scored: live.scored,
		smart_money_coins: live.withSmartMoney,
		remaining_unjudged: folded.remaining,
		took_ms: Date.now() - started,
	});
}, { requireWriteCapacity: true });

// ── Phase A: judge newly-rated coins and fold buyers into reputation ─────────
async function judgeAndFold() {
	const candidates = await sql`
		SELECT i.mint, extract(epoch from i.first_seen_at)::bigint AS first_ts
		FROM pump_coin_intel i
		WHERE i.network = ${NETWORK}
		  AND i.first_seen_at < now() - ${JUDGE_AFTER_HOURS} * interval '1 hour'
		  AND i.first_seen_at > now() - ${MAX_AGE_DAYS} * interval '1 day'
		  AND NOT EXISTS (
		      SELECT 1 FROM smart_money_scored s
		      WHERE s.mint = i.mint AND s.network = ${NETWORK}
		  )
		ORDER BY i.first_seen_at ASC
		LIMIT ${COINS_PER_RUN}
	`;
	if (!candidates.length) {
		return { coinsJudged: 0, graduates: 0, touchedWallets: [], remaining: 0 };
	}

	const mints = candidates.map((c) => c.mint);
	const gradRows = await sql`SELECT mint FROM pumpfun_graduations WHERE mint = ANY(${mints})`;
	const graduated = new Set(gradRows.map((r) => r.mint));

	// wallet → accumulated delta across every coin in this run.
	const deltas = new Map();
	const bump = (wallet, d) => {
		const cur = deltas.get(wallet) || zeroDelta();
		for (const k of DELTA_KEYS) cur[k] += d[k];
		deltas.set(wallet, cur);
	};

	// Top buyers (by buy_lamports) for every candidate coin in one round trip,
	// window-limited to TOP_WALLETS per mint — replaces a per-coin query.
	const walletRows = await sql`
		SELECT mint, wallet, buy_lamports, sell_lamports, is_creator, first_ts FROM (
			SELECT mint, wallet, buy_lamports, sell_lamports, is_creator,
			       extract(epoch from first_seen_at)::bigint AS first_ts,
			       row_number() OVER (PARTITION BY mint ORDER BY buy_lamports DESC) AS rn
			FROM pump_coin_wallets
			WHERE mint = ANY(${mints})
		) t WHERE rn <= ${TOP_WALLETS}
	`;
	const walletsByCoin = new Map();
	for (const w of walletRows) {
		if (!walletsByCoin.has(w.mint)) walletsByCoin.set(w.mint, []);
		walletsByCoin.get(w.mint).push(w);
	}

	for (const coin of candidates) {
		const outcome = graduated.has(coin.mint) ? 'graduated' : 'dud';
		const wallets = walletsByCoin.get(coin.mint) || [];
		for (const w of wallets) {
			const d = attributeCoin({
				outcome,
				wallet: {
					buy_lamports: Number(w.buy_lamports),
					sell_lamports: Number(w.sell_lamports),
					first_seen_ts: Number(w.first_ts),
					is_creator: w.is_creator,
				},
				coinFirstSeenTs: Number(coin.first_ts),
			});
			bump(w.wallet, d);
		}
	}

	if (deltas.size) {
		const wallets = [...deltas.keys()];
		const cols = Object.fromEntries(DELTA_KEYS.map((k) => [k, wallets.map((w) => deltas.get(w)[k])]));
		await sql`
			INSERT INTO wallet_reputation
				(wallet, network, coins_traded, early_entries, wins, early_wins, duds, dumps,
				 creator_count, creator_wins, buy_volume_lamports, last_active_at, updated_at)
			SELECT u.wallet, ${NETWORK}, u.coins_traded, u.early_entries, u.wins, u.early_wins, u.duds, u.dumps,
			       u.creator_count, u.creator_wins, u.buy_volume_lamports, now(), now()
			FROM unnest(
				${wallets}::text[],
				${cols.coins_traded}::int[],
				${cols.early_entries}::int[],
				${cols.wins}::int[],
				${cols.early_wins}::int[],
				${cols.duds}::int[],
				${cols.dumps}::int[],
				${cols.creator_count}::int[],
				${cols.creator_wins}::int[],
				${cols.buy_volume_lamports.map(String)}::numeric[]
			) AS u(wallet, coins_traded, early_entries, wins, early_wins, duds, dumps,
			       creator_count, creator_wins, buy_volume_lamports)
			ON CONFLICT (wallet, network) DO UPDATE SET
				coins_traded        = wallet_reputation.coins_traded + EXCLUDED.coins_traded,
				early_entries       = wallet_reputation.early_entries + EXCLUDED.early_entries,
				wins                = wallet_reputation.wins + EXCLUDED.wins,
				early_wins          = wallet_reputation.early_wins + EXCLUDED.early_wins,
				duds                = wallet_reputation.duds + EXCLUDED.duds,
				dumps               = wallet_reputation.dumps + EXCLUDED.dumps,
				creator_count       = wallet_reputation.creator_count + EXCLUDED.creator_count,
				creator_wins        = wallet_reputation.creator_wins + EXCLUDED.creator_wins,
				buy_volume_lamports = wallet_reputation.buy_volume_lamports + EXCLUDED.buy_volume_lamports,
				last_active_at      = now(),
				updated_at          = now()
		`;
	}

	// Mark every judged coin scored so it's never folded twice.
	const outcomes = candidates.map((c) => (graduated.has(c.mint) ? 'graduated' : 'dud'));
	await sql`
		INSERT INTO smart_money_scored (mint, network, outcome)
		SELECT u.mint, ${NETWORK}, u.outcome
		FROM unnest(${mints}::text[], ${outcomes}::text[]) AS u(mint, outcome)
		ON CONFLICT (mint, network) DO NOTHING
	`;

	const [{ remaining }] = await sql`
		SELECT count(*)::int AS remaining
		FROM pump_coin_intel i
		WHERE i.network = ${NETWORK}
		  AND i.first_seen_at < now() - ${JUDGE_AFTER_HOURS} * interval '1 hour'
		  AND i.first_seen_at > now() - ${MAX_AGE_DAYS} * interval '1 day'
		  AND NOT EXISTS (SELECT 1 FROM smart_money_scored s WHERE s.mint = i.mint AND s.network = ${NETWORK})
	`;

	return {
		coinsJudged: candidates.length,
		graduates: graduated.size,
		touchedWallets: [...deltas.keys()],
		remaining: Number(remaining) || 0,
	};
}

// ── Phase B: recompute score + label for the wallets we just touched ─────────
async function recomputeTouched(touched) {
	if (!touched.length) return 0;
	const rows = await sql`
		SELECT wallet, wins, duds, early_entries, early_wins, dumps, coins_traded,
		       creator_count, creator_wins
		FROM wallet_reputation
		WHERE network = ${NETWORK} AND wallet = ANY(${touched})
	`;
	if (!rows.length) return 0;

	const wallets = [];
	const winRate = [];
	const earlyWinRate = [];
	const dumpRate = [];
	const score = [];
	const label = [];
	for (const r of rows) {
		const rep = computeReputation(r);
		wallets.push(r.wallet);
		winRate.push(rep.win_rate);
		earlyWinRate.push(rep.early_win_rate);
		dumpRate.push(rep.dump_rate);
		score.push(rep.smart_money_score);
		label.push(rep.label);
	}
	await sql`
		UPDATE wallet_reputation w SET
			win_rate          = u.win_rate,
			early_win_rate    = u.early_win_rate,
			dump_rate         = u.dump_rate,
			smart_money_score = u.score,
			label             = u.label,
			updated_at        = now()
		FROM unnest(
			${wallets}::text[],
			${winRate}::numeric[],
			${earlyWinRate}::numeric[],
			${dumpRate}::numeric[],
			${score}::numeric[],
			${label}::text[]
		) AS u(wallet, win_rate, early_win_rate, dump_rate, score, label)
		WHERE w.wallet = u.wallet AND w.network = ${NETWORK}
	`;
	return rows.length;
}

// ── Phase C: score the coins trading right now by their buyers' pedigree ─────
async function scoreLiveCoins() {
	const coins = await sql`
		SELECT mint, symbol, name, image_uri, category, first_seen_at
		FROM pump_coin_intel
		WHERE network = ${NETWORK} AND first_seen_at > now() - ${LIVE_WINDOW_HOURS} * interval '1 hour'
		ORDER BY first_seen_at DESC
		LIMIT ${LIVE_COINS}
	`;
	if (!coins.length) return { scored: 0, withSmartMoney: 0 };

	const mints = coins.map((c) => c.mint);
	// Top buyers per coin in one round trip (window-limited).
	const walletRows = await sql`
		SELECT mint, wallet, buy_lamports, is_creator FROM (
			SELECT mint, wallet, buy_lamports, is_creator,
			       row_number() OVER (PARTITION BY mint ORDER BY buy_lamports DESC) AS rn
			FROM pump_coin_wallets
			WHERE mint = ANY(${mints}) AND buy_lamports > 0
		) t WHERE rn <= ${TOP_WALLETS}
	`;
	const gradRows = await sql`SELECT mint FROM pumpfun_graduations WHERE mint = ANY(${mints})`;
	const graduated = new Set(gradRows.map((r) => r.mint));

	const byCoin = new Map();
	const allWallets = new Set();
	for (const r of walletRows) {
		if (!byCoin.has(r.mint)) byCoin.set(r.mint, []);
		byCoin.get(r.mint).push({ wallet: r.wallet, buy_lamports: Number(r.buy_lamports), is_creator: r.is_creator });
		allWallets.add(r.wallet);
	}

	const repMap = new Map();
	if (allWallets.size) {
		const repRows = await sql`
			SELECT wallet, smart_money_score, label
			FROM wallet_reputation
			WHERE network = ${NETWORK} AND wallet = ANY(${[...allWallets]})
		`;
		for (const r of repRows) repMap.set(r.wallet, { smart_money_score: Number(r.smart_money_score), label: r.label });
	}

	const out = {
		mint: [], symbol: [], name: [], image: [], category: [],
		score: [], smartCount: [], provenBuy: [], totalBuy: [], notable: [], firstSeen: [], grad: [],
	};
	let withSmartMoney = 0;
	for (const coin of coins) {
		const wallets = byCoin.get(coin.mint) || [];
		const r = computeCoinSmartMoney(wallets, repMap);
		if (r.smart_wallet_count > 0) withSmartMoney++;
		out.mint.push(coin.mint);
		out.symbol.push(coin.symbol || null);
		out.name.push(coin.name || null);
		out.image.push(coin.image_uri || null);
		out.category.push(coin.category || null);
		out.score.push(r.smart_money_score);
		out.smartCount.push(r.smart_wallet_count);
		out.provenBuy.push(String(r.proven_buy_lamports));
		out.totalBuy.push(String(r.total_buy_lamports));
		out.notable.push(JSON.stringify(r.notable));
		out.firstSeen.push(coin.first_seen_at ? new Date(coin.first_seen_at).toISOString() : null);
		out.grad.push(graduated.has(coin.mint));
	}

	await sql`
		INSERT INTO coin_smart_money
			(mint, network, symbol, name, image_uri, category, smart_money_score, smart_wallet_count,
			 proven_buy_lamports, total_buy_lamports, notable, coin_first_seen_at, graduated, scored_at)
		SELECT u.mint, ${NETWORK}, u.symbol, u.name, u.image, u.category, u.score, u.smart_count,
		       u.proven_buy, u.total_buy, u.notable::jsonb, u.first_seen, u.grad, now()
		FROM unnest(
			${out.mint}::text[],
			${out.symbol}::text[],
			${out.name}::text[],
			${out.image}::text[],
			${out.category}::text[],
			${out.score}::numeric[],
			${out.smartCount}::int[],
			${out.provenBuy}::numeric[],
			${out.totalBuy}::numeric[],
			${out.notable}::text[],
			${out.firstSeen}::timestamptz[],
			${out.grad}::boolean[]
		) AS u(mint, symbol, name, image, category, score, smart_count,
		       proven_buy, total_buy, notable, first_seen, grad)
		ON CONFLICT (mint, network) DO UPDATE SET
			symbol              = EXCLUDED.symbol,
			name                = EXCLUDED.name,
			image_uri           = EXCLUDED.image_uri,
			category            = EXCLUDED.category,
			smart_money_score   = EXCLUDED.smart_money_score,
			smart_wallet_count  = EXCLUDED.smart_wallet_count,
			proven_buy_lamports = EXCLUDED.proven_buy_lamports,
			total_buy_lamports  = EXCLUDED.total_buy_lamports,
			notable             = EXCLUDED.notable,
			graduated           = EXCLUDED.graduated,
			scored_at           = now()
	`;

	return { scored: coins.length, withSmartMoney };
}

// ── delta bookkeeping ────────────────────────────────────────────────────────
const DELTA_KEYS = [
	'coins_traded', 'early_entries', 'wins', 'early_wins', 'duds', 'dumps',
	'creator_count', 'creator_wins', 'buy_volume_lamports',
];
function zeroDelta() {
	const d = {};
	for (const k of DELTA_KEYS) d[k] = 0;
	return d;
}
