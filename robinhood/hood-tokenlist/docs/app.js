/* hood-tokenlist directory app: renders tokenlist.json as a searchable,
   filterable table with live on-chain data from the public RPC. */
(() => {
  'use strict'

  const RPC = 'https://rpc.mainnet.chain.robinhood.com'
  const EXPLORER = 'https://robinhoodchain.blockscout.com'

  const els = {
    tbody: document.getElementById('rows'),
    state: document.getElementById('table-state'),
    search: document.getElementById('search'),
    seg: document.getElementById('class-filter'),
    count: document.getElementById('result-count'),
    statTokens: document.getElementById('stat-tokens'),
    statStocks: document.getElementById('stat-stocks'),
    statMemes: document.getElementById('stat-memes'),
    statBlock: document.getElementById('stat-block'),
    statEth: document.getElementById('stat-eth'),
    version: document.getElementById('list-version'),
    updated: document.getElementById('list-updated'),
    drawer: document.getElementById('drawer'),
  }

  let list = null
  let activeClass = 'all'
  let query = ''

  /* ------------------------------------------------------------ data load */

  async function loadList() {
    try {
      const response = await fetch('./tokenlist.json', { cache: 'no-cache' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      // file:// fallback: the refresh script mirrors the list into a JS global.
      if (window.__TOKENLIST__) return window.__TOKENLIST__
      throw error
    }
  }

  /* ------------------------------------------------------------- RPC utils */

  // The public RPC occasionally emits a malformed duplicate CORS header that
  // browsers reject; a short retry rides it out, and callers degrade
  // gracefully when all attempts fail.
  async function rpcRequest(method, params, tries = 3) {
    let lastError
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const response = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        const body = await response.json()
        if (body.error) throw new Error(body.error.message)
        return body.result
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
    throw lastError
  }

  function ethCall(to, data) {
    return rpcRequest('eth_call', [{ to, data }, 'latest'])
  }

  async function blockNumber() {
    return parseInt(await rpcRequest('eth_blockNumber', []), 16)
  }

  // latestRoundData() -> answer (word 1), scaled by feed decimals.
  async function feedPrice(feed, decimals) {
    const result = await ethCall(feed, '0xfeaf968c')
    const answer = BigInt('0x' + result.slice(2 + 64, 2 + 128))
    return Number(answer) / 10 ** decimals
  }

  const usd = (value) =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 10 ? 4 : 2 })

  /* -------------------------------------------------------------- rendering */

  const CLASS_LABEL = {
    'stock-token': 'Stock Token',
    memecoin: 'Memecoin',
    stablecoin: 'Stablecoin',
    'wrapped-native': 'Wrapped ETH',
  }
  const CLASS_BADGE = {
    'stock-token': 'stock',
    memecoin: 'memecoin',
    stablecoin: 'stablecoin',
    'wrapped-native': 'wnative',
  }

  function visibleTokens() {
    const q = query.trim().toLowerCase()
    return list.tokens.filter((token) => {
      if (activeClass !== 'all' && token.extensions.assetClass !== activeClass) return false
      if (!q) return true
      return (
        token.symbol.toLowerCase().includes(q) ||
        token.name.toLowerCase().includes(q) ||
        token.address.toLowerCase().includes(q)
      )
    })
  }

  function logoSrc(token) {
    // Self-hosted logos live next to this page; strip the absolute Pages prefix
    // so the directory also works locally and on forks.
    const file = token.logoURI.split('/logos/')[1]
    return `./logos/${file}`
  }

  function render() {
    const tokens = visibleTokens()
    els.count.textContent = `${tokens.length} of ${list.tokens.length} tokens`
    els.tbody.replaceChildren()

    if (tokens.length === 0) {
      els.state.hidden = false
      els.state.className = 'state'
      els.state.innerHTML =
        '<strong>No tokens match</strong>Try a different ticker, name, or address, or clear the class filter.'
      return
    }
    els.state.hidden = true

    const fragment = document.createDocumentFragment()
    for (const token of tokens) {
      const tr = document.createElement('tr')
      tr.tabIndex = 0
      tr.setAttribute('role', 'button')
      tr.setAttribute('aria-label', `${token.symbol} details`)

      const klass = token.extensions.assetClass
      tr.innerHTML = `
        <td>
          <span class="tok">
            <img src="${logoSrc(token)}" alt="" loading="lazy" width="32" height="32">
            <span><span class="sym">${token.symbol}</span><br><span class="nm">${escapeHtml(token.name)}</span></span>
          </span>
        </td>
        <td><span class="badge ${CLASS_BADGE[klass]}">${CLASS_LABEL[klass]}</span></td>
        <td class="addr">${token.address.slice(0, 8)}…${token.address.slice(-6)}</td>
        <td class="feed-cell">${
          token.extensions.chainlinkFeed
            ? '<span class="px" data-feed>·</span>'
            : '<span class="none">no feed</span>'
        }</td>`
      tr.addEventListener('click', () => openDrawer(token))
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openDrawer(token)
        }
      })
      fragment.appendChild(tr)
      if (token.extensions.chainlinkFeed) {
        queuePriceCell(tr.querySelector('[data-feed]'), token)
      }
    }
    els.tbody.appendChild(fragment)
  }

  /* Lazy price loading: only fetch feeds for rows near the viewport, a few
     at a time, so the public RPC is never hammered. */
  const priceCache = new Map()
  let priceQueue = []
  let draining = false

  function queuePriceCell(cell, token) {
    const cached = priceCache.get(token.address)
    if (cached != null) {
      cell.textContent = usd(cached)
      return
    }
    priceQueue.push({ cell, token })
    if (!draining) drainPrices()
  }

  async function drainPrices() {
    draining = true
    while (priceQueue.length > 0) {
      const batch = priceQueue.splice(0, 4)
      await Promise.all(
        batch.map(async ({ cell, token }) => {
          try {
            const price = await feedPrice(token.extensions.chainlinkFeed, token.extensions.chainlinkFeedDecimals || 8)
            priceCache.set(token.address, price)
            if (cell.isConnected) cell.textContent = usd(price)
          } catch {
            if (cell.isConnected) cell.textContent = '·'
          }
        }),
      )
    }
    draining = false
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  }

  /* ---------------------------------------------------------------- drawer */

  function openDrawer(token) {
    const ext = token.extensions
    const rows = [
      ['Address', `<code>${token.address}</code> <a href="${EXPLORER}/token/${token.address}" target="_blank" rel="noopener">Blockscout ↗</a>`],
      ['Class', CLASS_LABEL[ext.assetClass]],
      ['Decimals', String(token.decimals)],
    ]
    if (ext.chainlinkFeed) rows.push(['Chainlink feed', `<code>${ext.chainlinkFeed}</code>`])
    if (ext.supportsUiMultiplier) rows.push(['uiMultiplier', 'ERC-8056 supported: raw balance times uiMultiplier() equals true position'])
    if (ext.launchpad) rows.push(['Launchpad', ext.launchpad === 'noxa' ? 'NOXA' : 'The Odyssey'])
    if (ext.uniswapV3Pool) rows.push(['Uniswap v3 pool', `<code>${ext.uniswapV3Pool}</code> (${(ext.uniswapV3PoolFee / 10000).toFixed(2)}% tier)`])
    if (ext.launchBlock) rows.push(['Launch block', String(ext.launchBlock)])
    if (ext.eligibility) rows.push(['Eligibility', '<a href="./criteria.html#eligibility">Not for US persons ↗</a>'])

    els.drawer.querySelector('.panel').innerHTML = `
      <button class="close" aria-label="Close details">✕</button>
      <div class="head">
        <img src="${logoSrc(token)}" alt="">
        <div><h2>${token.symbol}</h2><div class="nm">${escapeHtml(token.name)}</div></div>
      </div>
      ${ext.chainlinkFeed ? '<div class="live-price"><div class="l">Live Chainlink price</div><div class="v" id="drawer-price">loading…</div></div>' : ''}
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`

    els.drawer.dataset.open = 'true'
    els.drawer.querySelector('.close').focus()
    els.drawer.querySelector('.close').addEventListener('click', closeDrawer)

    if (ext.chainlinkFeed) {
      feedPrice(ext.chainlinkFeed, ext.chainlinkFeedDecimals || 8)
        .then((price) => {
          const el = document.getElementById('drawer-price')
          if (el) el.textContent = usd(price)
        })
        .catch(() => {
          const el = document.getElementById('drawer-price')
          if (el) {
            el.textContent = 'feed unreachable, try again shortly'
            el.className = 'v err'
          }
        })
    }
  }

  function closeDrawer() {
    els.drawer.dataset.open = 'false'
  }

  els.drawer.querySelector('.scrim').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer()
    if (event.key === '/' && document.activeElement !== els.search) {
      event.preventDefault()
      els.search.focus()
    }
  })

  /* --------------------------------------------------------------- controls */

  let searchTimer
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      query = els.search.value
      render()
    }, 120)
  })

  els.seg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-class]')
    if (!button) return
    activeClass = button.dataset.class
    for (const b of els.seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button))
    render()
  })

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    try {
      list = await loadList()
    } catch (error) {
      els.state.hidden = false
      els.state.className = 'state error'
      els.state.innerHTML = `<strong>Could not load tokenlist.json</strong>${escapeHtml(String(error.message || error))}<div class="hint">Opening this page from the filesystem? Serve the folder instead: <code>npx serve docs</code></div>`
      return
    }

    const stocks = list.tokens.filter((t) => t.extensions.assetClass === 'stock-token').length
    const memes = list.tokens.filter((t) => t.extensions.assetClass === 'memecoin').length
    els.statTokens.textContent = String(list.tokens.length)
    els.statStocks.textContent = String(stocks)
    els.statMemes.textContent = String(memes)
    els.version.textContent = `v${list.version.major}.${list.version.minor}.${list.version.patch}`
    els.updated.textContent = new Date(list.timestamp).toISOString().slice(0, 10)
    render()

    // Live chain data: block height ticker + ETH price. Non-fatal if offline.
    try {
      const weth = list.tokens.find((t) => t.symbol === 'WETH')
      const [height, eth] = await Promise.all([
        blockNumber(),
        weth?.extensions.chainlinkFeed ? feedPrice(weth.extensions.chainlinkFeed, 8) : null,
      ])
      els.statBlock.textContent = height.toLocaleString('en-US')
      if (eth) els.statEth.textContent = usd(eth)
      setInterval(async () => {
        try {
          els.statBlock.textContent = (await blockNumber()).toLocaleString('en-US')
        } catch { /* keep last value */ }
      }, 15000)
    } catch {
      els.statBlock.textContent = 'offline'
      els.statEth.textContent = '·'
    }
  }

  boot()
})()
