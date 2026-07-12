import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A process-wide kill switch, engaged by any of three independent sources:
 * SIGINT (Ctrl-C / `docker stop`), a `KILL` sentinel file dropped into the
 * data directory, or an explicit `engage()` call (wired to `HTTP POST
 * /kill` by the API/autonomous scheduler). Once engaged it stays engaged —
 * a fresh process must be started to resume.
 */
export class KillSwitch {
  private engaged = false
  private source: string | null = null
  private readonly killFilePath: string

  constructor(dataDir: string) {
    this.killFilePath = join(dataDir, 'KILL')
    process.once('SIGINT', () => this.engage('SIGINT'))
    process.once('SIGTERM', () => this.engage('SIGTERM'))
  }

  engage(source: string): void {
    if (this.engaged) return
    this.engaged = true
    this.source = source
    // eslint-disable-next-line no-console
    console.error(`[kill-switch] engaged by ${source} — no further launches will be attempted`)
  }

  /** Re-checks the KILL-file sentinel (cheap `existsSync`) in addition to the in-memory flag. */
  isEngaged(): { engaged: boolean; source: string | null } {
    if (!this.engaged && existsSync(this.killFilePath)) {
      this.engage(`KILL file at ${this.killFilePath}`)
    }
    return { engaged: this.engaged, source: this.source }
  }

  reasonIfEngaged(): string | null {
    const { engaged, source } = this.isEngaged()
    return engaged ? (source ?? 'unknown') : null
  }
}
