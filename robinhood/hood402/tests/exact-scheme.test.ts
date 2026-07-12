import { describe, expect, it } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { buildRequirements } from '../src/challenge.js'
import { ROBINHOOD_TESTNET } from '../src/networks.js'
import {
  isWellFormedPayload,
  randomNonce,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  usdgDomain,
  validateStructural,
  verifyAuthorizationSignature,
} from '../src/scheme/exact.js'
import type { ExactEvmAuthorization, PaymentPayload } from '../src/types.js'

const PAYER_KEY = generatePrivateKey()
const payerAccount = privateKeyToAccount(PAYER_KEY)
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

describe('isWellFormedPayload', () => {
  it('accepts a well-formed payload', async () => {
    expect(isWellFormedPayload(await signedPayload())).toBe(true)
  })

  it('rejects payloads with the wrong x402Version', async () => {
    const p = await signedPayload()
    expect(isWellFormedPayload({ ...p, x402Version: 2 })).toBe(false)
  })

  it('rejects payloads with a missing authorization field', () => {
    expect(
      isWellFormedPayload({
        x402Version: 1,
        scheme: 'exact',
        network: 'robinhood-testnet',
        payload: { signature: '0xabc' },
      }),
    ).toBe(false)
  })

  it('rejects non-address from/to values', async () => {
    const p = await signedPayload()
    expect(
      isWellFormedPayload({
        ...p,
        payload: { ...p.payload, authorization: { ...p.payload.authorization, from: 'not-an-address' } },
      }),
    ).toBe(false)
  })

  it('rejects null and non-object input', () => {
    expect(isWellFormedPayload(null)).toBe(false)
    expect(isWellFormedPayload('a string')).toBe(false)
    expect(isWellFormedPayload(42)).toBe(false)
  })
})

describe('validateStructural — the malformed/replay-adjacent/expiry/wrong-chain/underpayment matrix', () => {
  it('accepts a valid payload within its validity window', async () => {
    const result = validateStructural(await signedPayload(), requirements(), NOW)
    expect(result.isValid).toBe(true)
    expect(result.payer?.toLowerCase()).toBe(payerAccount.address.toLowerCase())
  })

  it('rejects a scheme mismatch', async () => {
    const p = await signedPayload()
    // @ts-expect-error - intentionally malformed for the test
    const result = validateStructural({ ...p, scheme: 'upto' }, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'invalid_scheme' })
  })

  it('rejects an unsupported/unknown network', async () => {
    const p = await signedPayload()
    const result = validateStructural({ ...p, network: 'ethereum-mainnet' }, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'unsupported_network' })
  })

  it('rejects a wrong-chain payment (payload network != requirement network)', async () => {
    const p = await signedPayload()
    const result = validateStructural({ ...p, network: 'robinhood' }, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'network_mismatch' })
  })

  it('rejects a payment to the wrong recipient', async () => {
    const p = await signedPayload({ to: '0x3333333333333333333333333333333333333333' })
    const result = validateStructural(p, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'invalid_recipient' })
  })

  it('rejects underpayment (authorized value below the price)', async () => {
    const p = await signedPayload({ value: '9999' })
    const result = validateStructural(p, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'insufficient_amount' })
  })

  it('accepts overpayment (authorized value above the price)', async () => {
    const p = await signedPayload({ value: '20000' })
    const result = validateStructural(p, requirements(), NOW)
    expect(result.isValid).toBe(true)
  })

  it('rejects an expired authorization (validBefore in the past)', async () => {
    const p = await signedPayload({ validBefore: String(NOW - 1) })
    const result = validateStructural(p, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'authorization_expired' })
  })

  it('rejects a not-yet-valid authorization (validAfter in the future)', async () => {
    const p = await signedPayload({ validAfter: String(NOW + 1000) })
    const result = validateStructural(p, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'authorization_not_yet_valid' })
  })

  it('rejects malformed numeric fields (non-numeric value)', async () => {
    // A malicious/buggy client could send unsignable garbage over the wire —
    // construct the payload directly rather than through the signer.
    const valid = await signedPayload()
    const p: PaymentPayload = {
      ...valid,
      payload: {
        ...valid.payload,
        authorization: { ...valid.payload.authorization, value: 'not-a-number' },
      },
    }
    const result = validateStructural(p, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'malformed_payment' })
  })

  it('rejects malformed validity window fields', async () => {
    const valid = await signedPayload()
    const p: PaymentPayload = {
      ...valid,
      payload: {
        ...valid.payload,
        authorization: { ...valid.payload.authorization, validBefore: 'soon' },
      },
    }
    const result = validateStructural(p, requirements(), NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'malformed_payment' })
  })

  it('rejects a payment for the wrong asset (requirement pinned to a foreign token)', async () => {
    const p = await signedPayload()
    const req = { ...requirements(), asset: '0x9999999999999999999999999999999999999999' as const }
    const result = validateStructural(p, req, NOW)
    expect(result).toEqual({ isValid: false, invalidReason: 'invalid_asset' })
  })
})

describe('EIP-3009 signature verification', () => {
  it('recovers a valid signature to the payer address', async () => {
    const p = await signedPayload()
    const ok = await verifyAuthorizationSignature(
      ROBINHOOD_TESTNET,
      p.payload.authorization,
      p.payload.signature,
    )
    expect(ok).toBe(true)
  })

  it('rejects a tampered amount (signature no longer matches the message)', async () => {
    const p = await signedPayload()
    const tampered = { ...p.payload.authorization, value: '999999999' }
    const ok = await verifyAuthorizationSignature(ROBINHOOD_TESTNET, tampered, p.payload.signature)
    expect(ok).toBe(false)
  })

  it('rejects a signature from the wrong domain (mainnet signature replayed on testnet)', async () => {
    const p = await signedPayload()
    // Re-sign against the WRONG (mainnet) domain, then verify against testnet.
    const mainnetSig = await payerAccount.signTypedData({
      domain: usdgDomain({ ...ROBINHOOD_TESTNET, chainId: 4663 }),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: p.payload.authorization.from,
        to: p.payload.authorization.to,
        value: BigInt(p.payload.authorization.value),
        validAfter: BigInt(p.payload.authorization.validAfter),
        validBefore: BigInt(p.payload.authorization.validBefore),
        nonce: p.payload.authorization.nonce,
      },
    })
    const ok = await verifyAuthorizationSignature(
      ROBINHOOD_TESTNET,
      p.payload.authorization,
      mainnetSig,
    )
    expect(ok).toBe(false)
  })

  it('rejects a signature recovering to a different signer than `from`', async () => {
    const p = await signedPayload()
    const otherPayer = privateKeyToAccount(generatePrivateKey())
    const spoofed = { ...p.payload.authorization, from: otherPayer.address }
    const ok = await verifyAuthorizationSignature(ROBINHOOD_TESTNET, spoofed, p.payload.signature)
    expect(ok).toBe(false)
  })
})
