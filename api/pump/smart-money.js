/**
 * Smart Money Radar — public read API.
 *
 *   GET /api/pump/smart-money                       → live feed: coins ranked by
 *       &min_score=20&limit=50&graduated=0            the pedigree of money in them
 *   GET /api/pump/smart-money?leaderboard=1          → top wallets by track record
 *       &label=smart_money&min_coins=8&limit=50
 *   GET /api/pump/smart-money?wallet=<addr>          → one wallet's reputation card
 *   GET /api/pump/smart-money?mint=<addr>            → one coin: who's in it + score
 *       (a coin the rollup has not scored resolves 200 + found:false, matching
 *        the intel / launch-detail convention, so detail pages never 404)
 *
 * The edge: judge a coin by WHO is buying it. The rollup cron
 * (api/cron/smart-money-rollup) crosses every coin's per-wallet footprint with
 * which coins actually graduated, building a real track record for each wallet —
 * then scores live coins by how much proven money is accumulating them. Public +
 * IP rate-limited. Every number traces to trades we observed and graduations we
 * recorded on-chain.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORK = 'mainnet';
const lamportsToSol = (v) => (v == null ? 0 : Math.round((Number(BigInt(v)) / 1e9) * 1000) / 1000);
const numOr = (v, d = 0) => (v == null ? d : Number(v));

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const wallet = url.searchParams.get('wallet');
	const mint = url.searchParams.get('mint');

	if (wallet) return walletCard(res, wallet.trim());
	if (mint) return coinDetail(res, mint.trim());
	if (url.searchParams.has('leaderboard')) return leaderboard(res, url);
	return feed(res, url);
});

// ── live feed: what the smart money is buying right now ──────────────────────
async function feed(res, url) {
	const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
	const minScore = clampNum(url.searchParams.get('min_score'), 0, 100, 0);
	const includeGraduated = ['1', 'true'].includes(String(url.searchParams.get('graduated')));

	const rows = await sql`
		SELECT mint, symbol, name, image_uri, category, smart_money_score, smart_wallet_count,
		       proven_buy_lamports, total_buy_lamports, notable, coin_first_seen_at, graduated, scored_at
		FROM coin_smart_money
		WHERE network = ${NETWORK}
		  AND smart_money_score >= ${minScore}
		  AND (${includeGraduated} OR graduated = false)
		  AND scored_at > now() - interval '6 hours'
		ORDER BY smart_money_score DESC, scored_at DESC
		LIMIT ${limit}
	`;
	return json(
		res,
		200,
		{ coins: rows.map(shapeCoin) },
		{ 'cache-control': 'public, max-age=15, stale-while-revalidate=30' },
	);
}

// ── leaderboard: the proven wallets ──────────────────────────────────────────
async function leaderboard(res, url) {
	const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
	const minCoins = clampInt(url.searchParams.get('min_coins'), 0, 1000, 4);
	const label = url.searchParams.get('label');
	const labelFilter = ['smart_money', 'sniper', 'dumper', 'rugger', 'fresh', 'neutral'].includes(label)
		? label
		: null;

	const rows = await sql`
		SELECT wallet, smart_money_score, label, win_rate, early_win_rate, dump_rate,
		       coins_traded, early_entries, wins, duds, dumps, creator_count, creator_wins,
		       buy_volume_lamports, last_active_at
		FROM wallet_reputation
		WHERE network = ${NETWORK}
		  AND (wins + duds) >= ${minCoins}
		  AND (${labelFilter}::text IS NULL OR label = ${labelFilter})
		ORDER BY smart_money_score DESC, wins DESC
		LIMIT ${limit}
	`;
	return json(
		res,
		200,
		{ wallets: rows.map(shapeWallet) },
		{ 'cache-control': 'public, max-age=30, stale-while-revalidate=60' },
	);
}

// ── one wallet's card + its recent coins ─────────────────────────────────────
async function walletCard(res, wallet) {
	const [rep] = await sql`
		SELECT wallet, smart_money_score, label, win_rate, early_win_rate, dump_rate,
		       coins_traded, early_entries, wins, duds, dumps, creator_count, creator_wins,
		       buy_volume_lamports, first_seen_at, last_active_at
		FROM wallet_reputation
		WHERE network = ${NETWORK} AND wallet = ${wallet}
		LIMIT 1
	`;
	if (!rep) return json(res, 404, { error: 'not_found', message: 'no track record for this wallet yet' });

	// Recent coins this wallet bought, with their outcome (graduated?) and metadata.
	const recent = await sql`
		SELECT w.mint, i.symbol, i.name, i.image_uri, i.category,
		       w.buy_lamports, w.sell_lamports, w.first_seen_at,
		       (g.mint IS NOT NULL) AS graduated
		FROM pump_coin_wallets w
		JOIN pump_coin_intel i ON i.mint = w.mint
		LEFT JOIN pumpfun_graduations g ON g.mint = w.mint
		WHERE w.wallet = ${wallet} AND w.buy_lamports > 0
		ORDER BY w.first_seen_at DESC
		LIMIT 30
	`;
	return json(
		res,
		200,
		{
			wallet: shapeWallet(rep),
			recent_coins: recent.map((r) => ({
				mint: r.mint,
				symbol: r.symbol,
				name: r.name,
				image_uri: r.image_uri,
				category: r.category,
				buy_sol: lamportsToSol(r.buy_lamports),
				sell_sol: lamportsToSol(r.sell_lamports),
				graduated: r.graduated,
				first_seen_at: r.first_seen_at,
			})),
		},
		{ 'cache-control': 'public, max-age=30' },
	);
}

// ── one coin: who's in it ────────────────────────────────────────────────────
async function coinDetail(res, mint) {
	const [coin] = await sql`
		SELECT mint, symbol, name, image_uri, category, smart_money_score, smart_wallet_count,
		       proven_buy_lamports, total_buy_lamports, notable, coin_first_seen_at, graduated, scored_at
		FROM coin_smart_money
		WHERE network = ${NETWORK} AND mint = ${mint}
		LIMIT 1
	`;
	if (!coin) {
		// Not scored yet (too new, or outside the rollup's observation window).
		// That is an answer about the coin, not a missing resource, so resolve it
		// the way the other pump detail endpoints (intel, launch-detail) do:
		// 200 + found:false. Cacheable so repeat probes for hot unscored mints
		// are absorbed at the edge.
		return json(
			res,
			200,
			{ found: false, mint, coin: null, notable: [] },
			{ 'cache-control': 'public, max-age=30, s-maxage=60' },
		);
	}

	// Resolve the notable wallets' live labels (in case they ranked up since).
	const notable = Array.isArray(coin.notable) ? coin.notable : [];
	const addrs = notable.map((n) => n.wallet).filter(Boolean);
	let labels = new Map();
	if (addrs.length) {
		const rows = await sql`
			SELECT wallet, label, smart_money_score, win_rate, wins, duds
			FROM wallet_reputation WHERE network = ${NETWORK} AND wallet = ANY(${addrs})
		`;
		labels = new Map(rows.map((r) => [r.wallet, r]));
	}
	return json(
		res,
		200,
		{
			found: true,
			coin: shapeCoin(coin),
			notable: notable.map((n) => {
				const live = labels.get(n.wallet);
				return {
					wallet: n.wallet,
					buy_sol: numOr(n.buy_sol),
					score: live ? numOr(live.smart_money_score) : numOr(n.score),
					label: live ? live.label : n.label,
					win_rate: live ? numOr(live.win_rate) : null,
					wins: live ? Number(live.wins) : null,
					duds: live ? Number(live.duds) : null,
				};
			}),
		},
		{ 'cache-control': 'public, max-age=15' },
	);
}

// ── shapers ──────────────────────────────────────────────────────────────────
function shapeCoin(r) {
	return {
		mint: r.mint,
		symbol: r.symbol,
		name: r.name,
		image_uri: r.image_uri,
		category: r.category,
		smart_money_score: numOr(r.smart_money_score),
		smart_wallet_count: Number(r.smart_wallet_count) || 0,
		proven_buy_sol: lamportsToSol(r.proven_buy_lamports),
		total_buy_sol: lamportsToSol(r.total_buy_lamports),
		notable: Array.isArray(r.notable) ? r.notable : [],
		first_seen_at: r.coin_first_seen_at,
		graduated: !!r.graduated,
		scored_at: r.scored_at,
	};
}

function shapeWallet(r) {
	const judged = (Number(r.wins) || 0) + (Number(r.duds) || 0);
	return {
		wallet: r.wallet,
		smart_money_score: numOr(r.smart_money_score),
		label: r.label,
		win_rate: numOr(r.win_rate),
		early_win_rate: numOr(r.early_win_rate),
		dump_rate: numOr(r.dump_rate),
		coins_judged: judged,
		coins_traded: Number(r.coins_traded) || 0,
		early_entries: Number(r.early_entries) || 0,
		wins: Number(r.wins) || 0,
		duds: Number(r.duds) || 0,
		dumps: Number(r.dumps) || 0,
		creator_count: Number(r.creator_count) || 0,
		creator_wins: Number(r.creator_wins) || 0,
		buy_volume_sol: lamportsToSol(r.buy_volume_lamports),
		last_active_at: r.last_active_at,
	};
}

function clampInt(v, lo, hi, def) {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return def;
	return Math.min(hi, Math.max(lo, n));
}
function clampNum(v, lo, hi, def) {
	const n = Number(v);
	if (!Number.isFinite(n)) return def;
	return Math.min(hi, Math.max(lo, n));
}
