import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { loadOperatorConfig, launchConfigSchema } from '../core/config.js'
import { HoodLauncher } from '../core/launcher.js'
import { AutoScheduler, loadAutoConfig } from '../auto/scheduler.js'
import { ProposalStore } from '../auto/proposals.js'
import { ALL_RAILS, createRail } from '../rails/index.js'
import { clientFromOperatorConfig } from '../core/config.js'
import { HoodLauncherError } from '../errors.js'

const dataDir = process.env.HOOD_LAUNCHER_DATA_DIR ?? resolve(process.cwd(), '.hood-launcher')
const port = Number(process.env.PORT ?? 8787)

const operatorConfig = loadOperatorConfig()
const autoConfig = loadAutoConfig()
const launcher = new HoodLauncher(operatorConfig, dataDir)
const proposals = new ProposalStore(dataDir)
const scheduler = new AutoScheduler(launcher, operatorConfig, autoConfig, proposals)

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

/**
 * `hood-launcher`'s HTTP API — the programmatic twin of the CLI, sharing the
 * same `HoodLauncher` core.
 *
 *   GET  /health
 *   GET  /rails                       preflight status of every rail
 *   POST /launch        { config, theme?, dryRun? }   run the full pipeline
 *   GET  /auto/pending                list pending autonomous proposals
 *   POST /auto/tick                   run one poll-propose cycle
 *   POST /auto/approve/:id            approve + (if LIVE=1) execute a proposal
 *   POST /auto/reject/:id
 *   POST /kill                        engage the kill switch immediately
 */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, {
        ok: true,
        network: operatorConfig.network,
        live: operatorConfig.live,
        killed: launcher.killSwitch.isEngaged(),
      })
    }

    if (req.method === 'GET' && path === '/rails') {
      const client = clientFromOperatorConfig(operatorConfig)
      const probe = { name: 'probe', symbol: 'PROBE', description: '', logoUri: '', socials: {}, initialBuyWei: 0n }
      const results = await Promise.all(
        ALL_RAILS.map(async (name) => {
          const rail = createRail(name)
          if (!rail.networks.includes(operatorConfig.network)) {
            return { rail: name, available: false, reason: `not deployed on ${operatorConfig.network}` }
          }
          const preflight = await rail.preflight({ client }, probe)
          return { rail: name, available: true, preflight }
        }),
      )
      return send(res, 200, { network: operatorConfig.network, rails: results })
    }

    if (req.method === 'POST' && path === '/launch') {
      const body = (await readBody(req)) as { config: unknown; theme?: string; dryRun?: boolean }
      const launchConfig = launchConfigSchema.parse(body.config)
      const outcome = await launcher.launch(launchConfig, {
        dryRun: body.dryRun ?? false,
        ...(body.theme ? { theme: body.theme } : {}),
      })
      return send(res, 200, outcome)
    }

    if (req.method === 'GET' && path === '/auto/pending') {
      return send(res, 200, { proposals: proposals.list('pending') })
    }

    if (req.method === 'POST' && path === '/auto/tick') {
      const proposal = await scheduler.tick()
      return send(res, 200, { proposal })
    }

    const approveMatch = path.match(/^\/auto\/approve\/([a-f0-9]+)$/)
    if (req.method === 'POST' && approveMatch) {
      const result = await scheduler.approve(approveMatch[1] as string)
      return send(res, 200, { proposal: result })
    }

    const rejectMatch = path.match(/^\/auto\/reject\/([a-f0-9]+)$/)
    if (req.method === 'POST' && rejectMatch) {
      scheduler.reject(rejectMatch[1] as string)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/kill') {
      launcher.killSwitch.engage('HTTP POST /kill')
      return send(res, 200, { killed: true })
    }

    send(res, 404, { error: 'not_found', path })
  } catch (err) {
    const status = err instanceof HoodLauncherError ? 400 : 500
    send(res, status, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(port, () => {
  console.log(`hood-launcher API listening on :${port} (network=${operatorConfig.network} live=${operatorConfig.live})`)
})
