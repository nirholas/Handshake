import { describe, expect, it } from 'vitest'
import { setConfigValue, redactedConfig, type HoodConfig } from '../../src/config.js'

describe('setConfigValue', () => {
  it('accepts a valid network', () => {
    const next = setConfigValue({}, 'network', 'testnet')
    expect(next.network).toBe('testnet')
  })

  it('rejects an invalid network value', () => {
    expect(() => setConfigValue({}, 'network', 'devnet')).toThrow(/mainnet.*testnet/)
  })

  it('parses maxSpendUsd as a number', () => {
    const next = setConfigValue({}, 'maxSpendUsd', '250.5')
    expect(next.maxSpendUsd).toBe(250.5)
  })

  it('rejects a negative maxSpendUsd', () => {
    expect(() => setConfigValue({}, 'maxSpendUsd', '-10')).toThrow(/non-negative/)
  })

  it('rejects a non-numeric maxSpendUsd', () => {
    expect(() => setConfigValue({}, 'maxSpendUsd', 'a lot')).toThrow(/non-negative/)
  })

  it('rejects an unknown key', () => {
    expect(() => setConfigValue({}, 'bogus', 'x')).toThrow(/Unknown config key/)
  })

  it('does not mutate the input config', () => {
    const original: HoodConfig = { network: 'mainnet' }
    const next = setConfigValue(original, 'network', 'testnet')
    expect(original.network).toBe('mainnet')
    expect(next.network).toBe('testnet')
  })
})

describe('redactedConfig', () => {
  it('masks the alchemy key', () => {
    const view = redactedConfig({ alchemyKey: 'abcdefghijklmnop' })
    expect(view.alchemyKey).toBe('abc…nop')
    expect(view.alchemyKey).not.toContain('def')
  })

  it('never leaks a private key field', () => {
    const view = redactedConfig({ walletAddress: '0xabc' })
    expect(JSON.stringify(view)).not.toMatch(/privateKey/i)
  })

  it('reports null for unset optional fields', () => {
    const view = redactedConfig({})
    expect(view.rpc).toBeNull()
    expect(view.walletAddress).toBeNull()
  })
})
