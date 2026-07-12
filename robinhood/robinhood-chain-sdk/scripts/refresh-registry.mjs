#!/usr/bin/env node
/**
 * Regenerates src/registry/stock-tokens.json from live sources and re-verifies
 * every entry on-chain. Run: `npm run refresh-registry`
 *
 * Pipeline:
 *  1. DISCOVER  — paginate Blockscout token search for the canonical
 *                 "<Name> • Robinhood Token" naming pattern.
 *  2. VERIFY    — on-chain (public RPC, multicall):
 *                 a. every token's EIP-1967 beacon slot points at the shared
 *                    canonical Stock beacon (same issuer for all tokens);
 *                 b. symbol / name / decimals / uiMultiplier read back.
 *  3. FEEDS     — map Chainlink's official Robinhood Chain feed directory
 *                 (reference-data-directory, the JSON behind docs.chain.link)
 *                 onto tokens by ticker, then verify each feed answers
 *                 latestRoundData() with a positive 8-decimal answer.
 *  4. WRITE     — emit stock-tokens.json sorted by symbol, with provenance
 *                 metadata (block number, counts, source URLs).
 *
 * The script fails loudly (non-zero exit) on any verification mismatch —
 * a registry that cannot be fully re-verified must not ship.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPublicClient, http, getAddress, parseAbi } from 'viem'
import { robinhood } from 'viem/chains'

const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2'
const CHAINLINK_RDD = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json'
const CANONICAL_NAME_MARKER = '• Robinhood Token'
const UA = { 'user-agent': 'hoodchain-registry-refresh (https://github.com/nirholas/robinhood-chain-sdk)' }

const client = createPublicClient({ chain: robinhood, transport: http(), batch: { multicall: true } })

const stockAbi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function uiMultiplier() view returns (uint256)',
])
const feedAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
])

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

// ---- 1. DISCOVER ------------------------------------------------------------
async function discoverTokens() {
  const seen = new Map()
  let params = new URLSearchParams({ q: 'Robinhood Token' })
  for (let page = 0; page < 60; page++) {
    const data = await fetchJson(`${BLOCKSCOUT}/tokens?${params}`)
    for (const t of data.items ?? []) {
      if ((t.name ?? '').includes(CANONICAL_NAME_MARKER)) {
        seen.set(getAddress(t.address_hash), { blockscoutName: t.name, holders: Number(t.holders_count ?? 0) })
      }
    }
    const next = data.next_page_params
    if (!next) break
    params = new URLSearchParams({ q: 'Robinhood Token' })
    for (const [k, v] of Object.entries(next)) {
      if (v !== null && v !== undefined) params.set(k, typeof v === 'boolean' ? String(v) : String(v))
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return seen
}

// ---- 2. VERIFY on-chain -----------------------------------------------------
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

async function verifyTokens(addresses) {
  // All canonical Stock Tokens are BeaconProxies onto one shared beacon.
  const beacons = await Promise.all(
    addresses.map((address) => client.getStorageAt({ address, slot: BEACON_SLOT })),
  )
  const beaconSet = new Set(beacons.map((b) => getAddress(`0x${(b ?? '0x').slice(-40)}`)))
  if (beaconSet.size !== 1) {
    throw new Error(
      `Expected one shared Stock beacon, found ${beaconSet.size}: ${[...beaconSet].join(', ')}. ` +
        'A non-canonical token slipped through discovery — refusing to write the registry.',
    )
  }
  const beacon = [...beaconSet][0]

  const reads = await client.multicall({
    contracts: addresses.flatMap((address) => [
      { address, abi: stockAbi, functionName: 'symbol' },
      { address, abi: stockAbi, functionName: 'name' },
      { address, abi: stockAbi, functionName: 'decimals' },
      { address, abi: stockAbi, functionName: 'uiMultiplier' },
    ]),
    allowFailure: false,
  })
  return {
    beacon,
    tokens: addresses.map((address, i) => ({
      address,
      symbol: reads[i * 4],
      name: reads[i * 4 + 1],
      decimals: Number(reads[i * 4 + 2]),
      uiMultiplierAtGeneration: String(reads[i * 4 + 3]),
    })),
  }
}

// ---- 3. FEEDS ---------------------------------------------------------------
function feedSymbol(feedName) {
  // Directory names look like "Robinhood TSLA / USD" or "Robinhood SGOV-USD".
  const m = feedName.match(/^Robinhood ([A-Z0-9.]+?)(?:\s*\/\s*USD|-USD)$/)
  return m ? m[1] : null
}

async function mapAndVerifyFeeds(tokens) {
  const rdd = await fetchJson(CHAINLINK_RDD)
  const feedsBySymbol = new Map()
  for (const feed of rdd) {
    const sym = feedSymbol(feed.name ?? '')
    if (sym && feed.proxyAddress) feedsBySymbol.set(sym, getAddress(feed.proxyAddress))
  }

  const withFeeds = tokens.filter((t) => feedsBySymbol.has(t.symbol))
  const reads = await client.multicall({
    contracts: withFeeds.flatMap((t) => [
      { address: feedsBySymbol.get(t.symbol), abi: feedAbi, functionName: 'decimals' },
      { address: feedsBySymbol.get(t.symbol), abi: feedAbi, functionName: 'latestRoundData' },
    ]),
    allowFailure: false,
  })
  withFeeds.forEach((t, i) => {
    const decimals = Number(reads[i * 2])
    const [, answer, , updatedAt] = reads[i * 2 + 1]
    if (answer <= 0n) throw new Error(`Feed for ${t.symbol} answered ${answer} — refusing to ship it.`)
    t.feed = feedsBySymbol.get(t.symbol)
    t.feedDecimals = decimals
    t.feedAnswerAtGeneration = String(answer)
    t.feedUpdatedAtGeneration = Number(updatedAt)
  })
  for (const t of tokens) {
    if (!('feed' in t)) {
      t.feed = null
      t.feedDecimals = null
    }
  }
  const unmatchedFeeds = [...feedsBySymbol.keys()].filter((s) => !tokens.some((t) => t.symbol === s))
  return { tokens, feedCount: withFeeds.length, unmatchedFeeds }
}

// ---- 4. WRITE ---------------------------------------------------------------
const seen = await discoverTokens()
console.log(`discovered ${seen.size} canonical tokens (name contains "${CANONICAL_NAME_MARKER}")`)

const addresses = [...seen.keys()]
const { beacon, tokens } = await verifyTokens(addresses)
console.log(`verified: all ${tokens.length} tokens share Stock beacon ${beacon}`)

const { feedCount, unmatchedFeeds } = await mapAndVerifyFeeds(tokens)
console.log(`feeds: ${feedCount} Chainlink feeds mapped + verified (answer > 0, on-chain)`)
if (unmatchedFeeds.length) console.log(`note: feeds with no matching token: ${unmatchedFeeds.join(', ')}`)

const block = await client.getBlockNumber()
tokens.sort((a, b) => a.symbol.localeCompare(b.symbol))

const out = {
  $schema: './stock-tokens.schema.json',
  chainId: robinhood.id,
  generatedAtBlock: Number(block),
  sources: {
    discovery: `${BLOCKSCOUT}/tokens?q=Robinhood Token (canonical name pattern "<Name> ${CANONICAL_NAME_MARKER}")`,
    feeds: CHAINLINK_RDD,
    verification: 'on-chain via public RPC: shared beacon slot, symbol/name/decimals/uiMultiplier multicall, feed latestRoundData',
  },
  stockBeacon: beacon,
  tokenCount: tokens.length,
  feedCount,
  tokens,
}

const path = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/registry/stock-tokens.json')
await writeFile(path, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${path}: ${tokens.length} tokens, ${feedCount} with feeds, block ${block}`)
