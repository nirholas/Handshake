import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KillSwitch } from '../../src/framework/kill.js'

describe('KillSwitch', () => {
  let dir: string
  let killPath: string
  let sw: KillSwitch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hood-traders-kill-'))
    killPath = join(dir, 'KILL')
  })

  afterEach(() => {
    sw.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts un-killed', () => {
    sw = new KillSwitch(killPath)
    expect(sw.isKilled()).toBe(false)
    expect(sw.killReason()).toBeNull()
  })

  it('trips on an explicit trip() call and records the reason', () => {
    sw = new KillSwitch(killPath)
    sw.trip('manual')
    expect(sw.isKilled()).toBe(true)
    expect(sw.killReason()).toBe('manual')
  })

  it('is idempotent: a second trip() does not overwrite the original reason', () => {
    sw = new KillSwitch(killPath)
    sw.trip('first')
    sw.trip('second')
    expect(sw.killReason()).toBe('first')
  })

  it('notifies listeners exactly once on trip, even if one listener throws', () => {
    sw = new KillSwitch(killPath)
    const calls: string[] = []
    sw.onKill(() => {
      throw new Error('a broken listener must not block the others')
    })
    sw.onKill((reason) => calls.push(reason))
    sw.trip('boom')
    sw.trip('boom-again') // idempotent — no second notification
    expect(calls).toEqual(['boom'])
  })

  it('unsubscribe stops further notifications', () => {
    sw = new KillSwitch(killPath)
    const calls: string[] = []
    const unsub = sw.onKill((r) => calls.push(r))
    unsub()
    sw.trip('after-unsub')
    expect(calls).toEqual([])
  })

  it('trips immediately on arm() if the KILL file already exists', async () => {
    writeFileSync(killPath, '')
    sw = new KillSwitch(killPath)
    expect(sw.isKilled()).toBe(false)
    sw.arm()
    expect(sw.isKilled()).toBe(true)
    expect(sw.killReason()).toBe('kill_file')
  })

  it('trips when the KILL file appears while armed (polled)', async () => {
    sw = new KillSwitch(killPath)
    sw.arm()
    expect(sw.isKilled()).toBe(false)
    expect(existsSync(killPath)).toBe(false)
    writeFileSync(killPath, '')
    await new Promise((r) => setTimeout(r, 1200))
    expect(sw.isKilled()).toBe(true)
    expect(sw.killReason()).toBe('kill_file')
  })

  it('mid-loop: a trip during a simulated agent loop halts further iterations', () => {
    sw = new KillSwitch(killPath)
    let iterations = 0
    const maxIterations = 10
    for (let i = 0; i < maxIterations; i++) {
      if (sw.isKilled()) break
      iterations++
      if (i === 3) sw.trip('mid-loop')
    }
    expect(iterations).toBe(4) // stops the loop the iteration AFTER the trip fires
    expect(sw.isKilled()).toBe(true)
  })
})
