/**
 * Execute a REAL swap on Robinhood Chain testnet (46630): wrap faucet ETH
 * into WETH, then swap WETH → NFLX through the testnet Uniswap v3 router.
 *
 * Prerequisites:
 *  1. Fund a wallet at https://faucet.testnet.chain.robinhood.com/
 *     (drips 0.01 ETH + five of each test Stock Token; needs a browser —
 *     the faucet sits behind Cloudflare Turnstile + Google Sign-In).
 *  2. export ROBINHOOD_CHAIN_PRIVATE_KEY=0x…
 *
 * Run: npx tsx examples/swap-testnet.ts
 */
import { formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createHoodClient,
  executeSwap,
  weth9Abi,
  erc20Abi,
  TESTNET_ADDRESSES,
  TESTNET_STOCK_TOKENS,
} from 'hoodchain'

const pk = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY
if (!pk) {
  console.error('Set ROBINHOOD_CHAIN_PRIVATE_KEY (a funded testnet key) first.')
  process.exit(1)
}

const account = privateKeyToAccount(pk as `0x${string}`)
const hood = createHoodClient({ chain: 'testnet', account })
const AMOUNT_IN = parseEther('0.0001')

const ethBalance = await hood.public.getBalance({ address: account.address })
console.log(`wallet ${account.address}: ${formatEther(ethBalance)} testnet ETH`)
if (ethBalance < parseEther('0.001')) {
  console.error('Balance too low — claim from https://faucet.testnet.chain.robinhood.com/ first.')
  process.exit(1)
}

// 1. wrap a slice of faucet ETH into WETH (the only liquid pool is NFLX/WETH)
const wethBalance = await hood.public.readContract({
  address: TESTNET_ADDRESSES.weth,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
})
if (wethBalance < AMOUNT_IN) {
  console.log(`wrapping ${formatEther(AMOUNT_IN)} ETH → WETH…`)
  const wrapHash = await hood.wallet!.writeContract({
    address: TESTNET_ADDRESSES.weth,
    abi: weth9Abi,
    functionName: 'deposit',
    value: AMOUNT_IN,
  })
  await hood.public.waitForTransactionReceipt({ hash: wrapHash })
  console.log(`wrapped: ${wrapHash}`)
}

// 2. swap WETH → NFLX (quote → approve → send → confirm)
const { hash, receipt, quote } = await executeSwap(hood, {
  tokenIn: TESTNET_ADDRESSES.weth,
  tokenOut: TESTNET_STOCK_TOKENS.NFLX,
  amountIn: AMOUNT_IN,
})
console.log(`quoted ${formatEther(AMOUNT_IN)} WETH → ${formatEther(quote.amountOut)} NFLX (fee tier ${quote.route.fees[0]})`)
console.log(`swap tx: ${hash} — status ${receipt.status}, block ${receipt.blockNumber}`)
console.log(`explorer: https://explorer.testnet.chain.robinhood.com/tx/${hash}`)

const nflx = await hood.public.readContract({
  address: TESTNET_STOCK_TOKENS.NFLX,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
})
console.log(`NFLX balance now: ${formatEther(nflx)}`)
