/* ticker.js — live Robinhood Chain stats on the landing page.
   Raw JSON-RPC over fetch against the public mainnet RPC. No viem, no CDN:
   this is exactly the "read-only calls work client-side" claim, demonstrated. */
(function () {
  'use strict'

  var RPC = 'https://rpc.mainnet.chain.robinhood.com'
  var AAPL_FEED = '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' // Chainlink AAPL/USD (8 decimals)
  var USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' // 6 decimals
  var SEL_LATEST_ROUND = '0xfeaf968c' // latestRoundData()
  var SEL_TOTAL_SUPPLY = '0x18160ddd' // totalSupply()

  var el = {
    block: document.getElementById('stat-block'),
    gas: document.getElementById('stat-gas'),
    aapl: document.getElementById('stat-aapl'),
    usdg: document.getElementById('stat-usdg'),
    note: document.getElementById('chain-strip-note'),
  }
  if (!el.block) return

  var id = 0
  function rpc(method, params) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: method, params: params || [] }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j.error) throw new Error(j.error.message || 'rpc error')
        return j.result
      })
  }

  function hexToBig(h) { return BigInt(h && h !== '0x' ? h : '0x0') }

  // format a raw integer with `decimals` places to a compact human string
  function fmtUnits(raw, decimals, maxFrac) {
    var neg = raw < 0n
    if (neg) raw = -raw
    var base = 10n ** BigInt(decimals)
    var whole = raw / base
    var frac = raw % base
    var fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac == null ? decimals : maxFrac)
    fracStr = fracStr.replace(/0+$/, '')
    var wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return (neg ? '-' : '') + wholeStr + (fracStr ? '.' + fracStr : '')
  }

  function compact(raw, decimals) {
    var n = Number(raw) / Math.pow(10, decimals)
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
    return n.toFixed(0)
  }

  function set(node, value) {
    if (!node) return
    if (node.textContent !== value) {
      node.textContent = value
      node.classList.remove('tick')
      void node.offsetWidth
      node.classList.add('tick')
    }
  }

  function updateBlockAndGas() {
    Promise.all([rpc('eth_blockNumber'), rpc('eth_gasPrice')])
      .then(function (res) {
        set(el.block, '#' + fmtUnits(hexToBig(res[0]), 0))
        var gwei = Number(hexToBig(res[1])) / 1e9
        set(el.gas, (gwei < 0.01 ? gwei.toFixed(4) : gwei.toFixed(3)) + ' gwei')
        ok()
      })
      .catch(fail)
  }

  function updateSlow() {
    // AAPL price: latestRoundData() → answer is the 2nd 32-byte word
    rpc('eth_call', [{ to: AAPL_FEED, data: SEL_LATEST_ROUND }, 'latest'])
      .then(function (data) {
        if (!data || data.length < 2 + 64 * 2) return
        var answerHex = '0x' + data.slice(2 + 64, 2 + 128)
        set(el.aapl, '$' + fmtUnits(hexToBig(answerHex), 8, 2))
      })
      .catch(function () {})
    rpc('eth_call', [{ to: USDG, data: SEL_TOTAL_SUPPLY }, 'latest'])
      .then(function (data) {
        set(el.usdg, '$' + compact(hexToBig(data), 6))
      })
      .catch(function () {})
  }

  var failed = false
  function fail() {
    if (failed) return
    failed = true
    if (el.note) { el.note.textContent = 'Live RPC unreachable right now — values may be stale.'; el.note.classList.add('err') }
  }
  function ok() {
    if (failed && el.note) { failed = false; el.note.textContent = 'Live from the public RPC in your browser.'; el.note.classList.remove('err') }
  }

  updateBlockAndGas()
  updateSlow()
  var fast = setInterval(updateBlockAndGas, 4000)
  var slow = setInterval(updateSlow, 30000)
  window.addEventListener('pagehide', function () { clearInterval(fast); clearInterval(slow) })
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearInterval(fast); clearInterval(slow) }
    else { fast = setInterval(updateBlockAndGas, 4000); slow = setInterval(updateSlow, 30000); updateBlockAndGas() }
  })
})()
