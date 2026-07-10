# Economy heartbeat (single-URL driver)

Every scheduled job on the platform — the circulation engine tick, the x402 seed
and autonomous loops, the ring settlement tick, the Labor Market, treasury
top-ups, payouts, sweeps, reconciliation — is an authed `/api/cron/*` endpoint.
The whole **agent-to-agent economy** comes down to a handful of them being hit
every minute. When nothing hits them, the economy flat-lines while the site keeps
serving traffic.

In production these endpoints are driven by **Google Cloud Scheduler** — one
job per `vercel.json` cron entry (~76 jobs), each firing `GET /api/cron/<name>`
with the `Authorization: Bearer $CRON_SECRET` header. (We do **not** use GitHub
Actions for any scheduling.)

The economy is still fanned out through a **single dispatcher endpoint** rather
than relying on every one of those jobs firing individually. That design
predates the Cloud Run migration — on the old Vercel host the platform's cron
count blew past Vercel's per-project scheduled-cron cap, so everything past the
cap was silently never scheduled and the economy only moved when a deploy
happened to nudge it. Collapsing the economy onto one endpoint made it drivable
by a single trigger from anywhere, and that property is still what makes it
robust: whatever the scheduler, the whole economy needs exactly one URL hit per
minute.

## The fix: one endpoint, one external trigger

`GET|POST /api/cron/economy-tick` ([api/cron/economy-tick.js](../api/cron/economy-tick.js))
is a single dispatcher that fans out — concurrently, with the same
`Authorization: Bearer $CRON_SECRET` header the scheduler sends — to every engine
that makes the economy move:

| Group | Endpoints | Drives |
| --- | --- | --- |
| Payments & x402 | `x402-ring-tick`, `x402-seed-cron`, `x402-autonomous-loop`, `x402-ring-leak-scan`, `wallets-leak-scan`, `run-distribute-payments`, `payment-session-sweep` | ring settlements, micropayment feed, catalog spend, leak scans, payout distribution |
| Money Pulse, Labor & delegation | `pulse-tick`, `/api/labor/tick`, `index-delegations` | live wallet-activity feed, bounty bids/awards/settlements, agent hiring/delegation |
| Coin launches (pump.fun) | `launcher-tick`, `launcher-claimer`, `coin-intel-observe`, `pumpfun-monitor`, `pumpfun-graduations-sync`, `run-coin-cycle`, `run-coin-payouts` | autonomous minting, fee claims, launch intel, graduation sync, coin lifecycle + payouts |
| Autonomous / copy / strategy trading | `copy-fanout`, `mirror-fanout`, `signal-fanout`, `strategy-fanout`, `run-dca` | copy trading, signal/strategy execution, DCA |
| Tips, payouts, subscriptions, royalties | `club-payouts`, `run-subscriptions`, `process-subscriptions`, `settle-royalties`, `cosmetic-splits-sweep` | tipping payouts, subscription billing, royalty + cosmetic-split settlement |
| $THREE buyback | `run-buyback`, `run-three-buyback` | revenue → buy → treasury (internally gated hourly/daily) |
| Funding, treasury & reconcile | `treasury-topup`, `treasury-autopilot`, `treasury-sweepback`, `economy-reconcile`, `reflect-sweep` | master-wallet funding root, treasury autopilot, tamper reconciliation |
| $THREE market & holders | `three-market-refresh`, `three-holders-snapshot` | live coin market + holder snapshots |

The snipers / autonomous trading experiment run as a **standalone always-on Cloud
Run worker** ([workers/agent-sniper/](../workers/agent-sniper)), not a scheduled
cron, so they are continuous and not part of this dispatch list.

Every target engine is internally idempotent — per-tick spend caps, per-endpoint
cooldowns, and daily ceilings absorb over-calling — so it is safe to fire
`economy-tick` every minute (or more often) regardless of each engine's native
cadence. The dispatcher never moves money itself; it only invokes the engines
that do, over their existing authenticated path. It returns a per-engine summary
(status + each engine's own skip reason) and a `502` only when **every** engine
fails (bad secret / origin down), so an external scheduler's own alerting catches
a real economy-wide outage.

## Driving it (pick one — none use GitHub)

The whole economy now needs exactly one thing: something hitting
`https://three.ws/api/cron/economy-tick` every minute with the cron bearer.

1. **External HTTP cron (fastest, zero infra).** A service like cron-job.org or
   EasyCron: URL `https://three.ws/api/cron/economy-tick`, interval 1 minute,
   add header `Authorization: Bearer <CRON_SECRET>`. Done in two minutes, no code.
2. **Upstash QStash (you already run Upstash Redis).** Register a schedule that
   POSTs the same URL every minute with the bearer header. Reliable, retried,
   dashboard-visible.
3. **Google Cloud Scheduler (production primary — no extra infra).** `economy-tick`
   is the `* * * * *` entry in the `crons` array in `vercel.json`, and the
   migration provisioned one Cloud Scheduler job per cron entry, so it fires every
   minute in production. Because it fans out to every engine above, even if a
   per-engine job is ever missing, the dispatcher still covers it. The external
   triggers (1) and (2) remain valid as redundant belt-and-suspenders.
4. **Always-on host.** `scripts/economy-heartbeat.mjs` still works as a
   long-running pinger on any small VM (Fly.io / Railway / a box):
   `CRON_SECRET=… node scripts/economy-heartbeat.mjs` reads `vercel.json` and
   fires every due cron each minute — not just the economy ones.

## Watching it — the public heartbeat status

Every tick parks its fan-out summary in the cache (`economy:last-tick`), and the
public status feed exposes it — no auth needed:

```bash
curl -s https://three.ws/api/status | jq .economy
```

- `tickedAt` / `stale` — when the last tick ran; `stale: true` (older than ~3
  minutes) means **the heartbeat itself is dead** (scheduler not firing), which
  used to be invisible from outside until the Money Pulse feed went quiet hours
  later.
- `fired` / `failed` — how many engines responded OK vs errored on that tick.
- `engines[]` — per-engine `label`, `ok`, `status`, and the engine's own
  `reason` when it skipped (e.g. `settle_unaffordable`, `disabled`, a treasury
  floor) — the cause, not just the symptom.

The same data renders as the **Agent economy heartbeat** section on
[/status](https://three.ws/status).

### The watchdog — you get paged, not surprised

The uptime cron ([api/cron/uptime-check.js](../api/cron/uptime-check.js), every
5 minutes) watches the economy as a system and escalates to the ops Telegram
channel (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERTS_CHAT_ID` — alerts silently
no-op if unset, so set them):

- **Heartbeat dead** — no economy-tick for 10+ minutes (the scheduler itself is
  broken; this was invisible for ~9 hours in the July 2026 stall).
- **Engine problems** — any engine failing (404/5xx/timeout) or skipping on an
  actionable reason (`disabled`, key parse failures, `db_at_storage_cap`,
  funding floors, `settle_unaffordable`, treasury-low, invalid config).
- **Money-feed silence** — no on-chain agent activity on `/api/pulse` for 90+
  minutes, the end-to-end signal that catches anything the per-engine checks
  miss.
- **Sniper worker dead** — the Cloud Run worker's `bot_heartbeat` row stale for
  10+ minutes (worker crashed, crash-looping, or zombied on dead DB writes;
  oracle scoring and all sniping stop with it). Surfaced as the `sniper`
  subsystem in `/api/status` and paged through the subsystem digest. The July
  2026 outage — heartbeat frozen 36 hours, `scored_24h` flat at 0, zero pages —
  is exactly this. The worker also carries its own dead-man switch now: if its
  heartbeat writes fail continuously for 15 minutes
  (`SNIPER_HEARTBEAT_SELF_HEAL_MS`, 0 disables), it exits so Cloud Run restarts
  it with fresh connections and freshly resolved secrets.

Escalation is streak-gated like the subsystem digest: page on first sight,
re-page hourly while the problem persists (so a stall can't hide behind one
deduped alert), and a single "RESOLVED" note when the economy is healthy again.
The watchdog also parks 24 hours of samples in `economy:history` — surfaced as
`economy.history` in `/api/status` — so you can see **when** a stall started,
not just that one exists.

## Manual / one-off

```bash
# Fire one economy tick by hand (server-side does the fan-out):
curl -sS https://three.ws/api/cron/economy-tick -H "Authorization: Bearer $CRON_SECRET"

# Drive ALL vercel.json crons from anywhere for 10 minutes (superset of the economy):
CRON_SECRET=… DURATION_MINUTES=10 node scripts/economy-heartbeat.mjs
```

## Safety properties

- **No new money paths.** `economy-tick` only calls the same authed cron
  endpoints the scheduler would. All spend caps, registry allowlists, and ledger
  recording live server-side and apply identically.
- **Over-calling is harmless.** Every engine enforces per-tick and daily caps and
  per-endpoint cooldowns, so a 1-minute trigger driving 5-minute engines just
  no-ops the extra calls.
- **Undeployed endpoints are tolerated.** A target missing from the deployed
  build reports `status: 404` and never stops the others.

Related: [circulation engine](circulation-engine.md) ·
[x402 ring economy](x402-ring-economy.md) ·
[economy funding root](economy-master.md) · [money map](money-map.md)
