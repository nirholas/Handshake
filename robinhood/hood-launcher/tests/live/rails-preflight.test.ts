import { describe, it, expect } from 'vitest'
import { createHoodClient } from 'hoodchain'
import { createRail } from '../../src/rails/index.js'
import type { LaunchInput } from '../../src/rails/types.js'

const PROBE: LaunchInput = {
  name: 'Probe',
  symbol: 'PROBE',
  description: '',
  logoUri: '',
  socials: {},
  initialBuyWei: 0n,
}

describe('live rail preflight — mainnet 4663', () => {
  const client = createHoodClient({ chain: 'mainnet' })

  it('NOXA reports a real on-chain launch fee and enabled flag', async () => {
    const rail = createRail('noxa')
    const preflight = await rail.preflight({ client }, PROBE)
    expect(preflight.rail).toBe('noxa')
    expect(preflight.network).toBe('mainnet')
    // launchFee() was 0.0005 ETH when this rail was built — assert it's a
    // sane positive value rather than hardcoding the exact figure, since the
    // operator can change it on-chain.
    expect(preflight.protocolFeeWei).toBeGreaterThan(0n)
    expect(typeof preflight.ready).toBe('boolean')
  })

  it('Odyssey instant + bonding factories both have live code', async () => {
    for (const variant of ['instant', 'bonding'] as const) {
      const rail = createRail('odyssey', variant)
      const preflight = await rail.preflight({ client }, PROBE)
      expect(preflight.ready).toBe(true)
      expect(preflight.blockers).toEqual([])
    }
  })
})

describe('live rail preflight — testnet 46630', () => {
  const client = createHoodClient({ chain: 'testnet' })

  it('direct rail resolves the community Uniswap v3 deployment', async () => {
    const rail = createRail('direct')
    const preflight = await rail.preflight(
      { client, direct: { seedWethWei: 1n } }, // 1 wei — just enough to pass the >0 check, no signer needed for this read
      PROBE,
    )
    expect(preflight.network).toBe('testnet')
    expect(preflight.pairToken).toBeDefined()
    // No signer is configured in this read-only client, so this blocker is expected.
    expect(preflight.blockers.some((b) => b.includes('No signer'))).toBe(true)
  })

  it('NOXA and Odyssey correctly report unavailable on testnet (no deployment exists)', async () => {
    const noxa = await createRail('noxa').preflight({ client }, PROBE)
    expect(noxa.ready).toBe(false)
    expect(noxa.blockers[0]).toMatch(/mainnet/i)

    const odyssey = await createRail('odyssey').preflight({ client }, PROBE)
    expect(odyssey.ready).toBe(false)
    expect(odyssey.blockers[0]).toMatch(/mainnet/i)
  })
})
