import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { buildRefundTx, refundOverageTx, refundReceivedTx, sendRefund } from '../../src/verify/refund.js'
import type { PaymentResult } from '../../src/verify/types.js'

const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const BUYER = '0x2d4d2A025b10C09BDbd794B4FCe4F7ea8C7d7bB4' as Address

function result(status: PaymentResult['status'], received: bigint, expected = 10_000_000n): PaymentResult {
  return {
    status,
    expectedRaw: expected,
    receivedRaw: received,
    overageRaw: received > expected ? received - expected : 0n,
    payer: BUYER,
    transfers: [],
  }
}

describe('refund helpers', () => {
  it('builds a plain ERC-20 transfer back to the buyer', () => {
    const call = buildRefundTx(TOKEN, BUYER, 1_000_000n)
    expect(call.to).toBe(TOKEN)
    expect(call.data.startsWith('0xa9059cbb')).toBe(true)
    expect(() => buildRefundTx(TOKEN, BUYER, 0n)).toThrow(/positive/)
  })

  it('refundOverageTx refunds exactly the overage of an overpaid invoice', () => {
    const call = refundOverageTx(TOKEN, result('overpaid', 12_000_000n))
    expect(call.data.endsWith((2_000_000n).toString(16).padStart(64, '0'))).toBe(true)
    expect(() => refundOverageTx(TOKEN, result('paid', 10_000_000n))).toThrow(/not overpaid/)
    const noPayer = { ...result('overpaid', 12_000_000n) }
    delete noPayer.payer
    expect(() => refundOverageTx(TOKEN, noPayer)).toThrow(/payer/)
  })

  it('refundReceivedTx refunds everything an abandoned invoice received', () => {
    const call = refundReceivedTx(TOKEN, result('underpaid', 4_000_000n))
    expect(call.data.endsWith((4_000_000n).toString(16).padStart(64, '0'))).toBe(true)
    expect(() => refundReceivedTx(TOKEN, result('pending', 0n))).toThrow(/nothing received/)
  })

  it('sendRefund drives the merchant-supplied signer (stubbed - no broadcast)', async () => {
    const sent: Array<{ to: Address; data: Hex; value: bigint }> = []
    const wallet = {
      async sendTransaction(args: { to: Address; data: Hex; value: bigint }) {
        sent.push(args)
        return `0x${'cc'.repeat(32)}` as Hex
      },
    }
    const hash = await sendRefund(wallet, buildRefundTx(TOKEN, BUYER, 1_000_000n))
    expect(hash).toBe(`0x${'cc'.repeat(32)}`)
    expect(sent[0]!.to).toBe(TOKEN)
    expect(sent[0]!.value).toBe(0n)
  })
})
