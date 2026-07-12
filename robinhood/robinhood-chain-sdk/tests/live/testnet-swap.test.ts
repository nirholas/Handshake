/**
 * REAL testnet swap E2E — wraps faucet ETH and swaps WETH → NFLX through the
 * testnet Uniswap v3 router, asserting the receipt and balance delta.
 *
 * Gated on ROBINHOOD_CHAIN_PRIVATE_KEY because the faucet
 * (https://faucet.testnet.chain.robinhood.com/) requires a browser session
 * with Cloudflare Turnstile + Google Sign-In and cannot be automated
 * headlessly. Fund a key there (0.01 ETH + five of each test Stock Token,
 * one claim per 24h), export it, then: npm run test:live
 */
import { describe, expect, it } from 'vitest'
import { formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient } from '../../src/client.js'
import { executeSwap, quoteSwap } from '../../src/swap.js'
import { erc20Abi, weth9Abi } from '../../src/abis.js'
import { TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS } from '../../src/addresses.js'

const pk = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}` | undefined
const AMOUNT_IN = parseEther('0.0001')

describe.skipIf(!pk)('live: testnet swap E2E (requires funded ROBINHOOD_CHAIN_PRIVATE_KEY)', () => {
  it('quotes, wraps, swaps WETH → NFLX and receives tokens', async () => {
    const account = privateKeyToAccount(pk as `0x${string}`)
    const hood = createHoodClient({ chain: 'testnet', account })

    const ethBalance = await hood.public.getBalance({ address: account.address })
    expect(
      ethBalance >= parseEther('0.001'),
      `wallet ${account.address} holds ${formatEther(ethBalance)} ETH — claim the faucet first`,
    ).toBe(true)

    // quote must resolve through the community deployment's NFLX/WETH pool
    const quote = await quoteSwap(hood, {
      tokenIn: TESTNET_ADDRESSES.weth,
      tokenOut: TESTNET_STOCK_TOKENS.NFLX,
      amountIn: AMOUNT_IN,
    })
    expect(quote.amountOut).toBeGreaterThan(0n)

    // wrap gas ETH → WETH if short
    const weth = await hood.public.readContract({
      address: TESTNET_ADDRESSES.weth,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })
    if (weth < AMOUNT_IN) {
      const wrapHash = await hood.wallet!.writeContract({
        address: TESTNET_ADDRESSES.weth,
        abi: weth9Abi,
        functionName: 'deposit',
        value: AMOUNT_IN,
      })
      const wrapReceipt = await hood.public.waitForTransactionReceipt({ hash: wrapHash })
      expect(wrapReceipt.status).toBe('success')
    }

    const nflxBefore = await hood.public.readContract({
      address: TESTNET_STOCK_TOKENS.NFLX,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })

    const { hash, receipt } = await executeSwap(hood, {
      tokenIn: TESTNET_ADDRESSES.weth,
      tokenOut: TESTNET_STOCK_TOKENS.NFLX,
      amountIn: AMOUNT_IN,
    })
    expect(receipt.status).toBe('success')
    console.log(`testnet swap tx: https://explorer.testnet.chain.robinhood.com/tx/${hash}`)

    const nflxAfter = await hood.public.readContract({
      address: TESTNET_STOCK_TOKENS.NFLX,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })
    expect(nflxAfter - nflxBefore).toBeGreaterThan(0n)
  }, 180_000)
})
