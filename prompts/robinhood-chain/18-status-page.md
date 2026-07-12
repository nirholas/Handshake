# 18 — Chain status: `hood-status`

Read `prompts/robinhood-chain/_shared.md` first. Wave 2 (independent; core SDK optional).

## Mission
Build `robinhood/hood-status/` — the status page for Robinhood Chain. Nobody runs one; every
"is the chain down?" search should land here. Two pieces: a tiny probe worker (Cloud Run) and a
beautiful static front end (GitHub Pages) — with a degraded-but-useful mode where the Pages
site probes client-side if the worker is unreachable (never a dead status page).

## Deliverables

1. **Probe worker** (`worker/`) — every 30s, measure and persist (SQLite, rolling 90 days):
   - Public RPC + Alchemy (if key) latency/availability (`eth_blockNumber` round-trip).
   - Block production: height progression, blocks/min, detect stalls (100ms-block chain → a
     quiet minute is an incident).
   - Sequencer feed health: WS connect, message rate, lag vs RPC head.
   - Gas: base fee percentiles.
   - Blockscout API availability; bridge canonical contract activity heartbeat.
   - Chainlink feed freshness: sample 5 Stock Token feeds' `updatedAt` age (market-hours aware —
     document expected weekend behavior honestly rather than alarming on it).
   - Serves `GET /api/status` (current + incidents) and `GET /api/history?metric=…&window=…`
     JSON with CORS open. Incident detection = threshold rules, persisted with start/end.
2. **Status front end** (`docs/`, per `_shared.md`) — the classic status-page layout done
   beautifully: overall banner (operational/degraded/down), per-component rows with 90-day
   uptime bars, latency sparklines, live-updating current numbers, incident history. Reads the
   worker API; if unreachable, flips to client-side direct probing (RPC + feed from the
   browser) with a "direct probe mode" note — designed, not apologetic.
3. **Badges + embeds** — SVG status badge endpoint on the worker (`/badge.svg`) for READMEs
   (our other repos should adopt it — note this in the report), and an embeddable status
   snippet.
4. **Ops** — Dockerfile, Cloud Run deploy docs (min-instances 1), env table, data-retention
   note. Deploy for real if creds present.

## Requirements
- Honest thresholds: publish the rules (what counts as degraded/down) on a methodology page.
  No fake green — if a probe can't run, show unknown, not operational.
- Vitest: incident state machine (flap suppression, start/end edges), threshold rules, badge
  rendering. Integration: run the worker live ≥ 30 min and show real collected series.
- Front end works opened locally as static files (direct-probe mode proves it).
- Design bar: this page will be screenshot in outage threads — make the uptime bars and
  incident timeline genuinely beautiful in both themes.

## Done checklist
- [ ] 30+ min of real probe data collected; screenshots-worthy page rendering it locally.
- [ ] Direct-probe fallback proven by opening docs/ without the worker running.
- [ ] Incident machine tests green; badge renders; Docker builds.
- [ ] Report: deploy status, methodology summary, suggested badge adoption across our repos.
