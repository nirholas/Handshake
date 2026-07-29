#!/usr/bin/env node
/**
 * Capture a REAL MCP session against the built data server and write it to
 * `docs/session.json`, which `scripts/build-docs.mjs` renders into the docs
 * landing page.
 *
 * Nothing here is scripted output: a real `@modelcontextprotocol/sdk` client
 * spawns `dist/data-server.js` as a child process, speaks JSON-RPC over stdio,
 * and every frame in both directions is recorded verbatim off the transport.
 * The tool results are whatever the live chain, Blockscout, DefiLlama, and
 * GeckoTerminal returned at capture time.
 *
 *   npm run build && node scripts/capture-session.mjs
 *   node scripts/capture-session.mjs --network testnet
 *
 * Re-run it whenever the tool surface changes; the page is only as honest as
 * its last capture, and every transcript carries its own `capturedAt`.
 */
import { writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const SERVER = path.join(ROOT, 'dist', 'data-server.js')
const OUT = path.join(ROOT, 'docs', 'session.json')

/** The calls the transcript makes, in order. */
const MAINNET_CALLS = [
  { name: 'get_chain_stats', arguments: {} },
  { name: 'get_stock_quote', arguments: { symbol: 'AAPL' } },
  { name: 'list_trending_coins', arguments: { limit: 5 } },
  { name: 'search_token', arguments: { query: 'NVDA', limit: 3 } },
]

const TESTNET_CALLS = [{ name: 'get_chain_stats', arguments: {} }]

/**
 * Run one session and return `{ network, frames, tools, calls }`. `frames` is
 * the verbatim wire log; `calls` pairs each request with its decoded result so
 * the renderer does not have to re-derive it.
 */
async function captureSession(network, calls) {
  const frames = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, HOOD_MCP_NETWORK: network },
    stderr: 'pipe',
  })

  // Tap the transport in both directions before anything connects, so the
  // initialize handshake itself is recorded.
  const send = transport.send.bind(transport)
  transport.send = (message, options) => {
    frames.push({ dir: 'out', at: new Date().toISOString(), message })
    return send(message, options)
  }
  let onmessage
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => onmessage,
    set: (fn) => {
      onmessage = (message, extra) => {
        frames.push({ dir: 'in', at: new Date().toISOString(), message })
        return fn(message, extra)
      }
    },
  })

  const client = new Client({ name: 'hood-mcp-session-capture', version: '1.0.0' })
  const startedAt = Date.now()
  await client.connect(transport)

  const serverInfo = client.getServerVersion()
  const instructions = client.getInstructions()
  const { tools } = await client.listTools()

  const results = []
  for (const call of calls) {
    const t0 = Date.now()
    const result = await client.callTool(call)
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    results.push({
      ...call,
      ms: Date.now() - t0,
      isError: Boolean(result.isError),
      text,
      parsed,
    })
    process.stderr.write(`  ${network} · ${call.name} -> ${result.isError ? 'error' : 'ok'} (${Date.now() - t0}ms)\n`)
  }

  await client.close()

  return {
    network,
    capturedAt: new Date().toISOString(),
    totalMs: Date.now() - startedAt,
    serverInfo,
    instructions,
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title ?? t.annotations?.title ?? null,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    calls: results,
    frames,
  }
}

async function main() {
  if (!existsSync(SERVER)) {
    console.error(`Build first: ${SERVER} does not exist. Run \`npm run build\`.`)
    process.exit(1)
  }

  const onlyNetwork = process.argv.includes('--network')
    ? process.argv[process.argv.indexOf('--network') + 1]
    : null

  const sessions = []
  if (!onlyNetwork || onlyNetwork === 'mainnet') {
    process.stderr.write('capturing mainnet session (chain 4663)\n')
    sessions.push(await captureSession('mainnet', MAINNET_CALLS))
  }
  if (!onlyNetwork || onlyNetwork === 'testnet') {
    process.stderr.write('capturing testnet session (chain 46630)\n')
    sessions.push(await captureSession('testnet', TESTNET_CALLS))
  }

  const failures = sessions.flatMap((s) => s.calls.filter((c) => c.isError).map((c) => `${s.network}/${c.name}`))
  writeFileSync(OUT, `${JSON.stringify({ capturedAt: new Date().toISOString(), sessions }, null, 2)}\n`)
  console.log(`session transcript -> ${OUT}`)
  if (failures.length) {
    console.error(`WARNING: tool calls returned errors: ${failures.join(', ')}`)
    process.exit(2)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
