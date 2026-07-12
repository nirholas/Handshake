import { privateKeyToAccount } from 'viem/accounts'
import type { Account } from 'viem'
import { Agent } from './agent.js'
import type { FleetConfig } from './config.js'
import { Journal } from './journal.js'
import { KillSwitch } from './kill.js'
import { Market } from './market.js'
import { utcDayStart } from './risk.js'
import type { Strategy } from './strategy.js'
import type { AgentStatus, Mode, RiskLimits } from './types.js'

/** Definition of one agent within a fleet. */
export interface AgentSpec {
  id: string
  strategy: Strategy
  /** Overrides merged over the fleet default limits. */
  limits?: Partial<RiskLimits>
  tickIntervalMs?: number
}

/** Aggregate fleet numbers for the dashboard header. */
export interface FleetSummary {
  network: string
  mode: Mode
  killed: boolean
  killReason: string | null
  fleetSpentTodayUsd: number
  fleetMaxDailySpendUsdg: number
  realizedUsd: number
  openValueUsd: number
  equityUsd: number
  agents: number
  startedAt: number
}

/**
 * The fleet: owns the shared market client, journal, and kill switch, then runs
 * a set of agents against them and tracks the global daily-spend budget. It is
 * the process-level object the dashboard server reads and the kill switch acts
 * on.
 */
export class Fleet {
  readonly config: FleetConfig
  readonly journal: Journal
  readonly kill: KillSwitch
  readonly market: Market
  private readonly account: Account | null
  private readonly agents: Agent[] = []
  private fleetSpentTodayUsd = 0
  private spentDay = 0
  private startedAt = 0

  constructor(config: FleetConfig) {
    this.config = config
    this.account = config.privateKey ? privateKeyToAccount(config.privateKey) : null
    this.journal = new Journal(config.dbPath)
    this.kill = new KillSwitch(config.killFile)
    this.market = new Market(config, this.account ?? undefined)
  }

  /** Build agents from specs. */
  addAgents(specs: AgentSpec[]): void {
    for (const spec of specs) {
      const limits: RiskLimits = { ...this.config.defaultLimits, ...spec.limits }
      this.agents.push(
        new Agent({
          id: spec.id,
          strategy: spec.strategy,
          market: this.market,
          limits,
          journal: this.journal,
          kill: this.kill,
          mode: this.config.mode,
          account: this.account,
          fleetMaxDailySpendUsdg: this.config.fleetMaxDailySpendUsdg,
          fleetSpentTodayUsd: () => this.currentFleetSpend(),
          reportFleetSpend: (usd) => this.recordFleetSpend(usd),
          tickIntervalMs: spec.tickIntervalMs ?? 5000,
        }),
      )
    }
  }

  private currentFleetSpend(now = Date.now()): number {
    const day = utcDayStart(now)
    if (day !== this.spentDay) {
      this.spentDay = day
      this.fleetSpentTodayUsd = 0
    }
    return this.fleetSpentTodayUsd
  }

  private recordFleetSpend(usd: number): void {
    this.currentFleetSpend()
    this.fleetSpentTodayUsd += usd
  }

  /** Arm the kill switch and start every agent's loop. */
  async start(): Promise<void> {
    this.startedAt = Date.now()
    this.kill.arm()
    await Promise.all(this.agents.map((a) => a.start()))
  }

  /** Stop all agents (kill switch stays tripped if it was). */
  stop(): void {
    for (const a of this.agents) a.stop()
  }

  /** Trip the kill switch — halts new orders across the fleet. */
  tripKill(reason: string): void {
    this.kill.trip(reason)
  }

  agentStatuses(): AgentStatus[] {
    return this.agents.map((a) => a.status())
  }

  summary(): FleetSummary {
    const statuses = this.agentStatuses()
    return {
      network: this.config.network,
      mode: this.config.mode,
      killed: this.kill.isKilled(),
      killReason: this.kill.killReason(),
      fleetSpentTodayUsd: round(this.currentFleetSpend()),
      fleetMaxDailySpendUsdg: this.config.fleetMaxDailySpendUsdg,
      realizedUsd: round(statuses.reduce((s, a) => s + a.realizedUsd, 0)),
      openValueUsd: round(statuses.reduce((s, a) => s + a.openValueUsd, 0)),
      equityUsd: round(statuses.reduce((s, a) => s + a.equityUsd, 0)),
      agents: this.agents.length,
      startedAt: this.startedAt,
    }
  }

  close(): void {
    this.stop()
    this.kill.dispose()
    this.journal.close()
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
