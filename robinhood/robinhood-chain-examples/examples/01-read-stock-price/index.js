/**
 * 01 — Read a Stock Token price with viem only (no SDK).
 *
 * The "hello chain" baseline: connect to Robinhood Chain mainnet (4663),
 * read one tokenized stock's Chainlink price feed, and print the price.
 *
 * This is the raw version — every address and ABI spelled out — so you can
 * see exactly what the `hoodchain` SDK does for you in example 02.
 *
 * Run: node index.js [SYMBOL]   (default AAPL)
 */
import { createPublicClient, http, formatUnits } from 'viem'
import { robinhood } from 'viem/chains'

// Robinhood Stock Token → its Chainlink price-feed proxy (8-decimal answers).
// Verified on-chain; the full 95-token registry lives in the hoodchain SDK.
const FEEDS = {
  AAPL: { token: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', feed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' },
  TSLA: { token: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', feed: '0x4A1166a659A55625345e9515b32adECea5547C38' },
  NVDA: { token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
}

// AggregatorV3Interface.latestRoundData() — the standard Chainlink read.
const aggregatorV3Abi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]

const symbol = (process.argv[2] || 'AAPL').toUpperCase()
const entry = FEEDS[symbol]
if (!entry) {
  console.error(`No hard-coded feed for ${symbol}. This baseline example ships AAPL, TSLA, and NVDA;`)
  console.error(`for all 95 Stock Tokens use example 02 (the hoodchain SDK).`)
  process.exit(1)
}

// One public client, viem's official chain definition — never hand-roll the config.
const client = createPublicClient({ chain: robinhood, transport: http() })

const [decimals, round] = await Promise.all([
  client.readContract({ address: entry.feed, abi: aggregatorV3Abi, functionName: 'decimals' }),
  client.readContract({ address: entry.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' }),
])

const [, answer, , updatedAt] = round
if (answer <= 0n) {
  console.error(`Feed returned a non-positive answer (${answer}) — not a live price.`)
  process.exit(1)
}

const price = Number(formatUnits(answer, Number(decimals)))
const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt))
const ageHours = (ageSeconds / 3600).toFixed(1)

const block = await client.getBlockNumber()

console.log(`Robinhood Chain (${robinhood.id}) — block ${block}`)
console.log(`${symbol} token ${entry.token}`)
console.log(`  Chainlink feed ${entry.feed}`)
console.log(`  price: $${price.toFixed(2)}  (answer age ${ageHours}h)`)
console.log()
console.log('Note: Robinhood feeds are already corporate-action adjusted — this is the')
console.log('total-return token price, not the raw share price. See example 03.')
