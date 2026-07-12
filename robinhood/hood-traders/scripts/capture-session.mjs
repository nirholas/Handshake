#!/usr/bin/env node
// Captures a real fleet session from a running dashboard API into
// docs/session.json — the data docs/index.html's "captured paper session"
// section renders. Not fake data: every field is read straight from the live
// dashboard's /api/summary, /api/agents, and per-agent /journal endpoints.
//
// Usage: node scripts/capture-session.mjs [--port 4670] [--started <ms epoch>]

import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const port = arg('port', '4670')
const base = `http://localhost:${port}`

async function get(path) {
  const res = await fetch(`${base}${path}`)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

const summary = await get('/api/summary')
const agents = await get('/api/agents')
const allJournals = (
  await Promise.all(agents.map((a) => get(`/api/agents/${encodeURIComponent(a.id)}/journal`)))
).flat()

const startedAt = Number(arg('started', summary.startedAt))
const now = Date.now()
const durationMinutes = Math.round(((now - startedAt) / 60000) * 10) / 10

const trades = agents.reduce((s, a) => s + a.trades, 0)
const refusals = agents.reduce((s, a) => s + a.refusals, 0)
const totalTicks = agents.reduce((s, a) => s + a.ticks, 0)

// A representative excerpt: prefer trades/refusals/alerts over routine observe noise, newest first.
const excerpt = allJournals
  .filter((j) => j.kind !== 'observe' || !/rate limit|too many requests/i.test(j.detail))
  .sort((a, b) => b.ts - a.ts)
  .slice(0, 40)

const session = {
  capturedAt: now,
  network: summary.network,
  mode: summary.mode,
  durationMinutes,
  agents: agents.length,
  totalTicks,
  trades,
  refusals,
  equityUsd: summary.equityUsd,
  realizedUsd: summary.realizedUsd,
  openValueUsd: summary.openValueUsd,
  perAgent: agents.map((a) => ({ id: a.id, strategy: a.strategy, ticks: a.ticks, trades: a.trades, refusals: a.refusals, lastError: a.lastError })),
  journalExcerpt: excerpt,
}

writeFileSync('docs/session.json', JSON.stringify(session, null, 2))
console.log(`captured ${durationMinutes}min session -> docs/session.json`)
console.log(JSON.stringify({ durationMinutes, totalTicks, trades, refusals, agents: agents.length }, null, 2))
