#!/usr/bin/env node
/**
 * hood-tokenlist refresh pipeline.
 *
 * Re-verifies every list entry live against Robinhood Chain mainnet (4663)
 * and rebuilds tokenlist.json deterministically:
 *
 *   1. Base assets (USDG, WETH) from the official docs registry snapshot,
 *      identity re-read on-chain.
 *   2. Stock Tokens: candidates from the hoodchain SDK registry, each
 *      re-verified on-chain (symbol/name/decimals/uiMultiplier + the shared
 *      EIP-1967 beacon) and cross-checked against the docs registry fixture.
 *   3. Chainlink feeds: ETH/USD + USDG/USD verified by description(), every
 *      Stock Token feed verified by a positive latestRoundData() answer.
 *   4. Memecoins: full historical scan of NOXA TokenLaunched and Odyssey
 *      PoolMigrated events, then the published rules-based funnel
 *      (see scripts/lib/criteria.mjs and docs/criteria.html).
 *   5. Logos: deterministic ticker monograms for Stock Tokens and any token
 *      without self-owned art; launchpad/Blockscout icons downloaded and
 *      self-hosted for memecoins where resolvable.
 *   6. Version bump per tokenlist semantics (major=removal, minor=add,
 *      patch=metadata). An unchanged list is byte-identical output.
 *
 * Read-only: this script signs nothing and spends nothing.
 */

import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import { getRegistry, MAINNET_ADDRESSES, NOXA_ADDRESSES, ODYSSEY_ADDRESSES } from 'hoodchain'

import { scanLogs, blockNumber, blockTimestamp } from './lib/rpc.mjs'
import {
  CHAIN_ID,
  client,
  erc20Abi,
  stockAbi,
  feedAbi,
  poolAbi,
  readIdentities,
  readBeacons,
  verifyUsdFeeds,
  simulateSellQuote,
  simulateTransfer,
  multicallChunked,
} from './lib/chain.mjs'
import {
  MEMECOIN_CRITERIA,
  checkErc20Identity,
  displayName,
  passesAge,
  passesHolders,
  passesLiquidity,
  isSymbolSpoof,
  resolveSymbolCollisions,
} from './lib/criteria.mjs'
import { nextVersion, stableStringify } from './lib/version.mjs'
import { monogramSvg } from './lib/monogram.mjs'
import { tokenInfo, topHolder, downloadIcon } from './lib/blockscout.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOGO_BASE_URL = 'https://nirholas.github.io/hood-tokenlist/logos'

const NOXA_TOKEN_LAUNCHED_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a'
const ODYSSEY_POOL_MIGRATED_TOPIC = '0xa915d8c1403c8f95a7c6318211de8aabf6f0bfb612a7624e84ebb91a9be1c21c'

const log = (...args) => console.log('[refresh]', ...args)

function topicAddress(topic) {
  return getAddress(`0x${topic.slice(26)}`)
}

function dataWord(data, index) {
  return data.slice(2 + index * 64, 2 + (index + 1) * 64)
}

function dataAddress(data, index) {
  return getAddress(`0x${dataWord(data, index).slice(24)}`)
}

function dataUint(data, index) {
  return BigInt(`0x${dataWord(data, index)}`)
}

async function loadJson(file) {
  return JSON.parse(await readFile(path.join(ROOT, file), 'utf8'))
}

/** ---------------------------------------------------------------- base */

async function buildBaseAssets(docsRegistry, feeds) {
  const entries = []
  const byLabel = Object.fromEntries(docsRegistry.baseAssets.map((a) => [a.docsLabel, getAddress(a.address)]))
  const usdg = byLabel.USDG
  const weth = byLabel.WETH
  if (usdg !== getAddress(MAINNET_ADDRESSES.usdg) || weth !== getAddress(MAINNET_ADDRESSES.weth)) {
    throw new Error('docs registry base assets disagree with the SDK addresses; investigate before shipping')
  }
  const identities = await readIdentities([usdg, weth])
  const usdgId = identities.get(usdg.toLowerCase())
  const wethId = identities.get(weth.toLowerCase())
  if (!usdgId || usdgId.symbol !== 'USDG' || usdgId.decimals !== 6) {
    throw new Error(`USDG on-chain identity mismatch: ${JSON.stringify(usdgId)}`)
  }
  if (!wethId || wethId.symbol !== 'WETH' || wethId.decimals !== 18) {
    throw new Error(`WETH on-chain identity mismatch: ${JSON.stringify(wethId)}`)
  }
  entries.push({
    verified: { address: usdg, ...usdgId },
    entry: {
      chainId: CHAIN_ID,
      address: usdg,
      symbol: usdgId.symbol,
      name: displayName(usdgId.name),
      decimals: usdgId.decimals,
      tags: ['stablecoin', 'priced'],
      extensions: {
        assetClass: 'stablecoin',
        chainlinkFeed: feeds.usdg.address,
        chainlinkFeedDecimals: feeds.usdg.decimals,
        supportsUiMultiplier: false,
      },
    },
  })
  entries.push({
    verified: { address: weth, ...wethId },
    entry: {
      chainId: CHAIN_ID,
      address: weth,
      symbol: wethId.symbol,
      name: displayName(wethId.name),
      decimals: wethId.decimals,
      tags: ['wnative', 'priced'],
      extensions: {
        assetClass: 'wrapped-native',
        chainlinkFeed: feeds.eth.address,
        chainlinkFeedDecimals: feeds.eth.decimals,
        supportsUiMultiplier: false,
      },
    },
  })
  return entries
}

/** --------------------------------------------------------------- stocks */

async function buildStockTokens(docsRegistry, report) {
  const registry = getRegistry()
  const candidates = registry.tokens.map((t) => ({ ...t, address: getAddress(t.address) }))
  const addresses = candidates.map((t) => t.address)

  log(`stock candidates from SDK registry: ${candidates.length}`)

  const [identities, beacons] = await Promise.all([readIdentities(addresses), readBeacons(addresses)])

  // uiMultiplier for every candidate (also proves the ERC-8056 surface).
  const multiplierResults = await multicallChunked(
    addresses.map((address) => ({ address, abi: stockAbi, functionName: 'uiMultiplier' })),
  )

  // Feed answers for every candidate with a feed.
  const priced = candidates.filter((t) => t.feed)
  const feedResults = await multicallChunked(
    priced.map((t) => ({ address: getAddress(t.feed), abi: feedAbi, functionName: 'latestRoundData' })),
  )
  const feedAnswerByToken = new Map()
  priced.forEach((t, i) => {
    const r = feedResults[i]
    feedAnswerByToken.set(t.address.toLowerCase(), r.status === 'success' ? r.result[1] : null)
  })

  const expectedBeacon = getAddress(registry.stockBeacon)
  const included = []
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const key = candidate.address.toLowerCase()
    const identity = identities.get(key)
    const beacon = beacons.get(key)
    const multiplier = multiplierResults[i]
    const reasons = []

    if (!identity) reasons.push('identity unreadable on-chain')
    else {
      if (identity.symbol !== candidate.symbol) reasons.push(`symbol drift: chain=${identity.symbol} registry=${candidate.symbol}`)
      if (identity.decimals !== candidate.decimals) reasons.push(`decimals drift: chain=${identity.decimals}`)
      const name = displayName(identity.name)
      reasons.push(...checkErc20Identity({ symbol: identity.symbol, name, decimals: identity.decimals }))
      if (name.length > 60) reasons.push('display name exceeds 60 chars even after suffix strip')
    }
    if (beacon !== expectedBeacon) reasons.push(`beacon mismatch: ${beacon ?? 'none'}`)
    if (multiplier.status !== 'success') reasons.push('uiMultiplier() unreadable')
    if (candidate.feed) {
      const answer = feedAnswerByToken.get(key)
      if (answer == null || answer <= 0n) reasons.push('chainlink feed returned no positive answer')
    }

    if (reasons.length > 0) {
      report.exclusions.push({ stage: 'stock-verification', address: candidate.address, symbol: candidate.symbol, reasons })
      continue
    }

    included.push({
      verified: {
        address: candidate.address,
        symbol: identity.symbol,
        name: identity.name,
        decimals: identity.decimals,
        beacon,
        uiMultiplier: multiplier.result.toString(),
        feed: candidate.feed ? getAddress(candidate.feed) : null,
      },
      entry: {
        chainId: CHAIN_ID,
        address: candidate.address,
        symbol: identity.symbol,
        name: displayName(identity.name),
        decimals: identity.decimals,
        tags: candidate.feed ? ['stock', 'priced'] : ['stock'],
        extensions: {
          assetClass: 'stock-token',
          chainlinkFeed: candidate.feed ? getAddress(candidate.feed) : null,
          chainlinkFeedDecimals: candidate.feed ? candidate.feedDecimals : null,
          supportsUiMultiplier: true,
          eligibility: 'not-for-us-persons',
        },
      },
    })
  }

  // Docs-registry cross-check: every docs address must be in the verified set.
  const includedByAddress = new Map(included.map((t) => [t.entry.address.toLowerCase(), t]))
  for (const row of docsRegistry.stockTokens) {
    const hit = includedByAddress.get(row.address.toLowerCase())
    if (!hit) throw new Error(`docs registry token ${row.docsLabel} (${row.address}) missing from verified set`)
  }
  log(`stock tokens verified: ${included.length} (docs cross-check: ${docsRegistry.stockTokens.length} matched)`)
  report.stats.stockCandidates = candidates.length
  report.stats.stockVerified = included.length
  report.stats.docsCrossChecked = docsRegistry.stockTokens.length
  return included
}

/** ------------------------------------------------------------ memecoins */

async function scanLaunchpadCandidates(tipBlock) {
  const candidates = new Map() // token lower -> candidate

  log('scanning NOXA TokenLaunched…')
  const noxaLogs = await scanLogs(
    { address: NOXA_ADDRESSES.launchFactory, topics: [NOXA_TOKEN_LAUNCHED_TOPIC] },
    Number(NOXA_ADDRESSES.deployBlock),
    tipBlock,
    { onChunk: ({ toBlock, total }) => process.stdout.write(`\r[refresh]   noxa @${toBlock}: ${total} launches`) },
  )
  process.stdout.write('\n')
  for (const item of noxaLogs) {
    const token = topicAddress(item.topics[1])
    candidates.set(token.toLowerCase(), {
      launchpad: 'noxa',
      token,
      pairToken: dataAddress(item.data, 0),
      pool: dataAddress(item.data, 1),
      restrictionsEndBlock: Number(dataUint(item.data, 5)),
      eventBlock: parseInt(item.blockNumber, 16),
    })
  }

  log('scanning Odyssey PoolMigrated…')
  const odysseyFactories = [
    ODYSSEY_ADDRESSES.bondingCurveFactory,
    ODYSSEY_ADDRESSES.reflectionFactory,
    ODYSSEY_ADDRESSES.instantFactory,
    ODYSSEY_ADDRESSES.legacyFactory,
  ]
  for (const factory of odysseyFactories) {
    const logs = await scanLogs({ address: factory, topics: [ODYSSEY_POOL_MIGRATED_TOPIC] }, 0, tipBlock)
    for (const item of logs) {
      const token = topicAddress(item.topics[1])
      candidates.set(token.toLowerCase(), {
        launchpad: 'odyssey',
        token,
        pairToken: null, // resolved from the pool below
        pool: dataAddress(item.data, 0),
        restrictionsEndBlock: 0,
        eventBlock: parseInt(item.blockNumber, 16),
      })
    }
  }
  return [...candidates.values()]
}

async function buildMemecoins({ tipBlock, nowSeconds, feeds, reservedSymbols, report }) {
  const weth = getAddress(MAINNET_ADDRESSES.weth)
  const usdg = getAddress(MAINNET_ADDRESSES.usdg)
  const quoteMeta = {
    [weth.toLowerCase()]: { decimals: 18, usd: feeds.eth.price },
    [usdg.toLowerCase()]: { decimals: 6, usd: feeds.usdg.price },
  }

  const candidates = await scanLaunchpadCandidates(tipBlock)
  report.stats.launchpadCandidates = candidates.length
  log(`launchpad candidates: ${candidates.length}`)

  // Resolve quote token for Odyssey pools (token0/token1 read).
  const odyssey = candidates.filter((c) => c.launchpad === 'odyssey')
  if (odyssey.length > 0) {
    const poolReads = await multicallChunked(
      odyssey.flatMap((c) => [
        { address: c.pool, abi: poolAbi, functionName: 'token0' },
        { address: c.pool, abi: poolAbi, functionName: 'token1' },
      ]),
    )
    odyssey.forEach((c, i) => {
      const t0 = poolReads[i * 2]
      const t1 = poolReads[i * 2 + 1]
      if (t0.status === 'success' && t1.status === 'success') {
        const other = getAddress(t0.result).toLowerCase() === c.token.toLowerCase() ? t1.result : t0.result
        c.pairToken = getAddress(other)
      }
    })
  }

  // Stage 1: quote must be WETH or USDG.
  const knownQuote = []
  let unknownQuote = 0
  for (const c of candidates) {
    if (c.pairToken && quoteMeta[c.pairToken.toLowerCase()]) knownQuote.push(c)
    else unknownQuote++
  }
  report.stats.excludedUnknownQuote = unknownQuote

  // Stage 2: liquidity pre-filter: quote-side pool reserves valued in USD.
  const balanceReads = await multicallChunked(
    knownQuote.map((c) => ({ address: c.pairToken, abi: erc20Abi, functionName: 'balanceOf', args: [c.pool] })),
    { chunk: 400 },
  )
  const liquid = []
  let excludedLiquidity = 0
  knownQuote.forEach((c, i) => {
    const read = balanceReads[i]
    const meta = quoteMeta[c.pairToken.toLowerCase()]
    const quoteSideUsd =
      read.status === 'success' ? (Number(read.result) / 10 ** meta.decimals) * meta.usd : Number.NaN
    if (passesLiquidity(quoteSideUsd)) liquid.push({ ...c, quoteSideUsd })
    else excludedLiquidity++
  })
  report.stats.excludedLiquidityPrefilter = excludedLiquidity
  log(`memecoins past the $${MEMECOIN_CRITERIA.minLiquidityUsd} liquidity gate: ${liquid.length}`)

  // Stage 3: full per-survivor verification.
  const identities = await readIdentities(liquid.map((c) => c.token))
  const feeReads = await multicallChunked(liquid.map((c) => ({ address: c.pool, abi: poolAbi, functionName: 'fee' })))

  const survivors = []
  for (let i = 0; i < liquid.length; i++) {
    const candidate = liquid[i]
    const reasons = []
    const identity = identities.get(candidate.token.toLowerCase())
    const fee = feeReads[i].status === 'success' ? feeReads[i].result : null

    if (!identity) {
      reasons.push('identity unreadable on-chain')
    } else {
      reasons.push(
        ...checkErc20Identity({
          symbol: identity.symbol,
          name: displayName(identity.name),
          decimals: identity.decimals,
        }),
      )
      if (isSymbolSpoof(identity.symbol, reservedSymbols)) reasons.push('symbol spoofs a canonical asset ticker')
    }
    if (fee == null) reasons.push('pool fee unreadable')

    if (reasons.length === 0) {
      const launchedAt = await blockTimestamp(candidate.eventBlock)
      if (!passesAge(launchedAt, nowSeconds)) {
        reasons.push(`younger than ${MEMECOIN_CRITERIA.minAgeDays} days (launched ${new Date(launchedAt * 1000).toISOString()})`)
      } else {
        candidate.launchedAt = launchedAt
      }
    }

    if (reasons.length === 0) {
      const info = await tokenInfo(candidate.token)
      if (!info || !passesHolders(info.holdersCount)) {
        reasons.push(`holders ${info?.holdersCount ?? 'unknown'} below ${MEMECOIN_CRITERIA.minHolders}`)
      } else {
        candidate.holdersCount = info.holdersCount
        candidate.iconUrl = info.iconUrl
      }
    }

    if (reasons.length === 0) {
      const sell = await simulateSellQuote({
        token: candidate.token,
        quoteToken: candidate.pairToken,
        fee,
        decimals: identity.decimals,
      })
      if (!sell.ok) reasons.push(`simulated sell quote failed: ${sell.error ?? 'no output'}`)
    }

    if (reasons.length === 0) {
      const holder = await topHolder(candidate.token)
      if (!holder) {
        reasons.push('no holder available for transfer simulation')
      } else {
        const transfer = await simulateTransfer({ token: candidate.token, holder })
        if (!transfer.ok) reasons.push(`simulated transfer failed: ${transfer.error ?? 'returned false'}`)
      }
    }

    if (reasons.length > 0) {
      report.exclusions.push({
        stage: 'memecoin-verification',
        address: candidate.token,
        symbol: identity?.symbol ?? null,
        launchpad: candidate.launchpad,
        reasons,
      })
      continue
    }
    survivors.push({ ...candidate, identity, fee })
  }

  // Stage 4: symbol collisions: deepest liquidity wins, deterministic.
  const { included, excluded } = resolveSymbolCollisions(
    survivors.map((s) => ({ ...s, symbol: s.identity.symbol, address: s.token })),
  )
  for (const loser of excluded) {
    report.exclusions.push({
      stage: 'memecoin-symbol-collision',
      address: loser.token,
      symbol: loser.identity.symbol,
      launchpad: loser.launchpad,
      reasons: [`symbol ${loser.identity.symbol} collision lost to deeper pool`],
    })
  }

  report.stats.memecoinsIncluded = included.length
  log(`memecoins included: ${included.length}`)

  return included.map((s) => ({
    verified: {
      address: s.token,
      symbol: s.identity.symbol,
      name: s.identity.name,
      decimals: s.identity.decimals,
      pool: s.pool,
      quoteSideUsd: Math.round(s.quoteSideUsd),
      holders: s.holdersCount,
      launchedAt: s.launchedAt,
    },
    iconUrl: s.iconUrl ?? null,
    entry: {
      chainId: CHAIN_ID,
      address: s.token,
      symbol: s.identity.symbol,
      name: displayName(s.identity.name),
      decimals: s.identity.decimals,
      tags: ['memecoin', s.launchpad],
      extensions: {
        assetClass: 'memecoin',
        launchpad: s.launchpad,
        uniswapV3Pool: s.pool,
        uniswapV3PoolFee: Number(s.fee),
        launchBlock: s.eventBlock,
        // NOXA stamps anti-snipe launch restrictions that expire at this
        // block (a far-future constant on every launch). Tradability is
        // verified live via simulated sell + transfer, not this field.
        ...(s.launchpad === 'noxa' ? { launchRestrictionsEndBlock: s.restrictionsEndBlock } : {}),
        chainlinkFeed: null,
        supportsUiMultiplier: false,
      },
    },
  }))
}

/** ----------------------------------------------------------------- logos */

async function ensureLogos(baseEntries, stockEntries, memeEntries) {
  const logosDir = path.join(ROOT, 'logos')
  await mkdir(logosDir, { recursive: true })

  const assignments = []

  // Stock tokens and base assets: always the deterministic monogram system.
  for (const { entry } of [...baseEntries, ...stockEntries]) {
    const file = `${entry.address}.svg`
    await writeFile(path.join(logosDir, file), monogramSvg(entry.symbol, entry.address))
    assignments.push({ address: entry.address, file })
  }

  // Memecoins: self-hosted copy of their own art where resolvable, monogram fallback.
  for (const item of memeEntries) {
    const { entry } = item
    let file = null
    if (item.iconUrl) {
      const existing = (await readdir(logosDir)).find((f) => f.startsWith(`${entry.address}.`) && !f.endsWith('.svg'))
      if (existing) {
        file = existing
      } else {
        const icon = await downloadIcon(item.iconUrl)
        if (icon) {
          file = `${entry.address}.${icon.extension}`
          await writeFile(path.join(logosDir, file), icon.bytes)
        }
      }
    }
    if (!file) {
      file = `${entry.address}.svg`
      await writeFile(path.join(logosDir, file), monogramSvg(entry.symbol, entry.address))
    }
    assignments.push({ address: entry.address, file })
  }

  // List logo.
  await writeFile(path.join(logosDir, 'list.svg'), monogramSvg('HOOD', '0x0000000000000000000000000000000000004663'))

  const byAddress = new Map(assignments.map((a) => [a.address, a.file]))
  for (const { entry } of [...baseEntries, ...stockEntries, ...memeEntries]) {
    entry.logoURI = `${LOGO_BASE_URL}/${byAddress.get(entry.address)}`
  }
}

/** -------------------------------------------------------------- assemble */

const TAG_DEFINITIONS = {
  stock: { name: 'Stock Token', description: 'Tokenized equity issued on Robinhood Chain, subject to eligibility restrictions' },
  memecoin: { name: 'Memecoin', description: 'Launchpad token that passed the published rules based inclusion criteria' },
  stablecoin: { name: 'Stablecoin', description: 'Dollar pegged stablecoin' },
  wnative: { name: 'Wrapped Native', description: 'Wrapped gas token of the chain' },
  priced: { name: 'Chainlink Priced', description: 'Has a live onchain Chainlink price feed' },
  noxa: { name: 'NOXA', description: 'Launched on the NOXA launchpad' },
  odyssey: { name: 'The Odyssey', description: 'Graduated from The Odyssey bonding curve' },
}

function orderedEntry(entry) {
  return {
    chainId: entry.chainId,
    address: entry.address,
    symbol: entry.symbol,
    name: entry.name,
    decimals: entry.decimals,
    logoURI: entry.logoURI,
    tags: entry.tags,
    extensions: entry.extensions,
  }
}

async function assemble({ tokens, tipBlock }) {
  const sorted = [...tokens].sort(
    (a, b) => a.symbol.localeCompare(b.symbol, 'en') || a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
  )

  let previous = null
  const listPath = path.join(ROOT, 'tokenlist.json')
  if (existsSync(listPath)) previous = JSON.parse(await readFile(listPath, 'utf8'))

  const previousVersion = previous?.version ?? { major: 0, minor: 0, patch: 0 }
  const previousTokens = previous?.tokens ?? []

  const candidateList = {
    name: 'Robinhood Chain Token List',
    timestamp: previous?.timestamp ?? new Date().toISOString(),
    version: previousVersion,
    keywords: ['robinhood chain', 'stock tokens', 'memecoins', 'chainlink', 'uniswap'],
    tags: TAG_DEFINITIONS,
    logoURI: `${LOGO_BASE_URL}/list.svg`,
    tokens: sorted.map(orderedEntry),
  }

  const diff = nextVersion(previousVersion, previousTokens, candidateList.tokens)
  const listChanged =
    diff.changed || !previous || stableStringify({ ...previous, timestamp: 0, version: 0 }) !== stableStringify({ ...candidateList, timestamp: 0, version: 0 })

  if (listChanged) {
    candidateList.version = previous ? diff.version : { major: 1, minor: 0, patch: 0 }
    candidateList.timestamp = new Date().toISOString()
  }

  await writeFile(listPath, `${JSON.stringify(candidateList, null, 2)}\n`)
  return { list: candidateList, diff, listChanged, tipBlock }
}

async function mirrorToDocs() {
  const docsDir = path.join(ROOT, 'docs')
  await mkdir(path.join(docsDir, 'logos'), { recursive: true })
  await copyFile(path.join(ROOT, 'tokenlist.json'), path.join(docsDir, 'tokenlist.json'))
  // file:// fallback for the directory page (fetch of local JSON is blocked
  // when index.html is opened straight from the filesystem).
  const json = await readFile(path.join(ROOT, 'tokenlist.json'), 'utf8')
  await writeFile(path.join(docsDir, 'tokenlist.data.js'), `window.__TOKENLIST__ = ${json.trimEnd()}\n`)
  const logosDir = path.join(ROOT, 'logos')
  for (const file of await readdir(logosDir)) {
    await copyFile(path.join(logosDir, file), path.join(docsDir, 'logos', file))
  }
}

/** ------------------------------------------------------------------ main */

async function main() {
  const startedAt = Date.now()
  const report = { stats: {}, exclusions: [] }

  const [tipBlock, docsRegistry] = await Promise.all([blockNumber(), loadJson('data/robinhood-docs-registry.json')])
  const nowSeconds = Math.floor(Date.now() / 1000)
  log(`chain tip: ${tipBlock}`)

  const feeds = await verifyUsdFeeds()
  log(`feeds verified: ETH/USD $${feeds.eth.price.toFixed(2)}, USDG/USD $${feeds.usdg.price.toFixed(4)}`)

  const baseEntries = await buildBaseAssets(docsRegistry, feeds)
  const stockEntries = await buildStockTokens(docsRegistry, report)

  const reservedSymbols = new Set(
    [...baseEntries, ...stockEntries].map((t) => t.entry.symbol.toUpperCase()),
  )
  const memeEntries = await buildMemecoins({ tipBlock, nowSeconds, feeds, reservedSymbols, report })

  await ensureLogos(baseEntries, stockEntries, memeEntries)

  const allEntries = [...baseEntries, ...stockEntries, ...memeEntries].map((t) => t.entry)
  const { list, diff, listChanged } = await assemble({ tokens: allEntries, tipBlock })
  await mirrorToDocs()

  report.stats.checkedAtBlock = tipBlock
  report.stats.tokensTotal = list.tokens.length
  report.stats.byClass = list.tokens.reduce((acc, t) => {
    acc[t.extensions.assetClass] = (acc[t.extensions.assetClass] ?? 0) + 1
    return acc
  }, {})
  report.stats.version = list.version
  report.stats.changed = listChanged
  report.stats.added = diff.added
  report.stats.removed = diff.removed
  report.stats.modified = diff.modified
  report.stats.durationSeconds = Math.round((Date.now() - startedAt) / 1000)
  await writeFile(path.join(ROOT, 'data', 'refresh-report.json'), `${JSON.stringify(report, null, 2)}\n`)

  log(`done in ${report.stats.durationSeconds}s: ${list.tokens.length} tokens, version ${list.version.major}.${list.version.minor}.${list.version.patch} (${listChanged ? 'changed' : 'unchanged'})`)
  log(`by class: ${JSON.stringify(report.stats.byClass)}`)
}

main().catch((error) => {
  console.error('[refresh] FAILED:', error)
  process.exitCode = 1
})
