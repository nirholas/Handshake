/**
 * Live re-verification: a deterministic sample of list entries is checked
 * against Robinhood Chain mainnet (public RPC) and Blockscout on every test
 * run. Slower than the unit suites, but this is a data product; the tests
 * must prove the data, not just its shape.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RPC = 'https://rpc.mainnet.chain.robinhood.com'
const list = JSON.parse(await readFile(path.join(ROOT, 'tokenlist.json'), 'utf8'))

async function rpcCall(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const data = await response.json()
  assert.ok(!data.error, `RPC error: ${JSON.stringify(data.error)}`)
  return data.result
}

function decodeString(hex) {
  const body = hex.slice(2)
  const length = parseInt(body.slice(64, 128), 16)
  return Buffer.from(body.slice(128, 128 + length * 2), 'hex').toString('utf8')
}

// Deterministic sample: USDG, WETH, first + last stock token, and the first,
// middle, and last memecoin in list order.
const stocks = list.tokens.filter((t) => t.extensions.assetClass === 'stock-token')
const memes = list.tokens.filter((t) => t.extensions.assetClass === 'memecoin')
const sample = [
  ...new Set(
    [
      list.tokens.find((t) => t.symbol === 'USDG'),
      list.tokens.find((t) => t.symbol === 'WETH'),
      stocks[0],
      stocks[stocks.length - 1],
      memes[0],
      memes[Math.floor(memes.length / 2)],
      memes[memes.length - 1],
    ].filter(Boolean),
  ),
]

test(`live: on-chain symbol and decimals match for ${sample.length} sampled entries`, async () => {
  for (const token of sample) {
    const [symbolHex, decimalsHex] = await Promise.all([
      rpcCall('eth_call', [{ to: token.address, data: '0x95d89b41' }, 'latest']),
      rpcCall('eth_call', [{ to: token.address, data: '0x313ce567' }, 'latest']),
    ])
    assert.equal(decodeString(symbolHex), token.symbol, `${token.address} symbol drifted`)
    assert.equal(parseInt(decimalsHex, 16), token.decimals, `${token.symbol} decimals drifted`)
  }
})

test('live: sampled Chainlink feeds answer with a positive price', async () => {
  const priced = sample.filter((t) => t.extensions.chainlinkFeed)
  assert.ok(priced.length >= 2, 'sample should include priced tokens')
  for (const token of priced) {
    // latestRoundData() selector
    const result = await rpcCall('eth_call', [{ to: token.extensions.chainlinkFeed, data: '0xfeaf968c' }, 'latest'])
    const answer = BigInt(`0x${result.slice(2 + 64, 2 + 128)}`)
    assert.ok(answer > 0n, `${token.symbol} feed ${token.extensions.chainlinkFeed} returned ${answer}`)
  }
})

test('live: Blockscout knows every sampled token under the same symbol', async () => {
  for (const token of sample) {
    // The public Blockscout instance throws occasional transient 5xx; retry
    // with backoff so only a real failure fails the suite.
    let response
    for (let attempt = 0; attempt < 4; attempt++) {
      response = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${token.address}`, {
        headers: { accept: 'application/json' },
      })
      if (response.ok || (response.status < 500 && response.status !== 429)) break
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }
    assert.ok(response.ok, `Blockscout HTTP ${response.status} for ${token.address}`)
    const data = await response.json()
    assert.equal(data.symbol, token.symbol, `${token.address}: Blockscout symbol ${data.symbol}`)
    assert.equal(Number(data.decimals), token.decimals)
  }
})
