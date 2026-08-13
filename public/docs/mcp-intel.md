# Intel MCP — read the market the way smart money does

Score a coin by **who** is net-buying it, pull any wallet's realized reputation, read a signal feed's proven track record, rank KOL traders, and browse the copy-trade Smart Money directory — all live, all read-only, all from inside your agent. Every score is computed from real observed buys joined to real outcomes (graduated / pumped / rugged + ATH), not vibes.

Registered in the [official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas) as **`io.github.nirholas/intel-mcp`**.

- **Install:** `npx -y @three-ws/intel-mcp`
- **npm:** [`@three-ws/intel-mcp`](https://www.npmjs.com/package/@three-ws/intel-mcp), published from `packages/intel-mcp`
- **Transport:** stdio — no account, no key, no payment

## Add it

```bash
claude mcp add intel -- npx -y @three-ws/intel-mcp
```

```json
{
  "mcpServers": {
    "intel": { "command": "npx", "args": ["-y", "@three-ws/intel-mcp"] }
  }
}
```

## Tools

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `smart_money_coin` | `mint` *(string, required)*, `network` *(`mainnet`\|`devnet`, default `mainnet`)* | Assess a coin by who is net-buying it now: a 0–100 `smart_money_score`, the reputable buyers in the book (realized score, win rate, labels), the funder clusters behind them, and a `sybil_flag` when one cluster dominates. `computed:false` means no on-chain history yet. |
| `wallet_intel` | `wallet` *(string, required)*, `network` *(`mainnet`\|`devnet`, default `mainnet`)* | One wallet's realized reputation: `realized_score` (0–100), win rate, behavioral labels, and the funder cluster it belongs to (root, size, confidence). |
| `signal_feed` | `slug` *(string, required)*, `network` *(`mainnet`\|`devnet`, default `mainnet`)* | A signal feed's public detail: the publisher's verified track record, proven accuracy (hit-rate, avg realized ROI, follower ROI, emit→fill latency), pricing, and the recent emission log with each signal's outcome and proving tx. |
| `kol_leaderboard` | `window` *(`7d`\|`30d`, default `7d`)*, `limit` *(1–100, default 25)* | Rank tracked KOL traders by realized performance over the window — P&L, win rate, and activity per wallet. |
| `kol_trades` | `mint` *(string, required)*, `limit` *(1–100, default 20)* | Which tracked KOL wallets recently traded a mint — buys/sells with size and timing, plus the size of the tracked set. |
| `copy_smart_wallets` | `chain` *(`sol`\|`bsc`)*, `category` *(`smart_money`\|`launchpad`\|`kol`\|`sniper`)*, `sort` *(`profit`\|`pnl`\|`winrate`\|`followers`\|`score`, default `score`)*, `q` *(string)*, `limit` *(1–100, default 30)*, `offset` *(default 0)* | Browse the curated Smart Money directory for copy-trading: deduplicated wallets ranked by 30-day performance, with category/chain facets. Returns wallet identity + performance (never token mints). |

## Examples

Smart-money score for a token:

```json
{ "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump", "network": "mainnet" }
```

A wallet's reputation card:

```json
{ "wallet": "5fNfvyp5K9PLcntsVFj6MwG4sNUZeYqyhMixLYXgrkm" }
```

Top KOLs over 30 days:

```json
{ "window": "30d", "limit": 25 }
```

## Configuration

| Env | Purpose | Default |
|-----|---------|---------|
| `THREE_WS_BASE` | Base URL of the three.ws API serving the intel endpoints. | `https://three.ws` |
| `THREE_WS_TIMEOUT_MS` | Per-request timeout in ms for the live intel reads. | `20000` |

## Notes

- **Read-only and free** — no auth, no key, no payment, no state mutation.
- Scores reflect live on-chain history; `computed:false` is an honest "not enough data yet," not an error. Errors are normalized with `.code` (`timeout`, `network_error`, `upstream_error`, `not_found`).

## Source & publishing

Manifest: [`packages/intel-mcp/server.json`](https://github.com/nirholas/three.ws/blob/main/packages/intel-mcp/server.json). Published with `npm run publish:mcp`. Full catalog: [MCP overview](/docs/mcp).
