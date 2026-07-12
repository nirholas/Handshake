Tutorial 7 taught you to *watch* NOXA and The Odyssey. This tutorial takes it one step further — a live launch monitor with fuller event decoding — and then gives you an honest account of what programmatic *launching* actually requires today, including a real gap this course found and didn't paper over.

## A fuller launch monitor

Extend the watcher from Tutorial 7 to decode every field each platform's events carry, so you can react to specific launch shapes rather than just "something launched":

```ts
import { createHoodClient, watchLaunches, watchCurveTrades, watchGraduations, formatUsdg } from 'hoodchain'
import { formatEther } from 'viem'

const hood = createHoodClient()

watchLaunches(hood, (launch) => {
  if (launch.launchpad === 'noxa') {
    // NOXA: instant listing — trading starts immediately on the pool address
    console.log(`NOXA launch: ${launch.token} by ${launch.creator}, pool ${launch.pool}`)
  } else {
    // Odyssey: opens on a bonding curve — no pool until it graduates
    console.log(`Odyssey curve opened: ${launch.token} by ${launch.creator} (no pool yet)`)
  }
})

// only meaningful for Odyssey — NOXA has no curve, it's a normal Uniswap v3 pool from block one
watchCurveTrades(hood, (trade) => {
  const dir = trade.isBuy ? 'BUY' : 'SELL'
  console.log(`${dir} ${trade.token}: ${formatEther(trade.tokenAmount)} tokens for ${formatEther(trade.quoteAmount)} ETH`)
})

watchGraduations(hood, (g) => {
  console.log(`GRADUATED: ${g.token} -> locked Uniswap v3 pool ${g.pool}`)
})
```

This is exactly the decoding verified in Tutorial 7 against 21 real historical NOXA launches — extended here with curve-trade and graduation handling for Odyssey specifically. If you're building a trading bot or an alert system (Tutorial 16-style tooling), this is the complete event surface you'd hook into.

## What "launch a coin programmatically" actually requires — and a real gap

Watching launches only requires decoding **events**, which are public and don't need a verified ABI — you can decode a known event signature off any contract, verified or not. **Sending a transaction that creates a new launch is different**: it requires the factory contract's *write function* signature — argument names, types, and order — which you can only get reliably from a verified source contract, or by painstakingly reverse-engineering calldata from a real transaction.

This course checked both launchpads' factory contracts against the Blockscout API before writing this page:

```bash
curl -s https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB
```

Neither the NOXA launch factory (`0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`) nor The Odyssey's bonding-curve factory (`0xEb3FeeD2716cF0eEAda05B22e67424794e1f5a80`) returns verified source through Blockscout's API — confirming what the [hoodchain SDK's own source comments](https://github.com/nirholas/robinhood-chain-sdk/blob/main/src/launchpads.ts) already note: *"neither publishes verified source on Blockscout."* That's why the SDK ships **event ABIs only** (for the read/watch path you used above) and no write-function ABI for either factory — extracting one would mean either reverse-engineering calldata from real launch transactions or asking the platforms directly, and doing that with unverified confidence long enough to publish it as "the" launch function would risk shipping guessed calldata that either fails or, worse, succeeds with the wrong parameters.

:::warning We will not publish a guessed function signature
It would be easy to fill this section with a plausible-looking `createToken(name, symbol, supply, ...)` call. It would also be irresponsible: an unverified guess at a factory's write interface, if wrong, can burn real gas on a failed transaction or — worse — succeed with parameters you didn't intend (wrong fee tier, wrong initial liquidity split, wrong lock terms). This course only ships code that was actually run and verified. For the launch-transaction write path specifically, that bar isn't met yet.
:::

## The responsible path today

Until a launch factory's write ABI is verified from a primary source, the correct way to launch a token on NOXA or The Odyssey is through **the platform's own front-end** (fun.noxa.fi/robinhood, theodyssey.fun) — it already encodes the correct calldata, has been tested against the live contract by its own team, and gives you a UI to review exactly what you're about to deploy before you sign. That's not a cop-out; it's the same advice you'd give anyone about to send a transaction to a contract they don't have a verified interface for.

If you want to pursue the programmatic path yourself: launch a token through the front-end **once**, on testnet, with a throwaway wallet, then pull the transaction's calldata from the explorer and decode it against the four-byte selector directory or by testing candidate ABIs against `eth_call` in simulation. That reverse-engineering work is exactly what standing up a verified, publishable write-ABI would require — and it's future work this course is flagging rather than rushing.

## What a launch monitor *is* good for right now

None of the above weakens the read side. A production-quality launch monitor — alerting, filtering by creator reputation, feeding a trading bot's universe of new tokens — is fully buildable today with the event decoding shown above and in Tutorial 7. That's most of what "reacting to launches" actually means in practice; only the "originate a new launch from my own code" half has the gap described here.

## Troubleshooting

**I found a write ABI for one of these factories elsewhere** — verify it against a real `eth_call` simulation before trusting it (Tutorial 6 covers `simulateContract`-style verification for swaps; the same discipline applies here). If it's a real, verified interface, it belongs in an update to the SDK's `launchpads.ts`, not a one-off script.

**`watchCurveTrades` never fires for a NOXA token** — expected. NOXA has no bonding curve; its tokens trade as ordinary Uniswap v3 swaps from launch, which you'd track with `watchTransfers` (Tutorial 7) on the token itself, not curve events.

**I want historical curve trade volume for a specific token** — use `client.public.getLogs` directly with `odysseyTradedEvent` and an `args: { token }` filter over a historical block range, following the pattern from `getRecentLaunches` in Tutorial 7.

## What you built

A launch monitor covering both platforms' full event surface, and — just as valuably — a documented, honest boundary around what's safely automatable today versus what still requires a human at the platform's own front-end. Knowing where that line is is worth more than a script that pretends it isn't there. Next: the capstone — taking everything you've built and actually shipping it.
