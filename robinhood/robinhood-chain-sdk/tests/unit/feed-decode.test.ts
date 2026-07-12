import { describe, expect, it } from 'vitest'
import { keccak256, parseTransaction, serializeTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { subscribeFeed } from '../../src/feed.js'
import type { FeedMessage } from '../../src/feed.js'

// A locally signed tx lets us assert the decoder recovers hash + fields
// exactly, without touching the network.
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

async function signedRawTx(): Promise<`0x${string}`> {
  const signed = await account.signTransaction({
    chainId: 4663,
    type: 'eip1559',
    to: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    value: 0n,
    maxFeePerGas: 100_000_000n,
    maxPriorityFeePerGas: 0n,
    gas: 21_000n,
    nonce: 1,
  })
  return signed
}

function frame(l2Msg: Buffer, kind = 3) {
  return JSON.stringify({
    version: 1,
    messages: [
      {
        sequenceNumber: 42,
        message: {
          message: {
            header: {
              kind,
              sender: '0xa4b000000000000000000000000000000073657175',
              blockNumber: 123,
              timestamp: 1780000000,
            },
            l2Msg: l2Msg.toString('base64'),
          },
          delayedMessagesRead: 7,
        },
        blockHash: '0x' + '11'.repeat(32),
      },
    ],
  })
}

/** Drive subscribeFeed through a stub WebSocket to exercise decoding end-to-end. */
async function runThroughFeed(frameJson: string): Promise<FeedMessage[]> {
  const received: FeedMessage[] = []
  class StubSocket {
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    constructor(_url: string) {
      queueMicrotask(() => {
        this.onopen?.()
        this.onmessage?.({ data: frameJson })
      })
    }
    close() {
      this.onclose?.()
    }
  }
  const g = globalThis as { WebSocket?: unknown }
  const original = g.WebSocket
  g.WebSocket = StubSocket
  try {
    const sub = await subscribeFeed((m) => received.push(m))
    await new Promise((r) => setTimeout(r, 10))
    sub.close()
  } finally {
    if (original === undefined) delete g.WebSocket
    else g.WebSocket = original
  }
  return received
}

describe('sequencer feed decoding', () => {
  it('decodes a kind-4 (SignedTx) l2Msg into the exact transaction', async () => {
    const raw = await signedRawTx()
    const l2Msg = Buffer.concat([Buffer.from([0x04]), Buffer.from(raw.slice(2), 'hex')])
    const [msg] = await runThroughFeed(frame(l2Msg))
    expect(msg).toBeDefined()
    expect(msg!.sequenceNumber).toBe(42)
    expect(msg!.kind).toBe(3)
    expect(msg!.transactions).toHaveLength(1)
    const tx = msg!.transactions[0]!
    expect(tx.hash).toBe(keccak256(raw))
    expect(tx.transaction.to?.toLowerCase()).toBe('0x5fc5360d0400a0fd4f2af552add042d716f1d168')
    expect(tx.transaction.chainId).toBe(4663)
    // round-trip: reserializing the parsed tx reproduces the raw bytes
    const parsed = parseTransaction(raw)
    expect(serializeTransaction(parsed, {
      r: parsed.r!, s: parsed.s!, v: parsed.v!, yParity: parsed.yParity!,
    })).toBe(raw)
  })

  it('decodes a kind-3 (Batch) l2Msg with two nested signed txs', async () => {
    const raw = await signedRawTx()
    const rawBytes = Buffer.from(raw.slice(2), 'hex')
    const nested = Buffer.concat([Buffer.from([0x04]), rawBytes])
    const lengthPrefix = Buffer.alloc(8)
    lengthPrefix.writeBigUInt64BE(BigInt(nested.length))
    const batch = Buffer.concat([Buffer.from([0x03]), lengthPrefix, nested, lengthPrefix, nested])
    const [msg] = await runThroughFeed(frame(batch))
    expect(msg!.transactions).toHaveLength(2)
    expect(msg!.transactions[0]!.hash).toBe(keccak256(raw))
    expect(msg!.transactions[1]!.hash).toBe(keccak256(raw))
  })

  it('passes through unknown payloads without throwing', async () => {
    const [msg] = await runThroughFeed(frame(Buffer.from([0x7f, 0x01, 0x02])))
    expect(msg!.transactions).toHaveLength(0)
    expect(msg!.l2MsgBase64.length).toBeGreaterThan(0)
  })

  it('ignores non-kind-3 headers', async () => {
    const raw = await signedRawTx()
    const l2Msg = Buffer.concat([Buffer.from([0x04]), Buffer.from(raw.slice(2), 'hex')])
    const [msg] = await runThroughFeed(frame(l2Msg, 9))
    expect(msg!.kind).toBe(9)
    expect(msg!.transactions).toHaveLength(0)
  })
})
