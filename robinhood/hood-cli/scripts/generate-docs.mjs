#!/usr/bin/env node
/**
 * Command reference generator: the ONLY source is `dist/cli.js --help` and
 * each subcommand's own `--help` — the exact text a user sees, piped
 * straight from commander. docs/commands.html renders this JSON verbatim, so
 * the reference can never drift from the real CLI.
 *
 * Run: npm run build && npm run docs:commands
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bin = join(root, 'dist', 'cli.js')

if (!existsSync(bin)) {
  console.error(`dist/cli.js not found — run "npm run build" first.`)
  process.exit(1)
}

function help(args) {
  const proc = spawnSync('node', [bin, ...args, '--help'], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } })
  return proc.stdout.trimEnd()
}

const rootHelp = help([])

// Extract subcommand names from the "Commands:" section of the root --help —
// so a newly added command is picked up automatically, no manual list to
// forget.
const commandsSection = rootHelp.split(/\nCommands:\n/)[1] ?? ''
const names = [...commandsSection.matchAll(/^\s{2}([a-z][a-z-]*)/gm)].map((m) => m[1])
// commander auto-adds "help [command]" — it just reprints the root block, so
// it isn't a distinct reference entry.
const uniqueNames = [...new Set(names)].filter((n) => n !== 'help')

if (uniqueNames.length === 0) {
  console.error('Could not parse any subcommand names out of `hood --help` — aborting.')
  process.exit(1)
}

const commands = uniqueNames.map((name) => ({ name, help: help([name]) }))

const out = { generatedAt: new Date().toISOString(), root: rootHelp, commands }
const outPath = join(root, 'docs', 'commands-data.json')
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
console.log(`✓ Wrote ${commands.length} command help blocks to ${outPath}`)
