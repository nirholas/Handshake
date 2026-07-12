import { createRail } from '../rails/index.js'
import type { DirectRailOptions, LaunchInput, RailLaunch, RailPreflight } from '../rails/types.js'
import { buildConcept } from '../concept/index.js'
import type { LaunchConfig, OperatorConfig } from './config.js'
import { clientFromOperatorConfig } from './config.js'
import { enforceCaps } from './caps.js'
import { KillSwitch } from './kill-switch.js'
import { LaunchLedger } from './ledger.js'
import { NoSignerError } from '../errors.js'

export interface LaunchOptions {
  theme?: string
  artworkPrompt?: string
  dryRun?: boolean
}

export interface LaunchOutcome {
  input: LaunchInput
  preflight: RailPreflight
  result: RailLaunch | null
  dryRun: boolean
}

/**
 * The one core every entry point (CLI, HTTP API, autonomous scheduler)
 * drives. Owns the operator config, wallet client, kill switch, and launch
 * ledger, and runs the full pipeline: concept → screen → uniqueness →
 * artwork → cap enforcement → rail preflight → (dry-run stop, or) launch.
 */
export class HoodLauncher {
  readonly config: OperatorConfig
  readonly killSwitch: KillSwitch
  readonly ledger: LaunchLedger

  constructor(config: OperatorConfig, dataDir: string) {
    this.config = config
    this.killSwitch = new KillSwitch(dataDir)
    this.ledger = new LaunchLedger(dataDir)
  }

  private hoodClient() {
    return clientFromOperatorConfig(this.config)
  }

  async launch(launchConfig: LaunchConfig, options: LaunchOptions = {}): Promise<LaunchOutcome> {
    const client = this.hoodClient()
    const concept = await buildConcept(this.config.network, launchConfig, {
      ...(options.theme ? { theme: options.theme } : {}),
      ...(options.artworkPrompt ? { artworkPrompt: options.artworkPrompt } : {}),
    })
    const input = concept.input

    const rail = createRail(launchConfig.rail, launchConfig.odysseyVariant)
    const seedWei =
      launchConfig.rail === 'direct'
        ? BigInt(Math.round((launchConfig.direct?.seedEth ?? 0) * 1e18))
        : input.initialBuyWei

    const directOptions: DirectRailOptions | undefined =
      launchConfig.rail === 'direct' && launchConfig.direct
        ? {
            totalSupply: launchConfig.direct.totalSupply,
            feeTier: launchConfig.direct.feeTier,
            seedWethWei: seedWei,
            lpSupplyBps: launchConfig.direct.lpSupplyBps,
            lpDisposition: launchConfig.direct.lpDisposition,
          }
        : undefined

    const ctx = { client, ...(directOptions ? { direct: directOptions } : {}) }
    // Preflight is a pure read — always safe to run, even mid-kill-switch or
    // before the operator has acknowledged live-launch responsibility. Only
    // an actual spend attempt below is gated by enforceCaps().
    const preflight = await rail.preflight(ctx, input)

    if (options.dryRun || !preflight.ready) {
      this.ledger.record({
        timestamp: Date.now(),
        rail: launchConfig.rail,
        network: this.config.network,
        symbol: input.symbol,
        token: null,
        seedWei: seedWei.toString(),
        launchTx: null,
        status: 'rejected',
        reason: options.dryRun ? 'dry-run' : preflight.blockers.join('; '),
      })
      return { input, preflight, result: null, dryRun: Boolean(options.dryRun) }
    }

    if (!this.config.live) {
      throw new Error('Launch refused: set LIVE=1 to send real transactions (this run was not a dry-run request)')
    }
    if (!client.account) throw new NoSignerError('HoodLauncher.launch')

    await enforceCaps(this.config, this.ledger, this.killSwitch, client, seedWei)

    try {
      const result = await rail.launch(ctx, input)
      this.ledger.record({
        timestamp: Date.now(),
        rail: launchConfig.rail,
        network: this.config.network,
        symbol: input.symbol,
        token: result.token,
        seedWei: seedWei.toString(),
        launchTx: result.launchTx,
        status: 'launched',
      })
      return { input, preflight, result, dryRun: false }
    } catch (err) {
      this.ledger.record({
        timestamp: Date.now(),
        rail: launchConfig.rail,
        network: this.config.network,
        symbol: input.symbol,
        token: null,
        seedWei: seedWei.toString(),
        launchTx: null,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}
