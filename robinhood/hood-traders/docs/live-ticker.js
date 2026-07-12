// Live ticker — raw JSON-RPC calls straight from the browser to the public
// Robinhood Chain mainnet RPC. No SDK bundle, no server: this is the same
// read-only capability any client of the chain has. Two calls:
//   1. eth_blockNumber           — chain liveness
//   2. eth_call latestRoundData  — AAPL's Chainlink feed, decoded by hand

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
const AAPL_FEED = '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0'
// keccak256("latestRoundData()")[:4] — Chainlink AggregatorV3Interface selector.
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c'

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return json.result
}

function decodeLatestRoundData(hex) {
  // Five ABI-encoded words: roundId(uint80) answer(int256) startedAt(uint256) updatedAt(uint256) answeredInRound(uint80)
  const data = hex.slice(2)
  const words = []
  for (let i = 0; i < 5; i++) words.push(data.slice(i * 64, i * 64 + 64))
  const answer = BigInt('0x' + words[1])
  const updatedAt = Number(BigInt('0x' + words[3]))
  return { answer, updatedAt }
}

function tile(label, value) {
  return `<div class="stat-tile"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`
}

async function refresh() {
  const el = document.getElementById('live-ticker')
  try {
    const [blockHex] = await Promise.all([rpc('eth_blockNumber', [])])
    const blockNumber = BigInt(blockHex).toLocaleString('en-US')

    const callResult = await rpc('eth_call', [{ to: AAPL_FEED, data: LATEST_ROUND_DATA_SELECTOR }, 'latest'])
    const { answer, updatedAt } = decodeLatestRoundData(callResult)
    const priceUsd = (Number(answer) / 1e8).toFixed(2)
    const ageMin = Math.max(0, Math.floor(Date.now() / 1000 - updatedAt) / 60).toFixed(0)

    el.innerHTML = [
      tile('Mainnet block (4663)', blockNumber),
      tile('AAPL token (Chainlink)', `$${priceUsd}`),
      tile('Feed age', `${ageMin}m`),
      tile('RPC', 'rpc.mainnet.chain.robinhood.com'),
    ].join('')
  } catch (err) {
    el.innerHTML = `<div class="state-block">Couldn't reach the public RPC from your browser: ${err.message}</div>`
  }
}

refresh()
setInterval(refresh, 15_000)
