import { describe, expect, it } from 'vitest'
import { fundingOptionsFor } from '../src/index.js'

describe('fundingOptionsFor', () => {
  it('mainnet: bridge first, then the Robinhood app path', () => {
    const options = fundingOptionsFor('mainnet')
    expect(options.map((o) => o.id)).toEqual(['bridge', 'robinhood-app'])
    for (const option of options) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.description.length).toBeGreaterThan(20)
    }
  })

  it('testnet: both faucets with working URLs', () => {
    const options = fundingOptionsFor('testnet')
    expect(options.map((o) => o.id)).toEqual(['faucet', 'chainlink-faucet'])
    expect(options[0]!.url).toBe('https://faucet.testnet.chain.robinhood.com/')
    expect(options[1]!.url).toBe('https://faucets.chain.link/robinhood-testnet')
  })
})
