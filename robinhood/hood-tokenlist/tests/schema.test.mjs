import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const schema = require('@uniswap/token-lists/src/tokenlist.schema.json')
const list = JSON.parse(await readFile(path.join(ROOT, 'tokenlist.json'), 'utf8'))

test('tokenlist.json is schema-valid per @uniswap/token-lists', () => {
  const ajv = new Ajv({ allErrors: true })
  addFormats(ajv)
  const validate = ajv.compile(schema)
  const valid = validate(list)
  assert.ok(valid, `schema violations:\n${JSON.stringify(validate.errors, null, 2)}`)
})

test('docs mirror is byte-identical to the canonical list', async () => {
  const canonical = await readFile(path.join(ROOT, 'tokenlist.json'), 'utf8')
  const mirror = await readFile(path.join(ROOT, 'docs', 'tokenlist.json'), 'utf8')
  assert.equal(mirror, canonical)
})

test('list covers only Robinhood Chain mainnet (4663)', () => {
  for (const token of list.tokens) assert.equal(token.chainId, 4663)
})

test('list is non-trivial: stock tokens, base assets present', () => {
  const classes = new Set(list.tokens.map((t) => t.extensions.assetClass))
  assert.ok(classes.has('stock-token'))
  assert.ok(classes.has('stablecoin'))
  assert.ok(classes.has('wrapped-native'))
  assert.ok(list.tokens.length >= 90, `expected at least 90 tokens, got ${list.tokens.length}`)
})
