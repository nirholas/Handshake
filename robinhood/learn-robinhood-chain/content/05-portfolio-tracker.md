Every wallet tracker on every chain does the same thing: enumerate token balances, price them, sum them. On Robinhood Chain, that naive recipe is wrong twice — once from the multiplier trap (Tutorial 3), and once from the sheer number of round trips a naive implementation makes. This tutorial builds the tracker correctly: one multicall sweep, multiplier-correct valuation, and an honest treatment of holdings that can't be priced.

## Why "just loop and call balanceOf" doesn't scale

There are 95 Stock Tokens in the registry. A naive tracker does:

```ts
for (const token of tokens) {
  const balance = await client.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
  // ...
}
```

That's 95 sequential RPC round trips before you've even started pricing anything. On the public RPC, each round trip is real latency — this loop takes seconds and burns your rate limit for nothing, since most addresses hold a handful of these tokens at most.

## The right approach: one multicall

viem's public client (used by `hoodchain`) batches calls into `Multicall3` automatically when `batch: { multicall: true }` is set — which `createHoodClient()` does for you. So the fix is almost free: fire all 95 `balanceOf` reads as a single batch, filter to the ones that are actually held, then multicall *those* for balance + multiplier together, and multicall the feeds for pricing. That's what `getPortfolio` does under the hood:

```ts
import { createHoodClient, getPortfolio } from 'hoodchain'
import type { Address } from 'viem'

const owner = process.argv[2] as Address | undefined
if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
  console.error('usage: npx tsx portfolio.ts 0xADDRESS')
  process.exit(1)
}

const hood = createHoodClient()
const portfolio = await getPortfolio(hood, owner, { maxAgeSeconds: 7 * 24 * 60 * 60 })

if (portfolio.positions.length === 0) {
  console.log(`${owner} holds no Stock Tokens.`)
  process.exit(0)
}

console.log(`Stock Token portfolio for ${owner}\n`)
for (const p of portfolio.positions) {
  const value = p.valueUsd === null ? 'unpriced (no feed)' : `$${p.valueUsd.toFixed(2)}`
  console.log(
    `${p.symbol.padEnd(6)} ${p.balanceTokens.toFixed(6).padStart(16)} tokens  ` +
      `= ${p.shareEquivalent.toFixed(6).padStart(16)} share-equivalents  ${value}`,
  )
}
console.log(`\nTotal priced value: $${portfolio.totalUsd.toFixed(2)}`)
if (portfolio.unpricedSymbols.length) {
  console.log(`Unpriced holdings (no Chainlink feed yet): ${portfolio.unpricedSymbols.join(', ')}`)
}
```

Run it against any address (this example uses the Multicall3 deployer, a busy contract address, purely to demonstrate the zero-holdings path):

```bash
npx tsx portfolio.ts 0xca11bde05977b3631167028862be2a173976ca11
```

```text
0xca11bde05977b3631167028862be2a173976ca11 holds no Stock Tokens.
```

That's the honest empty state — the tracker checked all 95 tokens in one batch and confirmed zero holdings, rather than silently returning nothing. Point it at a wallet that actually holds Stock Tokens (your testnet wallet from Tutorial 2, once funded, or any address you find via the explorer) and you'll see rows like:

```text
Stock Token portfolio for 0xYourAddress

NFLX         5.000000000000000000 tokens  =         5.000000000000000000 share-equivalents  $612.40
TSLA         2.500000000000000000 tokens  =         2.500000000000000000 share-equivalents  $1019.55

Total priced value: $1631.95
```

## What `getPortfolio` is actually doing

Reading the [source](https://github.com/nirholas/robinhood-chain-sdk/blob/main/src/stocks.ts) is worth five minutes, because the pattern generalizes to any multi-asset dashboard you'll ever build:

1. **One multicall** for `balanceOf` across all 95 registry tokens, `allowFailure: false` — if this fails, something is fundamentally wrong (bad RPC), so let it throw.
2. **Filter to non-zero balances.** Most wallets hold a handful of tokens; there's no reason to fetch multiplier and feed data for tokens you don't own.
3. **A second multicall**, this time for `balanceOf` + `uiMultiplier()` together, only over the held tokens.
4. **A third multicall for feed prices**, `allowFailure: true` — a single bad feed (stale, or a reverting call) shouldn't take down the whole portfolio. Positions with a failed feed fall back to `valueUsd: null`.
5. **Valuation**, per the Tutorial 3 rule: `valueUsd = balanceTokens × quote.priceUsd`. Multiplier is used only for `shareEquivalent`, never for `valueUsd`.

Total RPC round trips for a full 95-token sweep: **three**, regardless of how many tokens the wallet actually holds. That's the difference between a tracker that feels instant and one that spins for ten seconds.

## Correctness, proven, not asserted

It's easy to *claim* multiplier-correct math. The SDK's live test suite instead **cross-checks its share-equivalent computation against the token contract's own `balanceOfUI()`** — a view function the Stock Token contracts expose that does the same multiplication on-chain. If the SDK's `shareEquivalent` field and the contract's `balanceOfUI()` ever disagree, the test fails. That's the standard to hold your own money-math code to: don't just compute a number, find an independent on-chain source of truth and assert equality against it.

```ts
// simplified from tests/live — the actual assertion the SDK ships with
const onChainShares = await hood.public.readContract({
  address: token.address, abi: stockTokenAbi, functionName: 'balanceOfUI', args: [owner],
})
expect(position.shareEquivalent).toBeCloseTo(Number(formatUnits(onChainShares, 18)))
```

## Handling the unpriced case in a UI

`portfolio.unpricedSymbols` exists because 95 tokens exist but only a subset have a live Chainlink feed (34 at the time of writing). A dashboard that silently omits unpriced holdings is lying by omission — a user who holds one would wonder where it went. Show it, clearly labeled as unpriced, and let `totalUsd` reflect only what could actually be valued:

```ts
const totalLabel = portfolio.unpricedSymbols.length
  ? `$${portfolio.totalUsd.toFixed(2)} priced (+ ${portfolio.unpricedSymbols.length} unpriced holdings)`
  : `$${portfolio.totalUsd.toFixed(2)}`
```

## Troubleshooting

**Portfolio total looks wrong after I know a token split** — you're computing value somewhere outside `getPortfolio`, and you're multiplying by the multiplier. Revisit Tutorial 3; the rule doesn't change just because you're now summing across many tokens.

**Slow first run** — the very first multicall batch resolves 95 balances; on the public RPC that's still one HTTP round trip, but a cold connection adds latency. Subsequent calls are fast.

**A held token shows `unpriced (no feed)`** — expected for tokens outside Chainlink's current 34-feed coverage. Its balance is real; it just can't be priced on-chain yet.

**I want portfolio history / a chart** — this reads *current* state only. For history, you'd index `Transfer` events over time (see `watchTransfers` in Tutorial 7) and combine with historical feed rounds — a bigger project outside this tutorial's scope.

## What you built

A portfolio tracker that does one multicall sweep instead of ninety-five sequential calls, values holdings using the correct rule from Tutorial 3, and is honest about what it can't price — with its math independently verified against the chain's own accounting. Next: turning a read into a write, with your first on-chain swap.
