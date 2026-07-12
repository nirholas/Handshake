import { describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { buildRequirements } from '../src/challenge.js'
import { ROBINHOOD_TESTNET } from '../src/networks.js'
import { randomNonce, TRANSFER_WITH_AUTHORIZATION_TYPES, usdgDomain } from '../src/scheme/exact.js'
import { settlePayment, type HoodBroadcaster, type HoodConfirmer } from '../src/settle.js'
import type { ExactEvmAuthorization, PaymentPayload } from '../src/types.js'

const payerAccount = privateKeyToAccount(generatePrivateKey())
const FACILITATOR_ADDRESS = '0x4444444444444444444444444444444444444444' as const
const PAY_TO = '0x2222222222222222222222222222222222222222'
const NOW = 1_800_000_000

function requirements() {
  return buildRequirements({
    price: { atomic: '10000' },
    payTo: PAY_TO,
    resource: 'https://api.example.com/premium',
    network: 'robinhood-testnet',
  })
}

async function signedPayload(overrides: Partial<ExactEvmAuthorization> = {}): Promise<PaymentPayload> {
  const authorization: ExactEvmAuthorization = {
    from: payerAccount.address,
    to: PAY_TO,
    value: '10000',
    validAfter: String(NOW - 60),
    validBefore: String(NOW + 60),
    nonce: randomNonce(),
    ...overrides,
  }
  const signature = await payerAccount.signTypedData({
    domain: usdgDomain(ROBINHOOD_TESTNET),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  })
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'robinhood-testnet',
    payload: { signature, authorization },
  }
}

const TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`

function makeConfirmer(opts: {
  used: boolean
  balance: bigint
  receiptStatus: 'success' | 'reverted'
}): HoodConfirmer {
  return {
    async readContract(args) {
      if (args.functionName === 'authorizationState') return opts.used
      if (args.functionName === 'balanceOf') return opts.balance
      throw new Error(`unexpected readContract: ${args.functionName}`)
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: opts.receiptStatus, transactionHash: hash }
    },
  }
}

describe('settlePayment — happy path', () => {
  it('broadcasts transferWithAuthorization and returns the confirmed tx hash', async () => {
    const write = vi.fn<HoodBroadcaster['writeContract']>().mockResolvedValue(TX_HASH)
    const wallet: HoodBroadcaster = { writeContract: write }
    const reader = makeConfirmer({ used: false, balance: 1_000_000n, receiptStatus: 'success' })

    const result = await settlePayment({
      payload: await signedPayload(),
      requirements: requirements(),
      wallet,
      account: FACILITATOR_ADDRESS,
      reader,
      now: NOW,
    })

    expect(result.success).toBe(true)
    expect(result.transaction).toBe(TX_HASH)
    expect(result.network).toBe('robinhood-testnet')
    expect(write).toHaveBeenCalledOnce()
    const call = write.mock.calls[0]![0]
    expect(call.functionName).toBe('transferWithAuthorization')
    expect(call.account).toBe(FACILITATOR_ADDRESS)
  })
})

describe('settlePayment — replay protection blocks settlement before broadcasting', () => {
  it('refuses to settle an already-used nonce and never calls the wallet', async () => {
    const write = vi.fn<HoodBroadcaster['writeContract']>().mockResolvedValue(TX_HASH)
    const wallet: HoodBroadcaster = { writeContract: write }
    const reader = makeConfirmer({ used: true, balance: 1_000_000n, receiptStatus: 'success' })

    const result = await settlePayment({
      payload: await signedPayload(),
      requirements: requirements(),
      wallet,
      account: FACILITATOR_ADDRESS,
      reader,
      now: NOW,
    })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('authorization_already_used')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('settlePayment — underpayment is caught by re-verification', () => {
  it('refuses to settle when the authorized value no longer covers the price', async () => {
    const write = vi.fn<HoodBroadcaster['writeContract']>().mockResolvedValue(TX_HASH)
    const wallet: HoodBroadcaster = { writeContract: write }
    const reader = makeConfirmer({ used: false, balance: 1_000_000n, receiptStatus: 'success' })

    const result = await settlePayment({
      payload: await signedPayload({ value: '1' }),
      requirements: requirements(),
      wallet,
      account: FACILITATOR_ADDRESS,
      reader,
      now: NOW,
    })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('insufficient_amount')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('settlePayment — broadcast failure', () => {
  it('returns settlement_failed when the wallet rejects the transaction', async () => {
    const write = vi.fn<HoodBroadcaster['writeContract']>().mockRejectedValue(new Error('rpc down'))
    const wallet: HoodBroadcaster = { writeContract: write }
    const reader = makeConfirmer({ used: false, balance: 1_000_000n, receiptStatus: 'success' })

    const result = await settlePayment({
      payload: await signedPayload(),
      requirements: requirements(),
      wallet,
      account: FACILITATOR_ADDRESS,
      reader,
      now: NOW,
    })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('settlement_failed')
  })
})

describe('settlePayment — on-chain revert', () => {
  it('returns settlement_failed with the transaction hash when the receipt reverted', async () => {
    const write = vi.fn<HoodBroadcaster['writeContract']>().mockResolvedValue(TX_HASH)
    const wallet: HoodBroadcaster = { writeContract: write }
    const reader = makeConfirmer({ used: false, balance: 1_000_000n, receiptStatus: 'reverted' })

    const result = await settlePayment({
      payload: await signedPayload(),
      requirements: requirements(),
      wallet,
      account: FACILITATOR_ADDRESS,
      reader,
      now: NOW,
    })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('settlement_failed')
    expect(result.transaction).toBe(TX_HASH)
  })
})

describe('settlePayment — reverify: false', () => {
  it('skips re-verification and broadcasts even against a stale replay-flagged reader', async () => {
    const write = vi.fn<HoodBroadcaster['writeContract']>().mockResolvedValue(TX_HASH)
    const wallet: HoodBroadcaster = { writeContract: write }
    // `used: true` would normally block settlement — but reverify is disabled.
    const reader = makeConfirmer({ used: true, balance: 1_000_000n, receiptStatus: 'success' })

    const result = await settlePayment({
      payload: await signedPayload(),
      requirements: requirements(),
      wallet,
      account: FACILITATOR_ADDRESS,
      reader,
      now: NOW,
      reverify: false,
    })

    expect(result.success).toBe(true)
    expect(write).toHaveBeenCalledOnce()
  })
})
