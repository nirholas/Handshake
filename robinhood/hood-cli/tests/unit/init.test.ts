import { describe, expect, it } from 'vitest'
import { buildEnvFiles, initCommand } from '../../src/commands/init.js'

describe('init command wiring', () => {
  it('registers a --out option defaulting to the current directory', () => {
    const cmd = initCommand()
    const out = cmd.options.find((o) => o.long === '--out')
    expect(out).toBeDefined()
    expect(out!.defaultValue).toBe('.')
  })
})

describe('buildEnvFiles', () => {
  it('writes a minimal hood-traders.env with paper mode when nothing else is configured', () => {
    const { traderEnv } = buildEnvFiles({})
    expect(traderEnv).toMatch(/HOOD_TRADERS_LIVE=0/)
    expect(traderEnv).not.toMatch(/HOOD_LLM_PROVIDER/)
  })

  it('includes LLM provider + key only when both are set', () => {
    const { traderEnv } = buildEnvFiles({ llmProvider: 'anthropic', llmApiKey: 'sk-ant-test' })
    expect(traderEnv).toMatch(/HOOD_LLM_PROVIDER=anthropic/)
    expect(traderEnv).toMatch(/HOOD_LLM_API_KEY=sk-ant-test/)
  })

  it('writes an empty-ish hood-alerts.env when nothing is configured', () => {
    const { alertsEnv } = buildEnvFiles({})
    expect(alertsEnv).not.toMatch(/HOOD_ALERTS_TELEGRAM_TOKEN=/)
    expect(alertsEnv).not.toMatch(/HOOD_ALERTS_X_MODE=/)
  })

  it('includes Telegram token when set', () => {
    const { alertsEnv } = buildEnvFiles({ telegramToken: '123:abc' })
    expect(alertsEnv).toMatch(/HOOD_ALERTS_TELEGRAM_TOKEN=123:abc/)
  })

  it('includes official X credentials under official mode', () => {
    const { alertsEnv } = buildEnvFiles({
      xMode: 'official',
      xApiKey: 'k',
      xApiSecret: 's',
      xAccessToken: 't',
      xAccessSecret: 'ts',
    })
    expect(alertsEnv).toMatch(/HOOD_ALERTS_X_MODE=official/)
    expect(alertsEnv).toMatch(/HOOD_ALERTS_X_API_KEY=k/)
    expect(alertsEnv).toMatch(/HOOD_ALERTS_X_ACCESS_SECRET=ts/)
    expect(alertsEnv).not.toMatch(/XACTIONS_URL/)
  })

  it('includes xactions credentials under xactions mode, not official X keys', () => {
    const { alertsEnv } = buildEnvFiles({ xMode: 'xactions', xactionsUrl: 'https://example.com', xactionsToken: 'tok' })
    expect(alertsEnv).toMatch(/HOOD_ALERTS_X_MODE=xactions/)
    expect(alertsEnv).toMatch(/HOOD_ALERTS_XACTIONS_URL=https:\/\/example\.com/)
    expect(alertsEnv).not.toMatch(/HOOD_ALERTS_X_API_KEY/)
  })
})
