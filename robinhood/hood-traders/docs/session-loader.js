// Loads a captured paper-session summary (session.json, written by
// `npm run test:e2e` / the 30-minute paper-mode soak run) and renders it.
// Designed-empty state when no session has been captured into docs/ yet.

function fmtUsd(n) {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function tile(label, value, cls = '') {
  return `<div class="stat-tile"><div class="stat-label">${label}</div><div class="stat-value ${cls}">${value}</div></div>`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function render() {
  const summaryEl = document.getElementById('session-summary')
  const journalEl = document.getElementById('session-journal')
  try {
    const res = await fetch('session.json', { cache: 'no-store' })
    if (!res.ok) throw new Error('no session.json yet')
    const s = await res.json()

    summaryEl.innerHTML = [
      tile('Mode', s.mode === 'live' ? 'LIVE' : 'PAPER'),
      tile('Duration', `${s.durationMinutes} min`),
      tile('Network', s.network),
      tile('Agents', String(s.agents)),
      tile('Trades executed', String(s.trades)),
      tile('Refusals (risk gate working)', String(s.refusals)),
      tile('Fleet equity', fmtUsd(s.equityUsd), s.equityUsd >= 0 ? 'pos' : 'neg'),
      tile('Captured', new Date(s.capturedAt).toUTCString()),
    ].join('')

    journalEl.innerHTML = (s.journalExcerpt || [])
      .map(
        (j) =>
          `<div class="journal-row kind-${j.kind}"><span class="journal-time">${new Date(j.ts).toLocaleTimeString('en-US', { hour12: false })}</span>${escapeHtml(j.detail)}</div>`,
      )
      .join('') || '<div class="state-block">No journal rows in this excerpt.</div>'
  } catch {
    summaryEl.innerHTML = `<div class="state-block">
      No captured session yet. Run <code>npm run test:e2e</code> (a ≥30-minute live-data paper
      soak, see <a href="architecture.html">Architecture</a>) and copy its <code>session.json</code>
      output into <code>docs/</code> to populate this section.
    </div>`
    journalEl.innerHTML = ''
  }
}

render()
