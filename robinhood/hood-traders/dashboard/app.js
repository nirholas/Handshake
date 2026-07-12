// hood-traders dashboard — vanilla JS, no build step, polls the fleet API.

const POLL_MS = 4000
const openJournals = new Set()

function fmtUsd(n) {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

function fmtAgo(ts) {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

async function api(path, opts) {
  const res = await fetch(path, opts)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

function sparkline(points) {
  if (!points || points.length < 2) {
    return `<div class="no-positions">not enough equity history yet</div>`
  }
  const vals = points.map((p) => p.equityUsd)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1
  const w = 300
  const h = 44
  const step = w / (points.length - 1)
  const coords = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
  const last = vals[vals.length - 1]
  const first = vals[0]
  const color = last >= first ? '#34d399' : '#f87171'
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="${color}" stroke-width="2" points="${coords.join(' ')}" />
  </svg>`
}

function renderSummary(summary) {
  const el = document.getElementById('summary')
  const tiles = [
    ['Equity', fmtUsd(summary.equityUsd), summary.equityUsd >= 0 ? 'pos' : 'neg'],
    ['Realized PnL', fmtUsd(summary.realizedUsd), summary.realizedUsd >= 0 ? 'pos' : 'neg'],
    ['Open value', fmtUsd(summary.openValueUsd), ''],
    ['Fleet spend today', `${fmtUsd(summary.fleetSpentTodayUsd)} / ${fmtUsd(summary.fleetMaxDailySpendUsdg)}`, ''],
    ['Agents', String(summary.agents), ''],
  ]
  el.innerHTML = tiles
    .map(
      ([label, value, cls]) => `
    <div class="stat-tile">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${cls}">${value}</div>
    </div>`,
    )
    .join('')

  document.getElementById('mode-badge').textContent = summary.mode === 'live' ? '● LIVE' : '◆ PAPER'
  document.getElementById('mode-badge').className = `badge ${summary.mode}`
  document.getElementById('network-label').textContent = summary.network === 'testnet' ? 'testnet 46630' : 'mainnet 4663'

  const killedBadge = document.getElementById('killed-badge')
  killedBadge.hidden = !summary.killed
  if (summary.killed) killedBadge.textContent = `⛔ killed: ${summary.killReason ?? 'unknown'}`

  const killBtn = document.getElementById('kill-btn')
  killBtn.disabled = summary.killed
  killBtn.textContent = summary.killed ? '⛔ Halted' : '⏻ Kill switch'
}

function renderAgentCard(agent, journal, equity) {
  const statusClass = agent.killed ? 'killed' : agent.running ? 'running' : ''
  const isOpen = openJournals.has(agent.id)

  const positionsHtml = agent.positions.length
    ? agent.positions
        .map((p) => {
          const pnl = p.markUsd !== null && p.investedUsd > 0 ? (p.markUsd / p.investedUsd - 1) * 100 : null
          const pnlStr = pnl === null ? '' : ` · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`
          return `<div class="position-row"><span>${p.tokenSymbol}</span><span>${fmtUsd(p.markUsd ?? p.investedUsd)}${pnlStr}</span></div>`
        })
        .join('')
    : `<div class="no-positions">no open positions</div>`

  const journalHtml = journal.length
    ? journal
        .slice(0, 40)
        .map(
          (j) => `<div class="journal-row kind-${j.kind}"><span class="journal-time">${fmtTime(j.ts)}</span>${escapeHtml(j.detail)}</div>`,
        )
        .join('')
    : `<div class="journal-row kind-observe">no decisions journaled yet</div>`

  const errorHtml = agent.lastError
    ? `<div class="error-banner">⚠ ${escapeHtml(agent.lastError)}</div>`
    : ''

  return `
  <div class="agent-card">
    <div class="agent-head">
      <span class="agent-name">${agent.id}</span>
      <span><span class="status-dot ${statusClass} ${agent.running && !agent.killed ? 'live-pulse' : ''}"></span></span>
    </div>
    <div class="agent-strategy">${agent.strategy} · tick ${agent.ticks} · last ${fmtAgo(agent.lastTickAt)}</div>

    <div class="mini-chart">${sparkline(equity)}</div>

    <div class="agent-metrics">
      <div class="metric"><div class="metric-label">Equity</div><div class="metric-value">${fmtUsd(agent.equityUsd)}</div></div>
      <div class="metric"><div class="metric-label">Realized</div><div class="metric-value">${fmtUsd(agent.realizedUsd)}</div></div>
      <div class="metric"><div class="metric-label">Spent today</div><div class="metric-value">${fmtUsd(agent.spentTodayUsd)} / ${fmtUsd(agent.limits.maxDailySpendUsdg)}</div></div>
      <div class="metric"><div class="metric-label">Trades / refused</div><div class="metric-value">${agent.trades} / ${agent.refusals}</div></div>
    </div>

    <div class="positions-list">${positionsHtml}</div>

    <button class="journal-toggle" data-agent="${agent.id}" aria-expanded="${isOpen}">
      ${isOpen ? '▾' : '▸'} Decision journal (why each trade fired)
    </button>
    <div class="journal-list ${isOpen ? 'open' : ''}">${journalHtml}</div>
    ${errorHtml}
  </div>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function renderFleetTrades(trades) {
  const el = document.getElementById('fleet-trades')
  if (!trades.length) {
    el.innerHTML = `<div class="state-block">
      <div class="state-icon">📭</div>
      <div class="state-title">No trades yet</div>
      <div class="state-detail">The fleet is observing live market data. Trades will appear here the moment a strategy's risk-checked intent executes.</div>
    </div>`
    return
  }
  el.innerHTML = `<div class="agent-card">${trades
    .slice(0, 30)
    .map(
      (t) =>
        `<div class="journal-row kind-trade"><span class="journal-time">${fmtTime(t.ts)}</span>${t.agentId} ${t.side} ${t.tokenSymbol} — ${escapeHtml(t.reason)}${t.txHash ? ` <a href="#" title="${t.txHash}">↗ tx</a>` : ' (paper)'}</div>`,
    )
    .join('')}</div>`
}

async function refresh() {
  try {
    const [summary, agents, trades] = await Promise.all([
      api('/api/summary'),
      api('/api/agents'),
      api('/api/trades'),
    ])
    renderSummary(summary)

    const agentsEl = document.getElementById('agents')
    if (!agents.length) {
      agentsEl.innerHTML = `<div class="state-block">
        <div class="state-icon">🤖</div>
        <div class="state-title">No agents configured</div>
        <div class="state-detail">Add agents in src/main.ts and restart the fleet.</div>
      </div>`
    } else {
      const withDetail = await Promise.all(
        agents.map(async (a) => {
          const [journal, equity] = await Promise.all([
            api(`/api/agents/${encodeURIComponent(a.id)}/journal`).catch(() => []),
            api(`/api/agents/${encodeURIComponent(a.id)}/equity`).catch(() => []),
          ])
          return renderAgentCard(a, journal, equity)
        }),
      )
      agentsEl.innerHTML = withDetail.join('')
      agentsEl.querySelectorAll('.journal-toggle').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.agent
          if (openJournals.has(id)) openJournals.delete(id)
          else openJournals.add(id)
          refresh()
        })
      })
    }

    renderFleetTrades(trades)
  } catch (err) {
    document.getElementById('summary').innerHTML = `<div class="state-block" style="grid-column: 1 / -1">
      <div class="state-icon">⚠</div>
      <div class="state-title">Can't reach the fleet API</div>
      <div class="state-detail">${escapeHtml(err.message)} — is the hood-traders process running?</div>
    </div>`
  }
}

document.getElementById('kill-btn').addEventListener('click', async () => {
  if (!confirm('Trip the global kill switch? This halts all new orders across every agent immediately and cannot be undone for this process.')) return
  await api('/api/kill', { method: 'POST' })
  refresh()
})

refresh()
setInterval(refresh, POLL_MS)
