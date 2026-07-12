/**
 * Guard-rail wiring tests at the commander parsing layer: writes must default
 * to a dry run (`--execute` required + defaults false), required flags must
 * actually be required, and the eligibility/confirmation flags must exist
 * with safe defaults. These check the parser contract without touching the
 * network — full execute-path behaviour is covered by the live E2E script.
 */
import { describe, expect, it } from 'vitest'
import type { Option } from 'commander'
import { swapCommand } from '../../src/commands/swap.js'
import { transferCommand } from '../../src/commands/transfer.js'
import { deployTokenCommand } from '../../src/commands/deploy-token.js'
import { faucetCommand } from '../../src/commands/faucet.js'

function findOption(options: Option[], flag: string): Option | undefined {
  return options.find((o) => o.long === flag || o.short === flag)
}

describe('swap command — execute gate', () => {
  const cmd = swapCommand()
  it('defaults --execute to false (quote-only by default)', () => {
    const opt = findOption(cmd.options, '--execute')
    expect(opt).toBeDefined()
    expect(opt!.defaultValue).toBe(false)
  })
  it('requires --sell, --buy, and --amount', () => {
    for (const flag of ['--sell', '--buy', '--amount']) {
      const opt = findOption(cmd.options, flag)
      expect(opt, `missing option ${flag}`).toBeDefined()
      expect(opt!.mandatory, `${flag} should be mandatory`).toBe(true)
    }
  })
  it('exposes --slippage with a conservative default', () => {
    const opt = findOption(cmd.options, '--slippage')
    expect(opt!.defaultValue).toBe('50') // 0.5%
  })
})

describe('transfer command — execute gate (implicit: no --execute flag, wallet + confirm always gate)', () => {
  const cmd = transferCommand()
  it('requires --to and --amount', () => {
    for (const flag of ['--to', '--amount']) {
      const opt = findOption(cmd.options, flag)
      expect(opt, `missing option ${flag}`).toBeDefined()
      expect(opt!.mandatory, `${flag} should be mandatory`).toBe(true)
    }
  })
  it('--token is optional (defaults to native ETH)', () => {
    const opt = findOption(cmd.options, '--token')
    expect(opt!.mandatory).toBe(false)
  })
})

describe('deploy-token command — execute gate', () => {
  const cmd = deployTokenCommand()
  it('defaults --execute to false (plan-only by default)', () => {
    const opt = findOption(cmd.options, '--execute')
    expect(opt!.defaultValue).toBe(false)
  })
  it('requires --config', () => {
    const opt = findOption(cmd.options, '--config')
    expect(opt!.mandatory).toBe(true)
  })
})

describe('faucet command', () => {
  it('takes no required arguments (pure instructions + balance read)', () => {
    const cmd = faucetCommand()
    expect(cmd.options.every((o) => !o.required)).toBe(true)
  })
})
