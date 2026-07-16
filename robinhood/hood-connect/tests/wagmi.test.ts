import { describe, expect, it } from 'vitest'
import { robinhood, robinhoodTestnet } from 'viem/chains'
import { hoodWagmiConfig } from '../src/wagmi/index.js'

describe('hoodWagmiConfig', () => {
  it('registers Robinhood Chain mainnet from the viem def', () => {
    const config = hoodWagmiConfig()
    expect(config.chains).toHaveLength(1)
    expect(config.chains[0]).toBe(robinhood)
  })

  it('adds the testnet on request', () => {
    const config = hoodWagmiConfig({ includeTestnet: true })
    expect(config.chains.map((c) => c.id)).toEqual([robinhood.id, robinhoodTestnet.id])
    expect(config.chains[0]).toBe(robinhood)
    expect(config.chains[1]).toBe(robinhoodTestnet)
  })

  it('keeps EIP-6963 multi-injected discovery enabled', () => {
    const config = hoodWagmiConfig()
    // wagmi defaults multiInjectedProviderDiscovery to true; the config must
    // not disable it (that is the whole point of a connect kit).
    expect(config._internal.mipd).toBeTruthy()
  })
})
