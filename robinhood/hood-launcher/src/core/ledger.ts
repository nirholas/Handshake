import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One row of the launch journal — every launch attempt, decided or executed. */
export interface LedgerEntry {
  timestamp: number
  rail: string
  network: string
  symbol: string
  token: string | null
  seedWei: string
  launchTx: string | null
  status: 'launched' | 'rejected' | 'failed'
  reason?: string
}

/**
 * Append-only JSON-Lines journal of every launch attempt, used to enforce
 * `MAX_LAUNCHES_PER_DAY` (a rolling 24h window over `status: 'launched'`
 * rows) and to give operators/dashboards a durable audit trail.
 */
export class LaunchLedger {
  private readonly path: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.path = join(dataDir, 'launches.jsonl')
  }

  record(entry: LedgerEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8')
  }

  readAll(): LedgerEntry[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry)
  }

  /** Count `status: 'launched'` entries within the last `windowHours` hours. */
  countLaunchedInWindow(windowHours: number): number {
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000
    return this.readAll().filter((e) => e.status === 'launched' && e.timestamp >= cutoff).length
  }
}
