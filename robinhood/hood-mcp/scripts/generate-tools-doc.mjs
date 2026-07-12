#!/usr/bin/env node
/**
 * Generate docs/tools.html directly from the servers' real registered tool
 * schemas — never hand-duplicated, so the reference can't drift from the
 * actual tools. Run after any tool change: `npx tsx scripts/generate-tools-doc.mjs`
 * (or `node scripts/generate-tools-doc.mjs` after `npm run build`, importing
 * from `../src/*.js` which then resolves against `dist/`).
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient } from 'hoodchain'
import { registerDataTools } from '../src/register-data.js'
import { registerTradingTools } from '../src/register-trading.js'
import { readTradingConfig, SpendLedger } from '../src/shared/trading-env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = path.join(__dirname, '..', 'docs')

// Build-time only — never used to sign anything, just to satisfy the
// "requires a wallet" constructor check so tool schemas can be listed.
const BUILD_KEY = '0x4918baba5b953918b69687637b543e8943bd2d2b83893ca51643c89845b9d16d'

async function listTools(register) {
  const server = new McpServer({ name: 'docgen', version: '0.0.0' })
  register(server)
  const [serverT, clientT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'docgen', version: '0.0.0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function paramsTable(tool) {
  const props = tool.inputSchema?.properties ?? {}
  const required = new Set(tool.inputSchema?.required ?? [])
  const names = Object.keys(props)
  if (names.length === 0) return '<p style="color:var(--text-faint);font-size:13px;">No parameters.</p>'
  const rows = names
    .map((name) => {
      const p = props[name]
      const type = p.type ?? (p.anyOf ? p.anyOf.map((x) => x.type).join(' | ') : 'any')
      return `<tr><td><code>${esc(name)}</code>${required.has(name) ? ' <span style="color:var(--down);font-size:11px;">required</span>' : ''}</td><td><code>${esc(type)}</code></td><td>${esc(p.description ?? '')}</td></tr>`
    })
    .join('\n')
  return `<div class="table-scroll"><table><thead><tr><th>Param</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

function toolCard(tool, kind) {
  const badge =
    kind === 'data'
      ? '<span class="pill free">free</span>'
      : tool.annotations?.destructiveHint
        ? '<span class="pill guarded">guarded</span>'
        : '<span class="pill free">read-only</span>'
  return `<div class="card" style="margin-bottom:14px;">
  <h3><code>${esc(tool.name)}</code> ${badge}</h3>
  <p>${esc(tool.description)}</p>
  ${paramsTable(tool)}
</div>`
}

async function main() {
  const hoodData = createHoodClient() // mainnet, read-only
  const dataTools = await listTools((s) => registerDataTools(s, hoodData))

  const hoodTrading = createHoodClient({ chain: 'mainnet', account: privateKeyToAccount(BUILD_KEY) })
  const config = readTradingConfig({ HOOD_MCP_ENABLE_TRADING: '1' })
  const ledger = new SpendLedger(config)
  const tradingTools = await listTools((s) => registerTradingTools(s, hoodTrading, config, ledger))

  const html = `<title>Tools — hood-mcp</title>
<meta name="description" content="Full tool reference for hood-mcp, generated from the servers' live registered schemas." />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🏹</text></svg>" />
<link rel="stylesheet" href="site.css" />

<nav class="top">
  <div class="wrap">
    <div class="brand"><span class="tick">hood</span>-mcp</div>
    <div class="links">
      <a href="index.html">Overview</a>
      <a href="install.html">Install</a>
      <a href="tools.html" aria-current="page">Tools</a>
      <a href="safety.html">Safety model</a>
      <a href="https://github.com/nirholas/hood-mcp">GitHub</a>
    </div>
  </div>
</nav>

<main class="wrap">
  <section style="border-top:none; padding-top:48px;">
    <h2 style="font-size:30px;">Tool reference</h2>
    <p class="section-lede">
      Generated directly from each server's live registered tool schemas — this page cannot
      drift from the actual tools. Regenerate with <code>node scripts/generate-tools-doc.mjs</code>.
    </p>
  </section>

  <section>
    <h2>hood-mcp — data server (${dataTools.length} tools)</h2>
    <p class="section-lede">Zero-config, read-only, no wallet required.</p>
    ${dataTools.map((t) => toolCard(t, 'data')).join('\n')}
  </section>

  <section>
    <h2>hood-mcp-trading — wallet server (${tradingTools.length} tools)</h2>
    <p class="section-lede">Requires <code>HOOD_MCP_ENABLE_TRADING=1</code> + a wallet key. See the <a href="safety.html">safety model</a>.</p>
    ${tradingTools.map((t) => toolCard(t, 'trading')).join('\n')}
  </section>

  <footer>
    Apache License 2.0 © 2026 nirholas · Built by <a href="https://x.com/nichxbt">nirholas</a> ·
    <a href="https://three.ws">three.ws</a>
  </footer>
</main>
`
  writeFileSync(path.join(DOCS_DIR, 'tools.html'), html)
  console.log(`Wrote docs/tools.html — ${dataTools.length} data tools, ${tradingTools.length} trading tools`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
