/**
 * 09 — Pay for an API call: the x402 client side, step by step.
 *
 * A metered Robinhood Chain endpoint answers an unpaid request with HTTP 402
 * and a machine-readable price. This example decodes that challenge, signs an
 * EIP-3009 USDG authorization for exactly the quoted amount, retries with the
 * `X-PAYMENT` header, and reads the settlement receipt off `X-PAYMENT-RESPONSE`
 * — every step printed, nothing hidden inside a wrapper.
 *
 * The endpoint being paid is a hood-api-shaped quote route (`/v1/quote/:symbol`)
 * gated by hood402's `paywall()`. By default this file starts it locally so the
 * example is standalone; point it anywhere else with `--url`, including a
 * deployed hood-api instance you have put behind the USDG rail:
 *
 *   node index.js                                   # local endpoint, testnet rail
 *   node index.js --url https://api.example.com/v1/quote/AAPL
 *   HOOD_API_URL=http://localhost:8787 node index.js   # paywall a real hood-api
 *
 * Paying for real needs a payer wallet holding testnet USDG:
 *
 *   ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js
 *
 * Without it, a fresh keypair is generated. The 402, the signature, and the
 * on-chain verification are all still real — the payer just genuinely holds
 * 0 USDG, so the server correctly reports `insufficient_funds`. No output here
 * is fabricated, ever.
 *
 * Note on the USDG rail: USDG has 6 decimals and NO EIP-2612 permit, so the
 * gasless path is EIP-3009 `transferWithAuthorization` (verified live by
 * hood402's `npm run verify:usdg`). The payer signs; the resource server or a
 * facilitator broadcasts and pays the gas.
 */
import { createServer } from 'node:http'
import express from 'express'
import { Hood402Client, fromAccount } from 'hood402/client'
import { paywall } from 'hood402/server'
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  encodePaymentHeader,
  decodeSettlementHeader,
  requireNetwork,
} from 'hood402'
import { createHoodClient, getQuote } from 'hoodchain'
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const urlFlag = process.argv.indexOf('--url')
const explicitUrl = urlFlag >= 0 ? process.argv[urlFlag + 1] : null
const networkId = process.env.HOOD402_NETWORK ?? 'robinhood-testnet'
const net = requireNetwork(networkId)
const hoodApiUrl = process.env.HOOD_API_URL?.replace(/\/$/, '')

// --- payer -------------------------------------------------------------------
const payerKey = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY
const payer = privateKeyToAccount(
  payerKey ? (payerKey.startsWith('0x') ? payerKey : `0x${payerKey}`) : generatePrivateKey(),
)
const client = new Hood402Client({
  signer: fromAccount(payer),
  maxSpendPerOrigin: process.env.HOOD402_MAX_SPEND_PER_ORIGIN ?? '1.00',
  allowedNetworks: [net.id],
})

console.log(`x402 paid API call — ${net.id} (chain ${net.chainId})`)
console.log(`  payer  ${payer.address}${payerKey ? '' : '  (ephemeral: no ROBINHOOD_CHAIN_PRIVATE_KEY set)'}`)
console.log(`  USDG   ${net.usdg}  6 decimals, EIP-3009 rail`)

// --- the endpoint to pay ------------------------------------------------------
let server = null
let target = explicitUrl

if (!target) {
  const reader = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl) })
  const gas = privateKeyToAccount(process.env.FACILITATOR_PRIVATE_KEY ?? generatePrivateKey())
  const hood = createHoodClient({ chain: 'mainnet' })

  const app = express()
  app.get(
    '/v1/quote/:symbol',
    paywall({
      price: '0.01',
      payTo: gas.address,
      network: net.id,
      description: 'Robinhood Chain Stock Token quote (Chainlink oracle price + freshness).',
      wallet: createWalletClient({ account: gas, chain: net.chain, transport: http(net.rpcUrl) }),
      account: gas.address,
      reader,
    }),
    async (req, res) => {
      try {
        if (hoodApiUrl) {
          // Monetize a real hood-api deployment: the paywall sits in front and
          // the upstream stays free/internal.
          const upstream = await fetch(`${hoodApiUrl}/v1/stocks/${req.params.symbol}`)
          res.status(upstream.status).json(await upstream.json())
          return
        }
        const q = await getQuote(hood, req.params.symbol)
        res.json({
          symbol: q.symbol,
          priceUsd: q.priceUsd,
          feed: q.feed,
          updatedAt: q.updatedAt,
          ageSeconds: q.ageSeconds,
        })
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  target = `http://127.0.0.1:${server.address().port}/v1/quote/AAPL`
  console.log(`  seller ${gas.address}  (local endpoint, self-settling)`)
  console.log(`  source ${hoodApiUrl ? `hood-api at ${hoodApiUrl}` : 'hoodchain getQuote on mainnet 4663'}`)
}

console.log(`  target ${target}\n`)

// --- 1. unpaid request: read the price off the 402 ----------------------------
console.log('1. GET without payment')
const challengeRes = await fetch(target)
if (challengeRes.status !== 402) {
  console.log(`   HTTP ${challengeRes.status} — endpoint is not metered, nothing to pay.`)
  console.log(`   body: ${(await challengeRes.text()).slice(0, 200)}`)
  server?.close()
  process.exit(0)
}
const challenge = await challengeRes.json()
const requirements = challenge.accepts.find((a) => a.scheme === 'exact' && a.network === net.id)
if (!requirements) {
  console.error(`   402, but no "exact" requirement on ${net.id}. accepts: ${JSON.stringify(challenge.accepts)}`)
  server?.close()
  process.exit(1)
}
console.log(`   HTTP 402 · x402Version ${challenge.x402Version}`)
console.log(`   price    ${formatUnits(BigInt(requirements.maxAmountRequired), net.usdgDecimals)} USDG`)
console.log(`   payTo    ${requirements.payTo}`)
console.log(`   asset    ${requirements.asset}`)
console.log(`   expires  ${requirements.maxTimeoutSeconds}s after payment`)

// --- 2. sign the authorization ------------------------------------------------
console.log('\n2. Sign an EIP-3009 authorization for exactly that amount')
const payload = await client.sign(requirements)
const auth = payload.payload.authorization
console.log(`   from       ${auth.from}`)
console.log(`   to         ${auth.to}`)
console.log(`   value      ${auth.value} atomic (${formatUnits(BigInt(auth.value), net.usdgDecimals)} USDG)`)
console.log(`   validAfter ${auth.validAfter}   validBefore ${auth.validBefore}`)
console.log(`   nonce      ${auth.nonce}`)
console.log(`   signature  ${payload.payload.signature.slice(0, 22)}…${payload.payload.signature.slice(-8)}`)

// --- 3. retry with X-PAYMENT ---------------------------------------------------
console.log('\n3. Retry with the X-PAYMENT header')
const paidRes = await fetch(target, { headers: { [PAYMENT_HEADER]: encodePaymentHeader(payload) } })
console.log(`   HTTP ${paidRes.status}`)

const settlementHeader = paidRes.headers.get(PAYMENT_RESPONSE_HEADER)
if (settlementHeader) {
  const settlement = decodeSettlementHeader(settlementHeader)
  console.log(`   settled    ${settlement.success}`)
  console.log(`   txHash     ${settlement.transaction}`)
  console.log(`   payer      ${settlement.payer}`)
  console.log(`   explorer   ${net.explorerUrl}/tx/${settlement.transaction}`)
}

const body = await paidRes.json()
if (paidRes.ok) {
  console.log('\n   Paid response:')
  console.log(`   ${JSON.stringify(body)}`)
  console.log(`\n   Spent against this origin so far: ${client.spent(target)} USDG`)
} else {
  console.log(`   error      ${body.error ?? 'unknown'}`)
  console.log('\n   The 402, the signature, and the on-chain verification above are all real.')
  console.log('   This payer holds 0 USDG on the network, so the server refused the payment')
  console.log('   rather than settling one that would revert. Fund a testnet wallet and set')
  console.log('   ROBINHOOD_CHAIN_PRIVATE_KEY to see step 3 return the data plus a tx hash.')
  console.log(`   Faucet: https://faucet.testnet.chain.robinhood.com/`)
}

server?.close()
