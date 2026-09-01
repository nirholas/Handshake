# PumpSwap: virtual quote reserves

Upstream announcement, plus what three.ws had to change to stay correctly priced.

## What changed

The PumpSwap (`pump_amm`) `Pool` account carries a field appended to the end of
the struct:

```text
virtual_quote_reserves: i128
```

Note the type. It is **signed** and **16 bytes**, not a `u64`. Two things follow,
and both fail silently rather than loudly:

- A hand-rolled decoder that reads 8 bytes gets a truncated value.
- A decoder that reads it as *unsigned* turns a negative into an enormous
  positive, which reads as near-infinite pool depth. That is the dangerous
  direction: a position sizer would happily push size into a pool that cannot
  absorb it. Never clamp it to zero, never parse it unsigned, and do not guard
  with `if (virtual > 0)`.

Because the value can be negative, **effective quote reserves can be lower than
the raw vault balance**. Treat a non-positive effective reserve as an untradable
pool, not as a normal quote.

The identically-named `BondingCurve.virtual_quote_reserves` is a `u64`. The two
fields differ in type as well as in meaning; see the collision note below.

Quotes are computed against the pool's **effective** quote reserves, not the raw
balance sitting in the quote vault:

```text
effective_quote_reserves = quote_vault_balance + virtual_quote_reserves
```

Buys and sells are both priced on `effective_quote_reserves`. Pricing off the raw
vault balance alone under-states the quote side of the pool, which under-prices
the token.

The **base** side is explicitly unchanged: base reserves remain the raw
`pool_base_token_account.amount`. Only the quote side gains a virtual component.

`BuyEvent` and `SellEvent` also carry `virtual_quote_reserves`, appended. Because
it is appended, existing Borsh decoders keep decoding the earlier fields
correctly. Indexers that rebuild reserves from the event stream need it to
reconstruct effective reserves.

## Rollout

| Phase | Date | Behaviour |
|---|---|---|
| 1 | 2026-07-15 | Field ships, `0` on every pool. `effective == raw`, so quotes are byte-identical to before. Integrate here. |
| 2 | 2026-07-20, 10:00 EST | Pools begin carrying a non-zero value. Anything still pricing off the raw vault balance starts mispricing. |

The IDL scopes which pools those are: the field's doc comment reads *"For
non-boost pools, value is 0, so the behavior is identical to legacy pools."* So
boost pools are the non-zero population, and every other pool keeps
`virtual_quote_reserves` at `0`, where the change is a no-op.

Note that upstream's own prose still reads "`0` on all pools today", because the
public docs were written for phase 1 and have not been revised for phase 2. Do
not read that as the change being deferred.

## The name collision

Two different accounts now expose a field called `virtual_quote_reserves`, and
they are not the same thing:

| | `BondingCurve.virtual_quote_reserves` | `Pool.virtual_quote_reserves` |
|---|---|---|
| Program | `pump` | `pump_amm` (PumpSwap) |
| Stage | Pre-graduation | Post-graduation |
| Type | `u64` | `i128` (signed) |
| Meaning | The curve's virtual quote leg, part of the constant-product curve since launch | Quote-side liquidity the pool holds outside its vault, appended 2026-07-15 |

A coin has one or the other, never both. The bonding-curve field is *not* new:
it is the old `virtual_sol_reserves` renamed (see below). The pool field is
genuinely new. Conflating them is the easiest way to get this wrong.

## The other rename, already live

Separately from the change above, the `pump` bonding-curve struct renamed its
quote-side fields when a non-SOL quote asset became possible:

| Was | Now |
|---|---|
| `virtual_sol_reserves` | `virtual_quote_reserves` |
| `real_sol_reserves` | `real_quote_reserves` |

`Global` also gained `initial_virtual_quote_reserves`, and the curve gained a
`quote_mint` (`Pubkey::default()` on every coin created to date, and on any
SOL-paired coin).

This one is already in effect and fails **silently**: reading the retired name
off a freshly decoded curve yields `undefined`, which coerces to `0` rather than
throwing. The symptom is every coin reporting 0% to graduation with zero reserves
and a zero price. three.ws hit exactly this before commit `798725c21`.

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
  maker's price and the order book's derived market cap. These return no price at
  all for a non-positive effective reserve, rather than a misleading one.

### Refusing an exhausted pool

Because the virtual figure is signed, effective depth can be zero or negative:
a pool that cannot absorb a trade. Every path that quotes must refuse such a pool
outright rather than price it, because all of our impact math clamps the result
to a floor of zero and would therefore report an exhausted pool as **0% impact,
the safest-looking trade available**. That number then sails past the very guards
meant to stop it (the sniper's circuit breaker, the agent `max_price_impact_pct`
limit).

| Surface | Refusal |
|---|---|
| `workers/agent-sniper/amm-exit.js` | throws `amm_quote_depth_empty` |
| `api/agents/solana-trade.js` (`loadAmm`) | HTTP 409 `pool_depth_empty` |
| `api/pump-fun-mcp.js` (`quoteSwap`) | JSON-RPC `-32004` |
| `src/pump/pump-swap-quote.js` | throws `no tradable quote depth` |

A `0` returned by any impact helper means "unknown", never "safe".

An RPC outage is kept distinct from an exhausted pool. When the vault and mint accounts behind a pool cannot be read because the Solana RPC lane is down, `getAmmPoolState` throws a retryable `rpc_unavailable` error (HTTP 503 with a `Retry-After`) instead of a reserve figure, and `api/agents/solana-trade.js` answers `503 rpc_unavailable`; a depth refusal is only ever issued from reserves that were actually read.

Regression coverage lives in
[`tests/agent-sniper-amm-exit.test.js`](../../tests/agent-sniper-amm-exit.test.js)
and [`tests/pump-swap-quote.test.js`](../../tests/pump-swap-quote.test.js): the
virtual figure must reach the SDK un-summed and signed, impact must be measured
against effective reserves, a negative that exhausts depth must be refused before
any quote is attempted, and a negative that merely reduces depth must still price
normally against the reduced reserve.

## Versions

| | |
|---|---|
| TypeScript SDK | `@pump-fun/pump-swap-sdk@1.19.0` |
| Rust SDK | `pump-rust-client@0.1.9` |
| IDL | `contracts/idl/pump/pump_amm.json`, refreshed via `npm run pump:refresh-idls` |

Upstream: <https://github.com/pump-fun/pump-public-docs#pumpswap-update-virtual-quote-reserves>
