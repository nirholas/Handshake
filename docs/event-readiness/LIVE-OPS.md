# LIVE-OPS: $THREE Community Day

One page. Everything an operator needs while the event is running, and nothing else.
Prepared 2026-08-08. Project `aerial-vehicle-466722-p5`, region `us-central1`.

---

## The link and the release

**Event URL** (the canonical $THREE world, from [README.md](README.md)):

```
https://three.ws/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three&image=%2Fapi%2Fimg%3Furl%3Dhttps%253A%252F%252Fipfs.io%252Fipfs%252Fbafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q%26seed%3DFeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
```

**Live release as of this writing:** `c1e600a04` on revision `three-ws-api-00364-n65`.
The world server runs an image built 2026-08-06 (revision `three-ws-multiplayer-00010-g89`).

> The release SHA above is NOT the event build. The event features (quest line,
> photo mode, live event board, `/event` landing page, operator announce, the
> `/population` endpoints) are committed but unshipped. See
> [Ship the release](#ship-the-release-owner-gated) at the bottom. Confirm the SHA
> with `curl -s https://three.ws/api/version` after the deploy and update this line.

---

## Health: three commands that prove the site is up

```bash
# 1. API alive, and which build is actually serving
curl -s https://three.ws/api/version

# 2. API subsystems (x402, monitor, speech, alerts) - status must be "ok"
curl -s https://three.ws/api/healthz | head -c 400

# 3. The world server itself. If this is not {"ok":true}, /play is dead
#    no matter what the site says.
curl -s https://three-ws-multiplayer-93741856042.us-central1.run.app/health
```

Continuous version, one terminal, quiet unless something changes:

```bash
npm run event:watch                  # every 30s
npm run event:watch -- --interval 15 # tighter during the opening rush
npm run event:watch -- --once        # single sweep; exit 1 if anything is down
```

It watches the API, the live release SHA, the `/play` page (including that the
game bootstrap is still in the HTML), the world server, and the live player
count. It is plain HTTPS on purpose: it keeps working when `gcloud` auth has
expired, which it does on its own schedule in this environment.

---

## Logs: two commands for fast triage

```bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"

# Errors across the whole fleet, last 6h
npm run logs:errors

# The world server specifically - join refusals, origin rejections, room churn
gcloud logging read 'resource.type="cloud_run_revision"
  resource.labels.service_name="three-ws-multiplayer" severity>=WARNING' \
  --freshness=1h --limit=50 --project aerial-vehicle-466722-p5
```

Deeper sweep when the cause is not obvious: `npm run triage:gcp:deep`.

---

## Rollback: pre-filled, per service

**These three revisions are the known-good pre-event state.** They are live right
now and all report Ready. After tomorrow's release deploy creates new revisions,
these are what you roll back TO.

```bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
R="--region us-central1 --project aerial-vehicle-466722-p5"

# API + frontend
gcloud run services update-traffic three-ws-api $R \
  --to-revisions=three-ws-api-00364-n65=100

# The /play world server (kicks everyone in-world; they auto-reconnect)
gcloud run services update-traffic three-ws-multiplayer $R \
  --to-revisions=three-ws-multiplayer-00010-g89=100

# Redis proxy (presence, durable builds)
gcloud run services update-traffic three-ws-redis-proxy $R \
  --to-revisions=three-ws-redis-proxy-00004-bwk=100
```

Then purge the edge or the CDN keeps serving the bad build:

```bash
npm run deploy:gcp:purge-cdn
```

Return to normal afterwards with `--to-latest` instead of `--to-revisions`.

**Rehearsal result (2026-08-08):** every target above exists and reports
`Ready=True` with 100% of traffic. Traffic was not actually shifted, because
shifting it and back is itself two world-server restarts on the eve of the event;
the commands are the same `update-traffic` calls that created the current
routing, and the revisions are the ones already serving.

---

## Scale: what is set, and how to raise it

Pre-scaled 2026-08-08 (config-only, pre-approved per
[docs/ops/gcp-credits-plan.md](../ops/gcp-credits-plan.md)):

| Service | min | max | concurrency | CPU / memory | changed from |
|---|---|---|---|---|---|
| `three-ws-api` | **6** | 100 | 160 | 2 / 4Gi | min was 2 |
| `three-ws-multiplayer` | 1 | **1 (hard)** | 1000 | **4 / 8Gi** | was 2 CPU / 4Gi |
| `three-ws-redis-proxy` | **3** | **10** | 80 | default | was min 2 / max 4 |

```bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
R="--region us-central1 --project aerial-vehicle-466722-p5"

# More API headroom (safe, instant)
gcloud run services update three-ws-api $R --min-instances=12 --max-instances=200

# More world-server headroom. NOTE: raise CPU/RAM or concurrency, never max-instances.
gcloud run services update three-ws-multiplayer $R --cpu=8 --memory=16Gi
gcloud run services update three-ws-multiplayer $R --concurrency=2000
```

**`three-ws-multiplayer` max-instances must stay 1.** Colyseus rooms live in one
process. A second instance is only correct when the room registry and presence
are shared through Redis *and* each instance is individually addressable so a
seat reservation lands on the box hosting the room. Cloud Run gives every
instance the same URL, so instance 2 would silently split players in the same
world into two invisible crowds. A Memorystore Redis exists
(`three-ws-redis`, `10.234.231.139:6379`) and `REDIS_URI` would switch the driver
on, but the addressability half is not solved and the eve of an event is not when
to find out. Use CPU, memory, and concurrency instead.

---

## Capacity: measured, not assumed

`npm run event:capacity -- --n 400 --ramp 45 --hold 150` against live production,
2026-08-08:

| | |
|---|---|
| requested / joined | 400 / 400 (100%) |
| held for the full 150s | 400 |
| join latency | p50 155ms · p95 219ms · max 388ms |
| mid-run drops | 0 |
| moves sent / state patches | 269,633 / 415,418 |
| verdict | PASS on all four thresholds |

The single world instance carried 400 concurrent players walking at 8 Hz with
zero drops. The known cliff is the concurrency ceiling: at 1000 simultaneous
connections Cloud Run wants a second instance and `max-instances=1` refuses it.
If the count approaches that, raise `--concurrency`, not `--max-instances`.

One caveat baked into the harness: at 400 clients its own event loop stalls, so
the page-latency figure it prints measures the machine running it, not the
origin. It now prints its own loop lag next to that number and says so. An idle
`curl` during the same run measured `/play` at a steady 420-490ms.

---

## Known failure modes and what to do

Audits 1-9 did not leave an accepted-risk register, so this is derived from the
code's own documented landmines plus what was measured on 2026-08-08.

| If this happens | Why | Do this |
|---|---|---|
| `/play` loads but nobody sees anyone else | World server restarted or a second instance appeared | `curl .../health`; confirm `max-instances=1`; rollback command above |
| Players kicked seconds after joining, phones only | Mobile memory kill, not a network fault | `node scripts/play-mobile-repro.mjs` reproduces it; it reads as bytes, not as a networking bug |
| `/walk` looks completely offline while `/play` works | Someone set `PLAY_GATE_MINT`/`THREE_MINT` on the world server. `/walk` sends no play pass, so every join throws `play_pass_required` (landmine documented in `multiplayer/src/rooms/WalkRoom.js`) | Unset it: `gcloud run services update three-ws-multiplayer $R --remove-env-vars=PLAY_GATE_MINT,THREE_MINT` |
| NPC / concierge replies slow or absent | Paid LLM tier is degraded today: OpenRouter `402 Payment Required`, OpenAI `429`. Vertex Gemini is healthy and the free-first chain leads, so players still get answers (measured 8-16s first token after live demotions) | Nothing during the event. Topping up OpenRouter is an owner spend decision |
| Wallet balances read as zero / holder tier collapses to Member | Helius and Alchemy are both `429` today. 6 free rungs plus the QuickNode reserve carry it (proven by poisoning the primary) | `npm run event:failover` to see which rungs are live now |
| Coin image missing on the event link or OG card | `4everland.io` gateway times out, `gateway.pinata.cloud` is slow (~4s). `api/img.js` races five gateways and takes the first valid one | Nothing. 4 of 5 gateways served the CID on 2026-08-08 |
| An x402 / boutique payment does not settle | `/api/healthz` shows 50,442 settle failures with `fee_runway_exhausted`. This is settle-floor starvation, which looks identical to "the wallets are dry" and has a different fix | Run the `x402-economy-triage` agent BEFORE concluding anything about wallet balances |
| A deploy dies at `npm ci` with "package.json and package-lock.json are not in sync" | Almost certainly NOT a dependency mistake. `FROM node:24-slim` floats, so a newer bundled npm resolves the tree differently and rejects an untouched lockfile. This took the 2026-08-08 release build down | The Dockerfile now pins `ARG NPM_VERSION`. If it recurs, compare `npm --version` locally against `docker run --rm node:24-slim npm --version` and set the pin to the version that produced the lockfile |
| Something breaks and nobody is told | Push alerting is thin. `TELEGRAM_ALERTS_CHAT_ID` is unset in production, so `/api/healthz` reports `telegram_push: "disabled"` and platform alerts land only in the `ops_alerts` table | Email now works: two uptime checks (site + world server) and two alert policies (uptime failure, `three-ws-api` 5xx rate) were created 2026-08-08 and page `nich@sperax.io`. Email is slow, so also keep `npm run event:watch` open on a screen |

---

## Talk to the whole world mid-event

`scripts/announce-play.mjs` pushes a message to every player standing in a live
world, right now. It is the host's microphone: use it to call each agenda beat,
to tell people where to go, and to say anything that cannot wait for chat to
scroll. Requires the world server to be running the event build (the endpoint is
`/internal/announce`; a 404 means the deploy below has not happened yet).

```bash
# Every live world, toast only
node scripts/announce-play.mjs "Totem showdown starts in 2 minutes. Get to the plaza."

# With a title: also raises the centre-screen banner for 12s
node scripts/announce-play.mjs \
  --title "Wheel hour" \
  --detail "Free spin at Fortune's Folly, prizes on every wedge" \
  "Wheel hour is open. Head to the plaza wheel."

# Only the $THREE world, and hold the banner 30s
node scripts/announce-play.mjs --coin FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump \
  --duration-ms 30000 --title "Fireworks" "Look up."
```

It prints how many rooms and players it reached, so `0 player(s)` is your cue
that nobody is in the world yet (or that you targeted the wrong coin). The
request is HMAC-signed with `MULTIPLAYER_SHARED_SECRET` (falling back to
`HOLDER_PASS_SECRET`, which is in `.env`), and the server rejects an unsigned or
stale call, so the endpoint is safe to leave exposed. Announcements ride the same
`notice` channel the game already uses, so they reach every connected client
regardless of which build the player loaded.

---

## Escalation: which tool for which subsystem

| Subsystem | Tool |
|---|---|
| x402 payments, settles, the ring, "wallets are dry" | `x402-economy-triage` agent. Do not diagnose by hand; settle-floor starvation and capital dispersion look the same from outside |
| Cloud Run, crons, logs, DB migrations, TLS, fleet readiness | `gcp-triage` skill, or `npm run triage:gcp:deep` |
| Phones dropping out of the world | `node scripts/play-mobile-repro.mjs` |
| Any page 404/500 across the site | `npm run smoke:prod` |
| A third-party provider suspected down | `npm run event:failover` |
| World capacity under a crowd | `npm run event:capacity -- --n <2x current peak>` |

---

## Ship the release (owner-gated)

Two services, two commands. Both need explicit owner approval.

```bash
# 1. API + frontend (26+ commits ahead of what is live)
npm run deploy:gcp:full

# 2. The world server - required for the event features and /population.
#    Its image predates every event commit.
cd multiplayer && ./deploy-cloudrun.sh
```

`deploy-cloudrun.sh` now defaults to `CPU=4 MEMORY=8Gi` so a redeploy cannot
silently undo the pre-scaling above. `gcloud run deploy` replaces resource limits
on every run, so a hotfix deploy with the old defaults would have halved the
world server's CPU mid-event.

After either deploy: `curl -s https://three.ws/api/version`, then
`npm run event:watch -- --once`, then update the release SHA at the top of this
page.

---

## Open items

1. **`TELEGRAM_ALERTS_CHAT_ID` exists nowhere** (not `.env`, not `.env.local`, not
   the Cloud Run service). Every alerting path in `api/_lib/alerts.js` is already
   wired behind it; it needs one private chat/DM id, which only the owner can
   create. Then:
   `gcloud run services update three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 --update-env-vars=TELEGRAM_ALERTS_CHAT_ID=<id>`
   (`--update-env-vars`, never `--set-env-vars`.) It must be a private chat: alerts
   carry stack traces, URLs, and IPs.
2. **Email alerting now exists; it did not before 2026-08-08.** Created that day
   and wired to the existing verified `nich@sperax.io` channel:

   - uptime check `three.ws API healthz` on `https://three.ws/api/healthz`
   - uptime check `three.ws world server` on the world server's `/health`
   - policy "Event: three.ws or the /play world server is DOWN" (uptime failing
     from more than 2 probe locations)
   - policy "Event: three-ws-api 5xx rate elevated" (5xx above 5/s for 5 minutes)

   Both policies link back to this page. Email is minutes-slow by nature, so it is
   the backstop, not the primary: `npm run event:watch` is the primary.

3. **The release build failed once on 2026-08-08** at the `npm ci` layer, root
   caused to the floating base image (see the failure-modes table). The Dockerfile
   pin is committed; the build has not been re-run since, so the release still
   needs a green build before the deploy commands above are known good.

4. **`gcloud` auth expires on its own schedule here.** It died mid-session
   (`invalid_grant: reauth related error (invalid_rapt)`) and was restored with
   `gcloud auth login --no-launch-browser`. Verify with a real call
   (`gcloud run services describe three-ws-api --region us-central1`), never with
   `gcloud auth list`, which reports an expired account as ACTIVE.
