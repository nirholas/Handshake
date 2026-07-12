import { describe, expect, it } from 'vitest'
import { MAINNET_ADDRESSES, TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS, type HoodClient } from 'hoodchain'
import { HoodError } from '../../src/errors.js'
import { isStockRef, resolveToken } from '../../src/tokens.js'

function fakeClient(network: 'mainnet' | 'testnet'): HoodClient {
  return {
    network,
    chain: { id: network === 'mainnet' ? 4663 : 46630 },
    public: {},
    wallet: null,
    account: null,
    acknowledgeStockTokenEligibility: false,
  } as unknown as HoodClient
}

describe('resolveToken — offline paths (no network call)', () => {
  it('resolves "USDG" to the network USDG address at 6 decimals', async () => {
    const mainnet = await resolveToken(fakeClient('mainnet'), 'USDG')
    expect(mainnet).toEqual({ address: MAINNET_ADDRESSES.usdg, decimals: 6, label: 'USDG' })
    const testnet = await resolveToken(fakeClient('testnet'), 'usdg')
    expect(testnet.address).toBe(TESTNET_ADDRESSES.usdg)
  })

  it('resolves "WETH" and "ETH" identically to the network WETH', async () => {
    const weth = await resolveToken(fakeClient('mainnet'), 'WETH')
    const eth = await resolveToken(fakeClient('mainnet'), 'eth')
    expect(weth.address).toBe(MAINNET_ADDRESSES.weth)
    expect(eth.address).toBe(MAINNET_ADDRESSES.weth)
    expect(weth.label).toBe('WETH')
  })

  it('resolves a mainnet Stock Token ticker case-insensitively', async () => {
    const t = await resolveToken(fakeClient('mainnet'), 'aapl')
    expect(t.label).toBe('AAPL')
    expect(t.decimals).toBe(18)
    expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('resolves a testnet Stock Token from the fixed faucet set', async () => {
    const t = await resolveToken(fakeClient('testnet'), 'NFLX')
    expect(t.address).toBe(TESTNET_STOCK_TOKENS.NFLX)
  })

  it('rejects a mainnet-only ticker on testnet with a helpful list', async () => {
    await expect(resolveToken(fakeClient('testnet'), 'AAPL')).rejects.toThrow(HoodError)
    await expect(resolveToken(fakeClient('testnet'), 'AAPL')).rejects.toThrow(/NFLX/)
  })

  it('rejects an unknown symbol on mainnet', async () => {
    await expect(resolveToken(fakeClient('mainnet'), 'NOTREAL')).rejects.toThrow(HoodError)
  })

  it('rejects empty/blank input before any lookup', async () => {
    await expect(resolveToken(fakeClient('mainnet'), '')).rejects.toThrow(HoodError)
    await expect(resolveToken(fakeClient('mainnet'), '   ')).rejects.toThrow(HoodError)
  })
})

describe('isStockRef', () => {
  it('is true for a known mainnet Stock Token ticker', () => {
    expect(isStockRef(fakeClient('mainnet'), 'tsla')).toBe(true)
  })
  it('is false for USDG/WETH and for raw addresses', () => {
    expect(isStockRef(fakeClient('mainnet'), 'USDG')).toBe(false)
    expect(isStockRef(fakeClient('mainnet'), MAINNET_ADDRESSES.weth)).toBe(false)
  })
  it('is false for an unknown symbol', () => {
    expect(isStockRef(fakeClient('mainnet'), 'NOTREAL')).toBe(false)
  })
})
