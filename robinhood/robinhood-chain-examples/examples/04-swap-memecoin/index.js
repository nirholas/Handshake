/**
 * 04 — Quote and execute a Uniswap v3 swap on Robinhood Chain testnet (46630).
 *
 * The quote is a read (works with no wallet). Execution needs a funded testnet
 * account: set ROBINHOOD_CHAIN_PRIVATE_KEY and drip testnet ETH from the faucet
 * (https://faucet.testnet.chain.robinhood.com/). Without a key, this prints the
 * quote and stops — it never fabricates a transaction.
 *
 * Testnet has one liquid pool (WETH/NFLX 0.05%), so we swap a little WETH for
 * NFLX. On MAINNET the identical code swaps memecoins from NOXA / The Odyssey —
 * pass their token addresses as tokenOut and drop `chain: 'testnet'`.
 *
 * Run:
 *   node index.js                 # quote only
 *   ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js --execute
 */
import { createHoodClient, quoteSwap, executeSwap, TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS } from 'hoodchain'
import { parseEther, formatEther, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const AMOUNT_IN = parseEther('0.001') // 0.001 testnet WETH
const tokenIn = TESTNET_ADDRESSES.weth
const tokenOut = TESTNET_STOCK_TOKENS.NFLX
const execute = process.argv.includes('--execute')
const key = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY

// --- read-only quote --------------------------------------------------------
const reader = createHoodClient({ chain: 'testnet' })
const quote = await quoteSwap(reader, { tokenIn, tokenOut, amountIn: AMOUNT_IN })

console.log('Robinhood Chain testnet (46630) — Uniswap v3 quote')
console.log(`  in : ${formatEther(AMOUNT_IN)} WETH  (${tokenIn})`)
console.log(`  out: ${formatUnits(quote.amountOut, 18)} NFLX  (${tokenOut})`)
console.log(`  route: ${quote.route.path.length - 1} hop, fee tier(s) ${quote.route.fees.join('/')}`)
console.log(`  quoter gas estimate: ${quote.gasEstimate}`)

if (!execute) {
  console.log('\nQuote only. Re-run with --execute and a funded ROBINHOOD_CHAIN_PRIVATE_KEY to swap.')
  process.exit(0)
}

// --- execution (guarded) ----------------------------------------------------
if (!key) {
  console.error('\n✗ --execute needs ROBINHOOD_CHAIN_PRIVATE_KEY set to a funded testnet key.')
  console.error('  Get testnet ETH: https://faucet.testnet.chain.robinhood.com/')
  process.exit(1)
}

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const hood = createHoodClient({ chain: 'testnet', account })

const balance = await hood.public.getBalance({ address: account.address })
console.log(`\nAccount ${account.address}  balance ${formatEther(balance)} ETH`)
if (balance < AMOUNT_IN) {
  console.error(`✗ Insufficient balance to swap ${formatEther(AMOUNT_IN)} WETH + gas. Fund the account first.`)
  process.exit(1)
}

console.log('Swapping…')
const { hash, receipt, amountOutMinimum } = await executeSwap(hood, { tokenIn, tokenOut, amountIn: AMOUNT_IN })
console.log(`✓ tx ${hash}`)
console.log(`  block ${receipt.blockNumber}  status ${receipt.status}  min out ${formatUnits(amountOutMinimum, 18)} NFLX`)
console.log(`  explorer: https://explorer.testnet.chain.robinhood.com/tx/${hash}`)
