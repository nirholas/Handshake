import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock hoodchain's swap quoting so estimateUsdgValue is deterministic and
// network-free in a unit test — the real quote is exercised in tests/live.
vi.mock('hoodchain', async () => {
  const actual = await vi.importActual<typeof import('hoodchain')>('hoodchain')
  return {
    ...actual,
    quoteSwap: vi.fn(async (_client: unknown, args: { amountIn: bigint }) => ({
      route: { fees: [10000], path: [], encodedPath: '0x' },
      amountIn: args.amountIn,
      // Fixed fake rate for the test: 1 ETH (1e18 wei) == 2000 USDG (2000e6).
      amountOut: (args.amountIn * 2000n * 1_000_000n) / 1_000_000_000_000_000_000n,
      gasEstimate: 0n,
    })),
    formatUsdg: (n: bigint) => (Number(n) / 1e6).toString(),
  }
})

const { estimateUsdgValue, enforceCaps } = await import('../../src/core/caps.js')
const { KillSwitch } = await import('../../src/core/kill-switch.js')
const { LaunchLedger } = await import('../../src/core/ledger.js')
const { CapExceededError, KilledError, ResponsibilityNotAffirmedError } = await import('../../src/errors.js')

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hood-launcher-caps-test-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const fakeClient = { network: 'mainnet' } as unknown as Parameters<typeof estimateUsdgValue>[0]

function baseConfig(overrides: Partial<Parameters<typeof enforceCaps>[0]> = {}) {
  return {
    network: 'mainnet' as const,
    live: true,
    maxLaunchesPerDay: 3,
    maxSeedUsdgEquivalent: 5000,
    acknowledgeLaunchResponsibility: true,
    ...overrides,
  }
}

describe('estimateUsdgValue', () => {
  it('returns 0 for a zero-wei amount with no network call', async () => {
    expect(await estimateUsdgValue(fakeClient, 0n)).toBe(0)
  })

  it('converts wei to a USDG estimate via the mocked quote', async () => {
    const usd = await estimateUsdgValue(fakeClient, 1_000_000_000_000_000_000n) // 1 ETH
    expect(usd).toBe(2000)
  })
})

describe('enforceCaps', () => {
  it('throws KilledError when the kill switch is engaged', async () => {
    const kill = new KillSwitch(dataDir)
    kill.engage('manual-test')
    const ledger = new LaunchLedger(dataDir)
    await expect(enforceCaps(baseConfig(), ledger, kill, fakeClient, 0n)).rejects.toThrow(KilledError)
  })

  it('throws ResponsibilityNotAffirmedError when live but not acknowledged', async () => {
    const kill = new KillSwitch(dataDir)
    const ledger = new LaunchLedger(dataDir)
    await expect(
      enforceCaps(baseConfig({ acknowledgeLaunchResponsibility: false }), ledger, kill, fakeClient, 0n),
    ).rejects.toThrow(ResponsibilityNotAffirmedError)
  })

  it('throws CapExceededError once MAX_LAUNCHES_PER_DAY is reached', async () => {
    const kill = new KillSwitch(dataDir)
    const ledger = new LaunchLedger(dataDir)
    const config = baseConfig({ maxLaunchesPerDay: 2 })
    for (let i = 0; i < 2; i++) {
      ledger.record({
        timestamp: Date.now(),
        rail: 'noxa',
        network: 'mainnet',
        symbol: `T${i}`,
        token: '0xabc',
        seedWei: '0',
        launchTx: '0xdead',
        status: 'launched',
      })
    }
    await expect(enforceCaps(config, ledger, kill, fakeClient, 0n)).rejects.toThrow(CapExceededError)
  })

  it('throws CapExceededError when the seed exceeds MAX_SEED_USDG', async () => {
    const kill = new KillSwitch(dataDir)
    const ledger = new LaunchLedger(dataDir)
    const config = baseConfig({ maxSeedUsdgEquivalent: 100 }) // cap at $100
    // 1 ETH ≈ $2000 per the mock — well over the $100 cap.
    await expect(enforceCaps(config, ledger, kill, fakeClient, 1_000_000_000_000_000_000n)).rejects.toThrow(
      CapExceededError,
    )
  })

  it('passes when under every cap', async () => {
    const kill = new KillSwitch(dataDir)
    const ledger = new LaunchLedger(dataDir)
    const config = baseConfig({ maxSeedUsdgEquivalent: 5000, maxLaunchesPerDay: 5 })
    const result = await enforceCaps(config, ledger, kill, fakeClient, 1_000_000_000_000_000_000n)
    expect(result.usdgEstimate).toBe(2000)
  })
})
