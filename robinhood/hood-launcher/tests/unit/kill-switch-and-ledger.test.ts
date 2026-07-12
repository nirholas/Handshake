import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KillSwitch } from '../../src/core/kill-switch.js'
import { LaunchLedger } from '../../src/core/ledger.js'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hood-launcher-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('KillSwitch', () => {
  it('starts disengaged', () => {
    const kill = new KillSwitch(dataDir)
    expect(kill.isEngaged().engaged).toBe(false)
    expect(kill.reasonIfEngaged()).toBeNull()
  })

  it('engages via explicit engage() and stays engaged', () => {
    const kill = new KillSwitch(dataDir)
    kill.engage('test-source')
    expect(kill.isEngaged()).toEqual({ engaged: true, source: 'test-source' })
    expect(kill.reasonIfEngaged()).toBe('test-source')
    // A second engage() call does not overwrite the original source.
    kill.engage('second-source')
    expect(kill.reasonIfEngaged()).toBe('test-source')
  })

  it('engages when a KILL sentinel file is dropped into the data dir', () => {
    const kill = new KillSwitch(dataDir)
    expect(kill.isEngaged().engaged).toBe(false)
    writeFileSync(join(dataDir, 'KILL'), 'stop')
    const status = kill.isEngaged()
    expect(status.engaged).toBe(true)
    expect(status.source).toContain('KILL file')
  })
})

describe('LaunchLedger', () => {
  it('records entries and counts launches within a rolling window', () => {
    const ledger = new LaunchLedger(dataDir)
    const now = Date.now()
    ledger.record({
      timestamp: now,
      rail: 'noxa',
      network: 'mainnet',
      symbol: 'FOO',
      token: '0xabc',
      seedWei: '0',
      launchTx: '0xdead',
      status: 'launched',
    })
    ledger.record({
      timestamp: now - 25 * 60 * 60 * 1000, // 25h ago — outside a 24h window
      rail: 'noxa',
      network: 'mainnet',
      symbol: 'BAR',
      token: '0xdef',
      seedWei: '0',
      launchTx: '0xbeef',
      status: 'launched',
    })
    ledger.record({
      timestamp: now,
      rail: 'noxa',
      network: 'mainnet',
      symbol: 'BAZ',
      token: null,
      seedWei: '0',
      launchTx: null,
      status: 'rejected',
      reason: 'dry-run',
    })

    expect(ledger.countLaunchedInWindow(24)).toBe(1) // only the fresh, status:'launched' entry
    expect(ledger.readAll()).toHaveLength(3)
  })

  it('starts empty for a fresh data dir', () => {
    const ledger = new LaunchLedger(dataDir)
    expect(ledger.readAll()).toEqual([])
    expect(ledger.countLaunchedInWindow(24)).toBe(0)
  })
})
