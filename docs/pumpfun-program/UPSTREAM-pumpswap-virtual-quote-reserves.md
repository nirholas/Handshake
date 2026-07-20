# PumpSwap: virtual quote reserves

Upstream announcement, plus what three.ws had to change to stay correctly priced.

## What changed

The PumpSwap (`pump_amm`) `Pool` account carries a field appended to the end of
the struct:

```text
virtual_quote_reserves: u64
```

Quotes are computed against the pool's **effective** quote reserves, not the raw
balance sitting in the quote vault:

```text
effective_quote_reserves = quote_vault_balance + virtual_quote_reserves
```

Buys and sells are both priced on `effective_quote_reserves`. Pricing off the raw
vault balance alone under-states the quote side of the pool, which under-prices
the token.

`BuyEvent` and `SellEvent` also carry `virtual_quote_reserves`, appended. Because
it is appended, existing Borsh decoders keep decoding the earlier fields
correctly. Indexers that rebuild reserves from the event stream need it to
reconstruct effective reserves.

## Rollout

| Phase | Date | Behaviour |
|---|---|---|
| 1 | 2026-07-15 | Field ships, `0` on every pool. `effective == raw`, so quotes are byte-identical to before. Integrate here. |
| 2 | 2026-07-20, 10:00 EST | Launchpad-coin pools begin carrying a non-zero value. Anything still pricing off the raw vault balance starts mispricing. |

Non-launchpad pools keep `virtual_quote_reserves` at `0` indefinitely, where the
change is a no-op.

## The integration trap

The SDK's quote functions take `virtualQuoteReserves` as its **own argument** and
perform the addition internally:

```js
const effectiveQuoteReserve = quoteReserve.add(virtualQuoteReserves);
```

So pass the **raw** vault balance as `quoteReserve` alongside the virtual figure.
Passing an already-summed reserve double-counts the virtual liquidity.

The argument also **defaults to `0`**. An integration that upgrades the SDK but
never passes the field gets no error and no warning: it silently keeps pricing
off the raw vault balance. This fails quietly, as bad numbers, not as a crash.

```js
// correct — SDK adds the two
sellBaseInput({ base, slippage, baseReserve, quoteReserve, virtualQuoteReserves, ... })

// wrong — double-counts the virtual reserves
sellBaseInput({ base, slippage, baseReserve, quoteReserve: effectiveQuoteReserve, virtualQuoteReserves, ... })

// wrong — silently prices off the raw vault balance
sellBaseInput({ base, slippage, baseReserve, quoteReserve, ... })
```

The SDK's **instance** methods (`PumpAmmSdk#buyQuoteInput(swapState, …)` and
friends) read `pool.virtualQuoteReserves` off the swap state themselves, so those
call sites are correct purely by upgrading the SDK.

## What three.ws does

[`getAmmPoolState`](../../api/_lib/pump.js) is the single source of truth. It
returns both values, and callers pick by consumer:

| Field | Use it for |
|---|---|
| `quoteReserve` | The raw vault balance. Pass to SDK quote functions. |
| `virtualQuoteReserves` | Pass to SDK quote functions alongside `quoteReserve`. |
| `effectiveQuoteReserve` | Our own spot-price and price-impact math, which does not go through the SDK. |

Surfaces updated to price on effective reserves:

- `api/pump/[action].js` — the public quote + trade-build endpoints. The quote
  response now also reports `virtual_quote_reserves` and
  `effective_quote_reserve` so callers can reproduce our numbers.
- `api/agents/solana-trade.js`, `api/agents/pumpfun/[action].js` — agent trading.
- `api/pump-fun-mcp.js`, `src/pump/pump-swap-quote.js` — MCP + browser quoting.
- `api/_lib/trade-firewall.js` — the liquidity gate now judges depth on effective
  reserves, so a pool holding real quote-side depth virtually is not failed as
  `pool_reserves_empty`.
- `workers/agent-sniper/amm-exit.js` — position exits and their price-impact
  circuit breaker.
- `workers/agent-mm/market.js`, `workers/agent-orders/market.js` — the market
  maker's price and the order book's derived market cap.

Regression coverage is in [`tests/agent-sniper-amm-exit.test.js`](../../tests/agent-sniper-amm-exit.test.js):
one test asserts the virtual figure reaches the SDK un-summed, another asserts
price impact is measured against effective reserves.

## Versions

| | |
|---|---|
| TypeScript SDK | `@pump-fun/pump-swap-sdk@1.19.0` |
| Rust SDK | `pump-rust-client@0.1.9` |
| IDL | `contracts/idl/pump/pump_amm.json`, refreshed via `npm run pump:refresh-idls` |

Upstream: <https://github.com/pump-fun/pump-public-docs#pumpswap-update-virtual-quote-reserves>
