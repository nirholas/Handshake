/**
 * Bridges commander actions to the CLI runtime: resolves global flags, builds
 * the shared context, honours `--no-color`, and funnels every thrown error
 * through the single presenter so exit codes stay consistent.
 */
import type { Command } from 'commander'
import { createContext, type Context, type GlobalOptions } from './context.js'
import { presentError } from './output.js'
import { setColorEnabled } from './ui/ansi.js'
import type { HoodNetwork } from 'hoodchain'

function toGlobalOptions(raw: Record<string, unknown>): GlobalOptions {
  return {
    json: !!raw.json,
    network: raw.network as HoodNetwork | undefined,
    rpc: raw.rpc as string | undefined,
    verbose: !!raw.verbose,
    yes: !!raw.yes,
    acknowledgeEligibility: !!raw.acknowledgeEligibility,
  }
}

/** Run a command body with a resolved context and unified error handling. */
export async function runWith(command: Command, fn: (ctx: Context) => Promise<void>): Promise<void> {
  const raw = command.optsWithGlobals()
  if (raw.color === false) setColorEnabled(false)
  const ctx = createContext(toGlobalOptions(raw))
  try {
    await fn(ctx)
  } catch (err) {
    process.exitCode = presentError(err, { json: ctx.json, verbose: ctx.verbose })
  }
}
