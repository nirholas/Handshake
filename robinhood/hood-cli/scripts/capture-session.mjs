#!/usr/bin/env node
/**
 * Capture a REAL terminal session against live Robinhood Chain mainnet data
 * and write it to docs/session.json. The docs landing page's typewriter
 * animation replays this file verbatim — it is never hand-authored output.
 *
 * Run: npm run build && npm run capture
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bin = join(root, 'dist', 'cli.js')

if (!existsSync(bin)) {
  console.error(`dist/cli.js not found — run "npm run build" first.`)
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'hood-cli-capture-'))
const env = { ...process.env, HOOD_CONFIG_DIR: join(workDir, 'config'), FORCE_COLOR: '1' }

const SCRIPT = [
  { prompt: 'hood price AAPL', args: ['price', 'AAPL'] },
  { prompt: 'hood stocks --sort premium --dex --limit 6', args: ['stocks', '--sort', 'premium', '--dex', '--limit', '6'] },
  { prompt: 'hood launches --lookback 2000000 --limit 5 --names', args: ['launches', '--lookback', '2000000', '--limit', '5', '--names'] },
  {
    prompt: 'hood portfolio 0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52',
    args: ['portfolio', '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52'],
  },
  { prompt: 'hood swap --sell USDG --buy WETH --amount 250', args: ['swap', '--sell', 'USDG', '--buy', 'WETH', '--amount', '250'] },
  {
    prompt: 'hood tx 0x870a3bee3070f10e3c4f34271cfde70fd5aa0dc2eade6f07d01ae6c9a00285bd',
    args: ['tx', '0x870a3bee3070f10e3c4f34271cfde70fd5aa0dc2eade6f07d01ae6c9a00285bd'],
  },
]

console.log(`Capturing ${SCRIPT.length} real commands against Robinhood Chain mainnet…\n`)

const frames = []
for (const step of SCRIPT) {
  process.stdout.write(`$ ${step.prompt}\n`)
  const proc = spawnSync('node', [bin, ...step.args], { env, encoding: 'utf8', timeout: 60_000 })
  if (proc.status !== 0) {
    console.error(`\n✗ capture failed for "${step.prompt}" (exit ${proc.status})\n${proc.stderr}`)
    rmSync(workDir, { recursive: true, force: true })
    process.exit(1)
  }
  process.stdout.write(proc.stdout)
  frames.push({ prompt: step.prompt, output: proc.stdout.replace(/\n$/, '') })
}

rmSync(workDir, { recursive: true, force: true })

const outPath = join(root, 'docs', 'session.json')
writeFileSync(
  outPath,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      chain: 'Robinhood Chain mainnet (4663)',
      frames,
    },
    null,
    2,
  ) + '\n',
)

console.log(`\n✓ Wrote ${frames.length} real frames to ${outPath}`)
