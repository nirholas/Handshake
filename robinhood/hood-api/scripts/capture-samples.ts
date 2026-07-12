import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from '../src/app.js'

/**
 * Captures real responses from a locally-running instance of this server and
 * writes them to `docs/samples.json`. The docs site embeds these as a
 * clearly-labeled "sample of live output — captured <timestamp>" fallback for
 * when it isn't loaded against a live deployment.
 */

const app = createApp()
const server = serve({ fetch: app.fetch, port: 0 }, async (info) => {
  const base = `http://127.0.0.1:${info.port}`
  const paths = {
    health: '/v1/health',
    chain: '/v1/chain',
    stocks: '/v1/stocks',
    stockDetail: '/v1/stocks/TSLA',
    coins: '/v1/coins?limit=8',
    launches: '/v1/launches?lookback=24h&limit=8',
    portfolioChallenge: '/v1/portfolio/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  }

  const samples: Record<string, unknown> = { capturedAt: new Date().toISOString() }
  for (const [key, path] of Object.entries(paths)) {
    const res = await fetch(base + path)
    samples[key] = { status: res.status, body: await res.json() }
    console.log(`captured ${key}: HTTP ${res.status}`)
  }

  // A <script src> file, not JSON fetched via XHR/fetch — the docs page must work when
  // opened directly via file://, where fetch() of a local file is blocked by browser CORS
  // policy but a <script> tag loads fine.
  const outPath = fileURLToPath(new URL('../docs/samples.js', import.meta.url))
  writeFileSync(outPath, `window.HOOD_API_SAMPLES = ${JSON.stringify(samples, null, 2)};\n`)
  console.log(`wrote ${outPath}`)
  server.close()
})
