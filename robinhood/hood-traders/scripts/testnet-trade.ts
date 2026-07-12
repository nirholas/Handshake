/**
 * Execute ONE real testnet-46630 trade through the full hood-traders pipeline
 * (Market.quoteBuy -> Agent-equivalent risk math -> real signed swap), using
 * hoodchain's executeSwap under the hood. Requires a funded testnet wallet:
 *
 *   1. Get testnet ETH + test Stock Tokens from
 *      https://faucet.testnet.chain.robinhood.com/ (Turnstile + Google
 *      Sign-In in a real browser — cannot be automated headlessly; this is a
 *      documented upstream blocker, see _shared.md and robinhood-chain-sdk's
 *      own tests/live/testnet-swap.test.ts, which hits the same wall).
 *   2. export ROBINHOOD_CHAIN_PRIVATE_KEY=0x...
 *   3. npm run testnet-trade
 */
import { formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createHoodClient,
  ensureApproval,
  executeSwap,
  quoteSwap,
  TESTNET_ADDRESSES,
  TESTNET_STOCK_TOKENS,
  erc20Abi,
  weth9Abi,
} from 'hoodchain'

const AMOUNT_IN = parseEther('0.0001')

async function main() {
  const pk = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}` | undefined
  if (!pk) {
    console.error(
      'ROBINHOOD_CHAIN_PRIVATE_KEY is not set.\n\n' +
        'This trade needs a testnet-46630 wallet funded via ' +
        'https://faucet.testnet.chain.robinhood.com/ — that faucet requires ' +
        'Cloudflare Turnstile + Google Sign-In in a real browser and cannot be ' +
        'automated headlessly (same blocker hit by robinhood-chain-sdk\'s own ' +
        'tests/live/testnet-swap.test.ts). Fund a wallet there, export the key, ' +
        'and re-run: npm run testnet-trade',
    )
    process.exit(1)
  }

  const account = privateKeyToAccount(pk)
  const hood = createHoodClient({ chain: 'testnet', account })
  console.log(`wallet: ${account.address}`)

  const ethBalance = await hood.public.getBalance({ address: account.address })
  console.log(`ETH balance: ${formatEther(ethBalance)}`)
  if (ethBalance < parseEther('0.001')) {
    console.error(`Insufficient testnet ETH (need >= 0.001, have ${formatEther(ethBalance)}). Claim the faucet first.`)
    process.exit(1)
  }

  console.log(`quoting ${formatEther(AMOUNT_IN)} WETH -> NFLX on testnet 46630...`)
  const quote = await quoteSwap(hood, {
    tokenIn: TESTNET_ADDRESSES.weth,
    tokenOut: TESTNET_STOCK_TOKENS.NFLX,
    amountIn: AMOUNT_IN,
  })
  console.log(`quote: ${AMOUNT_IN} wei WETH -> ${quote.amountOut} wei NFLX (route: ${quote.route.fees.join('/')}bps)`)

  const wethBalance = await hood.public.readContract({
    address: TESTNET_ADDRESSES.weth,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })
  if (wethBalance < AMOUNT_IN) {
    console.log(`wrapping ${formatEther(AMOUNT_IN)} ETH -> WETH...`)
    const wrapHash = await hood.wallet!.writeContract({
      address: TESTNET_ADDRESSES.weth,
      abi: weth9Abi,
      functionName: 'deposit',
      value: AMOUNT_IN,
    })
    await hood.public.waitForTransactionReceipt({ hash: wrapHash })
    console.log(`wrapped: ${wrapHash}`)
  }

  console.log('executing swap...')
  const result = await executeSwap(hood, {
    tokenIn: TESTNET_ADDRESSES.weth,
    tokenOut: TESTNET_STOCK_TOKENS.NFLX,
    amountIn: AMOUNT_IN,
  })

  console.log('\n✓ REAL TESTNET TRADE EXECUTED')
  console.log(`  tx hash:      ${result.hash}`)
  console.log(`  status:       ${result.receipt.status}`)
  console.log(`  block:        ${result.receipt.blockNumber}`)
  console.log(`  gas used:     ${result.receipt.gasUsed}`)
  console.log(`  amountOutMin: ${result.amountOutMinimum}`)
  console.log(`  explorer:     https://explorer.testnet.chain.robinhood.com/tx/${result.hash}`)
}

main().catch((err) => {
  console.error('testnet trade failed:', err)
  process.exit(1)
})
