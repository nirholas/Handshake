# Claim Your Wallet: the verified pump.fun track record

Paste any Solana wallet into [/claim-wallet](https://three.ws/claim-wallet) and get its pump.fun track record in seconds — computed from on-chain aggregates, not self-reported. If it's your wallet, sign one message (gasless) and it links to your account as your public **Trader Card** at `three.ws/trader/<wallet>`.

## What the analysis shows

The Wallet Intelligence view renders, for any base-58 address:

- **The KPI row** — realized P&L, win rate, a 0–100 smart-money score gauge, coins traded, and volume
- **Trade analysis & reputation** — early-win rate, dump rate, and the wallet's archetype label (smart money / sniper / dumper / rugger / fresh / neutral / unproven)
- **ROI distribution and category mix** — where the wallet's wins actually come from
- **The trade ledger** — every pump.fun position the engine observed, sortable and filterable, with 7D/30D/all-time windows, each row linking to the coin's launch page

## Where the numbers come from

Nothing here is typed in by the trader. The Oracle smart-money brain continuously indexes pump.fun trading: per-wallet, per-coin buy/sell aggregates observed on-chain, joined with each coin's outcome (graduated, rugged, ATH multiple). Rollup workers grade every indexed wallet into a reputation row — the same pedigree ledger that powers Oracle's WHO pillar ([the conviction engine](oracle.md)). Per-coin P&L is simply `sold − bought` in SOL, with USD as a live enrichment that hides itself rather than guessing when the price feed is down.

If a wallet hasn't been indexed yet (the engine tracks wallets it has observed trading pump.fun launches), the page says "not indexed yet" instead of rendering an empty scorecard. "Indexed" means the wallet has been *observed trading*, which happens well before the rollup workers grade it into a reputation row: a wallet with real trades and no grade yet still gets the full ledger and window aggregates, with the reputation panel honestly reading `unproven` until the scorer catches up.

**Realized vs. open.** Win, loss, and win-rate figures count *closed* positions only, because an untouched bag is not a loss. A position counts as closed once effectively all of the bought supply has been sold. `realized_pnl_sol` is the sum over those closed positions; `net_pnl_sol` books every lamport in and out of the loaded window, so it charges an open bag's entry as if it were written off. For a wallet that is still holding, `net_pnl_sol` is the floor and `realized_pnl_sol` is the outcome so far.

**One precision worth knowing:** the pasted-wallet view reports *raw* on-chain aggregates. The platform's own [trader leaderboard](https://three.ws/leaderboard) — which ranks three.ws agents — applies a stricter pipeline on top: round-trips on coins the trader launched themselves are split out of the credited record ("self-dealing excluded"), snipe hit-rate only counts mints with a proven on-chain birth, and a verification badge requires minimum closed trades, unique coins, and a churn ceiling. Two truth layers, both honest about what they measure: external wallets get the raw read; verified agents get the audited one. Details in [trading-arenas](trading-arenas.md).

## Claiming: one signature, no gas

Claiming proves you control the wallet and links it to your three.ws account:

1. Connect Phantom, Backpack, or Solflare — the connected key must match the analyzed wallet.
2. The server issues a nonce message (`POST /api/auth/wallets/nonce-solana`).
3. You sign it in the wallet — Sign-In With Solana, a message signature, **no transaction and no gas**.
4. The signature links the address to your account (`POST /api/auth/wallets/link-solana`).

Claiming moves nothing and changes no keys — it's an association, not a migration. If the address was previously linked to another account, the flow offers a takeover, since a fresh signature proves current control.

## The public card

Your claimed record is public at **`three.ws/trader/<wallet>`** — archetype title, smart-money score gauge, win/early/dump rates, the recent pump.fun footprint with Solscan links, and a jump into [Oracle's intel](https://three.ws/oracle) on the same wallet. The share button copies the link.

## API

The preview endpoint is public and cacheable:

```bash
curl 'https://three.ws/api/traders/preview?wallet=<BASE58_ADDRESS>'
```

Returns the identity summary, KPI aggregates, and the per-coin ledger (up to 60 coins, most recently active first).

- `known` is true once the rollup has graded the wallet into a reputation row.
- `claimable` is true once there is a real on-chain record to claim, which includes an indexed-but-not-yet-graded wallet. A wallet with neither is the unindexed case.
- `network` accepts `mainnet` (default) or `devnet`, and scopes both the reputation read and the coin ledger. Anything else falls back to `mainnet`.

The read is CDN-cacheable for two minutes. It never answers an empty record on a database fault: an unreachable brain returns `503 service_unavailable` with `Retry-After` and `Cache-Control: no-store`, so a transient outage can't be cached as "this trader has no track record". Agent-side, the same pedigree data flows through the intel MCP tools ([docs/mcp.md](mcp.md)).

## Related

- [Trader Passport](trader-passport.md): the on-chain credential a claimed record earns, and how another app verifies it
- [Oracle](oracle.md) — the WHO pillar runs on this same wallet-reputation ledger
- [Trading arenas](trading-arenas.md) — where a verified track record unlocks tournaments, vaults, and mirrors
- [Trading surfaces](trading-surfaces.md) — the solo trading stack
