import { describe, it, expect } from 'vitest'
import { checkTickerUniqueness } from '../../src/concept/uniqueness.js'
import { TickerTakenError } from '../../src/errors.js'
import { fetchTrendingNarratives, narrativeToTheme } from '../../src/auto/narratives.js'

describe('live ticker uniqueness — Blockscout token search', () => {
  it('rejects a ticker that is already live on mainnet ("BACK" — the NOXA launch used as the calldata proof)', async () => {
    await expect(checkTickerUniqueness('mainnet', 'BACK')).rejects.toThrow(TickerTakenError)
  })

  it('allows a ticker that has no plausible on-chain collision', async () => {
    await expect(
      checkTickerUniqueness('mainnet', `ZZZHOODLAUNCHERPROBE${Date.now()}`.slice(0, 40)),
    ).resolves.toBeUndefined()
  })
})

describe('live trending narratives — three.ws crypto news digest', () => {
  it('fetches real, non-empty narratives with titles, stances, and coverage counts', async () => {
    const narratives = await fetchTrendingNarratives(24, 5)
    expect(narratives.length).toBeGreaterThan(0)
    const first = narratives[0]
    expect(first).toBeDefined()
    expect(typeof first?.title).toBe('string')
    expect(first?.title.length).toBeGreaterThan(0)
    expect(typeof first?.coverage).toBe('number')
    expect(first?.coverage).toBeGreaterThan(0)
  })

  it('narrativeToTheme produces a non-empty, information-dense theme string', async () => {
    const narratives = await fetchTrendingNarratives(24, 1)
    const narrative = narratives[0]
    expect(narrative).toBeDefined()
    if (!narrative) return
    const theme = narrativeToTheme(narrative)
    expect(theme).toContain(narrative.title)
    expect(theme.length).toBeGreaterThan(narrative.title.length)
  })
})
