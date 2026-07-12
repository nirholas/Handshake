# 16 — Alert bots: `hood-alerts` (Telegram + Discord)

Read `prompts/robinhood-chain/_shared.md` first. Wave 3: requires core SDK; use hoodkit streams
and the hood-api service if present (check `robinhood/`), else SDK directly — note what you used.

## Mission
Build `robinhood/hood-alerts/` — the alert layer for Robinhood Chain: Telegram and Discord bots
plus the shared alert engine. $560M/day of memecoin volume and zero alert tooling exists; in
every prior ecosystem the alert bot is the most-shared product. Free tier broad, premium tier
paid. This is a hosted service product (Cloud Run), not just a library.

## Deliverables

1. **Alert engine** (`src/engine/`) — one stream-consumer, many subscribers:
   - Event detectors: new launch (with launchpad + initial metrics), graduation, whale trade
     (configurable USD threshold, per-token or chain-wide), price move (±% over window),
     new-holder-count milestones, Stock Token premium/discount crossing a threshold (the arb
     alert — unique to us), liquidity pulls (LP removal > X% — a rug early-warning).
   - Dedup, per-subscriber rate limiting, quiet hours, batching (digest mode).
   - Persistence: SQLite (subscriptions, delivery log, dedup state); clean adapter seam for
     Postgres.
2. **Telegram bot** (grammY) — `/watch <token|launches|whales|premiums>`, `/unwatch`, `/list`,
   `/threshold`, `/digest on|off`, inline token cards (price, chart link to three.ws markets
   page from prompt 12, Blockscout link). Group-chat support with admin-only config.
3. **Discord bot** (discord.js) — same feature set via slash commands + rich embeds; per-channel
   subscriptions.
4. **Premium tier** — free: 3 subscriptions, 60s minimum granularity. Premium: unlimited,
   real-time, premium-arb + rug-warning detectors. Payment: x402 USDC deep-link flow via the
   existing three.ws x402 stack OR hood402 USDG if built — implement ONE for real end-to-end
   (payment → entitlement flip → premium delivery), document the other as configurable.
   Entitlements in the DB with expiry.
5. **Ops** — Dockerfile, single process runs engine + both bots (env-gated), `/healthz`,
   graceful shutdown, structured logs. Deploy docs (Cloud Run + Scheduler-less; it's a
   long-running service — min-instances 1). Deploy for real only if creds present.

## Requirements
- Bot UX bar: every command has helpful replies, unknown-command help, designed empty states
  ("you watch nothing yet — try /watch launches"). No raw JSON at users, ever.
- Vitest: detector logic on captured real event streams (capture during build), dedup/rate
  limit, entitlement state machine.
- E2E: run both bots with REAL bot tokens you create (throwaway bot accounts — document names
  in the report), subscribe a real test chat, capture ≥ 3 real alerts fired from live chain
  activity (screenshots/transcript in report). Real payment E2E for the premium flow on the
  cheapest real rail available (document the path taken and its cost).
- `docs/` static site per `_shared.md`: landing = real alert screenshots + live "what would
  have alerted in the last hour" feed rendered client-side from public data, command
  reference for both platforms, premium pricing page, self-host guide.

## Done checklist
- [ ] Real alerts received in a real Telegram chat AND Discord channel (evidence in report).
- [ ] Premium purchase → entitlement → premium alert proven once for real.
- [ ] Detector + entitlement tests green; `docker build` clean.
- [ ] Report: bot handles created, deploy status, owner actions (prod bot identity, hosting).
