import { describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Hood402Client, fromAccount } from '../src/client/index.js'
import { buildPaymentRequired, buildRequirements, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER } from '../src/challenge.js'
import { decodePaymentHeader, encodeSettlementHeader } from '../src/scheme/encoding.js'
import { SpendCapExceededError } from '../src/errors.js'

const payerAccount = privateKeyToAccount(generatePrivateKey())
const PAY_TO = '0x2222222222222222222222222222222222222222'
const RESOURCE_URL = 'https://api.example.com/premium'

function requirements(priceAtomic: string) {
  return buildRequirements({
    price: { atomic: priceAtomic },
    payTo: PAY_TO,
    resource: RESOURCE_URL,
    network: 'robinhood-testnet',
  })
}

/** A fetch stub: first call returns 402, second call (with X-PAYMENT) returns 200. */
function make402ThenOkFetch(priceAtomic: string) {
  const settlement = encodeSettlementHeader({
    success: true,
    transaction: '0xabc',
    network: 'robinhood-testnet',
    payer: payerAccount.address,
  })
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: url.toString(), headers })
    if (!headers.get(PAYMENT_HEADER)) {
      const body = buildPaymentRequired(requirements(priceAtomic))
      return new Response(JSON.stringify(body), { status: 402 })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { [PAYMENT_RESPONSE_HEADER]: settlement },
    })
  })
  return { fetchStub, calls }
}

describe('Hood402Client — the pay-on-402 flow', () => {
  it('signs and retries automatically, returning a 200 and the settlement receipt', async () => {
    const { fetchStub, calls } = make402ThenOkFetch('10000')
    const client = new Hood402Client({
      signer: fromAccount(payerAccount),
      fetch: fetchStub as unknown as typeof fetch,
      maxSpendPerOrigin: '1.00',
    })

    const result = await client.fetchWithReceipt(RESOURCE_URL)

    expect(result.paid).toBe(true)
    expect(result.response.status).toBe(200)
    expect(result.settlement?.success).toBe(true)
    expect(calls).toHaveLength(2)
    const paymentHeader = calls[1]!.headers.get(PAYMENT_HEADER)
    const decoded = decodePaymentHeader(paymentHeader!)
    expect(decoded?.payload.authorization.from.toLowerCase()).toBe(
      payerAccount.address.toLowerCase(),
    )
    expect(decoded?.payload.authorization.value).toBe('10000')
  })

  it('passes through a non-402 response untouched (no payment attempted)', async () => {
    const fetchStub = vi.fn(async () => new Response('ok', { status: 200 }))
    const client = new Hood402Client({
      signer: fromAccount(payerAccount),
      fetch: fetchStub as unknown as typeof fetch,
    })
    const result = await client.fetchWithReceipt(RESOURCE_URL)
    expect(result.paid).toBe(false)
    expect(fetchStub).toHaveBeenCalledOnce()
  })

  it('tracks cumulative spend per origin', async () => {
    const { fetchStub } = make402ThenOkFetch('10000')
    const client = new Hood402Client({
      signer: fromAccount(payerAccount),
      fetch: fetchStub as unknown as typeof fetch,
      maxSpendPerOrigin: '1.00',
    })
    expect(client.spent('https://api.example.com')).toBe('0')
    await client.fetchWithReceipt(RESOURCE_URL)
    expect(client.spent('https://api.example.com')).toBe('0.01')
  })
})

describe('Hood402Client — spend cap enforcement', () => {
  it('throws SpendCapExceededError instead of paying above the cap', async () => {
    // Price is 2.00 USDG but the cap is 1.00 — must refuse before signing.
    const { fetchStub } = make402ThenOkFetch('2000000')
    const client = new Hood402Client({
      signer: fromAccount(payerAccount),
      fetch: fetchStub as unknown as typeof fetch,
      maxSpendPerOrigin: '1.00',
    })

    await expect(client.fetchWithReceipt(RESOURCE_URL)).rejects.toThrow(SpendCapExceededError)
    // Only the initial 402 probe happened — no paid retry was sent.
    expect(fetchStub).toHaveBeenCalledOnce()
  })

  it('accumulates spend across calls and refuses once the cap is reached', async () => {
    const { fetchStub } = make402ThenOkFetch('600000') // 0.60 USDG per call
    const client = new Hood402Client({
      signer: fromAccount(payerAccount),
      fetch: fetchStub as unknown as typeof fetch,
      maxSpendPerOrigin: '1.00',
    })

    await client.fetchWithReceipt(RESOURCE_URL) // spend: 0.60
    await expect(client.fetchWithReceipt(RESOURCE_URL + '?n=2')).rejects.toThrow(
      SpendCapExceededError,
    )
  })
})
