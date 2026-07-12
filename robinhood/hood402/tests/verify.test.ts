import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { buildRequirements } from '../src/challenge.js'
import { ROBINHOOD_TESTNET } from '../src/networks.js'
import { randomNonce, TRANSFER_WITH_AUTHORIZATION_TYPES, usdgDomain } from '../src/scheme/exact.js'
import { verifyPayment, type HoodReader } from '../src/verify.js'
import type { ExactEvmAuthorization, PaymentPayload } from '../src/types.js'

const payerAccount = privateKeyToAccount(generatePrivateKey())
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

/** A stub RPC reader whose responses are pre-programmed per test. */
function stubReader(opts: { used: boolean; balance: bigint }): HoodReader {
  return {
    async readContract(args) {
      if (args.functionName === 'authorizationState') return opts.used
      if (args.functionName === 'balanceOf') return opts.balance
      throw new Error(`unexpected readContract call: ${args.functionName}`)
    },
  }
}

describe('verifyPayment — structure + signature only (no reader)', () => {
  it('succeeds without touching the chain when no reader is supplied', async () => {
    const result = await verifyPayment({
      payload: await signedPayload(),
      requirements: requirements(),
      now: NOW,
    })
    expect(result.isValid).toBe(true)
    expect(result.payer?.toLowerCase()).toBe(payerAccount.address.toLowerCase())
  })

  it('fails structural checks before ever needing a reader', async () => {
    const result = await verifyPayment({
      payload: await signedPayload({ value: '1' }),
      requirements: requirements(),
      now: NOW,
    })
    expect(result).toEqual({ isValid: false, invalidReason: 'insufficient_amount' })
  })

  it('fails on an invalid signature', async () => {
    const p = await signedPayload()
    p.payload.signature = ('0x' + 'ab'.repeat(65)) as `0x${string}`
    const result = await verifyPayment({ payload: p, requirements: requirements(), now: NOW })
    expect(result).toEqual({ isValid: false, invalidReason: 'invalid_signature' })
  })
})

describe('verifyPayment — replay protection (RPC reader)', () => {
  it('rejects a nonce that has already been settled (replay)', async () => {
    const reader = stubReader({ used: true, balance: 1_000_000n })
    const result = await verifyPayment({
      payload: await signedPayload(),
      requirements: requirements(),
      reader,
      now: NOW,
    })
    expect(result).toEqual({
      isValid: false,
      invalidReason: 'authorization_already_used',
    })
  })

  it('accepts a fresh (unused) nonce with sufficient balance', async () => {
    const reader = stubReader({ used: false, balance: 1_000_000n })
    const result = await verifyPayment({
      payload: await signedPayload(),
      requirements: requirements(),
      reader,
      now: NOW,
    })
    expect(result.isValid).toBe(true)
  })
})

describe('verifyPayment — balance checks (RPC reader)', () => {
  it('rejects a payer with insufficient USDG balance', async () => {
    const reader = stubReader({ used: false, balance: 1n })
    const result = await verifyPayment({
      payload: await signedPayload(),
      requirements: requirements(),
      reader,
      now: NOW,
    })
    expect(result).toEqual({ isValid: false, invalidReason: 'insufficient_funds' })
  })

  it('accepts a payer whose balance exactly equals the payment', async () => {
    const reader = stubReader({ used: false, balance: 10000n })
    const result = await verifyPayment({
      payload: await signedPayload(),
      requirements: requirements(),
      reader,
      now: NOW,
    })
    expect(result.isValid).toBe(true)
  })
})
