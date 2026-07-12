:::danger Read this section before the code
An autonomous trading agent is software that spends money without asking you first, every time it runs. Every idea below is built with a **hard spend cap**, a **kill switch**, and **paper mode as the default** — not as afterthoughts, but as the first things written. If you take nothing else from this page: never remove the spend cap "just to test something real," and never run an agent with a live wallet key until you've watched it behave correctly in paper mode for longer than you think is necessary.

This is not investment advice, and nothing here is a strategy anyone should expect to be profitable. It's a template for the *engineering* of an agent that spends — the risk controls transfer to any strategy you actually design.
:::

## Design the risk controls first

Before a single line reads a price, decide three things:

1. **Per-trade spend cap** — the maximum a single trade can move, regardless of what the strategy wants.
2. **Period spend cap** — a rolling limit (daily is typical) that trips even if every individual trade was within its own cap.
3. **Kill switch** — a way to stop the agent immediately and safely, mid-loop, without corrupting state.

```ts
const MAX_SPEND_USDG_PER_TRADE = 25   // hard ceiling per trade
const DAILY_SPEND_CAP_USDG = 100      // hard ceiling per rolling day
let spentToday = 0
let running = true

process.on('SIGINT', () => {
  console.log('kill switch: SIGINT received, stopping after this tick')
  running = false // finish the in-flight tick, then exit the loop — never abort mid-transaction
})
```

Notice the kill switch doesn't `process.exit(0)` immediately. If the agent is mid-way through building a transaction when `SIGINT` fires, you want it to either finish that operation cleanly or not have started it — never leave a half-sent transaction or a corrupted spend counter. Setting a flag and checking it at loop boundaries is the safe pattern.

## A minimal strategy: dip detection, paper mode

This agent watches a basket of Stock Tokens, and on a mainnet dip beyond a threshold, logs what it *would* buy — respecting both spend caps — without ever building or sending a transaction:

```ts
import { createHoodClient, getQuote } from 'hoodchain'

const hood = createHoodClient()
const SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'SPY']
const DIP_THRESHOLD_PCT = 0.5 // paper-buy if price drops >0.5% vs the last observed price

const lastPrice = new Map<string, number>()

async function tick() {
  for (const symbol of SYMBOLS) {
    const q = await getQuote(hood, symbol, { maxAgeSeconds: 7 * 24 * 60 * 60 })
    const prev = lastPrice.get(symbol)
    lastPrice.set(symbol, q.priceUsd)
    if (prev === undefined) {
      console.log(`[${symbol}] baseline $${q.priceUsd.toFixed(2)}`)
      continue
    }
    const changePct = ((q.priceUsd - prev) / prev) * 100
    if (changePct <= -DIP_THRESHOLD_PCT) {
      if (spentToday + MAX_SPEND_USDG_PER_TRADE > DAILY_SPEND_CAP_USDG) {
        console.log(`[${symbol}] dip ${changePct.toFixed(3)}% -- SKIPPED, daily cap reached`)
        continue
      }
      spentToday += MAX_SPEND_USDG_PER_TRADE
      console.log(`[${symbol}] dip ${changePct.toFixed(3)}% -- PAPER BUY $${MAX_SPEND_USDG_PER_TRADE} (spent today: $${spentToday}/$${DAILY_SPEND_CAP_USDG})`)
    } else {
      console.log(`[${symbol}] $${q.priceUsd.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(3)}%) -- hold`)
    }
  }
}

console.log('paper-trading agent started -- Ctrl-C to stop (kill switch)')
while (running) {
  await tick()
  console.log('---')
  await new Promise((r) => setTimeout(r, 5000))
}
console.log('stopped cleanly.')
```

Run it against real mainnet quotes:

```bash
npx tsx agent.ts
```

A real, unedited capture from a 15-second run:

```text
paper-trading agent started -- Ctrl-C to stop (kill switch)
[AAPL] baseline $315.50
[TSLA] baseline $407.82
[NVDA] baseline $210.19
[SPY] baseline $753.62
---
[AAPL] $315.50 (+0.000%) -- hold
[TSLA] $407.82 (+0.000%) -- hold
[NVDA] $210.19 (+0.000%) -- hold
[SPY] $753.62 (+0.000%) -- hold
---
[AAPL] $315.50 (+0.000%) -- hold
[TSLA] $407.82 (+0.000%) -- hold
[NVDA] $210.19 (+0.000%) -- hold
[SPY] $753.62 (+0.000%) -- hold
```

Notice what this **doesn't** show: a fabricated trade. This capture ran over a weekend, when Chainlink stock feeds are closed (Tutorial 3) — the prices genuinely didn't move between ticks, so the agent correctly held every time. That's the right behavior, not a disappointing demo. **Never fake a trade to make a tutorial look more exciting than the real market was at the time you wrote it** — that habit is exactly how you end up trusting an agent's logs that lie to you.

## Going from paper to real (the parts that change, and don't)

When you're ready to let the agent actually spend, the strategy logic above is untouched. What changes is narrow and specific:

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient, executeSwap, parseUsdg, MAINNET_ADDRESSES } from 'hoodchain'

const hood = createHoodClient({
  account: privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}`),
  acknowledgeStockTokenEligibility: true, // only if you are actually eligible — see Tutorial 1
})

// replace the PAPER BUY console.log with:
const { hash, receipt } = await executeSwap(hood, {
  tokenIn: MAINNET_ADDRESSES.usdg,
  tokenOut: token.address,
  amountIn: parseUsdg(String(MAX_SPEND_USDG_PER_TRADE)),
}, { slippageBps: 100 }) // wider slippage — an unattended agent can't react to a failed fill
console.log(`REAL BUY ${symbol}: tx ${hash}, status ${receipt.status}`)
```

The spend caps, the kill switch, and the strategy decision are **identical code** — only the final action (`console.log` vs. `executeSwap`) changed. That's by design: if your paper-mode agent and your live agent share every line except the actual send, you can trust that what you watched in paper mode is what will happen live. If they're structurally different code paths, you're testing something you're not shipping.

:::warning Start with an amount you'd be fine losing entirely
Even with caps and a kill switch, a strategy can be wrong, a feed can behave unexpectedly, or a bug can exist in code you wrote an hour ago. `DAILY_SPEND_CAP_USDG = 100` is a ceiling, not a promise of safety. Fund the live wallet with exactly what you're prepared to lose, and nothing more, for at least the first several days of live operation.
:::

## Logging and observability

An agent with no audit trail is an agent you can't debug after the fact. At minimum, persist (to a file or a database, not just stdout) every: quote observed, decision made and why, transaction sent with its hash, and cap-triggered skip. When something looks wrong three days from now, you want to reconstruct exactly what the agent saw and decided, not just what it did.

## Troubleshooting

**Agent never trades, even during a volatile market** — check `DIP_THRESHOLD_PCT` isn't set unreasonably high for the volatility of your basket, and confirm `getQuote` isn't throwing `StaleFeedError` silently (wrap the tick loop's body in a try/catch per symbol so one bad feed doesn't kill the whole tick).

**Kill switch doesn't stop it** — confirm you're checking the `running` flag at the top of the `while` loop, not just setting it. A `SIGINT` handler that sets a flag nobody reads does nothing.

**Daily cap never resets** — the example above never resets `spentToday`; add a check against a stored date and reset the counter on a new day, ideally persisted so a restart doesn't reset the cap early and let the agent double-spend the "daily" limit.

## What you built

A strategy loop with the risk controls built in from the first line, verified against a real (honestly reported, not fabricated) run — and the exact, minimal diff between its paper and live modes. Next: the other side of an autonomous agent's toolkit — creating things on-chain, not just trading them.
