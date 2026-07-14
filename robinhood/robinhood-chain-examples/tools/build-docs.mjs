/**
 * Build-time docs generator. Renders every example's README.md to static
 * HTML with syntax highlighting (marked + highlight.js, both server-side —
 * no client-side markdown fetching), builds the gallery landing page from
 * the shared manifest, and copies example 07's self-contained page into
 * docs/ so it runs live, embedded, on GitHub Pages.
 *
 * Run: node tools/build-docs.mjs
 */
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import { EXAMPLES } from './manifest.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const docsDir = join(root, 'docs')
const examplesDir = join(root, 'examples')

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext'
      return hljs.highlight(code, { language }).value
    },
  }),
)

const page = ({ title, description, active, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · Robinhood Chain Examples</title>
    <meta name="description" content="${description}" />
    <link rel="stylesheet" href="${active === 'home' ? '' : '../'}style.css" />
    <link rel="stylesheet" href="${active === 'home' ? '' : '../'}hljs-theme.css" />
  </head>
  <body>
    <div class="topbar">
      <a class="brand" href="${active === 'home' ? '.' : '..'}/index.html">Robinhood Chain Examples</a>
      <a class="ghlink" href="https://github.com/nirholas/robinhood-chain-examples">GitHub ↗</a>
    </div>
    <div class="wrap">${body}</div>
    <footer>
      Built by <a href="https://x.com/nichxbt">nirholas</a> ·
      <a href="https://three.ws">three.ws</a> ·
      powered by <a href="https://github.com/nirholas/robinhood-chain-sdk">hoodchain</a>
    </footer>
  </body>
</html>
`

async function buildStyle() {
  const css = `
:root {
  --bg: #0a0b0f; --panel: #14161d; --panel-2: #191c25; --line: #262a36;
  --text: #e8eaf0; --muted: #8b90a0; --accent-a: #6d5efc; --accent-b: #21d4a8;
  --radius: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: radial-gradient(1200px 600px at 70% -10%, #1a1330 0%, var(--bg) 55%) fixed;
  color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: rgba(10,11,15,0.85); backdrop-filter: blur(8px); z-index: 10; }
.brand { font-weight: 650; letter-spacing: -0.01em; color: var(--text); text-decoration: none; font-size: 14px; }
.ghlink { color: var(--muted); text-decoration: none; font-size: 13px; }
.ghlink:hover { color: var(--text); }
.wrap { max-width: 980px; margin: 0 auto; padding: 40px 20px 64px; }
h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.02em; background: linear-gradient(90deg, var(--accent-a), var(--accent-b)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero-sub { color: var(--muted); font-size: 14px; max-width: 640px; }
.embed-frame { margin-top: 28px; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--panel); }
.embed-frame iframe { display: block; width: 100%; height: 560px; border: 0; background: var(--bg); }
.embed-label { font-size: 12px; color: var(--muted); padding: 10px 16px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
.section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 40px 0 14px; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.card { background: linear-gradient(180deg, var(--panel-2), var(--panel)); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; text-decoration: none; color: var(--text); display: block; transition: border-color 0.2s ease, transform 0.2s ease; }
.card:hover, .card:focus-visible { border-color: #3a3f52; transform: translateY(-2px); outline: none; }
.card .num { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.card .title { font-weight: 650; margin-top: 4px; font-size: 15px; }
.card .concept { color: var(--muted); font-size: 12px; margin-top: 6px; }
.card .proves { font-size: 12px; margin-top: 10px; color: #b8bccb; line-height: 1.5; }
.badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 999px; margin-top: 10px; letter-spacing: 0.03em; }
.badge.Beginner { background: rgba(33,212,168,0.15); color: var(--accent-b); }
.badge.Intermediate { background: rgba(109,94,252,0.18); color: #b3a8ff; }
.badge.Advanced { background: rgba(255,90,122,0.15); color: #ff9db1; }
.badge.blocked { background: rgba(139,144,160,0.15); color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 13px; }
th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
th { background: var(--panel); color: var(--muted); font-weight: 600; font-size: 12px; }
code { background: var(--panel); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; font-size: 0.9em; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; overflow-x: auto; }
pre code { background: none; border: none; padding: 0; }
.readme a { color: #9b8dff; }
.readme h1 { font-size: 24px; }
.readme h2 { font-size: 18px; margin-top: 32px; border-top: 1px solid var(--line); padding-top: 20px; }
.readme blockquote { border-left: 3px solid var(--accent-a); margin: 16px 0; padding: 4px 16px; color: var(--muted); background: var(--panel); border-radius: 0 8px 8px 0; }
footer { max-width: 980px; margin: 0 auto; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding: 18px 20px 40px; }
a { color: #9b8dff; }
`
  await writeFile(join(docsDir, 'style.css'), css.trimStart())
}

async function buildHljsTheme() {
  const src = join(root, 'node_modules', 'highlight.js', 'styles', 'github-dark.css')
  const css = await readFile(src, 'utf8')
  await writeFile(join(docsDir, 'hljs-theme.css'), css)
}

async function buildExamplePage(ex) {
  const readmePath = join(examplesDir, ex.id, 'README.md')
  if (!existsSync(readmePath)) return
  const md = await readFile(readmePath, 'utf8')
  const html = await marked.parse(md)
  const body = `<div class="readme">${html}</div>`
  await mkdir(join(docsDir, 'examples', ex.id), { recursive: true })
  await writeFile(
    join(docsDir, 'examples', ex.id, 'index.html'),
    page({ title: ex.title, description: ex.concept, active: 'example', body }),
  )
}

async function buildGallery() {
  const cards = EXAMPLES.map((ex, i) => {
    const num = String(i + 1).padStart(2, '0')
    const badge = ex.blocked ? '<span class="badge blocked">blocked</span>' : `<span class="badge ${ex.difficulty}">${ex.difficulty}</span>`
    const proves = ex.blocked
      ? `Blocked on: <code>${ex.blocked}</code> (not built yet — see the README for the gap).`
      : ex.proves
    return `<a class="card" href="examples/${ex.id}/index.html">
      <div class="num">${num}</div>
      <div class="title">${ex.title}</div>
      <div class="concept">${ex.concept}</div>
      <div class="proves">${proves}</div>
      ${badge}
    </a>`
  }).join('\n')

  const body = `
<h1>Robinhood Chain Examples</h1>
<p class="hero-sub">14 small, runnable projects for Robinhood Chain (mainnet 4663 / testnet 46630) —
from a raw viem read to a live dashboard, a Telegram bot, and a paper trader. Every read below is real.</p>

<div class="embed-frame">
  <iframe src="embed/07-live-price-webpage.html" title="Live Robinhood Chain Stock Token prices" loading="lazy"></iframe>
  <div class="embed-label">
    <span>Example 07, running live — client-side JSON-RPC, no backend.</span>
    <a href="examples/07-live-price-webpage/index.html">How it works →</a>
  </div>
</div>

<div class="section-title">Which package do I need?</div>
<table>
  <thead><tr><th>You want to…</th><th>Use</th><th>Try</th></tr></thead>
  <tbody>
    <tr><td>Read one price, no dependency</td><td><code>viem</code> only</td><td>Example 01</td></tr>
    <tr><td>Read prices / portfolios in a Node script</td><td><code>hoodchain</code></td><td>Examples 02, 03</td></tr>
    <tr><td>Ship a static page with live prices</td><td><code>hoodchain</code>-derived raw RPC (no build step)</td><td>Example 07</td></tr>
    <tr><td>Build a React app</td><td><code>hoodchain</code> + a local hook (hoodkit not shipped yet)</td><td>Example 08</td></tr>
    <tr><td>Trade or launch on-chain</td><td><code>hoodchain</code>'s <code>swap</code> / <code>launchpads</code> modules</td><td>Examples 04, 05, 14</td></tr>
    <tr><td>Charge or pay for an API call</td><td><code>hood402</code> (not shipped yet)</td><td>Examples 09, 10</td></tr>
    <tr><td>Give an LLM agent chain tools</td><td><code>hood-mcp</code> (not shipped yet)</td><td>Example 11</td></tr>
  </tbody>
</table>

<div class="section-title">All examples</div>
<div class="grid">
${cards}
</div>
`
  await writeFile(join(docsDir, 'index.html'), page({ title: 'Gallery', description: 'Runnable Robinhood Chain examples, from a raw viem read to a live dashboard.', active: 'home', body }))
}

async function copyEmbeds() {
  await mkdir(join(docsDir, 'embed'), { recursive: true })
  await cp(join(examplesDir, '07-live-price-webpage', 'index.html'), join(docsDir, 'embed', '07-live-price-webpage.html'))
}

await mkdir(docsDir, { recursive: true })
await buildStyle()
await buildHljsTheme()
await copyEmbeds()
await Promise.all(EXAMPLES.map(buildExamplePage))
await buildGallery()
console.log(`Docs built: ${EXAMPLES.length} example pages + gallery + live embed → docs/`)
