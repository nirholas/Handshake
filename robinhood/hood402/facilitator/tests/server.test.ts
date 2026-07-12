import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  buildRequirements,
  randomNonce,
  ROBINHOOD_TESTNET,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  usdgDomain,
  type ExactEvmAuthorization,
  type PaymentPayload,
} from 'hood402'
import { buildApp } from '../src/server.js'
import { Ledger } from '../src/ledger.js'
import type { FacilitatorConfig, NetworkRuntime } from '../src/config.js'

const payerAccount = privateKeyToAccount(generatePrivateKey())
const facilitatorAccount = privateKeyToAccount(generatePrivateKey())
const PAY_TO = '0x2222222222222222222222222222222222222222'
// The facilitator's /verify and /settle routes check validity against real
// wall-clock time (by design), so signed test payloads must be valid *now*.
const NOW = Math.floor(Date.now() / 1000)

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

function requirements() {
  return buildRequirements({
    price: { atomic: '10000' },
    payTo: PAY_TO,
    resource: 'https://api.example.com/premium',
    network: 'robinhood-testnet',
  })
}

const TX_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`

function testApp(opts: { used: boolean; balance: bigint; receiptStatus: 'success' | 'reverted' }) {
  const writeContract = vi.fn().mockResolvedValue(TX_HASH)
  const runtime: NetworkRuntime = {
    net: ROBINHOOD_TESTNET,
    publicClient: {
      async readContract(args: { functionName: string }) {
        if (args.functionName === 'authorizationState') return opts.used
        if (args.functionName === 'balanceOf') return opts.balance
        throw new Error('unexpected call')
      },
      async waitForTransactionReceipt({ hash }: { hash: string }) {
        return { status: opts.receiptStatus, transactionHash: hash }
      },
    } as unknown as NetworkRuntime['publicClient'],
    walletClient: { writeContract } as unknown as NetworkRuntime['walletClient'],
  }
  const config: FacilitatorConfig = {
    port: 0,
    ledgerPath: ':memory:',
    signerAddress: facilitatorAccount.address,
    runtimes: new Map([[ROBINHOOD_TESTNET.id, runtime]]),
  }
  const ledger = new Ledger(':memory:')
  return { app: buildApp(config, ledger), ledger, writeContract }
}

describe('GET /healthz, /supported, /metrics', () => {
  it('reports health with the signer and configured networks', async () => {
    const { app } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'success' })
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.networks).toEqual(['robinhood-testnet'])
  })

  it('lists supported (scheme, network) kinds', async () => {
    const { app } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'success' })
    const res = await request(app).get('/supported')
    expect(res.status).toBe(200)
    expect(res.body.kinds).toEqual(
      expect.arrayContaining([{ x402Version: 1, scheme: 'exact', network: 'robinhood-testnet' }]),
    )
  })

  it('exposes Prometheus-formatted metrics', async () => {
    const { app } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'success' })
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.text).toContain('hood402_settlements_total{status="settled"} 0')
  })
})

describe('POST /verify', () => {
  it('returns isValid: true for a well-formed, funded payment', async () => {
    const { app } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'success' })
    const res = await request(app)
      .post('/verify')
      .send({ paymentPayload: await signedPayload(), paymentRequirements: requirements() })
    expect(res.status).toBe(200)
    expect(res.body.isValid).toBe(true)
  })

  it('returns 400 for a missing paymentPayload', async () => {
    const { app } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'success' })
    const res = await request(app).post('/verify').send({ paymentRequirements: requirements() })
    expect(res.status).toBe(400)
  })

  it('flags insufficient balance', async () => {
    const { app } = testApp({ used: false, balance: 1n, receiptStatus: 'success' })
    const res = await request(app)
      .post('/verify')
      .send({ paymentPayload: await signedPayload(), paymentRequirements: requirements() })
    expect(res.body).toEqual({ isValid: false, invalidReason: 'insufficient_funds' })
  })
})

describe('POST /settle', () => {
  it('broadcasts and returns a confirmed transaction', async () => {
    const { app, writeContract } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'success' })
    const payload = await signedPayload()
    const res = await request(app)
      .post('/settle')
      .send({ paymentPayload: payload, paymentRequirements: requirements() })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.transaction).toBe(TX_HASH)
    expect(writeContract).toHaveBeenCalledOnce()
  })

  it('is idempotent: settling the same authorization twice broadcasts only once', async () => {
    const { app, writeContract } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'success' })
    const payload = await signedPayload()
    const body = { paymentPayload: payload, paymentRequirements: requirements() }

    const first = await request(app).post('/settle').send(body)
    const second = await request(app).post('/settle').send(body)

    expect(first.status).toBe(200)
    expect(first.body.success).toBe(true)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    // Only the first request actually broadcast a transaction.
    expect(writeContract).toHaveBeenCalledOnce()
  })

  it('rejects settlement of a nonce the chain already reports as used', async () => {
    const { app, writeContract } = testApp({ used: true, balance: 1_000_000n, receiptStatus: 'success' })
    const res = await request(app)
      .post('/settle')
      .send({ paymentPayload: await signedPayload(), paymentRequirements: requirements() })
    expect(res.body.success).toBe(false)
    expect(res.body.errorReason).toBe('authorization_already_used')
    expect(writeContract).not.toHaveBeenCalled()
  })

  it('reports settlement_failed when the on-chain transaction reverts', async () => {
    const { app } = testApp({ used: false, balance: 1_000_000n, receiptStatus: 'reverted' })
    const res = await request(app)
      .post('/settle')
      .send({ paymentPayload: await signedPayload(), paymentRequirements: requirements() })
    expect(res.body.success).toBe(false)
    expect(res.body.errorReason).toBe('settlement_failed')
  })
})
