/**
 * 13. Launch a coin on Robinhood Chain testnet.
 *
 * Robinhood Chain has two native launchpads (NOXA and The Odyssey) plus a
 * direct Uniswap v3 rail, and `hood-launcher` puts all three behind one call.
 * This example walks the full pipeline for a single coin: build the concept,
 * run the rail's on-chain preflight, show exactly what the launch will cost
 * and what it will send, then either stop (dry run, the default) or broadcast.
 *
 *   node index.js --name "Test Coin" --symbol TEST        # dry run, reads only
 *   node index.js --rail odyssey                          # price a different rail
 *   LIVE=1 ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js --send
 *
 * The dry run is not a simulation against a fake chain: preflight is a real
 * read against the real factory contracts, so the fee, the pair token, and any
 * blockers are the chain's actual answers. Only `--send` (with `LIVE=1` and a
 * funded key) broadcasts anything.
 *
 * Getting testnet ETH is the one manual step: the public faucet sits behind a
 * Turnstile + Google Sign-In gate, so it cannot be scripted. Without a funded
 * key this example still runs end to end and reports the real blocker. Nothing
 * here is mocked.
 */
import { HoodLauncher, launchConfigSchema, loadOperatorConfig } from 'hood-launcher'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * A ticker nobody has claimed yet.
 *
 * The launcher refuses to price a launch whose symbol already exists on the
 * chain, which is the correct behaviour and also means a hardcoded default
 * would break this example the first time someone actually launches it. A
 * random suffix keeps the default runnable; pass `--symbol` to pin your own.
 */
function suggestSymbol() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 3; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `EX${suffix}`
}

/** Parse `--flag value` / boolean `--flag` pairs out of argv. */
function parseArgs(argv) {
  const args = {
    name: 'Example Coin',
    symbol: suggestSymbol(),
    // `direct` is the only rail with a testnet deployment. NOXA and The
    // Odyssey are mainnet-only, which preflight will tell you if you ask.
    rail: 'direct',
    initialBuyEth: 0.001,
    send: false,
    generateLogo: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--name') args.name = argv[++i] ?? args.name
    else if (arg === '--symbol') args.symbol = argv[++i] ?? args.symbol
    else if (arg === '--rail') args.rail = argv[++i] ?? args.rail
    else if (arg === '--buy') args.initialBuyEth = Number(argv[++i] ?? 0)
    else if (arg === '--send') args.send = true
    else if (arg === '--generate-logo') args.generateLogo = true
  }
  return args
}

/**
 * A placeholder logo so the default run is fast.
 *
 * hood-launcher's differentiator is that it will generate a real 3D GLB logo
 * on the three.ws free forge lane when no `logoUri` is supplied. That is a
 * genuine generation job taking a minute or more, so this example supplies a
 * URI by default and exercises the forge path only behind `--generate-logo`.
 */
const PLACEHOLDER_LOGO = 'https://three.ws/models/demo-avatar.glb'

const fmtEth = (wei) => `${Number(wei) / 1e18} ETH`

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // Operator config comes from the environment so a key is never a CLI arg
  // (argv leaks into shell history and process listings).
  const operator = loadOperatorConfig(process.env)
  const dryRun = !args.send

  section('1 - Operator config')
  console.log(`  network    ${operator.network}${operator.network === 'mainnet' ? '  (real funds)' : '  (chain 46630)'}`)
  console.log(`  signer     ${operator.privateKey ? 'set' : 'none, reads only'}`)
  console.log(`  live flag  ${operator.live ? 'LIVE=1' : 'unset'}`)
  console.log(`  mode       ${dryRun ? 'dry run (no broadcast)' : 'SEND'}`)

  // Validated by the same schema the CLI and HTTP API use, so a bad symbol
  // fails here rather than halfway through a launch.
  const launchConfig = launchConfigSchema.parse({
    name: args.name,
    symbol: args.symbol,
    // Kept deliberately plain: the launcher screens every concept against a
    // denylist before it will price a launch, and brand terms are rejected.
    description: 'A test coin launched from example 13 of the chain examples repo.',
    rail: args.rail,
    initialBuyEth: args.initialBuyEth,
    // Omitting logoUri is what triggers real 3D logo generation.
    ...(args.generateLogo ? {} : { logoUri: PLACEHOLDER_LOGO }),
    ...(args.rail === 'direct' ? { direct: { seedEth: args.initialBuyEth } } : {}),
  })

  section('2 - Coin')
  console.log(`  name       ${launchConfig.name}`)
  console.log(`  symbol     ${launchConfig.symbol}`)
  console.log(`  rail       ${launchConfig.rail}`)
  console.log(`  initialBuy ${launchConfig.initialBuyEth} ETH`)
  console.log(`  logo       ${args.generateLogo ? 'generating a 3D GLB on the three.ws forge (slow)' : PLACEHOLDER_LOGO}`)

  // The ledger and kill switch persist to disk; a temp dir keeps this example
  // from writing into the user's project.
  const dataDir = mkdtempSync(join(tmpdir(), 'hood-launcher-example-'))
  const launcher = new HoodLauncher(operator, dataDir)

  section('3 - Preflight (a real read against the live factory)')
  const outcome = await launcher.launch(launchConfig, { dryRun })
  const { preflight } = outcome

  console.log(`  rail         ${preflight.rail} on ${preflight.network}`)
  console.log(`  protocol fee ${fmtEth(preflight.protocolFeeWei)}`)
  console.log(`  tx value     ${fmtEth(preflight.estimatedValueWei)}  (fee + initial buy)`)
  if (preflight.pairToken) console.log(`  pairs with   ${preflight.pairToken}`)
  console.log(`  ready        ${preflight.ready ? 'yes' : 'no'}`)
  for (const blocker of preflight.blockers) {
    console.log(`    blocker: ${blocker}`)
  }

  section('4 - Result')
  if (outcome.result) {
    const r = outcome.result
    console.log(`  token      ${r.token}`)
    console.log(`  launch tx  ${r.launchTx}`)
    console.log(`  spent      ${fmtEth(r.spentWei)}`)
    if (r.pool) console.log(`  pool       ${r.pool}`)
    console.log(`  explorer   ${r.explorer.token}`)
    return
  }

  if (dryRun) {
    console.log('  Dry run: nothing was broadcast. The numbers above are what the')
    console.log('  launch would cost right now, read from the live contracts.')
    console.log('\n  To launch for real on testnet:')
    console.log('    1. Fund a throwaway key at the Robinhood Chain testnet faucet')
    console.log('    2. LIVE=1 ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1 \\')
    console.log('       ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js --send')
  } else {
    console.log('  Not launched: the preflight blockers above must clear first.')
    console.log('  A missing signer or an unfunded wallet is the usual cause.')
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err?.message ?? err}`)
  process.exitCode = 1
})
