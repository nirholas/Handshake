import { describe, expect, it } from 'vitest'
import { numberToHex } from 'viem'
import { robinhood as viemRobinhood, robinhoodTestnet as viemRobinhoodTestnet } from 'viem/chains'
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  chainForNetwork,
  robinhood,
  robinhoodTestnet,
  toAddChainParams,
} from '../src/index.js'

/**
 * Chain parameters must be provably DERIVED from viem's official chain
 * definitions, never hand-copied. Every expectation below is computed from
 * the viem import at test time, so a viem update that changes an RPC URL or
 * explorer would flow through automatically (and a hand-copied value would
 * fail here).
 */
describe('chain params derive from viem', () => {
  it('re-exports viem chain objects by reference (no copies)', () => {
    expect(robinhood).toBe(viemRobinhood)
    expect(robinhoodTestnet).toBe(viemRobinhoodTestnet)
    expect(chainForNetwork('mainnet')).toBe(viemRobinhood)
    expect(chainForNetwork('testnet')).toBe(viemRobinhoodTestnet)
    expect(chainForNetwork()).toBe(viemRobinhood)
  })

  it('chain ID constants come from the viem defs', () => {
    expect(ROBINHOOD_CHAIN_ID).toBe(viemRobinhood.id)
    expect(ROBINHOOD_TESTNET_CHAIN_ID).toBe(viemRobinhoodTestnet.id)
    // Sanity anchors for the two networks this kit exists for.
    expect(viemRobinhood.id).toBe(4663)
    expect(viemRobinhoodTestnet.id).toBe(46630)
  })

  it.each([
    ['mainnet', viemRobinhood],
    ['testnet', viemRobinhoodTestnet],
  ] as const)('EIP-3085 params for %s are computed from the viem def', (_label, chain) => {
    const params = toAddChainParams(chain)
    expect(params.chainId).toBe(numberToHex(chain.id))
    expect(params.chainName).toBe(chain.name)
    expect(params.nativeCurrency).toEqual(chain.nativeCurrency)
    expect(params.rpcUrls).toEqual(chain.rpcUrls.default.http)
    expect(params.blockExplorerUrls).toEqual([chain.blockExplorers!.default.url])
  })

  it('mainnet params match the EIP-3085 wire format wallets expect', () => {
    const params = toAddChainParams(viemRobinhood)
    expect(params.chainId).toMatch(/^0x[0-9a-f]+$/)
    expect(params.chainId).toBe('0x1237')
    expect(params.nativeCurrency.decimals).toBe(18)
    expect(params.rpcUrls.length).toBeGreaterThan(0)
    for (const url of params.rpcUrls) expect(url).toMatch(/^https:\/\//)
  })

  it('omits blockExplorerUrls for chains without an explorer', () => {
    const bare = { ...viemRobinhood, blockExplorers: undefined }
    const params = toAddChainParams(bare)
    expect(params.blockExplorerUrls).toBeUndefined()
  })
})
