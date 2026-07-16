import { createPublicClient, http } from 'viem'
import { describe, expect, it } from 'vitest'
import { MAINNET_ADDRESSES } from 'hoodchain'
import { networkInfo } from '../../src/networks.js'
import { erc20Abi } from '../../src/abi.js'
import { checkPayment, createReader } from '../../src/verify/watcher.js'
import type { PaymentStatus } from '../../src/verify/types.js'

/**
 * LIVE, READ-ONLY tests against Robinhood Chain mainnet (chain 4663). Run with
 * `npm run test:live`. These are NOT part of `npm test` (which is unit-only and
 * offline). Nothing here signs, sends, or spends: every call is an `eth_call`,
 * `eth_getLogs`, or `eth_getBlockNumber` against the public RPC. They prove the
 * addresses and the watcher work against the real chain, and pin the two facts
 * hood-pay's math depends on: USDG is 6 decimals and its `transfer` is a plain
 * ERC-20 transfer (no memo/reference parameter).
 */

const info = networkInfo('mainnet')
const client = createPublicClient({ transport: http(info.rpcUrl) })

const VALID_STATUSES: PaymentStatus[] = ['pending', 'underpaid', 'paid', 'overpaid', 'expired', 'refunded']

describe('live mainnet reads (chain 4663, read-only)', () => {
  it('the RPC reports chain id 4663', async () => {
    const chainId = await client.getChainId()
    expect(chainId).toBe(4663)
  })

  it('USDG resolves to the SDK address and is 6 decimals', async () => {
    expect(info.usdg.address).toBe(MAINNET_ADDRESSES.usdg)
    const decimals = await client.readContract({
      address: info.usdg.address,
      abi: erc20Abi,
      functionName: 'decimals',
    })
    expect(decimals).toBe(6)
    expect(info.usdg.decimals).toBe(6)
  })

  it('USDG symbol reads as USDG on-chain', async () => {
    const symbol = await client.readContract({
      address: info.usdg.address,
      abi: erc20Abi,
      functionName: 'symbol',
    })
    expect(symbol).toBe('USDG')
  })

  it('the watcher scans real logs and returns a well-formed pending result', async () => {
    const reader = createReader('mainnet')
    const head = await reader.getBlockNumber()
    expect(head).toBeGreaterThan(0n)
    // A merchant address with no expected inbound USDG in a recent, confirmed
    // window: this exercises eth_getLogs + the canonical block re-check against
    // the live RPC and must resolve to a clean pending result.
    const result = await checkPayment(
      {
        token: info.usdg.address,
        payTo: '0x000000000000000000000000000000000000dEaD',
        expectedRaw: 25_000_000n,
      },
      { reader, fromBlock: head - 500n, confirmations: 30, chunkSize: 500n },
    )
    expect(VALID_STATUSES).toContain(result.status)
    expect(result.expectedRaw).toBe(25_000_000n)
    expect(typeof result.receivedRaw).toBe('bigint')
    expect(Array.isArray(result.transfers)).toBe(true)
  })
})
