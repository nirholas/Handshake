#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadOperatorConfig } from '../src/core/config.js'
import { launchConfigSchema } from '../src/core/config.js'
import { HoodLauncher } from '../src/core/launcher.js'
import { ALL_RAILS, createRail } from '../src/rails/index.js'
import { clientFromOperatorConfig } from '../src/core/config.js'

const dataDir = process.env.HOOD_LAUNCHER_DATA_DIR ?? resolve(process.cwd(), '.hood-launcher')

function usage(): never {
  console.log(`hood-launch — Robinhood Chain coin launcher CLI

Usage:
  hood-launch create --config <coin.json> [--rail noxa|odyssey|direct] [--theme "<narrative>"] [--dry-run]
  hood-launch preflight --config <coin.json> [--rail noxa|odyssey|direct]
  hood-launch rails

Env: ROBINHOOD_CHAIN_NETWORK=mainnet|testnet  ROBINHOOD_CHAIN_PRIVATE_KEY=0x..  LIVE=1
     ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1  MAX_LAUNCHES_PER_DAY  MAX_SEED_USDG
`)
  process.exit(1)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command) usage()

  if (command === 'rails') {
    const config = loadOperatorConfig()
    const client = clientFromOperatorConfig(config)
    for (const name of ALL_RAILS) {
      const rail = createRail(name)
      if (!rail.networks.includes(config.network)) {
        console.log(`${name}: not available on ${config.network}`)
        continue
      }
      try {
        const preflight = await rail.preflight({ client }, {
          name: 'probe',
          symbol: 'PROBE',
          description: '',
          logoUri: '',
          socials: {},
          initialBuyWei: 0n,
        })
        console.log(`${name}: ready=${preflight.ready} fee=${preflight.protocolFeeWei}wei blockers=${JSON.stringify(preflight.blockers)}`)
      } catch (err) {
        console.log(`${name}: error — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return
  }

  if (command === 'create' || command === 'preflight') {
    const { values } = parseArgs({
      args: rest,
      options: {
        config: { type: 'string' },
        rail: { type: 'string' },
        theme: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
      },
    })
    if (!values.config) usage()
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), values.config), 'utf8'))
    if (values.rail) raw.rail = values.rail
    const launchConfig = launchConfigSchema.parse(raw)

    const operatorConfig = loadOperatorConfig()
    const launcher = new HoodLauncher(operatorConfig, dataDir)
    const dryRun = command === 'preflight' || Boolean(values['dry-run'])

    console.log(`network=${operatorConfig.network} live=${operatorConfig.live} rail=${launchConfig.rail} dryRun=${dryRun}`)
    const outcome = await launcher.launch(launchConfig, {
      dryRun,
      ...(values.theme ? { theme: values.theme } : {}),
    })

    console.log(JSON.stringify({
      concept: { name: outcome.input.name, symbol: outcome.input.symbol, logoUri: outcome.input.logoUri },
      preflight: outcome.preflight,
      result: outcome.result
        ? {
            token: outcome.result.token,
            pool: outcome.result.pool,
            launchTx: outcome.result.launchTx,
            explorer: outcome.result.explorer,
            spentWei: outcome.result.spentWei.toString(),
            extra: outcome.result.extra,
          }
        : null,
    }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
    return
  }

  usage()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
