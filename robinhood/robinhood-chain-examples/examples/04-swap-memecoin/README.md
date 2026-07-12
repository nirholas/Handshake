# 04 · Quote & execute a swap (testnet)

Quote a Uniswap v3 route and — with a funded key — execute it, on Robinhood
Chain **testnet (46630)**. The quote is a read (no wallet needed); execution is
guarded behind `ROBINHOOD_CHAIN_PRIVATE_KEY` and a balance check, and never
fabricates a transaction.

Testnet has one liquid pool (WETH/NFLX 0.05%), so the example swaps a little
WETH for NFLX. **The identical code swaps memecoins on mainnet** — pass a NOXA
or Odyssey token as `tokenOut` and drop `chain: 'testnet'`.

**What it proves:** `quoteSwap` → `executeSwap` is the whole trade path, and the
SDK transparently handles the testnet router flavor (classic `SwapRouter` with a
struct deadline) vs. mainnet's `SwapRouter02` (deadline via `multicall`).

## Prerequisites

- Node ≥ 20 for the quote.
- To execute: a testnet key in `ROBINHOOD_CHAIN_PRIVATE_KEY` funded with testnet
  ETH from the [faucet](https://faucet.testnet.chain.robinhood.com/).

## Run

```bash
npm install && npm install ../../../robinhood-chain-sdk
npm start                                              # quote only
ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js --execute   # quote + swap
```

## Expected output (quote)

```
Robinhood Chain testnet (46630) — Uniswap v3 quote
  in : 0.001 WETH  (0x7943e237c7F95DA44E0301572D358911207852Fa)
  out: 2.149898526134466783 NFLX  (0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93)
  route: 1 hop, fee tier(s) 500
  quoter gas estimate: 1208171

Quote only. Re-run with --execute and a funded ROBINHOOD_CHAIN_PRIVATE_KEY to swap.
```

Without a key, `--execute` fails helpfully instead of pretending:

```
✗ --execute needs ROBINHOOD_CHAIN_PRIVATE_KEY set to a funded testnet key.
  Get testnet ETH: https://faucet.testnet.chain.robinhood.com/
```

> **On-chain execute: pending funding.** The public testnet faucet currently
> gates drips behind Turnstile + Google Sign-In in a real browser, so this repo
> ships the live quote (verified above) and the guarded execute path. When a
> funded testnet key is available, `--execute` prints a real tx hash and an
> explorer link — no output is faked here.

## Mainnet & the eligibility gate

On mainnet, any swap whose **output** is a canonical Stock Token throws
`StockTokenEligibilityError` unless you create the client with
`acknowledgeStockTokenEligibility: true` — your affirmation that you are not a
US person (Stock Tokens are tokenized debt securities barred to US persons).
Memecoins and selling are never gated.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
