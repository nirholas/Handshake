import { describe, expect, it } from 'vitest'
import type { Option } from 'commander'
import { createProgram } from '../../src/program.js'

function findOption(options: Option[], flag: string): Option | undefined {
  return options.find((o) => o.long === flag)
}

describe('global flags — eligibility + confirmation gates', () => {
  const program = createProgram()

  it('--acknowledge-eligibility defaults to unset (false)', () => {
    const opt = findOption(program.options, '--acknowledge-eligibility')
    expect(opt).toBeDefined()
    expect(!!opt!.defaultValue).toBe(false)
  })

  it('--yes defaults to unset (interactive confirm required by default)', () => {
    const opt = findOption(program.options, '--yes')
    expect(opt).toBeDefined()
    expect(!!opt!.defaultValue).toBe(false)
  })

  it('--network defaults to mainnet', () => {
    const opt = findOption(program.options, '--network')
    expect(opt!.defaultValue).toBe('mainnet')
  })

  it('registers every documented command', () => {
    const names = program.commands.map((c) => c.name()).sort()
    expect(names).toEqual(
      [
        'coins',
        'config',
        'deploy-token',
        'faucet',
        'launches',
        'portfolio',
        'price',
        'stocks',
        'swap',
        'token',
        'transfer',
        'tx',
        'watch',
      ].sort(),
    )
  })
})
