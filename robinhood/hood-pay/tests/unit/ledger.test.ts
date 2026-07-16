import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { createLedger } from '../../src/verify/ledger.js'
import { splitDust } from '../../src/reference.js'
import type { MatchedTransfer } from '../../src/verify/types.js'

const MERCHANT = '0x4022de2D36C334E73C7a108805Cea11C0564f402' as Address
const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const BUYER = '0x2d4d2A025b10C09BDbd794B4FCe4F7ea8C7d7bB4' as Address

function transfer(overrides: Partial<MatchedTransfer> = {}): MatchedTransfer {
  return {
    txHash: `0x${'aa'.repeat(32)}` as Hex,
    logIndex: 0,
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}` as Hex,
    payer: BUYER,
    amountRaw: 12_500_042n,
    ...overrides,
  }
}

describe('ledger', () => {
  it('reserves unique fingerprinted amounts per (payTo, token, amount)', async () => {
    const ledger = await createLedger(':memory:')
    const base = 12_500_000n
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const invoice = ledger.createDirectInvoice({ network: 'mainnet', payTo: MERCHANT, token: TOKEN, baseRaw: base })
      expect(invoice.status).toBe('pending')
      const { base: b, dust } = splitDust(invoice.expectedRaw)
      expect(b).toBe(base)
      expect(dust).toBe(invoice.dust)
      expect(dust >= 1n && dust <= 9999n).toBe(true)
      expect(seen.has(invoice.expectedRaw.toString())).toBe(false)
      seen.add(invoice.expectedRaw.toString())
    }
    ledger.close()
  })

  it('rejects a base amount that already carries dust digits', async () => {
    const ledger = await createLedger(':memory:')
    expect(() =>
      ledger.createDirectInvoice({ network: 'mainnet', payTo: MERCHANT, token: TOKEN, baseRaw: 12_500_042n }),
    ).toThrow(/low 4 decimal digits/)
    ledger.close()
  })

  it('records transfers idempotently and never double-credits', async () => {
    const ledger = await createLedger(':memory:')
    const invoice = ledger.createDirectInvoice({ network: 'mainnet', payTo: MERCHANT, token: TOKEN, baseRaw: 12_500_000n })
    const t = transfer({ amountRaw: invoice.expectedRaw })
    const first = ledger.recordTransfer(invoice.id, t)
    expect(first?.status).toBe('paid')
    expect(first?.receivedRaw).toBe(invoice.expectedRaw)
    expect(first?.payer).toBe(BUYER)
    // exact replay: ignored
    expect(ledger.recordTransfer(invoice.id, t)).toBeUndefined()
    expect(ledger.getInvoice(invoice.id)?.receivedRaw).toBe(invoice.expectedRaw)
    ledger.close()
  })

  it('sums 18-decimal amounts beyond SQLite integer range correctly', async () => {
    const ledger = await createLedger(':memory:')
    const big = 5_000n * 10n ** 18n // 5000 tokens, 18 decimals: overflows int64
    const invoice = ledger.createRouterInvoice({
      network: 'mainnet',
      payTo: MERCHANT,
      token: TOKEN,
      expectedRaw: big * 2n,
      reference: `0x${'11'.repeat(32)}` as Hex,
    })
    ledger.recordTransfer(invoice.id, transfer({ amountRaw: big, logIndex: 0 }))
    const after = ledger.recordTransfer(invoice.id, transfer({ amountRaw: big, logIndex: 1 }))
    expect(after?.receivedRaw).toBe(big * 2n)
    expect(after?.status).toBe('paid')
    ledger.close()
  })

  it('walks underpaid -> paid -> overpaid and never goes backward', async () => {
    const ledger = await createLedger(':memory:')
    const invoice = ledger.createRouterInvoice({
      network: 'mainnet',
      payTo: MERCHANT,
      token: TOKEN,
      expectedRaw: 10_000_000n,
      reference: `0x${'33'.repeat(32)}` as Hex,
    })
    expect(ledger.recordTransfer(invoice.id, transfer({ amountRaw: 4_000_000n, logIndex: 0 }))?.status).toBe('underpaid')
    expect(ledger.recordTransfer(invoice.id, transfer({ amountRaw: 6_000_000n, logIndex: 1 }))?.status).toBe('paid')
    expect(ledger.recordTransfer(invoice.id, transfer({ amountRaw: 1_000_000n, logIndex: 2 }))?.status).toBe('overpaid')
    // a stale writer cannot un-pay
    expect(ledger.setStatus(invoice.id, 'pending').status).toBe('overpaid')
    expect(ledger.setStatus(invoice.id, 'expired').status).toBe('overpaid')
    expect(ledger.setStatus(invoice.id, 'refunded').status).toBe('refunded')
    ledger.close()
  })

  it('lists invoices newest first and records webhook deliveries', async () => {
    const ledger = await createLedger(':memory:')
    ledger.createDirectInvoice({ network: 'testnet', payTo: MERCHANT, token: TOKEN, baseRaw: 1_000_000n, memo: 'a' })
    ledger.createDirectInvoice({ network: 'testnet', payTo: MERCHANT, token: TOKEN, baseRaw: 2_000_000n, memo: 'b' })
    const list = ledger.listInvoices()
    expect(list).toHaveLength(2)
    ledger.recordWebhookDelivery({ paymentId: list[0]!.id, event: 'payment.paid', ok: true, attempts: 1 })
    ledger.close()
  })
})
