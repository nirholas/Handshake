import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger.js'

const NETWORK = 'robinhood-testnet'
const PAYER = '0x1111111111111111111111111111111111111111'
const PAY_TO = '0x2222222222222222222222222222222222222222'
const NONCE = '0xdeadbeef'

function freshLedger(): Ledger {
  return new Ledger(':memory:', () => 1_800_000_000_000)
}

describe('Ledger — idempotent settlement claims', () => {
  it('claims a fresh (network, payer, nonce) key', () => {
    const ledger = freshLedger()
    const result = ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    expect(result).toEqual({ claimed: true })
  })

  it('refuses a second claim on the same key while pending', () => {
    const ledger = freshLedger()
    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    const second = ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    expect(second.claimed).toBe(false)
    if (!second.claimed) expect(second.existing.status).toBe('pending')
  })

  it('allows the same nonce to be claimed independently per network', () => {
    const ledger = freshLedger()
    const a = ledger.claim({ network: 'robinhood', payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    const b = ledger.claim({ network: 'robinhood-testnet', payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    expect(a).toEqual({ claimed: true })
    expect(b).toEqual({ claimed: true })
  })

  it('marks a claim settled and a replay returns the same transaction hash', () => {
    const ledger = freshLedger()
    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    ledger.markSettled(NETWORK, PAYER, NONCE, '0xabc123')

    const replay = ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    expect(replay.claimed).toBe(false)
    if (!replay.claimed) {
      expect(replay.existing.status).toBe('settled')
      expect(replay.existing.tx_hash).toBe('0xabc123')
    }
  })

  it('marks a claim failed and records the reason', () => {
    const ledger = freshLedger()
    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: NONCE })
    ledger.markFailed(NETWORK, PAYER, NONCE, 'settlement_failed')

    const row = ledger.find(NETWORK, PAYER, NONCE)
    expect(row?.status).toBe('failed')
    expect(row?.reason).toBe('settlement_failed')
  })

  it('is case-insensitive on payer and nonce (checksum vs lowercase addresses collide)', () => {
    const ledger = freshLedger()
    ledger.claim({ network: NETWORK, payer: PAYER.toUpperCase(), payTo: PAY_TO, amount: '10000', nonce: NONCE })
    const second = ledger.claim({
      network: NETWORK,
      payer: PAYER.toLowerCase(),
      payTo: PAY_TO,
      amount: '10000',
      nonce: NONCE,
    })
    expect(second.claimed).toBe(false)
  })
})

describe('Ledger — metrics', () => {
  it('counts settlements by status', () => {
    const ledger = freshLedger()
    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: '0x1' })
    ledger.markSettled(NETWORK, PAYER, '0x1', '0xaaa')

    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '20000', nonce: '0x2' })
    ledger.markFailed(NETWORK, PAYER, '0x2', 'settlement_failed')

    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '30000', nonce: '0x3' })

    expect(ledger.counts()).toEqual({ settled: 1, failed: 1, pending: 1 })
  })

  it('sums total settled USDG in atomic units', () => {
    const ledger = freshLedger()
    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '10000', nonce: '0x1' })
    ledger.markSettled(NETWORK, PAYER, '0x1', '0xaaa')
    ledger.claim({ network: NETWORK, payer: PAYER, payTo: PAY_TO, amount: '25000', nonce: '0x2' })
    ledger.markSettled(NETWORK, PAYER, '0x2', '0xbbb')

    expect(ledger.totalSettledAtomic()).toBe('35000')
  })
})
