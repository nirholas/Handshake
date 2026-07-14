# 09 · x402 paid API call — blocked on siblings

**Status: not built.** This example is supposed to show a client paying a
`hood-api` endpoint via `hood402`. Neither package exists yet in the
`robinhood/` workspace as of this writing — only the core SDK
([`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk)) has shipped.
Per this repo's mission ("check which siblings exist and cover what's
actually there; note any gaps"), this folder is a placeholder-free gap note,
not a stub implementation.

## What's missing

- **`hood-api`** — a market-data API server for Robinhood Chain (Stock Token
  quotes, portfolios, launches) with metered endpoints.
- **`hood402`** — an [x402](https://github.com/coinbase/x402) payment client
  and middleware for USDG on Robinhood Chain (the payment rail this example
  would use).

## What this example will do once they exist

```
Client → GET /api/quote/AAPL on a hood-api endpoint
       → 402 Payment Required (x402 challenge, USDG on Robinhood Chain)
       → hood402 client signs and attaches payment
       → retry → 200 OK with the priced quote
```

The general x402 pattern is proven elsewhere on three.ws (see the
[`pay-for-service`](https://three.ws) skill and `x402` catalog) — the gap here
is Robinhood-Chain-specific: a `hood402` client that speaks USDG (6 decimals,
no EIP-2612 `permit`, so approvals are on-chain — see `hoodchain`'s `usdg.ts`)
instead of the USDC flow those examples use.

## Owner action

Build `hood-api` and `hood402` (prompts 04 and 05 in
`prompts/robinhood-chain/`), then this example becomes a ~40-line client
script. No further action needed from this repo until then.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
