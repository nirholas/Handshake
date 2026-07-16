// Live Robinhood Chain (4663) premium/discount feed, rendered client-side from
// the public RPC. Read-only: this is exactly the arb signal hood-alerts fires
// as its premium detector, computed live in your browser. No wallet, no keys.
(() => {
  const SEL_LATEST_ROUND = '0xfeaf968c' // latestRoundData()
  const SEL_SLOT0 = '0x3850c7bd' // slot0()
  const Q192 = 2n ** 192n

  const els = {
    block: document.getElementById('live-block'),
    updated: document.getElementById('live-updated'),
    count: document.getElementById('live-count'),
    cards: document.getElementById('live-cards'),
    error: document.getElementById('live-error'),
  }
  if (!els.cards) return

  let cfg = null

  const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64))

  async function rpc(method, params) {
    const res = await fetch(cfg.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) throw new Error('rpc ' + res.status)
    const body = await res.json()
    if (body.error) throw new Error(body.error.message || 'rpc error')
    return body.result
  }

  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest'])

  function sqrtToPrice0in1(sqrtP, dec0, dec1) {
    // token1 per token0, decimal-adjusted, as a JS number.
    const num = sqrtP * sqrtP * 10n ** BigInt(dec0) * 10n ** 18n
    const den = Q192 * 10n ** BigInt(dec1)
    return Number(num / den) / 1e18
  }

  async function ethUsd() {
    try {
      const r = await fetch('https://robinhoodchain.blockscout.com/api/v2/stats', { headers: { accept: 'application/json' } })
      if (!r.ok) return null
      const b = await r.json()
      const p = b.coin_price ? Number(b.coin_price) : NaN
      return Number.isFinite(p) && p > 0 ? p : null
    } catch {
      return null
    }
  }

  function fmtUsd(n) {
    if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    return '$' + n.toFixed(2)
  }

  async function loadMarket(m, eth) {
    const [feedRes, slotRes] = await Promise.all([call(m.feed, SEL_LATEST_ROUND), call(m.pool, SEL_SLOT0)])
    const answer = word(feedRes, 1)
    const feedUsd = Number(answer) / 10 ** m.feedDecimals
    const sqrtP = word(slotRes, 0)
    const price0in1 = sqrtToPrice0in1(sqrtP, m.decimals0, m.decimals1)
    if (!(price0in1 > 0)) return null
    const stockInQuote = m.stockIs0 ? price0in1 : 1 / price0in1
    let dexUsd
    if (m.quote === 'USDG') dexUsd = stockInQuote
    else if (eth) dexUsd = stockInQuote * eth
    else return null
    const premiumPct = ((dexUsd - feedUsd) / feedUsd) * 100
    return { ...m, feedUsd, dexUsd, premiumPct }
  }

  function renderCard(r) {
    const abs = Math.abs(r.premiumPct)
    const cls = abs < 0.25 ? 'flat' : r.premiumPct >= 0 ? 'prem' : 'disc'
    const label = abs < 0.25 ? 'in line' : (r.premiumPct >= 0 ? '+' : '') + r.premiumPct.toFixed(2) + '%'
    const word = r.premiumPct >= 0 ? 'premium' : 'discount'
    const el = document.createElement('div')
    el.className = 'card'
    el.innerHTML =
      '<div class="row"><span class="sym">' + r.symbol + '</span>' +
      '<span class="badge ' + cls + '">' + label + '</span></div>' +
      '<div class="prices">' +
      '<span>DEX mid <b>' + fmtUsd(r.dexUsd) + '</b> · ' + r.quote + ' pool</span>' +
      '<span>Chainlink <b>' + fmtUsd(r.feedUsd) + '</b></span>' +
      (abs >= 0.25 ? '<span>trading at a ' + abs.toFixed(2) + '% ' + word + ' on-chain</span>' : '') +
      '</div>' +
      '<div class="links">' +
      '<a href="https://three.ws/markets/robinhood/stock/' + r.symbol + '" target="_blank" rel="noopener">Chart</a>' +
      '<a href="https://robinhoodchain.blockscout.com/address/' + r.pool + '" target="_blank" rel="noopener">Pool</a>' +
      '</div>'
    return el
  }

  async function refresh() {
    try {
      const [blockHex, eth] = await Promise.all([rpc('eth_blockNumber', []), ethUsd()])
      if (els.block) els.block.textContent = '#' + parseInt(blockHex, 16).toLocaleString('en-US')
      const results = []
      for (const m of cfg.markets) {
        try {
          const r = await loadMarket(m, eth)
          if (r) results.push(r)
        } catch {
          // one bad pool should not sink the feed
        }
      }
      results.sort((a, b) => Math.abs(b.premiumPct) - Math.abs(a.premiumPct))
      els.cards.innerHTML = ''
      for (const r of results) els.cards.appendChild(renderCard(r))
      if (els.count) els.count.textContent = results.length
      if (els.updated) els.updated.textContent = new Date().toLocaleTimeString()
      if (els.error) els.error.style.display = 'none'
    } catch (e) {
      if (els.error) {
        els.error.style.display = 'block'
        els.error.textContent = 'Live feed unavailable right now (' + (e.message || 'network') + '). The public RPC may be rate-limiting; it retries automatically.'
      }
    }
  }

  async function boot() {
    try {
      const res = await fetch('./live-markets.json')
      cfg = await res.json()
    } catch {
      if (els.error) {
        els.error.style.display = 'block'
        els.error.textContent = 'Could not load market list.'
      }
      return
    }
    await refresh()
    setInterval(refresh, 20000)
  }

  boot()
})()
