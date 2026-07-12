/**
 * REAL testnet E2E through the five-line hood-js API: quote WETH → NFLX on
 * chain 46630, then execute the swap and confirm a real balance delta.
 *
 * Gated on ROBINHOOD_CHAIN_PRIVATE_KEY, same as the underlying hoodchain
 * SDK's own testnet-swap test — the official faucet
 * (https://faucet.testnet.chain.robinhood.com/) requires a browser session
 * with Cloudflare Turnstile + Google Sign-In and cannot be automated
 * headlessly. Fund a key there (0.01 ETH + test Stock Tokens, one claim per
 * 24h), export it, then: npm run test:live
 */
import { describe, expect, it } from 'vitest'
import hood from '../../src/index.js'

const pk = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}` | undefined

describe.skipIf(!pk)('live: testnet swap E2E via hood.quote + hood.swap', () => {
  it('quotes then swaps 0.0001 WETH → NFLX and receives tokens', async () => {
    hood.testnet()

    const q = await hood.quote({ sell: 'WETH', buy: 'NFLX', amount: '0.0001' })
    expect(Number(q.buyAmount)).toBeGreaterThan(0)

    const result = await hood.swap({ ...q, wallet: pk as `0x${string}` })
    expect(result.status).toBe('success')
    expect(Number(result.amountOut)).toBeGreaterThan(0)
    console.log(`testnet swap tx: ${result.url}`)
  }, 180_000)
})

describe('live: testnet read path (no wallet needed)', () => {
  it('quotes WETH → NFLX on the community testnet pool', async () => {
    hood.testnet()
    const q = await hood.quote({ sell: 'WETH', buy: 'NFLX', amount: '0.0001' })
    expect(q.sell).toBe('WETH')
    expect(q.buy).toBe('NFLX')
    expect(Number(q.buyAmount)).toBeGreaterThan(0)
    hood.mainnet()
  })
})
