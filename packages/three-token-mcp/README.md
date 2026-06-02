# @three-ws/three-token-mcp

**The first MCP server whose actions burn a token.** Give any AI agent three
$THREE primitives over the Model Context Protocol: read the live price, read a
wallet's balance, and **burn $THREE on-chain** — split between the incinerator
and the three.ws treasury, priced live via Jupiter.

Deflation as an agent primitive: every `three_burn` call is a real, verifiable
Solana transaction that permanently removes $THREE from supply and funds the
treasury.

```
io.github.nirholas/three-token-mcp   →   @three-ws/three-token-mcp
```

## Why this is different

Most paid MCP servers settle in USDC. This one moves the project's own token,
and the destinations are not hardcoded — they're read at runtime from the
**public** three.ws token surface (`/api/token/config`, `/api/token/price`), so
the mint, decimals, burn address, treasury, and split always track the canonical
on-chain config the rest of three.ws uses.

## Tools

| Tool | Type | What it does |
| :--- | :--- | :----------- |
| `three_price` | read-only | Live USD price of $THREE (Jupiter → Birdeye fallback). Pass `usd` to also get the token-amount quote. |
| `three_balance` | read-only | $THREE + SOL balance for any pubkey (defaults to the configured signer). |
| `three_burn` | **execution** | Burn a USD-denominated amount of $THREE in one Solana tx, split incinerator/treasury. Returns the signature + breakdown + Solscan link. |

`three_burn` burns $THREE the wallet **already holds**. To acquire $THREE first,
swap SOL→$THREE on any Solana DEX, then burn.

## Install

Add to your MCP client (Claude Desktop / Cursor / Claude Code):

```json
{
  "mcpServers": {
    "three-token": {
      "command": "npx",
      "args": ["-y", "@three-ws/three-token-mcp"],
      "env": {
        "SOLANA_SECRET_KEY": "<base58 secret of the wallet that holds $THREE>",
        "SOLANA_RPC_URL": "https://your-rpc-provider"
      }
    }
  }
}
```

`SOLANA_SECRET_KEY` is only required for `three_burn`. The read-only tools work
without it.

## Configuration

| Variable | Required | Purpose |
| :------- | :------- | :------ |
| `SOLANA_SECRET_KEY` | for burns | Base58 secret of the signing wallet. **Treat like cash.** |
| `SOLANA_RPC_URL` | no | Solana mainnet RPC (defaults to the public cluster). |
| `THREE_WS_BASE` | no | three.ws API base (defaults to `https://three.ws`). |

## Example

```
> three_price { "usd": 5 }
{ "price_usd": 0.0042, "quote": { "usd": 5, "token_amount": 1190.47, "atomics": "1190476190" } }

> three_burn { "usd": 5, "burnBps": 5000 }
{
  "ok": true,
  "signature": "5x...",
  "explorer": "https://solscan.io/tx/5x...",
  "usd": 5,
  "burned": 595.23,
  "legs": [
    { "role": "burn", "amount": 595.23 },
    { "role": "treasury", "amount": 595.23 }
  ]
}
```

`burnBps` controls the split: `5000` (default) = 50% burn / 50% treasury;
`10000` = burn everything.

## How a burn is built

`three_burn` mirrors the proven three.ws browser payment flow:

1. `GET /api/token/config` → mint, decimals, burn address, treasury.
2. `GET /api/token/price?usd=<n>` → live Jupiter price + the exact $THREE atomics.
3. Build **one** transaction: an idempotent ATA-create + SPL transfer per leg
   (burn + treasury), plus a memo tagging the burn on-chain.
4. Sign with your wallet, send, and confirm. The result reports the on-chain
   signature and per-leg amounts.

The server pre-checks your $THREE balance and fails fast with a clear error if
it can't cover the burn — no opaque on-chain failures.

## License

Apache-2.0 · [three.ws](https://three.ws)
