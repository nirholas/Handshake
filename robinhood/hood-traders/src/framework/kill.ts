import { existsSync } from 'node:fs'

/**
 * Global kill switch. Once tripped it is irreversible for the process lifetime:
 * every agent checks `isKilled()` before each decide/execute step and refuses to
 * open new positions. Three independent triggers, per the spec:
 *
 *   1. SIGINT / SIGTERM (Ctrl-C, container stop)
 *   2. the presence of a `KILL` file on disk (drop-a-file panic button)
 *   3. an HTTP `POST /kill` on the dashboard server (wired in server/)
 *
 * The switch never sells or unwinds on its own — it HALTS new risk. Unwinding is
 * an explicit operator action, because a forced market-sell into thin liquidity
 * during whatever caused the panic is usually worse than holding.
 */
export class KillSwitch {
  private killed = false
  private reason: string | null = null
  private readonly listeners = new Set<(reason: string) => void>()
  private fileTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly killFilePath: string) {}

  /** Install SIGINT/SIGTERM handlers and begin polling the kill file. */
  arm(): void {
    const onSignal = (sig: string) => () => this.trip(`signal:${sig}`)
    process.once('SIGINT', onSignal('SIGINT'))
    process.once('SIGTERM', onSignal('SIGTERM'))

    // Poll the kill file. If it already exists at boot, trip immediately.
    const check = () => {
      if (!this.killed && existsSync(this.killFilePath)) this.trip('kill_file')
    }
    check()
    this.fileTimer = setInterval(check, 1000)
    // Do not keep the event loop alive solely for this poll.
    this.fileTimer.unref?.()
  }

  /** Trip the switch. Idempotent. */
  trip(reason: string): void {
    if (this.killed) return
    this.killed = true
    this.reason = reason
    for (const l of this.listeners) {
      try {
        l(reason)
      } catch {
        // a listener throwing must not stop the others from being notified
      }
    }
  }

  isKilled(): boolean {
    return this.killed
  }

  killReason(): string | null {
    return this.reason
  }

  /** Subscribe to the trip event. Returns an unsubscribe fn. */
  onKill(listener: (reason: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Stop the file poller (used in tests/teardown). */
  dispose(): void {
    if (this.fileTimer) clearInterval(this.fileTimer)
    this.fileTimer = null
    this.listeners.clear()
  }
}
