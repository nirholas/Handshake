# Task 18 — On-chain token: treasury, burn & USD pricing

## Context

The game references an on-chain token used for premium actions (paid wheel spins,
token-priced marketplace sales) but there is **no token integration in the game
code** — no mint config, no treasury wallet, no burn, no USD-based price quoting,
no payment verification. The platform has Solana tooling (`src/solana.js`,
`api/` functions, payment helpers under `api/payments/`) to build on. This task
establishes the shared on-chain primitives that Tasks 19 and 20 consume.

## Goal

A reusable, real on-chain token layer: read the live token price, quote a USD
amount as a token amount, build/verify payment transactions, and route proceeds
to burn + treasury per the configured split.

## What to build

1. **Config.** Centralize the token mint address, decimals, treasury wallet
   address, and split policy in config/env (no hardcoded literals scattered
   around). Fail loudly if required values are missing in production, mirroring
   the `HOLDER_PASS_SECRET` boot guard.
2. **Live price + USD quoting.** Fetch the token's live USD price from a real
   source (the price feed/oracle the platform already uses — e.g. the Pump.fun /
   market data path). Provide `quoteTokenForUsd(usd)` returning the token amount
   at current price, with a short server-side quote validity window so a quoted
   price can't be exploited after the market moves.
3. **Payment build + verify.** Server issues a quote (amount, recipient split,
   nonce, expiry). Client wallet signs/sends one transaction. Server verifies the
   on-chain transaction: correct amount, correct destinations (burn address +
   treasury per split), confirmed on-chain, nonce unused, within expiry. Only a
   verified payment unlocks the paid action. Never trust a client "paid" claim.
4. **Burn + treasury split.** Implement the split primitive (e.g. 50/50 for paid
   spins: half to the burn address, half to treasury; and the 95/5 seller/treasury
   split for marketplace token sales). Make the split a parameter so Tasks 19/20
   reuse the same verified-payment path with different ratios.
5. **Auditability.** Record each settled payment (payer, amount, split, tx
   signature, purpose) in the persistence store for reconciliation. Expose a
   minimal internal read path; do not log secrets.

## Definition of done

- A USD amount quotes to a correct token amount at the live price, with an
  enforced quote expiry.
- A real signed transaction is verified end-to-end (amount + burn/treasury
  destinations + confirmation) before the paid action is granted; replays and
  underpayments are rejected.
- Burn and treasury receive the configured shares on a real transaction. Settled
  payments are recorded. No secrets logged. No console errors.

## Dependencies

Requires Task 17 (authenticated wallet). Consumed by Task 19 (paid spins) and
Task 20 (token-priced listings). Uses existing Solana/payment infra + price feed.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
