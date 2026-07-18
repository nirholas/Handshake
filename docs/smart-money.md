# Smart Money Radar: follow the wallets that actually win

Smart Money Radar is a live, first-party reputation graph of every pump.fun wallet. It crosses each coin's buyers with which coins actually graduated, folds the result into a per-wallet track record, and surfaces two things you cannot get from a price chart: which wallets keep picking winners, and what that proven money is buying right now. Every number is earned from on-chain outcomes, not a hand-curated allowlist.

Page: [/smart-money](https://three.ws/smart-money)

API: `/api/pump/smart-money` (feed, leaderboard, per-coin, per-wallet). The coin drawer also reads `/api/oracle/coin` for conviction context.

## Why it exists

The single most predictive early signal on pump.fun is not the chart, it is who is buying. A wallet that has repeatedly entered coins that went on to graduate is worth watching; a wallet that dumps every launch it touches is worth avoiding. That information exists on chain, but nobody keeps a running scorecard in time. Smart Money Radar is that scorecard. It re-earns every wallet's reputation continuously from real outcomes, so a coin's "pedigree" is the buy-weighted track record of the wallets actually in it, and a wallet's rank is its own history of picking coins that graduated. This is the same proven-wallet ledger the WHO pillar of [Oracle](./oracle.md) draws on, exposed as its own browsable surface.

## How it works

The page is a self-contained module inside `pages/smart-money.html` that polls `/api/pump/smart-money` every 20 seconds (paused when the tab is hidden). It has three tabs: **Smart money is buying** (the coin feed), **Top wallets** (the leaderboard), and **Watchlist** (a local list of up to 200 mints in `localStorage`).

The numbers are produced by a cron rollup (`api/cron/smart-money-rollup.js`) in three phases that write to `wallet_reputation`, `coin_smart_money`, and a `smart_money_scored` dedupe ledger:

**Phase A: judge and fold.** Six hours after launch, a coin's outcome is binary: present in `pumpfun_graduations` is a win, otherwise a dud. For the top 60 buyers of each judged coin, per-wallet deltas are folded into `wallet_reputation`. An entry counts as **early** when the wallet's first buy is within 180 seconds of the coin's first trade, and a **dump** when the wallet sold at least half of what it bought.

**Phase B: recompute reputation.** For each touched wallet the score is:

```
win_rate       = wins / (wins + duds)
early_win_rate = early_wins / early_entries
dump_rate      = dumps / (wins + duds)
confidence     = clamp(judged / 12, 0, 1)          # full confidence at 12 judged coins
earlyBonus     = clamp((early_win_rate - win_rate) * 0.4, 0, 20)
dumpPenalty    = dump_rate * 0.4
smart_money_score = round((win_rate + earlyBonus - dumpPenalty) * confidence, 1)
```

The label follows from the profile: a creator with 3 or more launches and zero graduations is a `rugger`; fewer than 4 judged coins is `fresh`; a dump rate of 60 percent or more is a `dumper`; a score of 70 or more is `smart_money`; 5 or more early entries with a win rate under 25 percent is a `sniper`; everything else is `neutral`.

**Phase C: score live coins.** For every coin launched in the last 3 hours, `coin_smart_money` is computed from its non-creator buyers (creators do not lend pedigree to their own coin):

```
weightedAvg  = sum(reputation * buy) / sum(buy)     # unknown wallets score 0, dragging it down
networkBonus = min(smart_wallet_count, 5) * 4        # capped at +20
smart_money_score = round(clamp(weightedAvg + networkBonus, 0, 100), 1)
```

A wallet is "proven smart money" at reputation 70 or more. The card's smart-money **share** is proven buy volume over total buy volume. The top 8 wallets by score become the coin's `notable` roster, each re-resolved to its live label so the display never goes stale.

## Walkthrough

1. Open [/smart-money](https://three.ws/smart-money). The hero shows live totals: proven wallets, proven win rate, tracked capital, coins on radar, and last-updated.
2. Stay on **Smart money is buying**. Filter by `On radar (fresh)`, `Graduated`, or `All`, and sort by pedigree, smart-money share, smart buy volume, proven wallets in, or freshest. Each card shows the pedigree badge, the share bar, and up to four notable wallet labels.
3. Click a coin to open its drawer: the full notable roster, and an Oracle conviction slot fetched separately from `/api/oracle/coin`.
4. Switch to **Top wallets**. Filter by label (`smart_money`, `sniper`, `dumper`, or all), or paste a wallet address to jump straight to it. The sortable table shows win rate, early-win rate, dump rate, record, volume, and score.
5. Click any wallet to see its recent coins and cross-navigate back to a coin it bought. Star coins to your Watchlist to track them locally.

## Examples

Every read is public and IP rate-limited (600 requests per minute per IP).

```bash
# The live feed: coins ranked by smart-money score, graduated ones included
curl 'https://three.ws/api/pump/smart-money?limit=100&graduated=1'

# The wallet leaderboard: proven wallets with at least 4 judged coins
curl 'https://three.ws/api/pump/smart-money?leaderboard=1&limit=100&min_coins=4'

# One coin's pedigree and notable roster
curl 'https://three.ws/api/pump/smart-money?mint=<MINT>'

# One wallet's track record and recent coins
curl 'https://three.ws/api/pump/smart-money?wallet=<WALLET>'
```

```javascript
// Find the freshest coins where proven money already has real skin in
const { coins } = await fetch(
  'https://three.ws/api/pump/smart-money?limit=100&graduated=0'
).then((r) => r.json());

const conviction = coins
  .filter((c) => c.smart_wallet_count >= 2)
  .sort((a, b) => b.smart_money_score - a.smart_money_score);

for (const c of conviction.slice(0, 5)) {
  console.log(c.symbol, 'pedigree', c.smart_money_score, 'proven wallets', c.smart_wallet_count);
}
```

## States and limits

- **Auth.** The read APIs are public and require no account. The rollup cron is Bearer-authenticated with `CRON_SECRET`.
- **Rate limit.** 600 requests per minute per IP; over that returns 429.
- **Warm-up window.** A coin is not judged until roughly 6 hours after launch, so a very fresh coin shows "not scored yet." The per-coin read deliberately returns `200 { found: false }` rather than a 404 for an unscored mint.
- **Empty and error states.** The feed, leaderboard, and watchlist each have designed empty copy ("No proven money on a fresh coin yet," "No wallets ranked yet"). A wallet with no history returns 404 and renders "No track record yet." A failed full refresh shows a stale-data reconnecting bar with a Retry button and escalates its message after repeated failures.
- **Two engines, one name.** This page reads `/api/pump/smart-money` (the graduation-outcome rollup). A sibling endpoint, `/api/intel/smart-money`, is a distinct funder-cluster and sybil-detection graph used by other surfaces. They answer related questions from different tables; do not conflate them.

## Related

- [Oracle: the conviction engine](./oracle.md) uses this proven-wallet ledger as its WHO pillar
- [The trading surfaces](./trading-surfaces.md) map, including the Coin Intelligence cross-coin trader board
- [Coin Radar](./radar.md) and [Mission Control](./terminal.md) surface the same pedigree read inline
- Pages: [/smart-money](https://three.ws/smart-money) · [/radar](https://three.ws/radar) · [/oracle](https://three.ws/oracle)
