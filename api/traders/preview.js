/**
 * Public wallet preview — show an on-chain pump.fun trade record without auth.
 *
 *   GET /api/traders/preview?wallet=<base58>&network=mainnet
 *
 * Returns the wallet's brain reputation (win rate, smart-money score, label,
 * trade count) and their most recent pump.fun coin appearances
 * (WALLET_PROFILE_COIN_LIMIT of them). This powers the /claim-wallet page where
 * a KOL or trader can see their verified track record before signing in to
 * claim it.
 *
 * Public, IP rate-limited, 2-minute CDN cache. A database fault propagates out
 * of walletProfile() so wrap() answers 503 no-store: an unreachable brain must
 * never be published to the CDN as "this wallet has no track record".
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { walletProfile } from '../_lib/oracle/sources.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS = 1e9;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const wallet  = (p.get('wallet') || '').trim();
	const network = NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';

	if (!WALLET_RE.test(wallet)) return error(res, 400, 'invalid_wallet', 'Paste a valid Solana base-58 wallet address.');

	const { rep, recent } = await walletProfile(wallet, network);

	// Build a useful summary even if wallet_reputation doesn't have this wallet
	// yet (it's scored by the smart-money rollup worker, so new wallets lag).
	// Every per-coin number traces to a real on-chain trade aggregate in
	// pump_coin_wallets — buy/sell lamports + base amounts + tx counts + the
	// observed first/last-seen window — so the wallet dashboard renders deep,
	// honest analytics with no synthesized values.
	const coins = (recent || []).map((r) => {
		const buySol  = r.buy_lamports  != null ? Number(r.buy_lamports)  / LAMPORTS : null;
		const sellSol = r.sell_lamports != null ? Number(r.sell_lamports) / LAMPORTS : null;
		const pnlSol  = buySol != null && sellSol != null ? sellSol - buySol : null;
		// ROI on deployed capital — the canonical "Xx" a trader reads off GMGN.
		const roi     = buySol != null && sellSol != null && buySol > 0 ? (sellSol - buySol) / buySol : null;
		const buyCount  = r.buy_count  != null ? Number(r.buy_count)  : 0;
		const sellCount = r.sell_count != null ? Number(r.sell_count) : 0;
		// Tokens still held = bought − sold (base units). >0 means an open bag,
		// so realized PnL alone understates an unclosed winner.
		const baseBought = r.base_bought != null ? Number(r.base_bought) : null;
		const baseSold   = r.base_sold   != null ? Number(r.base_sold)   : null;
		const baseHeld   = baseBought != null && baseSold != null ? Math.max(0, baseBought - baseSold) : null;
		const holdMs = r.first_seen_at && r.last_seen_at
			? new Date(r.last_seen_at).getTime() - new Date(r.first_seen_at).getTime()
			: null;
		const open = baseHeld != null ? baseHeld > 0 && (baseBought ? baseHeld / baseBought > 0.01 : false) : false;
		return {
			mint:        r.mint,
			symbol:      r.symbol || null,
			name:        r.name   || null,
			image_uri:   r.image_uri || null,
			category:    r.category || null,
			narrative:   r.narrative || null,
			quality_score: r.quality_score != null ? Number(r.quality_score) : null,
			is_creator:  r.is_creator || false,
			graduated:   r.graduated ?? null,
			rugged:      r.rugged ?? null,
			ath_multiple:       r.ath_multiple != null ? Number(r.ath_multiple) : null,
			last_market_cap_usd: r.last_market_cap_usd != null ? Number(r.last_market_cap_usd) : null,
			buy_count:   buyCount,
			sell_count:  sellCount,
			tx_count:    buyCount + sellCount,
			buy_sol:     buySol,
			sell_sol:    sellSol,
			pnl_sol:     pnlSol,
			roi:         roi,
			base_bought: baseBought,
			base_sold:   baseSold,
			base_held:   baseHeld,
			open:        open,
			hold_ms:     holdMs != null && holdMs >= 0 ? holdMs : null,
			first_seen_at: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null,
			last_seen_at: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
		};
	});

	const totalBuy  = coins.reduce((a, c) => a + (c.buy_sol  || 0), 0);
	const totalSell = coins.reduce((a, c) => a + (c.sell_sol || 0), 0);

	// ROI distribution buckets — the GMGN "Distribution (Token N)" panel. Each
	// closed position lands in exactly one bucket by realized return.
	const closed = coins.filter((c) => c.roi != null && !c.open);
	// Win/loss is a statement about REALIZED outcomes, so only closed positions
	// vote. Counting every non-positive pnl called an untouched open bag a loss:
	// a sniper holding 60 fresh positions read as "0 wins / 60 losses" on the
	// card while win_rate_window said null, and the client's own aggregate()
	// (closed-only) disagreed with the server on the same numbers.
	const wins   = closed.filter((c) => c.pnl_sol > 0).length;
	const losses = closed.length - wins;
	// Realized PnL closes the same gap in the money column: net_pnl_sol books an
	// open bag's buy as a total loss, so it is the floor, not the outcome.
	const realizedPnl = closed.reduce((a, c) => a + (c.pnl_sol || 0), 0);
	const dist = { x5: 0, x2: 0, up: 0, down: 0, rug: 0 };
	for (const c of closed) {
		if (c.roi >= 5) dist.x5++;
		else if (c.roi >= 2) dist.x2++;
		else if (c.roi >= 0) dist.up++;
		else if (c.roi >= -0.5) dist.down++;
		else dist.rug++;
	}

	// Holding-duration + tx aggregates across the observed window.
	const holdMsList = coins.map((c) => c.hold_ms).filter((m) => m != null && m > 0);
	const avgHoldMs = holdMsList.length ? Math.round(holdMsList.reduce((a, b) => a + b, 0) / holdMsList.length) : null;
	const totalTx   = coins.reduce((a, c) => a + (c.tx_count || 0), 0);
	const openCount = coins.filter((c) => c.open).length;
	const creatorCoins = coins.filter((c) => c.is_creator).length;

	// Category mix — what this wallet actually trades.
	const catMap = new Map();
	for (const c of coins) {
		const k = c.category || 'unknown';
		catMap.set(k, (catMap.get(k) || 0) + 1);
	}
	const categories = [...catMap.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);

	const profile = rep ? {
		coins_traded:      Number(rep.coins_traded)      || 0,
		early_entries:     Number(rep.early_entries)     || 0,
		wins:              Number(rep.wins)              || 0,
		duds:              Number(rep.duds)              || 0,
		dumps:             Number(rep.dumps)             || 0,
		creator_count:     Number(rep.creator_count)     || 0,
		creator_wins:      Number(rep.creator_wins)      || 0,
		win_rate:          rep.win_rate != null ? Number(rep.win_rate) : null,
		early_win_rate:    rep.early_win_rate != null ? Number(rep.early_win_rate) : null,
		dump_rate:         rep.dump_rate != null ? Number(rep.dump_rate) : null,
		smart_money_score: rep.smart_money_score != null ? Number(rep.smart_money_score) : null,
		label:             rep.label || 'unproven',
		first_seen_at:     rep.first_seen_at ? new Date(rep.first_seen_at).toISOString() : null,
		last_active_at:    rep.last_active_at ? new Date(rep.last_active_at).toISOString() : null,
	} : null;

	// `known` means the rollup has graded this wallet. `claimable` means there is
	// a real on-chain record to claim, which is true the moment the indexer has
	// seen the wallet trade — the rollup lags by design. Gating claimable on
	// known made /claim-wallet answer "no record found" to wallets carrying
	// thousands of indexed pump.fun trades, purely because the scorer hadn't run.
	const known = !!profile;
	const claimable = coins.length > 0 || (known && Number(profile.coins_traded) > 0);

	return json(res, 200, {
		wallet,
		network,
		known,
		claimable,
		profile,
		coins,
		summary: {
			total_coins: coins.length,
			closed_coins: closed.length,
			open_positions: openCount,
			creator_coins: creatorCoins,
			wins_in_window:   wins,
			losses_in_window: losses,
			win_rate_window: closed.length ? Math.round((closed.filter((c) => c.pnl_sol > 0).length / closed.length) * 1000) / 1000 : null,
			total_buy_sol:   Math.round(totalBuy  * 1000) / 1000,
			total_sell_sol:  Math.round(totalSell * 1000) / 1000,
			total_volume_sol: Math.round((totalBuy + totalSell) * 1000) / 1000,
			net_pnl_sol:     Math.round((totalSell - totalBuy) * 1000) / 1000,
			realized_pnl_sol: Math.round(realizedPnl * 1000) / 1000,
			avg_buy_sol:     coins.length ? Math.round((totalBuy  / coins.length) * 1000) / 1000 : 0,
			avg_sell_sol:    coins.length ? Math.round((totalSell / coins.length) * 1000) / 1000 : 0,
			total_tx: totalTx,
			avg_hold_ms: avgHoldMs,
			distribution: dist,
			categories,
		},
		generated_at: new Date().toISOString(),
	}, { 'Cache-Control': 'public, max-age=120, stale-while-revalidate=300' });
});
