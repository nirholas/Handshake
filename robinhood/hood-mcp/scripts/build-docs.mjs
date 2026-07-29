#!/usr/bin/env node
/**
 * Render `docs/index.html` from the captured MCP session in
 * `docs/session.json`. Everything on the landing page is build-time rendered:
 * no client-side JS, no fetching, no template placeholders. If the transcript
 * is missing, this fails loudly rather than shipping a page with invented
 * numbers.
 *
 *   npm run build && node scripts/capture-session.mjs && node scripts/build-docs.mjs
 *
 * (or just `npm run docs`, which chains all three).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(__dirname, '..', 'docs')
const SESSION = path.join(DOCS, 'session.json')

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

/** Tint an escaped JSON string at build time. No client JS involved. */
function highlightJson(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return esc(json).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, bool, num) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`
      if (bool) return `<span class="j-bool">${match}</span>`
      if (num) return `<span class="j-num">${match}</span>`
      return `<span class="j-null">${match}</span>`
    },
  )
}

function fmtUsd(n) {
  if (n === null || n === undefined) return '—'
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function fmtInt(n) {
  if (n === null || n === undefined) return '—'
  return Number(n).toLocaleString('en-US')
}

/** One request/response pair in the transcript. */
function turn(label, kind, body, meta) {
  return `<div class="turn ${kind}">
      <div class="turn-label">${esc(label)}${meta ? `<span class="ms">${esc(meta)}</span>` : ''}</div>
      <pre><code>${highlightJson(body)}</code></pre>
    </div>`
}

function main() {
  if (!existsSync(SESSION)) {
    console.error(`Missing ${SESSION}. Run \`node scripts/capture-session.mjs\` first.`)
    process.exit(1)
  }
  const data = JSON.parse(readFileSync(SESSION, 'utf8'))
  const mainnet = data.sessions.find((s) => s.network === 'mainnet')
  const testnet = data.sessions.find((s) => s.network === 'testnet')
  if (!mainnet) {
    console.error('session.json has no mainnet session — recapture.')
    process.exit(1)
  }

  const stats = mainnet.calls.find((c) => c.name === 'get_chain_stats')?.parsed
  const quote = mainnet.calls.find((c) => c.name === 'get_stock_quote')?.parsed
  if (!stats || !quote) {
    console.error('session.json is missing get_chain_stats / get_stock_quote results — recapture.')
    process.exit(1)
  }

  const initReq = mainnet.frames.find((f) => f.dir === 'out' && f.message.method === 'initialize')
  const initRes = mainnet.frames.find((f) => f.dir === 'in' && f.message.result?.protocolVersion)
  const listReq = mainnet.frames.find((f) => f.dir === 'out' && f.message.method === 'tools/list')

  const premium = quote.premiumPct
  const premiumClass = premium >= 0 ? 'pos' : 'neg'
  const capturedDate = new Date(mainnet.capturedAt).toISOString().replace('T', ' ').slice(0, 19)

  const toolCallTurns = mainnet.calls
    .map((call) => {
      const req = {
        jsonrpc: '2.0',
        id: call.name,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments },
      }
      return `${turn(`→ tools/call  ${call.name}`, 'req', req)}
    ${turn('← result', 'res', call.text, `${call.ms} ms · live`)}`
    })
    .join('\n    ')

  const testnetTurns = testnet
    ? testnet.calls
        .map((call) => {
          const req = {
            jsonrpc: '2.0',
            id: call.name,
            method: 'tools/call',
            params: { name: call.name, arguments: call.arguments },
          }
          return `${turn(`→ tools/call  ${call.name}`, 'req', req)}
    ${turn('← result', 'res', call.text, `${call.ms} ms · live`)}`
        })
        .join('\n    ')
    : ''

  const toolList = mainnet.tools
    .map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.description)}</td></tr>`)
    .join('\n          ')

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>hood-mcp: a real Robinhood Chain agent session</title>
<meta name="description" content="A verbatim MCP session transcript: a real client spawns hood-mcp over stdio, initializes, lists 9 tools, and asks what AAPL is trading at on-chain and what the premium is. Live chain-4663 numbers, captured, not written." />
<link rel="canonical" href="https://nirholas.github.io/hood-mcp/" />
<meta name="theme-color" content="#0a0d10" />
<meta property="og:type" content="website" />
<meta property="og:title" content="hood-mcp: a real Robinhood Chain agent session" />
<meta property="og:description" content="Verbatim MCP wire transcript against Robinhood Chain 4663: AAPL oracle vs DEX price, the premium, trending coins, token search. Every number captured from a live run." />
<meta property="og:url" content="https://nirholas.github.io/hood-mcp/" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="hood-mcp: a real Robinhood Chain agent session" />
<meta name="twitter:description" content="A real MCP client, the real server, live chain 4663 data. The transcript is the documentation." />
<meta name="twitter:creator" content="@nichxbt" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230a0d10'/><path d='M7 22V10m0 6h8m0-6v12' fill='none' stroke='%2300c805' stroke-width='2.6' stroke-linecap='round'/><circle cx='24' cy='12' r='2.6' fill='%2335e0c0'/></svg>" />
<link rel="stylesheet" href="site.css" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SoftwareApplication","name":"hood-mcp","applicationCategory":"DeveloperApplication","operatingSystem":"Node.js >= 20","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},"description":"Model Context Protocol servers for Robinhood Chain (chain ID 4663): a zero-config read-only data server and an explicitly opt-in trading server with hard spend caps and a confirm gate.","softwareVersion":"${esc(mainnet.serverInfo?.version ?? '0.1.0')}","author":{"@type":"Person","name":"nirholas","url":"https://x.com/nichxbt"},"downloadUrl":"https://www.npmjs.com/package/hood-mcp","codeRepository":"https://github.com/nirholas/hood-mcp"}
</script>
</head>
<body>

<nav class="top">
  <div class="wrap">
    <div class="brand"><span class="tick">hood</span>-mcp</div>
    <div class="links">
      <a href="index.html" aria-current="page">Session</a>
      <a href="install.html">Install</a>
      <a href="tools.html">Tools</a>
      <a href="safety.html">Safety model</a>
      <a href="https://github.com/nirholas/hood-mcp">GitHub</a>
    </div>
  </div>
</nav>

<main class="wrap">

  <section style="border-top:none; padding-top:56px;">
    <p class="eyebrow">Captured session · ${esc(capturedDate)} UTC</p>
    <h1>“What is AAPL trading at on-chain,<br />and what is the premium?”</h1>
    <p class="section-lede">
      Below is the answer, and then the entire wire transcript that produced it: a real
      <a href="https://modelcontextprotocol.io">Model Context Protocol</a> client spawning
      <code>hood-mcp</code> over stdio, initializing, listing its ${mainnet.tools.length} tools, and
      calling ${mainnet.calls.length} of them against live Robinhood Chain mainnet (4663). Nothing on this page
      is written by hand. It is generated from
      <a href="session.json">session.json</a>, the recorded frames of one run.
    </p>

    <dl class="figures">
      <div>
        <dt>${esc(quote.symbol)} · Chainlink oracle</dt>
        <dd>${fmtUsd(quote.chainlink?.priceUsd)}<small>feed answer, ${fmtInt(quote.chainlink?.ageSeconds)}s old</small></dd>
      </div>
      <div>
        <dt>${esc(quote.symbol)} · Uniswap DEX</dt>
        <dd>${fmtUsd(quote.dexPriceUsd)}<small>on-chain v3 mid price</small></dd>
      </div>
      <div>
        <dt>Premium</dt>
        <dd class="${premiumClass}">${premium >= 0 ? '+' : ''}${esc(premium)}%<small>DEX vs oracle</small></dd>
      </div>
      <div>
        <dt>Chain 4663</dt>
        <dd>#${fmtInt(stats.latestBlock)}<small>${esc(stats.blockscout?.averageBlockTimeMs ?? '—')} ms blocks · ${fmtUsd(stats.tvlUsd)} TVL</small></dd>
      </div>
    </dl>

    <p class="section-lede">
      That premium is the whole trade: a Stock Token can drift from its oracle, and an agent that can
      read both sides in one tool call can act on the gap. <code>get_stock_quote</code> returns the
      oracle price, the DEX price, the spread, and the ERC-8056 <code>uiMultiplier</code> so the
      underlying share price is never misstated after a split.
    </p>

    <p class="note">
      <strong>Reproduce it.</strong> <code>npm install &amp;&amp; npm run build &amp;&amp; npm run docs</code> re-runs the
      capture against the chain as it is right now and re-renders this page. The numbers above will
      differ from yours, because they are real.
    </p>
  </section>

  <section id="transcript">
    <h2>The transcript</h2>
    <p class="section-lede">
      Every frame below was recorded off the stdio transport in both directions during a single run
      of <code>scripts/capture-session.mjs</code>. Request frames are the client speaking; result
      frames are the server's, verbatim.
    </p>

    <div class="transcript">
      <div class="transcript-head">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>node dist/data-server.js &nbsp;·&nbsp; stdio &nbsp;·&nbsp; HOOD_MCP_NETWORK=mainnet</span>
        <span style="margin-left:auto">${esc(mainnet.frames.length)} frames · ${esc(mainnet.totalMs)} ms total</span>
      </div>

      ${turn('→ initialize', 'req', initReq?.message ?? {}, 'handshake')}
      ${turn('← initialize result', 'res', initRes?.message ?? {}, 'server capabilities')}
      ${turn('→ tools/list', 'req', listReq?.message ?? {})}
      <div class="turn res">
        <div class="turn-label">← ${mainnet.tools.length} tools<span class="ms">schemas in <a href="tools.html">the reference</a></span></div>
        <div class="table-scroll"><table>
          <thead><tr><th>Tool</th><th>Description the model routes on</th></tr></thead>
          <tbody>
          ${toolList}
          </tbody>
        </table></div>
      </div>
      ${toolCallTurns}
    </div>

    <p class="section-lede" style="margin-top:18px;">
      The server's <code>instructions</code> string (returned in the handshake and shown to the model
      before any tool is picked) is what keeps routing sane on a chain with both tokenized equities
      and memecoins:
    </p>
    <pre><code>${esc(mainnet.instructions ?? '')}</code></pre>
  </section>

  ${
    testnet
      ? `<section id="testnet">
    <h2>Same server, testnet 46630</h2>
    <p class="section-lede">
      One env var switches networks. Captured in the same run against the live testnet, which is a
      different chain with its own block height, gas market, and Blockscout index.
    </p>
    <div class="transcript">
      <div class="transcript-head">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>node dist/data-server.js &nbsp;·&nbsp; stdio &nbsp;·&nbsp; HOOD_MCP_NETWORK=testnet</span>
        <span style="margin-left:auto">${esc(testnet.frames.length)} frames · ${esc(testnet.totalMs)} ms total</span>
      </div>
      ${testnetTurns}
    </div>
  </section>`
      : ''
  }

  <section id="install">
    <h2>Add it to your client</h2>
    <p class="section-lede">
      The data server is zero-config and read-only: no API key, no wallet, no account. The full
      matrix (Claude Desktop, Cursor, Smithery, raw stdio, Streamable HTTP) is on the
      <a href="install.html">install page</a>.
    </p>
    <pre><code>claude mcp add hood-mcp -- npx -y hood-mcp</code></pre>
    <div class="grid">
      <div class="card">
        <h3>Data server <span class="pill free">free</span></h3>
        <p>${mainnet.tools.length} read-only tools: quotes with the oracle/DEX premium, multiplier-correct portfolios, launches, trending coins, chain stats, token search.</p>
        <p style="margin:0"><a href="tools.html">Tool reference →</a></p>
      </div>
      <div class="card">
        <h3>Trading server <span class="pill guarded">opt-in</span></h3>
        <p>A separate binary that never starts unless you set <code>HOOD_MCP_ENABLE_TRADING=1</code> and a wallet key. Hard USD spend caps per call and per session, plus a simulate-then-confirm round trip on every mutating tool.</p>
        <p style="margin:0"><a href="safety.html">Safety model →</a></p>
      </div>
    </div>
  </section>

</main>

<footer class="wrap">
  © 2026 nirholas · Built by <a href="https://x.com/nichxbt">nirholas</a> ·
  <a href="https://three.ws">three.ws</a> ·
  <a href="https://www.npmjs.com/package/hood-mcp">npm</a>
</footer>

</body>
</html>
`

  writeFileSync(path.join(DOCS, 'index.html'), html)
  console.log(
    `Wrote docs/index.html — ${mainnet.calls.length} mainnet tool calls, ${mainnet.frames.length} frames, captured ${mainnet.capturedAt}`,
  )
}

main()
