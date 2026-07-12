import { describe, expect, it } from 'vitest'
import { createHoodClient, MAINNET_ADDRESSES, TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS } from 'hoodchain'
import { resolveToken } from '../../src/resolve.js'

describe('resolveToken (mainnet, offline-safe symbols)', () => {
  const client = createHoodClient()

  it('resolves USDG to the mainnet address with 6 decimals', async () => {
    const t = await resolveToken(client, 'usdg')
    expect(t.address.toLowerCase()).toBe(MAINNET_ADDRESSES.usdg.toLowerCase())
    expect(t.decimals).toBe(6)
    expect(t.isStock).toBe(false)
  })

  it('resolves WETH and ETH to the same address', async () => {
    const weth = await resolveToken(client, 'WETH')
    const eth = await resolveToken(client, 'eth')
    expect(weth.address).toBe(eth.address)
    expect(weth.address.toLowerCase()).toBe(MAINNET_ADDRESSES.weth.toLowerCase())
  })

  it('resolves a canonical Stock Token ticker case-insensitively', async () => {
    const t = await resolveToken(client, 'aapl')
    expect(t.symbol).toBe('AAPL')
    expect(t.isStock).toBe(true)
    expect(t.hasFeed).toBe(true)
  })

  it('rejects an invalid non-address, non-ticker string', async () => {
    await expect(resolveToken(client, 'NOT_A_REAL_TICKER')).rejects.toThrow(/Unknown token/)
  })

  it('rejects a malformed 0x-prefixed string as invalid, not unknown', async () => {
    await expect(resolveToken(client, '0xnotanaddress')).rejects.toThrow(/not a valid address/)
  })
})

describe('resolveToken (testnet)', () => {
  const client = createHoodClient({ chain: 'testnet' })

  it('resolves testnet USDG to the testnet address', async () => {
    const t = await resolveToken(client, 'USDG')
    expect(t.address.toLowerCase()).toBe(TESTNET_ADDRESSES.usdg.toLowerCase())
  })

  it('resolves a faucet-dripped testnet Stock Token', async () => {
    const t = await resolveToken(client, 'NFLX')
    expect(t.address.toLowerCase()).toBe(TESTNET_STOCK_TOKENS.NFLX.toLowerCase())
    expect(t.isStock).toBe(true)
    expect(t.hasFeed).toBe(false) // testnet tokens carry no Chainlink feed
  })

  it('does not resolve a mainnet-only ticker on testnet', async () => {
    await expect(resolveToken(client, 'AAPL')).rejects.toThrow(/Unknown token/)
  })
})
