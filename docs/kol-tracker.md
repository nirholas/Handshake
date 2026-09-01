# KOL Tracker: influencers ranked by what their wallets actually did

The KOL Tracker ranks Solana KOLs by realized P&L computed from their own wallets' on-chain trade history. Not screenshots, not self-reported win streaks: the board reads real trades, runs a FIFO cost-basis computation over them, and sorts by the realized USD result. Alongside P&L it shows win rate, traded volume, trade count, and, for the handles an admin has verified actually control the wallet, the X follower count. A big following with a losing wallet is exactly the kind of gap this page exists to expose.

Page: [/tracker](https://three.ws/tracker)

API: `/api/kol/tracker` (the board), with sibling reads `/api/kol/leaderboard`, `/api/kol/wallets`, and `/api/kol/trades`.

## Why it exists

Influence and skill are different assets, and only one of them is priced into a follow button. A wallet address cannot exaggerate: every entry and exit is public, timestamped, and attributable. The tracker joins the two records, social reach and on-chain results, into one table so you can see at a glance whose calls are backed by their own money winning. Follower counts are shown only where the wallet-to-handle link has been explicitly verified, and every P&L figure names its source, so the page never renders a number whose provenance it cannot state.

## What the page shows

`pages/tracker.html` is a self-contained module that fetches `/api/kol/tracker?window=<w>&limit=100` and renders one row per wallet:

- **Rank**, with medals for the top three.
- **KOL identity**: avatar, `@handle` (linked to X) when a verified handle is attached, otherwise the curated label, otherwise the shortened wallet address. The wallet address always renders under the name.
- **PnL** for the selected window, green or red. When the figure did not come from our own on-chain computation, a small source tag (for example `(kolscan)`) renders next to it.
- **Followers**, only for verified handles; a wallet with no attached handle shows a blank, never a fabricated count.
- **Volume**, **Win Rate**, and **Trades** for the window.

The column set is data-driven: a column that every row leaves empty in the current window (followers when no verified handle ranks, volume when no wallet took the on-chain path) is dropped rather than rendered as a column of blanks, and the board's minimum width shrinks with it. The handle links to X, and the wallet address under every name links to its Solscan account. An "updated" stamp next to the row count says when the board was last fetched.

A segmented control switches the window between 24H, 7D, and 30D (arrow keys work on it), and the column headers relabel to match. Loading renders skeleton rows; an empty tracked list renders a designed empty state; a failed fetch renders an error state. The board never falls back to placeholder rows.

## How ranking works (as coded)

The aggregator is `src/kol/tracker.js` (`getKolTracker`). Per request it:

1. **Builds the wallet universe** by merging two sources. The live universe is the kolscan.io leaderboard for the requested window (`src/kol/leaderboard.js` over `src/kol/kolscan-live.js`: one HTML GET yields all three window boards, priced SOL to USD from the live feed, cached 120 seconds). The curated universe is the admin-maintained list from `src/kol/wallet-store.js` (a bundled `wallets.json` that ships empty by design, merged with R2 imports written by the admin-only import endpoint). Live rows carry numbers; curated records carry identity (label, verified `xHandle`). The merge is by address, so a curated wallet that also ranks live gets both.
2. **Computes on-chain P&L per wallet** with `src/kol/wallet-pnl.js`: real trades for the wallet are fetched server-side, filtered to the window, sorted by time, and run through a FIFO cost-basis engine. Realized P&L is sell proceeds minus FIFO-consumed cost. Win rate is winning closed sells over all closed sells. Volume is the USD value of every trade leg in the window. No synthetic numbers enter this path.
3. **Applies a strict P&L precedence per wallet**, recorded in `pnlSource`: our own FIFO computation wins whenever we have trades for the wallet (`onchain`); otherwise the live kolscan figure for that window (`kolscan`); otherwise whatever the curated record carries (`imported`); otherwise `null`.
4. **Attaches the X profile** (`src/kol/x-profile.js`) only for wallets with an admin-attached handle: follower count, avatar, and verified flag from the real X API, cached 15 minutes per handle. Handles are never inferred or scraped; the only way one enters the list is an admin attaching it at import time after verifying the KOL controls the wallet (a signed message, a public self-disclosure).
5. **Sorts by `pnlUsd` descending, nulls last**, and caps the result at the requested limit (max 100).

If every source is unreachable the tracker returns an empty array and the page shows its empty state. A cron (`api/cron/kol-tracker-refresh.js`, every 10 minutes, Bearer-authenticated with `CRON_SECRET`) prewarms all three windows so the tight X API budget (75 lookups per 15 minutes on the free tier) is never spent inside a visitor's request.

## Where the data comes from

- **On-chain trades, not self-reported numbers.** The `onchain` P&L path computes from the wallet's own trade history; the `kolscan` fallback is itself a board of realized on-chain SOL profit. Nothing on this page is entered by the KOL.
- **kolscan.io** supplies the live wallet universe and the fallback P&L per window. Trader names it publishes are deliberately dropped; the schema stays address-keyed.
- **Helius** enhanced transactions back the per-mint trade feed (`/api/kol/trades`).
- **Birdeye** backs the holdings half of the portfolio proxy (`/api/kol/wallets`); its P&L half is computed in-house from on-chain trades.
- **The X API** supplies follower counts and avatars, only for admin-verified handles.

Each integration degrades honestly: a missing key or an upstream outage yields an empty or null field (and, for `/api/kol/trades`, an explicit error when the whole provider is down), never a fabricated or zeroed row that looks like real data.

## API

All reads are public, CORS-open, and IP rate-limited (600 requests per minute per IP; over that returns 429). `tracker`, `leaderboard`, `wallets`, and the admin import share one dispatcher, `api/kol/[action].js`; `/api/kol/trades` is served by its own exact file, `api/kol/trades.js`, which wins on filesystem precedence.

### `GET /api/kol/tracker`

The board behind the page.

| Param | Values | Default |
|---|---|---|
| `window` | `24h`, `7d`, `30d` | `7d` |
| `limit` | 1 to 100 | 100 |

```bash
curl 'https://three.ws/api/kol/tracker?window=7d&limit=25'
```

Response: `{ window, rows }`, sorted by `pnlUsd` descending, nulls last. Each row:

```json
{
  "wallet": "<WALLET_ADDRESS>",
  "label": "curated label or null",
  "xHandle": "verified handle or null",
  "avatarUrl": "X avatar URL or null",
  "verified": false,
  "followerCount": null,
  "pnlUsd": 12345.67,
  "volumeUsd": 98765.43,
  "winRate": 0.62,
  "trades": 41,
  "pnlSource": "onchain",
  "window": "7d"
}
```

`winRate` is a fraction (0 to 1); the page renders it as a percent. `volumeUsd` and `trades` are only populated on the `onchain` path (volume) or on `onchain`/`kolscan` (trades). `pnlSource` is one of `onchain`, `kolscan`, `imported`, or `null`. An invalid `window` returns `400 validation_error`.

### `GET /api/kol/leaderboard`

The raw live board (no curation, no X profiles): address-keyed rows straight from the kolscan-backed source.

```bash
curl 'https://three.ws/api/kol/leaderboard?window=24h&limit=10'
```

Response: `{ items: [{ wallet, pnlSol, pnlUsd, winRate, trades, rank }] }`. Empty when the live source is unreachable, never stale or fabricated.

### `GET /api/kol/trades`

Recent pump.fun buys and sells by the tracked wallets for one mint, via Helius, cached for a few seconds.

```bash
curl 'https://three.ws/api/kol/trades?mint=<MINT_ADDRESS>&limit=20'
```

Response: `{ mint, trades, wallets }` where each trade carries `wallet`, `side`, `amountSol`, `amountToken`, `price`, `signature`, `ts`, `time`, `usd`, `source` (`kol`, `whale`, or `smart-money` from the wallet's tags), and `label`. The `x-kol-source` response header is `helius` when the provider is configured; with no provider key the feed returns an empty list and `x-kol-source: unconfigured`, which is distinct from a configured provider outage. When Helius fails but a last-good answer for that mint is still held, it is served with `x-kol-stale: 1` and `stale: true, as_of` in the body rather than blanking the feed; with no last-good copy either, the error (a `502 provider_unavailable`) carries `Retry-After: 15`.

### `GET /api/kol/wallets`

Portfolio snapshot proxy (Birdeye) for up to 20 addresses at once, cached 60 seconds per address. Requires `BIRDEYE_API_KEY` server-side; without it the endpoint returns `503 birdeye_not_configured`.

```bash
curl 'https://three.ws/api/kol/wallets?addresses=<WALLET_ADDRESS>,<WALLET_ADDRESS_2>'
```

Response: `{ data: [{ address, totalUsd, holdings, topToken, realizedPnl, winRate, totalTrades, volumeUsd, pnlSource, pnlWindow }] }`.

The row has two independently-sourced halves, and the field names say which is which:

- **Holdings, from Birdeye.** `totalUsd` is the wallet's current token-position value, `holdings` the number of positions, and `topToken` is `{ symbol, valueUsd }` for the single largest one. Birdeye's portfolio endpoint returns positions and nothing else, so this half never carries a P&L number.
- **Trading record, FIFO-computed from the wallet's own on-chain trades** over `pnlWindow` (30d) by [`src/kol/wallet-pnl.js`](../src/kol/wallet-pnl.js), the same engine behind the tracker board. `pnlSource` is `onchain-fifo` when it ran on real trades.

Every P&L field is `null` when there is no trade history for the wallet in the window, and `winRate` is additionally `null` when nothing closed inside it (a wallet that has only bought has no win rate yet). A null is "unknown", never "flat": treat it as no data, not as zero profit. `pnlSource: null` marks the whole half as unmeasured.

A wallet whose upstream fetch failed is omitted from `data` rather than rendered as a fake zero-P&L row.

### `POST /api/kol/import-gmgn` (admin only)

Writes the curated tracked-wallet list that the tracker merges in. Accepts `{ rawJson, xHandles }` where `xHandles` is the optional wallet-to-handle map described above: the only path by which a follower count ever attaches to a wallet. Imports persist to R2 and merge with (never blindly replace) the existing list, preserving previously attached handles.

## How it connects to wallet reputation

The tracker answers "who is making money"; the reputation surfaces answer "should this wallet's record earn trust". They meet at the wallet address:

- **`GET /api/intel/wallet/<WALLET_ADDRESS>`** returns one wallet's realized track record from the Smart-Money graph: a 0 to 100 realized score, win rate, average ATH multiple, winners and losers, labels (`smart_money`, `sybil`, `fresh`, and others), and its funder cluster. `computed: false` means no track record exists yet for that address; that is an honest zero, not an error. A string that is not a base58 Solana address is a different case and returns `400 bad_request`, so a typo never reads as a wallet with no history. Any wallet you see on the tracker can be fed straight into it. The same card is served by `GET /api/intel/smart-money?wallet=<WALLET_ADDRESS>`, which applies the identical validation.
- **[Smart Money Radar](./smart-money.md)** is the sibling leaderboard built from graduation outcomes rather than a KOL universe: reputation earned per wallet from which coins actually graduated. The tracker's footer links to it, and the two boards frequently disagree in instructive ways.
- **[Trust primitives](./trust-primitives.md)** wrap the same question for autonomous agents: a paid endpoint that scores any counterparty wallet from real on-chain evidence before an agent transacts with it.

```bash
# Take a wallet from the tracker and pull its reputation record
curl 'https://three.ws/api/intel/wallet/<WALLET_ADDRESS>?network=mainnet'
```

## States and limits

- **Auth.** All tracker reads are public. The import endpoint is admin-only; the refresh cron is Bearer-authenticated with `CRON_SECRET`.
- **Rate limit.** 600 requests per minute per IP on every public read.
- **Windows.** Exactly `24h`, `7d`, `30d`. Anything else is a 400.
- **Follower counts are opt-in by verification.** A wallet with no admin-attached handle ranks normally and simply shows no follower data. Nothing on this page guesses at identity.
- **Provenance is always visible.** Every P&L figure carries `pnlSource`, and the page tags any figure that did not come from our own on-chain computation.
- **Honest degradation everywhere.** Upstream outages produce empty boards, omitted wallets, or explicit errors, never placeholder rows, stale boards presented as fresh, or zeros dressed up as data.

## Related

- [Smart Money Radar](./smart-money.md): reputation earned from graduation outcomes, wallet by wallet
- [Trust primitives](./trust-primitives.md): the paid cross-chain reputation read for autonomous agents
- Pages: [/tracker](https://three.ws/tracker) · [/smart-money](https://three.ws/smart-money) · [/leaderboard](https://three.ws/leaderboard)
