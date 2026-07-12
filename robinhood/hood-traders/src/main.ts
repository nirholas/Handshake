import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFleetConfig } from './framework/config.js'
import { Fleet } from './framework/fleet.js'
import { LaunchSniper } from './strategies/launch-sniper.js'
import { Momentum } from './strategies/momentum.js'
import { PremiumWatch } from './strategies/premium-watch.js'
import { createDashboardServer } from './server/dashboard.js'

// main.ts sits at a stable one-level depth in both trees: src/main.ts (tsx,
// dev) and dist/main.js (tsup bundle, prod) — so "one level up + dashboard"
// resolves correctly in both without guessing at bundler output shape.
const DASHBOARD_STATIC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dashboard')

async function main(): Promise<void> {
  const config = loadFleetConfig()
  const fleet = new Fleet(config)

  fleet.addAgents([
    { id: 'sniper-1', strategy: new LaunchSniper(), tickIntervalMs: 4000 },
    { id: 'momentum-1', strategy: new Momentum(), tickIntervalMs: 15000 },
    { id: 'premium-1', strategy: new PremiumWatch(), tickIntervalMs: 30000 },
  ])

  const banner = [
    '─'.repeat(60),
    ' hood-traders — Robinhood Chain autonomous fleet',
    '─'.repeat(60),
    ` network   : ${config.network} (${config.network === 'testnet' ? 46630 : 4663})`,
    ` mode      : ${config.mode.toUpperCase()}${config.mode === 'paper' ? ' (simulation only, no real funds move)' : ' (REAL FUNDS — swaps will be signed and broadcast)'}`,
    ` agents    : sniper-1, momentum-1, premium-1`,
    ` fleet cap : $${config.fleetMaxDailySpendUsdg}/day`,
    ` dashboard : http://localhost:${config.dashboardPort}`,
    ` kill file : ${config.killFile}`,
    '─'.repeat(60),
  ].join('\n')
  console.log(banner)

  if (config.mode === 'live') {
    console.warn(
      '\n⚠ LIVE MODE — this process will sign and broadcast real transactions with real funds.\n' +
        '  Risk caps are active but are not a guarantee against loss. Ctrl-C or POST /kill to halt.\n',
    )
  }

  await fleet.start()

  const server = createDashboardServer(fleet, DASHBOARD_STATIC_ROOT)
  server.listen(config.dashboardPort, () => {
    console.log(`dashboard listening on :${config.dashboardPort}`)
  })

  const shutdown = () => {
    console.log('\nshutting down — stopping agents, closing journal…')
    server.close()
    fleet.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('hood-traders fatal error:', err)
  process.exit(1)
})
