/**
 * Plan and dry-run a TWAP swap: slice a large USDG → WETH order across time,
 * quoting and `eth_call`-simulating each slice without ever sending a
 * transaction.
 *
 * Run: npx tsx examples/twap-dry-run.ts [TOTAL_USDG]
 *
 * The planning + quoting stage needs no wallet. The `eth_call` simulation
 * stage is a REAL execution attempt (just not broadcast) — like a real swap,
 * it reverts if the simulating account doesn't actually hold `tokenIn` and
 * hasn't approved the router. Set `ROBINHOOD_CHAIN_PRIVATE_KEY` to a funded
 * key to see slices actually simulate successfully; without one, this script
 * still runs end-to-end and explains the expected revert below.
 */
import { createHoodClient, MAINNET_ADDRESSES, parseUsdg } from 'hoodchain'
import { privateKeyToAccount } from 'viem/accounts'
import { createTwapExecutor, SpendCap } from '../src/index.js'

const key = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}` | undefined
const account = key ? privateKeyToAccount(key) : undefined
const hood = createHoodClient(account ? { account } : {})
const totalUsdg = process.argv[2] ?? '500'

const twap = createTwapExecutor(hood, {
  tokenIn: MAINNET_ADDRESSES.usdg,
  tokenOut: MAINNET_ADDRESSES.weth,
  totalAmountIn: parseUsdg(totalUsdg),
  slices: 5,
  intervalMs: 0, // examples run fast; real usage would space slices minutes apart
  spendCap: new SpendCap(parseUsdg(totalUsdg)),
  // No funded key: this client has no wallet, so give buildSwapTx an explicit
  // recipient — planning/simulating a swap needs no signing key, just an
  // address for the output to land on (irrelevant to whether it reverts).
  recipient: account ? undefined : '0x000000000000000000000000000000000000dEaD',
})

console.log(`Planning a ${totalUsdg} USDG → WETH TWAP over 5 slices:\n`)
for (const slice of twap.plan()) {
  console.log(`  slice ${slice.index + 1}/${slice.total}: ${(Number(slice.amountIn) / 1e6).toFixed(2)} USDG`)
}

console.log(
  account
    ? `\nRunning in dry-run mode against a REAL funded account (${account.address}) — expect real simulated fills...\n`
    : '\nRunning in dry-run mode with no wallet configured. Each slice still gets a REAL quote and a REAL eth_call\n' +
        'simulation against the live router — exactly like a real swap, so it reverts with "STF" (Safe Transfer\n' +
        'Failed) because the simulating account holds no USDG. That revert IS the proof the simulation is real,\n' +
        'not faked. Set ROBINHOOD_CHAIN_PRIVATE_KEY to a funded key to see successful simulated fills.\n',
)

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
