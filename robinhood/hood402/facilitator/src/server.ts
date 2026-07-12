import express, { type NextFunction, type Request, type Response } from 'express'
import {
  requireNetwork,
  verifyPayment,
  settlePayment,
  isWellFormedPayload,
  X402_VERSION,
  SCHEME,
  type PaymentPayload,
  type PaymentRequirements,
  type VerifyResult,
  type SettleResult,
} from 'hood402'
import type { FacilitatorConfig } from './config.js'
import { supportedNetworks } from './config.js'
import { Ledger } from './ledger.js'

interface VerifyRequestBody {
  x402Version?: number
  paymentPayload?: PaymentPayload
  paymentRequirements?: PaymentRequirements
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message })
}

/** Build the Express app. Exported separately from `listen()` so tests can mount it directly. */
export function buildApp(config: FacilitatorConfig, ledger: Ledger) {
  const app = express()
  app.use(express.json({ limit: '64kb' }))

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, signer: config.signerAddress, networks: [...config.runtimes.keys()] })
  })

  app.get('/supported', (_req, res) => {
    const kinds = supportedNetworks().map((net) => ({
      x402Version: X402_VERSION,
      scheme: SCHEME,
      network: net.id,
    }))
    res.json({ kinds })
  })

  app.get('/metrics', (_req, res) => {
    const counts = ledger.counts()
    const totalSettledAtomic = ledger.totalSettledAtomic()
    res.set('content-type', 'text/plain; version=0.0.4')
    res.send(
      [
        '# HELP hood402_settlements_total Settlements by status.',
        '# TYPE hood402_settlements_total counter',
        `hood402_settlements_total{status="settled"} ${counts.settled}`,
        `hood402_settlements_total{status="failed"} ${counts.failed}`,
        `hood402_settlements_total{status="pending"} ${counts.pending}`,
        '# HELP hood402_settled_usdg_atomic_total Total USDG settled, atomic units (6 decimals).',
        '# TYPE hood402_settled_usdg_atomic_total counter',
        `hood402_settled_usdg_atomic_total ${totalSettledAtomic}`,
        '',
      ].join('\n'),
    )
  })

  function parseVerifyBody(req: Request, res: Response): VerifyRequestBody | null {
    const body = req.body as VerifyRequestBody
    if (!body || typeof body !== 'object') {
      badRequest(res, 'expected a JSON body')
      return null
    }
    if (!body.paymentPayload || !isWellFormedPayload(body.paymentPayload)) {
      badRequest(res, 'paymentPayload is missing or malformed')
      return null
    }
    if (!body.paymentRequirements) {
      badRequest(res, 'paymentRequirements is required')
      return null
    }
    return body
  }

  app.post('/verify', async (req, res, next: NextFunction) => {
    try {
      const body = parseVerifyBody(req, res)
      if (!body) return
      const net = requireNetwork(body.paymentPayload!.network)
      const runtime = config.runtimes.get(net.id)
      if (!runtime) {
        res.json({ isValid: false, invalidReason: 'unsupported_network' } satisfies VerifyResult)
        return
      }
      const result = await verifyPayment({
        payload: body.paymentPayload!,
        requirements: body.paymentRequirements!,
        reader: runtime.publicClient,
        network: net,
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  app.post('/settle', async (req, res, next: NextFunction) => {
    try {
      const body = parseVerifyBody(req, res)
      if (!body) return
      const payload = body.paymentPayload!
      const requirements = body.paymentRequirements!
      const net = requireNetwork(payload.network)
      const runtime = config.runtimes.get(net.id)
      if (!runtime) {
        res.json({
          success: false,
          errorReason: 'unsupported_network',
          network: net.id,
        } satisfies SettleResult)
        return
      }

      const auth = payload.payload.authorization
      const claim = ledger.claim({
        network: net.id,
        payer: auth.from,
        payTo: auth.to,
        amount: auth.value,
        nonce: auth.nonce,
      })

      if (!claim.claimed) {
        // Idempotent replay: return the original outcome instead of re-broadcasting.
        const existing = claim.existing
        if (existing.status === 'settled' && existing.tx_hash) {
          res.json({
            success: true,
            transaction: existing.tx_hash,
            network: net.id,
            payer: existing.payer,
          } satisfies SettleResult)
          return
        }
        if (existing.status === 'failed') {
          res.json({
            success: false,
            errorReason: 'authorization_already_used',
            network: net.id,
            payer: existing.payer,
          } satisfies SettleResult)
          return
        }
        // status === 'pending': a concurrent request owns this settlement.
        res.status(409).json({
          success: false,
          errorReason: 'authorization_already_used',
          network: net.id,
          payer: existing.payer,
        } satisfies SettleResult)
        return
      }

      const result = await settlePayment({
        payload,
        requirements,
        wallet: runtime.walletClient,
        reader: runtime.publicClient,
        network: net,
      })

      if (result.success && result.transaction) {
        ledger.markSettled(net.id, auth.from, auth.nonce, result.transaction)
      } else {
        ledger.markFailed(net.id, auth.from, auth.nonce, result.errorReason ?? 'settlement_failed')
      }
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'internal error'
    res.status(500).json({ error: message })
  })

  return app
}
