import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsoleTransport } from '../src/transports/console.js'
import { logger } from '../src/logger.js'
import type { AlertEvent } from '../src/engine/events.js'

const TOKEN = '0x1234567890123456789012345678901234567890' as `0x${string}`

function whaleEvent(): AlertEvent {
  return { type: 'whale', source: 'uniswap-v3', token: TOKEN, symbol: 'X', side: 'buy', usd: 6000, trader: TOKEN, blockNumber: 1n, transactionHash: '0x1', at: 0 }
}

describe('ConsoleTransport', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger)
  })

  afterEach(() => {
    infoSpy.mockRestore()
  })

  it('has the console platform', () => {
    expect(new ConsoleTransport().platform).toBe('console')
  })

  it('sendAlert logs the rendered card text with chat and event type', async () => {
    const t = new ConsoleTransport()
    await t.sendAlert('chat-1', whaleEvent())
    expect(infoSpy).toHaveBeenCalledTimes(1)
    const [payload, message] = infoSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(message).toBe('alert')
    expect(payload.chatId).toBe('chat-1')
    expect(payload.eventType).toBe('whale')
    expect(payload.alert).toContain('Whale buy: $6.0k of X')
  })

  it('sendDigest logs a digest with per-alert lines and an omitted count', async () => {
    const t = new ConsoleTransport()
    const events = Array.from({ length: 12 }, () => whaleEvent())
    await t.sendDigest('chat-1', events)
    const [payload, message] = infoSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(message).toBe('digest')
    expect(payload.chatId).toBe('chat-1')
    expect(payload.title).toBe('Digest: 12 alerts')
    expect(payload.omitted).toBe(2)
    expect(Array.isArray(payload.alerts)).toBe(true)
    expect((payload.alerts as string[])).toHaveLength(10)
  })

  it('start and stop resolve without throwing', async () => {
    const t = new ConsoleTransport()
    await expect(t.start()).resolves.toBeUndefined()
    await expect(t.stop()).resolves.toBeUndefined()
  })
})
