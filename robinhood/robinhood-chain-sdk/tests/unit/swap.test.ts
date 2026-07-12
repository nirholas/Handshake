import { describe, expect, it } from 'vitest'
import { decodeFunctionData, parseEther, type Address } from 'viem'
import { buildSwapTx, swapAddresses } from '../../src/swap.js'
import { swapRouter02Abi, swapRouterAbi } from '../../src/abis.js'
import { MAINNET_ADDRESSES, TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS } from '../../src/addresses.js'
import { getStockToken } from '../../src/registry/index.js'
import { StockTokenEligibilityError, NoAccountError } from '../../src/errors.js'
import type { HoodClient } from '../../src/client.js'
import type { SwapQuote } from '../../src/swap.js'

const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address

function fakeClient(network: 'mainnet' | 'testnet', acknowledge = false): HoodClient {
  return {
    network,
    chain: { id: network === 'mainnet' ? 4663 : 46630 },
    public: {},
    wallet: null,
    account: null,
    acknowledgeStockTokenEligibility: acknowledge,
  } as unknown as HoodClient
}

function quoteFor(path: Address[], fees: number[], amountIn: bigint, amountOut: bigint): SwapQuote {
  // encodedPath only matters for multi-hop decode assertions below
  const encodedPath = `0x${path
    .map((p, i) => p.slice(2) + (i < fees.length ? (fees[i] as number).toString(16).padStart(6, '0') : ''))
    .join('')}` as `0x${string}`
  return { route: { path, fees, encodedPath }, amountIn, amountOut, gasEstimate: 100000n }
}

describe('buildSwapTx — SwapRouter02 (mainnet)', () => {
  const client = fakeClient('mainnet')
  const usdgToWeth = quoteFor(
    [MAINNET_ADDRESSES.usdg, MAINNET_ADDRESSES.weth],
    [500],
    100_000_000n,
    parseEther('0.055'),
  )

  it('wraps the swap in multicall(deadline, [exactInputSingle])', () => {
    const tx = buildSwapTx(client, usdgToWeth, { recipient: RECIPIENT })
    expect(tx.to).toBe(MAINNET_ADDRESSES.swapRouter02)
    const outer = decodeFunctionData({ abi: swapRouter02Abi, data: tx.data })
    expect(outer.functionName).toBe('multicall')
    const [deadline, calls] = outer.args as [bigint, `0x${string}`[]]
    expect(deadline).toBe(tx.deadline)
    expect(Number(deadline)).toBeGreaterThan(Date.now() / 1000)
    const inner = decodeFunctionData({ abi: swapRouter02Abi, data: (calls as `0x${string}`[])[0] as `0x${string}` })
    expect(inner.functionName).toBe('exactInputSingle')
    const params = (inner.args as readonly unknown[])[0] as {
      tokenIn: Address
      tokenOut: Address
      fee: number
      recipient: Address
      amountIn: bigint
      amountOutMinimum: bigint
    }
    expect(params.tokenIn).toBe(MAINNET_ADDRESSES.usdg)
    expect(params.tokenOut).toBe(MAINNET_ADDRESSES.weth)
    expect(params.fee).toBe(500)
    expect(params.recipient).toBe(RECIPIENT)
    expect(params.amountIn).toBe(100_000_000n)
  })

  it('applies slippage in basis points to amountOutMinimum', () => {
    const tx = buildSwapTx(client, usdgToWeth, { recipient: RECIPIENT, slippageBps: 100 })
    expect(tx.amountOutMinimum).toBe((usdgToWeth.amountOut * 9900n) / 10_000n)
    const tight = buildSwapTx(client, usdgToWeth, { recipient: RECIPIENT, slippageBps: 0 })
    expect(tight.amountOutMinimum).toBe(usdgToWeth.amountOut)
  })

  it('uses exactInput for multi-hop routes', () => {
    const multiHop = quoteFor(
      [MAINNET_ADDRESSES.usdg, MAINNET_ADDRESSES.weth, '0x3333333333333333333333333333333333333333' as Address],
      [500, 3000],
      100_000_000n,
      1n,
    )
    const tx = buildSwapTx(client, multiHop, { recipient: RECIPIENT })
    const outer = decodeFunctionData({ abi: swapRouter02Abi, data: tx.data })
    const calls = (outer.args as [bigint, `0x${string}`[]])[1]
    const inner = decodeFunctionData({ abi: swapRouter02Abi, data: calls[0] as `0x${string}` })
    expect(inner.functionName).toBe('exactInput')
  })

  it('requires a recipient or account', () => {
    expect(() => buildSwapTx(client, usdgToWeth)).toThrowError(NoAccountError)
  })
})

describe('buildSwapTx — classic SwapRouter (testnet)', () => {
  const client = fakeClient('testnet')

  it('puts the deadline inside the params struct', () => {
    const quote = quoteFor(
      [TESTNET_ADDRESSES.weth, TESTNET_STOCK_TOKENS.NFLX],
      [500],
      parseEther('0.0001'),
      parseEther('2'),
    )
    const tx = buildSwapTx(client, quote, { recipient: RECIPIENT, deadlineSeconds: 300 })
    expect(tx.to).toBe(TESTNET_ADDRESSES.swapRouter)
    const decoded = decodeFunctionData({ abi: swapRouterAbi, data: tx.data })
    expect(decoded.functionName).toBe('exactInputSingle')
    const params = (decoded.args as readonly unknown[])[0] as { deadline: bigint; tokenOut: Address }
    expect(params.deadline).toBe(tx.deadline)
    expect(params.tokenOut).toBe(TESTNET_STOCK_TOKENS.NFLX)
  })
})

describe('Stock Token eligibility gate', () => {
  const tsla = getStockToken('TSLA')

  it('refuses to build a mainnet swap INTO a Stock Token without acknowledgement', () => {
    const client = fakeClient('mainnet')
    const quote = quoteFor([MAINNET_ADDRESSES.usdg, tsla.address], [3000], 100_000_000n, 1n)
    expect(() => buildSwapTx(client, quote, { recipient: RECIPIENT })).toThrowError(
      StockTokenEligibilityError,
    )
  })

  it('builds the same swap once the operator acknowledged eligibility', () => {
    const client = fakeClient('mainnet', true)
    const quote = quoteFor([MAINNET_ADDRESSES.usdg, tsla.address], [3000], 100_000_000n, 1n)
    expect(() => buildSwapTx(client, quote, { recipient: RECIPIENT })).not.toThrow()
  })

  it('never gates SELLING a Stock Token', () => {
    const client = fakeClient('mainnet')
    const quote = quoteFor([tsla.address, MAINNET_ADDRESSES.usdg], [3000], parseEther('1'), 1n)
    expect(() => buildSwapTx(client, quote, { recipient: RECIPIENT })).not.toThrow()
  })
})

describe('swapAddresses', () => {
  it('resolves the verified per-network router flavors', () => {
    expect(swapAddresses(fakeClient('mainnet'))).toMatchObject({
      router: MAINNET_ADDRESSES.swapRouter02,
      routerKind: 'swapRouter02',
    })
    expect(swapAddresses(fakeClient('testnet'))).toMatchObject({
      router: TESTNET_ADDRESSES.swapRouter,
      routerKind: 'swapRouter',
    })
  })
})
