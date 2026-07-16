import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const list = JSON.parse(await readFile(path.join(ROOT, 'tokenlist.json'), 'utf8'))

test('every address is EIP-55 checksummed', () => {
  for (const token of list.tokens) {
    assert.equal(token.address, getAddress(token.address), `${token.symbol}: ${token.address} is not checksummed`)
  }
})

test('no duplicate addresses', () => {
  const seen = new Set()
  for (const token of list.tokens) {
    const key = token.address.toLowerCase()
    assert.ok(!seen.has(key), `duplicate address ${token.address}`)
    seen.add(key)
  }
})

test('no duplicate symbols (collision rule enforced at build time)', () => {
  const seen = new Set()
  for (const token of list.tokens) {
    const key = token.symbol.toUpperCase()
    assert.ok(!seen.has(key), `duplicate symbol ${token.symbol}`)
    seen.add(key)
  }
})

test('every logoURI resolves to a self-hosted file that exists in logos/ and docs/logos/', async () => {
  const base = 'https://nirholas.github.io/hood-tokenlist/logos/'
  for (const token of list.tokens) {
    assert.ok(token.logoURI.startsWith(base), `${token.symbol}: logo not self-hosted: ${token.logoURI}`)
    const file = token.logoURI.slice(base.length)
    await access(path.join(ROOT, 'logos', file))
    await access(path.join(ROOT, 'docs', 'logos', file))
  }
  assert.ok(list.logoURI.startsWith(base))
  await access(path.join(ROOT, 'logos', list.logoURI.slice(base.length)))
})

test('every token tag is defined in the list tag map', () => {
  for (const token of list.tokens) {
    for (const tag of token.tags ?? []) {
      assert.ok(list.tags[tag], `${token.symbol}: tag "${tag}" undefined`)
    }
  }
})

test('class invariants hold for every entry', () => {
  for (const token of list.tokens) {
    const ext = token.extensions
    switch (ext.assetClass) {
      case 'stock-token':
        assert.equal(ext.supportsUiMultiplier, true, `${token.symbol}: stock token must support uiMultiplier`)
        assert.equal(ext.eligibility, 'not-for-us-persons', `${token.symbol}: stock token needs eligibility marker`)
        assert.equal(token.decimals, 18, `${token.symbol}: canonical Stock Tokens have 18 decimals`)
        assert.ok(token.tags.includes('stock'))
        break
      case 'memecoin':
        assert.ok(['noxa', 'odyssey'].includes(ext.launchpad), `${token.symbol}: launchpad missing`)
        assert.match(ext.uniswapV3Pool, /^0x[a-fA-F0-9]{40}$/, `${token.symbol}: pool missing`)
        assert.ok(Number.isInteger(ext.uniswapV3PoolFee), `${token.symbol}: pool fee missing`)
        assert.ok(Number.isInteger(ext.launchBlock), `${token.symbol}: launch block missing`)
        assert.ok(token.tags.includes('memecoin') && token.tags.includes(ext.launchpad))
        break
      case 'stablecoin':
        assert.equal(token.symbol, 'USDG')
        assert.equal(token.decimals, 6)
        break
      case 'wrapped-native':
        assert.equal(token.symbol, 'WETH')
        assert.equal(token.decimals, 18)
        break
      default:
        assert.fail(`${token.symbol}: unknown assetClass ${ext.assetClass}`)
    }
    if (token.tags.includes('priced')) {
      assert.match(ext.chainlinkFeed ?? '', /^0x[a-fA-F0-9]{40}$/, `${token.symbol}: priced tag without feed`)
    }
  }
})

test('memecoins never spoof canonical symbols', () => {
  const canonical = new Set(
    list.tokens.filter((t) => t.extensions.assetClass !== 'memecoin').map((t) => t.symbol.toUpperCase()),
  )
  for (const token of list.tokens) {
    if (token.extensions.assetClass === 'memecoin') {
      assert.ok(!canonical.has(token.symbol.toUpperCase()), `${token.symbol} spoofs a canonical ticker`)
    }
  }
})

test('typed loader agrees with the JSON', async () => {
  const loader = await import('../src/index.mjs')
  assert.equal(loader.tokens.length, list.tokens.length)
  assert.equal(loader.CHAIN_ID, 4663)
  const usdg = loader.getToken('0x5fc5360d0400a0fd4f2af552add042d716f1d168')
  assert.equal(usdg?.symbol, 'USDG')
  assert.ok(loader.stockTokens().length >= 90)
  assert.equal(
    loader.pricedTokens().length,
    list.tokens.filter((t) => t.extensions.chainlinkFeed).length,
  )
  assert.match(loader.listVersion(), /^\d+\.\d+\.\d+$/)
  assert.equal(loader.getTokensBySymbol('aapl')[0]?.address, '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')
})
