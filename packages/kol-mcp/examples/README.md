# Examples: @three-ws/kol-mcp

Two runnable examples. Both spawn this package's own MCP server over stdio (the
same `node src/index.js` entry point the README documents), speak real MCP
JSON-RPC to it, and read the live public KOL API.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Prints both tools with titles, annotation hints, and full input schemas. | `node examples/list-tools.mjs` |
| [`wallet-card.mjs`](wallet-card.mjs) | One trader's portfolio card, then that trader's trades on a mint. | `node examples/wallet-card.mjs` |

Run them from the package directory:

```bash
cd packages/kol-mcp
node examples/list-tools.mjs
node examples/wallet-card.mjs
```

Nothing to install and nothing to configure: both tools on this server are
read-only and keyless. The server prints a one-line banner to stderr on connect
(`[kol-mcp@x.y.z] connected over stdio with 2 tools`), which is normal.

## list-tools.mjs

Runs the MCP `initialize` handshake, then `tools/list`, and formats every tool.
Expected output (abridged):

```
server:       kol-mcp v0.1.1 (stdio)
capabilities: tools
tools:        2

1. get_wallet_portfolio
   title: KOL wallet portfolio + P&L
   hints: read-only, open-world
   params:
     - wallet (required; string, minLength 1)

2. get_wallet_trades
   title: A KOL wallet's trades on a mint
   hints: read-only, open-world
   params:
     - wallet (required; string, minLength 1)
     - mint (required; string, minLength 1)
     - limit (optional; integer, min 1, max 100)
```

Both tools report `read-only, open-world`. There is no write tool on this
server to accidentally reach for.

## wallet-card.mjs

The two calls chained the way an agent would chain them: pull the trader's card,
then look at how that trader is positioning in one token.

```bash
node examples/wallet-card.mjs                   # picks a tracked wallet for you
node examples/wallet-card.mjs <wallet>          # a wallet you care about
node examples/wallet-card.mjs <wallet> <mint>   # and a token to inspect
```

With no wallet argument it reads one off the public KOL leaderboard at runtime,
so the example stays runnable without pasting an address in. The mint defaults
to `$THREE`.

```
get_wallet_portfolio: 5xY…KoL
  holdings:   14 position(s) worth $38,120
  top token:  THREE at $21,500
  realized:   $124,300 over 30d
  win rate:   64.0%
  trades:     412 (source: onchain-fifo)

get_wallet_trades: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
  - buy  4.2 SOL  $612.4  2026-06-24 09:12

Both calls were read-only. Nothing was signed, spent, or modified.
```

Live data moves between runs. Two states are printed rather than hidden, and
both are worth reading:

- **`unknown (no data to measure)`** where a P&L field is null. three.ws has no
  trade history for that wallet in the window. It is not a flat record, and the
  example refuses to render it as `$0`.
- **`provider outage: …`** when the holdings or trade provider is down or
  rate-limited. The server reports that as an error rather than an empty card,
  so an outage can never be misread as a quiet wallet. The example prints it and
  keeps going.

### Environment

Optional, forwarded to the server if set: `THREE_WS_BASE` (default
`https://three.ws`) and `THREE_WS_TIMEOUT_MS`. Point `THREE_WS_BASE` at your own
deployment to read its KOL data instead.
