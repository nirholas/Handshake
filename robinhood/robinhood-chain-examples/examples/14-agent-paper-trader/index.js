/**
 * 14 — Minimal agent paper trader.
 *
 * A tiny momentum strategy that polls real Chainlink prices via hoodchain and
 * simulates trades against a virtual USDG balance — no wallet, no real funds,
 * no on-chain transaction. "Paper mode" means every fill is logged and
 * tracked in memory only.
 *
 * Strategy (intentionally simple — this is a wiring example, not alpha):
 *   - Track each symbol's rolling high/low over the session.
 *   - BUY when price is down ≥ DIP_PCT from the session high and flat.
 *   - SELL when price is up ≥ TAKE_PROFIT_PCT from the paper entry.
 *
 * A hood-traders package (real execution, richer strategies, risk limits)
 * hasn't shipped yet — see the root README's SDK feedback. This example is
 * deliberately hoodchain-only so it runs standalone today; swapping in
 * hood-traders later is a strategy-object change, not a rewrite.
 *
 * Run: node index.js [seconds]   (default 60; polls every 15s)
 */
import { createHoodClient, getQuote } from 'hoodchain'

const SYMBOLS = ['AAPL', 'TSLA', 'NVDA']
const DIP_PCT = 0.001 // 0.1% dip from session high triggers a paper buy
const TAKE_PROFIT_PCT = 0.001 // 0.1% gain from entry triggers a paper sell
const POLL_MS = 15_000
const STARTING_USDG = 10_000

const runSeconds = process.argv[2] !== undefined ? Number(process.argv[2]) : 60
const hood = createHoodClient()

const book = new Map(SYMBOLS.map((s) => [s, { high: null, low: null, position: null }]))
let usdg = STARTING_USDG
const fills = []

function log(line) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
}

async function tick() {
  for (const symbol of SYMBOLS) {
    let quote
    try {
      quote = await getQuote(hood, symbol, { maxAgeSeconds: 7 * 24 * 3600 })
    } catch (err) {
      log(`${symbol}  quote failed: ${err.message}`)
      continue
    }
    const price = quote.priceUsd
    const s = book.get(symbol)
    s.high = s.high === null ? price : Math.max(s.high, price)
    s.low = s.low === null ? price : Math.min(s.low, price)

    if (!s.position) {
      const dipFromHigh = (s.high - price) / s.high
      if (dipFromHigh >= DIP_PCT && usdg >= price) {
        const qty = Math.floor((usdg * 0.1) / price * 1e6) / 1e6 // paper-size: 10% of book
        if (qty > 0) {
          usdg -= qty * price
          s.position = { qty, entry: price }
          fills.push({ symbol, side: 'BUY', qty, price, usdgAfter: usdg })
          log(`BUY  ${symbol}  ${qty} @ $${price.toFixed(2)}  (${(dipFromHigh * 100).toFixed(3)}% dip)  usdg=${usdg.toFixed(2)}`)
        }
      }
    } else {
      const gain = (price - s.position.entry) / s.position.entry
      if (gain >= TAKE_PROFIT_PCT) {
        usdg += s.position.qty * price
        fills.push({ symbol, side: 'SELL', qty: s.position.qty, price, usdgAfter: usdg })
        log(`SELL ${symbol}  ${s.position.qty} @ $${price.toFixed(2)}  (+${(gain * 100).toFixed(3)}%)  usdg=${usdg.toFixed(2)}`)
        s.position = null
        s.high = price
        s.low = price
      }
    }
  }
}

log(`Paper trading ${SYMBOLS.join(', ')} — starting book $${STARTING_USDG.toFixed(2)} USDG (simulated).`)
log(`Strategy: buy on ${(DIP_PCT * 100).toFixed(2)}% dip, sell on ${(TAKE_PROFIT_PCT * 100).toFixed(2)}% gain. No real funds, no on-chain tx.`)
await tick()
const interval = setInterval(tick, POLL_MS)

const stop = () => {
  clearInterval(interval)
  const openValue = [...book.values()].reduce((sum, s) => sum + (s.position ? s.position.qty * s.position.entry : 0), 0)
  console.log('\n--- session summary ---')
  console.log(`fills: ${fills.length}`)
  console.log(`cash (USDG): $${usdg.toFixed(2)}`)
  console.log(`open positions (at entry price): $${openValue.toFixed(2)}`)
  console.log(`estimated total: $${(usdg + openValue).toFixed(2)} (started at $${STARTING_USDG.toFixed(2)})`)
  process.exit(0)
}
process.on('SIGINT', stop)
if (runSeconds > 0) setTimeout(stop, runSeconds * 1000)
