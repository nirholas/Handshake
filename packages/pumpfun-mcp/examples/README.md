# Examples: @three-ws/pumpfun-mcp

Two runnable examples. Both spawn this package's own MCP server over stdio (the
same `node src/index.js` entry point the README documents), speak real MCP
JSON-RPC to it, and read live Solana mainnet data through the canonical three.ws
backend.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Prints every tool the backend currently serves, with titles, annotation hints, and full input schemas. | `node examples/list-tools.mjs` |
| [`token-report.mjs`](token-report.mjs) | A live on-chain report for one mint: backend status, SPL mint facts, curve state, top holders, recent trades. | `node examples/token-report.mjs` |

Run them from the package directory:

```bash
cd packages/pumpfun-mcp
node examples/list-tools.mjs
node examples/token-report.mjs
```

Nothing to install and nothing to configure: every tool on this server is free
and read-only, and there is no write tool to reach for. The server prints a
one-line banner to stderr on connect (`[pumpfun-mcp] three.ws-pumpfun-mcp
vx.y.z ready`), which is normal.

## list-tools.mjs

Runs the MCP `initialize` handshake, then `tools/list`, and formats every tool.
Expected output (abridged):

```
server:       three.ws-pumpfun-mcp v0.2.4 (stdio)
capabilities: tools
tools:        20

1. get_token_details
   title: Token Details
   hints: read-only, open-world
   params:
     - mint (required; string)

2. get_bonding_curve
   params:
     - mint (required; string)
     - network (optional; string, one of mainnet | devnet, default "mainnet")

3. get_token_trades      4. get_token_holders   5. pumpfun_vanity_mint
6. pumpfun_watch_whales  7. pumpfun_list_claims 8. pumpfun_watch_claims
...
```

### Why the tool count moves

This package is a stdio bridge in front of the canonical backend, and it asks the
backend for the authoritative tool list at startup. So the list reflects what the
backend can actually serve at that moment.

Six discovery tools depend on an external pump.fun indexer: `search_tokens`,
`get_trending_tokens`, `get_new_tokens`, `get_graduated_tokens`,
`get_king_of_the_hill`, and `get_creator_profile`. When the backend has no
`PUMPFUN_BOT_URL` configured, it filters those out of `tools/list` entirely,
which is deliberate: a client should only see tools it can call. They reappear
with no client change once an indexer is wired up. The on-chain tools never
depend on it. `pumpfun_bot_status` reports that state directly, which is why
`token-report.mjs` calls it first.

## token-report.mjs

Five live calls that add up to a real token report. Run against the $THREE mint
by default:

```
pumpfun_bot_status:
  indexer configured: false
  indexer healthy:    false
  PUMPFUN_BOT_URL is not configured. On-chain tools are available; indexer-backed discovery tools are disabled.

get_token_details: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
  decimals:         6
  supply:           999,674,525.94
  mint authority:   revoked (no further minting)
  freeze authority: revoked (accounts cannot be frozen)

get_bonding_curve:
  curve complete: yes, this token graduated off the bonding curve
  price now comes from the PumpSwap pool, so use pumpfun_quote_swap

get_token_holders: top 5
  top-holder share: 47.81%
   47.81%  <HOLDER_ADDRESS>  70,041,374
   15.17%  <HOLDER_ADDRESS>  22,217,654
   ...

get_token_trades: last 5 on-chain
  BUY   $    0.0620  0.000844943 SOL  21s ago
  BUY   $    0.0117  0.00015927 SOL  7s ago
  SELL  $    0.1154  0.001572055 SOL  19s ago
  ...

Every call was a read. Nothing was signed, sent, or paid for.
```

The real run prints full Base58 holder addresses and transaction-level trades;
they are elided above because they change every block. Balances, holder ranking,
and trades are live, so every number moves between runs.

Two things the report is deliberate about:

- **Curve versus pool.** A graduated token has no bonding curve left to read, so
  `get_bonding_curve` answers `complete: true` with zeroed reserves rather than
  pretending to price it. Post-graduation pricing lives in the PumpSwap pool, via
  `pumpfun_quote_swap`. A pre-graduation mint instead prints its graduation
  percentage and live reserves.
- **Authorities.** `mintAuthority` and `freezeAuthority` reading `null` means
  revoked, which is the safe state: no one can mint more supply or freeze a
  holder's account. The example spells that out rather than printing `null`.

### Arguments

```bash
node examples/token-report.mjs <MINT_ADDRESS>
```

Any pump.fun mint works. A mint still on the curve exercises the other
`get_bonding_curve` branch.

### Environment

Optional: `PUMPFUN_MCP_URL` repoints the bridge at a self-hosted backend
(default `https://three.ws/api/pump-fun-mcp`). It is forwarded to the server if
set. There is no API key to supply, for any tool.
