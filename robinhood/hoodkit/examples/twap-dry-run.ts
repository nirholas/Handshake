/**
 * Plan and dry-run a TWAP swap: slice a large USDG → WETH order across time,
 * quoting and `eth_call`-simulating each slice without ever sending a
 * transaction (no wallet key needed).
 *
 * Run: npx tsx examples/twap-dry-run.ts [TOTAL_USDG]
 */
import { createHoodClient, MAINNET_ADDRESSES, parseUsdg } from 'hoodchain'
import { createTwapExecutor, SpendCap } from '../src/index.js'

const hood = createHoodClient()
const totalUsdg = process.argv[2] ?? '500'

const twap = createTwapExecutor(hood, {
  tokenIn: MAINNET_ADDRESSES.usdg,
  tokenOut: MAINNET_ADDRESSES.weth,
  totalAmountIn: parseUsdg(totalUsdg),
  slices: 5,
  intervalMs: 0, // examples run fast; real usage would space slices minutes apart
  spendCap: new SpendCap(parseUsdg(totalUsdg)),
  // This client has no wallet (public reads only), so give buildSwapTx an
  // explicit recipient — planning/simulating a swap needs no signing key.
  recipient: '0x000000000000000000000000000000000000dEaD',
})

console.log(`Planning a ${totalUsdg} USDG → WETH TWAP over 5 slices:\n`)
for (const slice of twap.plan()) {
  console.log(`  slice ${slice.index + 1}/${slice.total}: ${(Number(slice.amountIn) / 1e6).toFixed(2)} USDG`)
}

console.log('\nRunning in dry-run mode (no wallet configured — every slice is quoted + eth_call-simulated, never sent)...\n')
const results = await twap.run()
for (const r of results) {
  const amount = (Number(r.amountIn) / 1e6).toFixed(2)
  if (r.status === 'simulated') {
    const out = r.quote ? (Number(r.quote.amountOut) / 1e18).toFixed(6) : 'n/a'
    console.log(`  slice ${r.index + 1}: SIMULATED — ${amount} USDG -> ~${out} WETH`)
  } else {
    console.log(`  slice ${r.index + 1}: ${r.status.toUpperCase()}${r.error ? ` (${r.error})` : ''}`)
  }
}
