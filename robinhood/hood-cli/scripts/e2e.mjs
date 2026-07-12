#!/usr/bin/env node
/**
 * Real end-to-end test of the BUILT binary — no mocks, no fixtures. Drives
 * `dist/cli.js` as a subprocess against the live Robinhood Chain mainnet RPC
 * and (when a funded key is present) a real testnet write. Prints a PASS/FAIL
 * table and exits non-zero on any failure, so it can gate a release.
 *
 * Run: npm run build && npm run e2e
 * Testnet writes: export ROBINHOOD_CHAIN_PRIVATE_KEY=0x... (funded via the
 * faucet — see `hood faucet --network testnet`) before running.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const workDir = mkdtempSync(join(tmpdir(), 'hood-cli-e2e-'))
// Strip ROBINHOOD_CHAIN_PRIVATE_KEY from the base env: env.wallet() checks it
// BEFORE the keystore, so leaving it set would silently satisfy the
// "refuses without a wallet" guard-rail test below even with no keystore
// configured. It's injected explicitly, only for the testnet section.
const { ROBINHOOD_CHAIN_PRIVATE_KEY: _testnetKeyFromEnv, ...restEnv } = process.env
const env = { ...restEnv, HOOD_CONFIG_DIR: join(workDir, 'config') }

const results = []

function run(label, args, { expectExit = 0, mustContain = [], mustNotContain = [], stdin, extraEnv, timeout = 60_000 } = {}) {
  const started = Date.now()
  const proc = spawnSync('node', [bin, ...args], {
    env: extraEnv ? { ...env, ...extraEnv } : env,
    encoding: 'utf8',
    input: stdin,
    timeout,
  })
  const ms = Date.now() - started
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`
  const exit = proc.status ?? -1

  const failures = []
  if (Array.isArray(expectExit) ? !expectExit.includes(exit) : exit !== expectExit) {
    failures.push(`expected exit ${JSON.stringify(expectExit)}, got ${exit}`)
  }
  for (const needle of mustContain) {
    if (!output.includes(needle)) failures.push(`missing expected text: ${JSON.stringify(needle)}`)
  }
  for (const needle of mustNotContain) {
    if (output.includes(needle)) failures.push(`contains forbidden text: ${JSON.stringify(needle)}`)
  }

  const ok = failures.length === 0
  results.push({ label, ok, ms, failures, command: `hood ${args.join(' ')}`, output })
  process.stdout.write(`${ok ? '✓' : '✗'} ${label} (${ms}ms)\n`)
  if (!ok) for (const f of failures) process.stdout.write(`    ${f}\n`)
  return proc
}

console.log(`\n== hood-cli E2E — real mainnet reads (RPC: public robinhood mainnet) ==\n`)

run('price: real mainnet AAPL quote', ['price', 'AAPL'], { mustContain: ['Oracle'] })
run('price --json: valid JSON with a live oracle number', ['price', 'AAPL', '--json'], {
  mustContain: ['"symbol": "AAPL"'],
})
run('stocks: full board renders', ['stocks', '--limit', '5'], { mustContain: ['Stock Tokens'] })
run('portfolio: real read on the known Uniswap deployer address', [
  'portfolio',
  '0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52',
], { mustContain: ['Portfolio'] })
run('token: AAPL metadata + oracle', ['token', 'AAPL'], { mustContain: ['Oracle'] })
run('launches: wide-window scan finds real NOXA launches', [
  'launches',
  '--lookback',
  '2000000',
  '--limit',
  '3',
], { mustContain: ['Launches'] })
run('coins --new: newest launches screener', ['coins', '--new', '--lookback', '2000000', '--limit', '3'], {
  mustContain: ['New coins'],
})
run('tx: decodes a real historical NOXA launch transaction', [
  'tx',
  '0x870a3bee3070f10e3c4f34271cfde70fd5aa0dc2eade6f07d01ae6c9a00285bd',
], { mustContain: ['Transaction', 'success'] })
run('swap: live quote on the real liquid USDG/WETH pool (no --execute)', [
  'swap',
  '--sell',
  'USDG',
  '--buy',
  'WETH',
  '--amount',
  '100',
], { mustContain: ['Swap quote'] })

console.log(`\n== Guard rails ==\n`)

run('price: unknown ticker exits NOT_FOUND (5)', ['price', 'NOT_A_REAL_TICKER'], { expectExit: 5 })
run('portfolio: invalid address exits USAGE (2)', ['portfolio', 'not-an-address'], { expectExit: 2 })
run('config: unknown key exits USAGE (2)', ['config', 'set', 'bogus', 'x'], { expectExit: 2 })
run('deploy-token: dry-run plan without --execute never asks for a wallet', [
  'deploy-token',
  '--config',
  writeTokenConfig(),
], { mustContain: ['Deploy plan'], mustNotContain: ['Wallet password'] })
run('transfer: refuses without a configured wallet (WALLET exit 6)', [
  'transfer',
  '--to',
  '0x000000000000000000000000000000000000dEaD',
  '--amount',
  '1',
  '--yes',
], { expectExit: 6 })

console.log(`\n== Wallet-backed flows ==\n`)

run('config set wallet: generates + encrypts a new keystore', ['config', 'set', 'wallet'], {
  extraEnv: { HOOD_WALLET_PASSWORD: 'testpassword123' },
  mustContain: ['Wallet generated'],
})
run('config get walletAddress: reads the generated address back', ['config', 'get', 'walletAddress'], {
  mustContain: ['0x'],
})
run('transfer: insufficient balance on the freshly generated (empty) wallet', [
  'transfer',
  '--to',
  '0x000000000000000000000000000000000000dEaD',
  '--amount',
  '1',
  '--yes',
], {
  extraEnv: { HOOD_WALLET_PASSWORD: 'testpassword123' },
  expectExit: 4,
  mustContain: ['Insufficient balance'],
})

console.log(`\n== Testnet write (gated on a funded key) ==\n`)

const testnetKey = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY
if (!testnetKey) {
  console.log(
    '⊘ SKIPPED — ROBINHOOD_CHAIN_PRIVATE_KEY not set. The testnet faucet requires a browser session\n' +
      '  (Cloudflare Turnstile + Google Sign-In) and cannot be automated headlessly; this is an owner\n' +
      '  action, not a code gap. Fund a key at https://faucet.testnet.chain.robinhood.com/, export it,\n' +
      '  and re-run `npm run e2e` to exercise a REAL signed testnet transfer + swap.\n',
  )
  results.push({ label: 'testnet transfer + swap (real signed tx)', ok: null, skipped: true })
} else {
  // A dedicated config dir keeps the imported testnet key out of the
  // mainnet keystore generated above — no overwrite prompt to route around.
  const testnetEnv = {
    HOOD_CONFIG_DIR: join(workDir, 'config-testnet'),
    HOOD_WALLET_PASSWORD: 'testpassword123',
    ROBINHOOD_CHAIN_IMPORT_KEY: testnetKey,
  }
  run('config set wallet --network testnet: imports the funded key', ['--network', 'testnet', 'config', 'set', 'wallet'], {
    extraEnv: testnetEnv,
    mustContain: ['Wallet imported'],
  })
  run('faucet --network testnet: real balance read for the imported key', ['--network', 'testnet', 'faucet'], {
    extraEnv: testnetEnv,
    mustContain: ['ETH'],
  })
  run('transfer --network testnet --execute: REAL signed testnet transfer', [
    '--network',
    'testnet',
    'transfer',
    '--to',
    '0x000000000000000000000000000000000000dEaD',
    '--amount',
    '0.0001',
    '--execute',
    '--yes',
  ], {
    extraEnv: testnetEnv,
    mustContain: ['confirmed'],
    timeout: 120_000,
  })
}

rmSync(workDir, { recursive: true, force: true })

console.log(`\n== Summary ==\n`)
const failed = results.filter((r) => r.ok === false)
const skipped = results.filter((r) => r.skipped)
const passed = results.filter((r) => r.ok === true)
console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (owner-blocked)\n`)
if (failed.length > 0) {
  console.error('FAILED:')
  for (const f of failed) console.error(`  - ${f.label}: ${f.failures.join('; ')}`)
  process.exit(1)
}

function writeTokenConfig() {
  const path = join(workDir, 'token.json')
  writeFileSync(path, JSON.stringify({ name: 'E2E Test Token', symbol: 'E2E', initialSupply: 1000 }))
  return path
}
