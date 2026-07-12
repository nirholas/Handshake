import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Fleet } from '../framework/fleet.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
// dist/server/dashboard.js -> ../../dashboard ; src/server/dashboard.ts (tsx) -> ../../dashboard
const STATIC_ROOT = join(__dirname, '..', '..', 'dashboard')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let rel = url.pathname === '/' ? '/index.html' : url.pathname
  if (rel.includes('..')) return false
  const path = join(STATIC_ROOT, rel)
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
    return true
  } catch {
    return false
  }
}

/**
 * The fleet dashboard: a tiny read API over {@link Fleet} plus a `POST /kill`
 * panic button, serving the static `dashboard/` UI. No framework — this is a
 * small, auditable surface that is also the E2E harness talks to.
 */
export function createDashboardServer(fleet: Fleet): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/summary' && req.method === 'GET') {
      return json(res, 200, fleet.summary())
    }
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      return json(res, 200, fleet.agentStatuses())
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/trades') && req.method === 'GET') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
      return json(res, 200, fleet.journal.recentTrades(agentId, 100))
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/journal') && req.method === 'GET') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
      return json(res, 200, fleet.journal.recentDecisions(agentId, 200))
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/equity') && req.method === 'GET') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
      return json(res, 200, fleet.journal.equityCurve(agentId, 500))
    }
    if (url.pathname === '/api/trades' && req.method === 'GET') {
      return json(res, 200, fleet.journal.allRecentTrades(100))
    }
    if (url.pathname === '/api/kill' && req.method === 'POST') {
      fleet.tripKill('dashboard')
      return json(res, 200, { killed: true, reason: 'dashboard' })
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true })
    }

    if (await serveStatic(req, res)) return
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
}
