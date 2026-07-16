/**
 * hood-pay demo shop - a real merchant, end to end.
 *
 * One digital good ("The USDG Merchant's Field Guide") sold for USDG on
 * Robinhood Chain. This wires every hood-pay piece together with NO mocks:
 *
 *   1. POST /api/checkout        -> reserve a unique fingerprinted amount in the
 *                                   SQLite ledger (direct mode) and start a
 *                                   reorg-safe on-chain watcher for that invoice.
 *   2. the buyer pays in the widget (public/index.html) -> a plain USDG transfer
 *                                   of the exact fingerprinted amount.
 *   3. the watcher confirms the transfer on-chain (never from the DOM), records
 *                                   it idempotently, and fires a SIGNED webhook.
 *   4. POST /hooks/hood-pay      -> the shop's own webhook receiver verifies the
 *                                   signature and unlocks the download.
 *   5. GET /api/checkout/:id     -> the browser polls until status = paid and
 *                                   then reveals the good.
 *
 * Config (all optional; sensible testnet defaults):
 *   NETWORK           mainnet | testnet          (default testnet)
 *   MERCHANT_ADDRESS  0x… receiving address       (default the project address)
 *   TOKEN_ADDRESS     ERC-20 to accept            (default USDG on NETWORK)
 *   TOKEN_SYMBOL      display symbol               (default USDG)
 *   TOKEN_DECIMALS    token decimals               (default 6)
 *   PRICE             decimal price, <= 2 dp       (default 1.00)
 *   PORT              http port                    (default 8788)
 *   WEBHOOK_SECRET    hmac secret for webhooks     (default a demo secret)
 *
 * Run:  npm install && npm start
 */
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import express from 'express'
import { formatUnits, parseUnits } from 'viem'
import { networkInfo } from 'hood-pay'
import {
  awaitPayment,
  createReader,
  createLedger,
  createWebhookEmitter,
  toWebhookEvent,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
} from 'hood-pay/verify'

const __dirname = dirname(fileURLToPath(import.meta.url))

const NETWORK = process.env.NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
const info = networkInfo(NETWORK)
const MERCHANT = process.env.MERCHANT_ADDRESS ?? '0x4022de2D36C334E73C7a108805Cea11C0564f402'
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ?? info.usdg.address
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL ?? info.usdg.symbol
const TOKEN_DECIMALS = process.env.TOKEN_DECIMALS ? Number(process.env.TOKEN_DECIMALS) : info.usdg.decimals
const PRICE = process.env.PRICE ?? '1.00'
const PORT = Number(process.env.PORT ?? 8788)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'hood-pay-demo-secret-change-me'

const PRODUCT = {
  id: 'field-guide',
  title: "The USDG Merchant's Field Guide",
  blurb: 'A one-page cheat sheet for accepting USDG on Robinhood Chain without a payment processor.',
  price: PRICE,
  // The "digital good" delivered on payment (kept trivial - the point is the flow).
  contents:
    'THANK YOU. Your USDG payment settled on-chain and this shop verified it against the ' +
    'ledger - not the DOM. Reference the tx hash below for your records. Reorg-safe, ' +
    'non-custodial, no processor took a cut.',
}

const ledger = await createLedger(join(__dirname, 'shop.sqlite'))
const reader = createReader(NETWORK)
const baseUrl = () => `http://localhost:${PORT}`

// Deliveries are posted to the shop's OWN webhook endpoint so the demo is
// self-contained. In production point WEBHOOK_URL at your real receiver.
const webhook = createWebhookEmitter({
  url: process.env.WEBHOOK_URL ?? `${baseUrl()}/hooks/hood-pay`,
  secret: WEBHOOK_SECRET,
})

// Invoices whose payment has been verified and whose good is unlocked.
const fulfilled = new Set()

const app = express()

// Capture the raw body for webhook signature verification, but still parse JSON.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8')
    },
  }),
)

app.get('/api/product', (_req, res) => {
  res.json({
    ...PRODUCT,
    network: NETWORK,
    chainId: info.chainId,
    token: { address: TOKEN_ADDRESS, symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS },
  })
})

// Start a checkout: reserve a fingerprinted amount and begin watching for it.
app.post('/api/checkout', async (_req, res) => {
  try {
    const baseRaw = parseUnits(PRODUCT.price, TOKEN_DECIMALS)
    const invoice = ledger.createDirectInvoice({
      network: NETWORK,
      payTo: MERCHANT,
      token: TOKEN_ADDRESS,
      baseRaw,
      memo: PRODUCT.title,
    })
    const fromBlock = await reader.getBlockNumber()
    // The exact fingerprinted amount the buyer must send (base + reserved dust).
    const amount = formatUnits(invoice.expectedRaw, TOKEN_DECIMALS)

    // Watch the chain in the background. Amounts are read on-chain, never trusted
    // from the browser. On settlement, record it and fire the signed webhook.
    void awaitPayment(
      {
        token: TOKEN_ADDRESS,
        payTo: MERCHANT,
        expectedRaw: invoice.expectedRaw,
      },
      {
        reader,
        fromBlock,
        confirmations: NETWORK === 'testnet' ? 3 : 30,
        timeoutMs: 15 * 60_000,
      },
    ).then(async (result) => {
      for (const transfer of result.transfers) ledger.recordTransfer(invoice.id, transfer)
      const fresh = ledger.setStatus(invoice.id, result.status)
      if (result.status === 'paid' || result.status === 'overpaid') fulfilled.add(invoice.id)
      const event = toWebhookEvent(`payment.${result.status}`, invoice.id, {
        ...result,
        // carry ledger-known payer if the watcher attributed one
        payer: result.payer ?? fresh.payer,
      })
      const delivery = await webhook.emit(event)
      ledger.recordWebhookDelivery({
        paymentId: invoice.id,
        event: event.type,
        ok: delivery.ok,
        attempts: delivery.attempts,
        lastError: delivery.error,
      })
      console.log(`[checkout ${invoice.id}] ${result.status} - webhook ${delivery.ok ? 'delivered' : 'FAILED'}`)
    })

    res.json({
      invoiceId: invoice.id,
      payTo: MERCHANT,
      amount,
      network: NETWORK,
      memo: PRODUCT.title,
      token: { address: TOKEN_ADDRESS, symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS },
    })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

// Poll invoice status. Reveals the good only once payment is verified.
app.get('/api/checkout/:id', (req, res) => {
  const invoice = ledger.getInvoice(req.params.id)
  if (!invoice) return res.status(404).json({ error: 'unknown invoice' })
  const paid = fulfilled.has(invoice.id)
  res.json({
    invoiceId: invoice.id,
    status: invoice.status,
    receivedRaw: invoice.receivedRaw.toString(),
    payer: invoice.payer,
    good: paid ? PRODUCT.contents : null,
    explorer: invoice.payer ? `${info.explorerUrl}/address/${MERCHANT}` : null,
  })
})

// The shop's own webhook receiver - verifies the signature before trusting it.
app.post('/hooks/hood-pay', (req, res) => {
  const header = req.get(SIGNATURE_HEADER)
  if (!header || !verifyWebhookSignature(WEBHOOK_SECRET, req.rawBody, header)) {
    console.warn('[webhook] rejected: bad signature')
    return res.sendStatus(400)
  }
  const event = req.body
  console.log(`[webhook] verified ${event.type} for ${event.invoiceId} (status ${event.payment.status})`)
  res.sendStatus(200)
})

app.get('/', async (_req, res, next) => {
  try {
    res.type('html').send(await readFile(join(__dirname, 'public', 'index.html'), 'utf8'))
  } catch (error) {
    next(error)
  }
})

// Serve the built widget bundle from the installed package.
app.get('/hood-pay.min.js', async (_req, res, next) => {
  try {
    res.type('application/javascript').send(
      await readFile(join(__dirname, 'node_modules', 'hood-pay', 'dist', 'hood-pay.min.js'), 'utf8'),
    )
  } catch {
    // Fallback to the repo build during local development against file:../..
    try {
      res.type('application/javascript').send(
        await readFile(join(__dirname, '..', '..', 'dist', 'hood-pay.min.js'), 'utf8'),
      )
    } catch (error) {
      next(error)
    }
  }
})

createServer(app).listen(PORT, () => {
  console.log(`hood-pay demo shop on ${baseUrl()}`)
  console.log(`  network:  ${NETWORK} (chain ${info.chainId})`)
  console.log(`  merchant: ${MERCHANT}`)
  console.log(`  token:    ${TOKEN_SYMBOL} @ ${TOKEN_ADDRESS} (${TOKEN_DECIMALS} decimals)`)
  console.log(`  price:    ${PRODUCT.price} ${TOKEN_SYMBOL}`)
})
