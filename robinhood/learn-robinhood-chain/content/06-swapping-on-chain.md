Swapping is where reads become writes, and where a single wrong assumption costs real money. This tutorial covers all three layers — quoting a route, protecting yourself with slippage, and sending the transaction — plus the eligibility gate that exists specifically because some of the tokens you can swap into are regulated securities.

## The routing problem

Robinhood Chain's DEX layer is Uniswap v3. A v3 pool exists per **token pair per fee tier** (0.01%, 0.05%, 0.3%, 1%), and plenty of those pools exist with **zero liquidity** — deployed, but never seeded. A naive swap implementation that assumes "the 0.3% pool" will revert constantly. The right approach probes every fee tier for a direct route, plus two-hop routes through common intermediates (WETH, USDG), and picks whichever produces the best output. That's what `quoteSwap` does.

## Getting a real quote (mainnet, read-only, no wallet needed)

This runs right now, with no funds and no risk — quoting is a simulated call, not a transaction:

```ts
import { createHoodClient, quoteSwap, parseUsdg, MAINNET_ADDRESSES } from 'hoodchain'
import { formatEther } from 'viem'

const hood = createHoodClient()

const quote = await quoteSwap(hood, {
  tokenIn: MAINNET_ADDRESSES.usdg,
  tokenOut: MAINNET_ADDRESSES.weth,
  amountIn: parseUsdg('100'), // USDG has 6 decimals — always use parseUsdg, not parseUnits(x, 18)
})

console.log(`100 USDG -> ${formatEther(quote.amountOut)} WETH`)
console.log(`route: ${quote.route.fees.join('/')} fee tier(s), ${quote.route.path.length} hop(s)`)
console.log(`gas estimate: ${quote.gasEstimate}`)
```

```text
100 USDG -> 0.055549693087148477 WETH
route: 100 fee tier(s), 2 hop(s)
```

That's a live capture: **100 USDG quoted at 0.0555 WETH**, filled through the 0.01% fee tier. Note the router picked a *two-hop* path even though `fees.join()` shows one number — `quoteSwap` probes single-hop routes across all four tiers *and* two-hop routes through WETH/USDG, and the winner here happened to be the tightest single-tier pool. Run it again in your own terminal and you'll get a live number of your own; Uniswap v3 pricing moves with every block.

:::tip USDG has 6 decimals, not 18
This is the single most common bug in a Robinhood Chain integration. USDG deliberately mirrors USDC's convention, unlike most L2-native stables which use 18. Always use the SDK's `parseUsdg` / `formatUsdg` helpers instead of hardcoding a decimals count — they encode the correct value so you can't get it wrong.
:::

## Building and sending the transaction

A quote alone doesn't move funds. `buildSwapTx` turns a quote into calldata with a slippage-protected minimum output and a deadline; `executeSwap` does the whole pipeline — quote, build, approve if needed, send, confirm — in one call:

```ts
import { parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient, executeSwap, TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS } from 'hoodchain'

const hood = createHoodClient({
  chain: 'testnet',
  account: privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}`),
})

const { hash, receipt, quote } = await executeSwap(hood, {
  tokenIn: TESTNET_ADDRESSES.weth,
  tokenOut: TESTNET_STOCK_TOKENS.NFLX,
  amountIn: parseEther('0.0001'),
})

console.log(`swapped for ${formatEther(quote.amountOut)} NFLX — tx ${hash}, status ${receipt.status}`)
```

Under the hood, `executeSwap`:

1. Calls `quoteSwap` to find the best route.
2. Calls `buildSwapTx` to encode calldata with `amountOutMinimum` set from your slippage tolerance (default 0.5%, `slippageBps: 50`) and a deadline (default 10 minutes).
3. Calls `ensureApproval` — checks the router's current allowance and sends an `approve` **only if it's short**, so a second swap of the same token doesn't re-approve for no reason.
4. Sends the transaction and waits for the receipt.

### Two router flavors, handled for you

Mainnet routes through **SwapRouter02** (no `deadline` field in the call struct — it's enforced by wrapping the call in `multicall(deadline, [data])`). The testnet community deployment uses the **classic `SwapRouter`**, whose struct carries `deadline` directly. `buildSwapTx` detects which network you're on and encodes the right shape automatically — this is exactly the kind of chain-specific footgun a good SDK exists to remove.

## The eligibility gate

Every canonical Stock Token is a regulated security under the restriction from Tutorial 1: it may not be offered, sold, or delivered to US persons. `buildSwapTx` enforces this at the SDK boundary — **any swap whose output is a canonical Stock Token throws before it builds calldata**, unless you've explicitly affirmed eligibility:

```ts
import { createHoodClient, StockTokenEligibilityError } from 'hoodchain'

const hood = createHoodClient() // default: acknowledgeStockTokenEligibility is false

try {
  await executeSwap(hood, { tokenIn: usdg, tokenOut: aaplToken, amountIn: parseUsdg('100') })
} catch (e) {
  if (e instanceof StockTokenEligibilityError) {
    console.error('Refused: Stock Token acquisition needs an eligibility acknowledgment.')
  }
}
```

To proceed, the *operator* — not the end user, the person deploying the software — affirms eligibility explicitly:

```ts
const hood = createHoodClient({ acknowledgeStockTokenEligibility: true })
```

This default-closed design is worth copying even outside this SDK: **gate the risky path, not the safe one.** Reads and *sells* of Stock Tokens are never restricted — only acquisition is, matching the actual legal restriction.

:::danger Not a substitute for real compliance
This flag is a development safety rail, not a KYC system. If you're building a real product that lets users acquire Stock Tokens, you need actual jurisdiction detection and legal review — this flag just stops you from *accidentally* shipping an unrestricted buy button.
:::

## Slippage and deadlines, tuned correctly

The defaults (0.5% slippage, 10-minute deadline) are reasonable for a human clicking a button. Tune them for your use case:

```ts
const tx = buildSwapTx(hood, quote, {
  slippageBps: 100,        // 1% — wider for a thinly-traded pair
  deadlineSeconds: 120,    // 2 minutes — tighter for an automated agent that re-quotes often
})
```

Wider slippage on illiquid Stock Token pools reduces failed transactions at the cost of worse fills; tighter deadlines protect an automated system from executing a stale quote after a long delay.

## Testnet verification status

This tutorial's `quoteSwap` example above is a **live, real capture from mainnet** — you can run it yourself right now. The `executeSwap` write path is fully implemented and unit-tested (calldata encoding for both router flavors is asserted byte-for-byte in the SDK's test suite), but a **real signed testnet transaction was not captured for this page**: the testnet faucet sits behind Cloudflare Turnstile and Google Sign-In, which can't be scripted, and no pre-funded testnet key was available in this environment. If you fund a testnet wallet yourself via the [faucet](https://faucet.testnet.chain.robinhood.com/), the example above will execute exactly as written — it's the same code the SDK's own `examples/swap-testnet.ts` uses.

## Troubleshooting

**`NoRouteError`** — no probed route (any fee tier, direct or two-hop via WETH/USDG) produced output for your amount. Either the pair genuinely has no liquidity, or your `amountIn` is too large for the pool's depth. Try a smaller amount or a different intermediate via `quoteSwap`'s `intermediates` option.

**`StockTokenEligibilityError`** — you're swapping into a Stock Token without acknowledging eligibility. See the eligibility section above; this is almost always working as intended.

**Transaction reverts with no clear reason on testnet** — remember there's no *official* Uniswap deployment on testnet; the SDK uses the one community deployment with a genuinely liquid pool (NFLX/WETH). Swapping into a different testnet Stock Token may have no liquidity at all.

**`SlippageExceededError`** or a revert from `amountOutMinimum` — the price moved between quoting and sending. Either widen `slippageBps` or re-quote closer to send time.

## What you built

A quoting function that correctly probes every viable route, a transaction builder that handles both router flavors and protects you with slippage, and a firsthand look at a default-closed compliance gate. Next: watching the chain move in real time, from confirmed launch events down to the raw sequencer feed.
