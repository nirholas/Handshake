/**
 * Output boundary: every command prints through here so `--json` is uniform,
 * exit codes are consistent, and errors get a human message + optional hint.
 */
import { bold, dim, red, yellow } from './ui/ansi.js'
import { CliError, EXIT, toCliError } from './errors.js'

/** Serialise bigints so `JSON.stringify` never throws on chain data. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** Print a machine-readable JSON payload to stdout. */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, jsonReplacer, 2) + '\n')
}

/** Print a human-facing string block to stdout. */
export function printHuman(block: string): void {
  process.stdout.write(block + '\n')
}

/**
 * Print a result either as JSON (`--json`) or via the human renderer.
 * `json` is the structured payload; `human` renders the same data for a person.
 */
export function printResult(json: unknown, human: () => string, asJson: boolean): void {
  if (asJson) printJson(json)
  else printHuman(human())
}

/** A dim note to stderr (never pollutes stdout / JSON). */
export function note(message: string): void {
  process.stderr.write(dim(message) + '\n')
}

/** A warning to stderr. */
export function warn(message: string): void {
  process.stderr.write(yellow('! ' + message) + '\n')
}

/**
 * Present a fatal error and return its exit code. Honours `--json` (emits a
 * `{ error, hint }` object) and `--verbose` (appends the raw cause).
 */
export function presentError(err: unknown, opts: { json: boolean; verbose: boolean }): number {
  const cli: CliError = toCliError(err)
  if (opts.json) {
    printJson({ error: cli.message, hint: cli.hint ?? null, exitCode: cli.exitCode })
  } else {
    process.stderr.write(red(bold('✗ ') + cli.message) + '\n')
    if (cli.hint) process.stderr.write(dim('  ' + cli.hint) + '\n')
    if (opts.verbose && cli.cause) {
      const cause = cli.cause instanceof Error ? (cli.cause.stack ?? cli.cause.message) : String(cli.cause)
      process.stderr.write(dim('\n' + cause) + '\n')
    } else if (cli.cause && cli.exitCode !== EXIT.GUARD) {
      process.stderr.write(dim('  Run with --verbose for the raw cause.') + '\n')
    }
  }
  return cli.exitCode
}
