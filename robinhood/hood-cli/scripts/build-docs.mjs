#!/usr/bin/env node
/**
 * Stitches the real captured data (docs/session.json, docs/commands-data.json
 * — both produced from a live `hood` binary, never hand-written) into the
 * docs/*.template.html sources, producing the final docs/index.html and
 * docs/commands.html that GitHub Pages serves as-is (no build step on Pages
 * itself, no fetch() of local files so the pages also open directly via
 * file://).
 *
 * Run after `npm run capture` and `npm run docs:commands`:
 *   npm run docs:build
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const docs = join(here, '..', 'docs')

function requireFile(path, hint) {
  if (!existsSync(path)) {
    console.error(`Missing ${path} — ${hint}`)
    process.exit(1)
  }
  return readFileSync(path, 'utf8')
}

const sessionJson = requireFile(join(docs, 'session.json'), 'run `npm run capture` first.')
const commandsJson = requireFile(join(docs, 'commands-data.json'), 'run `npm run docs:commands` first.')
const commandsParsed = JSON.parse(commandsJson)

const indexTemplate = requireFile(join(docs, 'index.template.html'), 'the template was deleted?')
const commandsTemplate = requireFile(join(docs, 'commands.template.html'), 'the template was deleted?')

const index = indexTemplate.replace('__SESSION_DATA__', sessionJson.trim())
writeFileSync(join(docs, 'index.html'), index)

const commands = commandsTemplate
  .replace('__COMMANDS_DATA__', commandsJson.trim())
  .replace('__GENERATED_AT__', new Date(commandsParsed.generatedAt).toISOString().slice(0, 10))
writeFileSync(join(docs, 'commands.html'), commands)

console.log(`✓ Wrote docs/index.html and docs/commands.html with real captured data inlined.`)
