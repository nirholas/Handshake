# pump.fun program reference (vendored snapshot)

Read-only reference copy of pump.fun's public program docs + IDLs, vendored into
this repo so on-chain work (instruction builders, fee logic, swap routing) can be
diffed against the source of truth without a network round-trip.

- **Source:** https://github.com/pump-fun/pump-public-docs
- **Commit:** `1b822158844a60ca577df6ca122211b595a1a578`
- **Vendored:** 2026-06-08
- **Maintainers (npm publishers of `@pump-fun/*`):** `oussama-baton`, `security-baton`

This is a snapshot, not a dependency. Do not edit these files to "fix" anything —
re-vendor from upstream to update. Nothing here is imported by application code.

## What's in here

| Path | What it covers |
| --- | --- |
| `UPSTREAM-buy-sell-v2-announcement.md` | **The v2 trade-instruction announcement** — `buy_v2` / `sell_v2` / `buy_exact_quote_in_v2`, the move to a unified interface, and USDC-as-quote support. (Upstream's root README.) |
| `UPSTREAM-pumpswap-virtual-quote-reserves.md` | **PumpSwap virtual quote reserves** (2026-07-20) — quotes price on `quote_vault_balance + virtual_quote_reserves`. The double-count and silent-default traps, and every three.ws surface that had to change. |
| `idl/pump.json` | Bonding-curve program IDL (canonical account/arg shapes). |
| `idl/pump_amm.json` | PumpSwap AMM (graduated pools) IDL. |
| `idl/pump_fees.json` | Fee program IDL (`fee_config`, `sharing_config`, creator-fee sharing). |
| `docs/instructions/BUY.md`, `SELL.md` | `buy_v2` / `sell_v2` full account lists + arg validation + TS/Rust SDK calls. |
| `docs/instructions/COIN_CREATION.md` | `create` / `create_v2` (Token-2022 base mints). |
| `docs/instructions/CLAIM_CASHBACK.md`, `COLLECT_CREATOR_FEE.md`, `CREATOR_FEE_SHARING.md` | Cashback + creator-fee flows. |
| `docs/PUMP_SWAP_README.md`, `PUMP_SWAP_SDK_README.md` | AMM swap mechanics + SDK. |
| `docs/FEE_PROGRAM_README.md`, `FEE_RECIPIENTS.md`, `PUMP_CASHBACK_README.md`, `PUMP_CREATOR_FEE_README.md` | Fee program, recipient address lists, cashback, creator fees. |
| `docs/BREAKING_FEE_RECIPIENT.md`, `CPI_README.md`, `FAQ.md` | Breaking changes, CPI integration, FAQ. |

## Headline change to be aware of

pump.fun is migrating to **unified v2 bonding-curve trade instructions**
(`buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`) so the same account interface works
for both SOL-paired and **USDC-paired** ("stable paired") meme coins. Key points:

- All accounts are mandatory and passed in the same order regardless of coin type
  (no more optional-account branching).
- `quote_mint` is now explicit — pass wrapped SOL
  (`So11111111111111111111111111111111111111112`) for SOL-paired coins, or the
  USDC mint for USDC-paired coins.
- New mandatory accounts on every buy/sell: `sharing_config`,
  `global_volume_accumulator`, `user_volume_accumulator`, `fee_config`,
  `fee_program`, plus a `buybackFeeRecipient`.
- `create_v2` coins use **Token-2022** base mints
  (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
- SDK helpers: `PUMP_SDK.getBuyV2InstructionRaw(...)` / `buy_v2_instructions(...)`
  (and the `sell_v2` equivalents).

Our code already references `buy_v2`/`sell_v2`, `user_volume_accumulator`, and
`sharing_config`, so we appear aligned — but a focused audit against these docs is
tracked in `tasks/pumpfun-upstream/01-v2-trade-instructions-usdc-audit.md`.
