# OWNER-ACTIONS: every human touchpoint on the road to 100%, batched

This file exists so no agent ever parks a task on an owner dependency, and so the owner can
clear every gate in one sitting instead of drip-feeding across sessions. Agents: when a work
order leaves an owner-only remainder, add a row here (and keep the detail in the owning
pack's file or brief; a row is a pointer, not an essay). When the owner clears a row, delete
it and, if that unblocks a work order, say which one in the owning pack's `production-100-PROGRESS.md`.

Rows carry the date they were added so staleness is visible. Re-verify a row before acting
on it; some resolve themselves as other work lands.

## Open rows (re-verified 2026-09-01; the 2026-08-09 set is folded in below)

| # | Action | Size | Unblocks | Detail lives in |
|---|---|---|---|---|
| 1 | Approve the production deploy (or say "get production working", which is itself the approval). Production is at `ad7b54c16` (2026-08-28), 107 commits behind `main`; seven declared routes 404 live until it lands, and the home-screen widget's PNG card and token endpoint are in the gap. | one yes | Nearly everything user-visible in the map | [01-ship-readiness.md](production-100-01-ship-readiness.md) |
| 2 | Fund the settle sponsor wallet `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`. Healthz reports `x402_settle` down with `cause: sponsor_floor` and the sniper worker out of capital (0.2307 SOL to refill its wallets); no config change moves either. | ~1 SOL | x402 settle recovery, backlog 01 retirement, sniper | [../backlog/PROGRESS.md](backlog-PROGRESS.md), 2026-08-02 and 2026-09-01 entries |
| 3 | Decide the stranded customer funds: two customers hold about 0.35 SOL behind the retired encryption key and cannot withdraw. Credit, contact, or write off. The brief that was meant to carry the numbers (`docs/ops/stranded-wallets.md`) does not exist yet; order 02 writes it. | decision | Closing the support obligation | [02-stranded-wallet-reclaim.md](production-100-02-stranded-wallet-reclaim.md), [../backlog/PROGRESS.md](backlog-PROGRESS.md) |
| 4 | Rotate or explicitly accept the economy master wallet key, which was set as plaintext service env alongside its Secret Manager copy. Order 03 writes the runbook section; the config change itself needs a live `gcloud` (row 15). | decision (+ one fund move if rotating) | 03 closeout | [03-master-key-hygiene.md](production-100-03-master-key-hygiene.md), `docs/ops/gcp-production.md` 2026-07-09 entry |
| 5 | Accept the Anthropic terms in Vertex Model Garden for `aerial-vehicle-466722-p5`, then an agent flips `VERTEX_CLAUDE_ENABLED=1` after a live probe. | minutes | First-party Claude lane | `docs/ops/llm-lanes.md` |
| 6 | Either reactivate OpenAI billing or approve dropping the key; every OpenAI rung is a dead attempt in the chain. Also: OpenRouter fallback key #1 is revoked and still burns a rung; fund the OpenRouter platform key or stay `:free`-only. | minutes | LLM chain latency | `docs/ops/llm-lanes.md` |
| 7 | Mint an R2 "Admin Read and Write" token scoped to the storage bucket, put it in `.env.local`, so `scripts/set-r2-cors.mjs` can apply the CORS policy at the origin. | minutes | backlog 05 retirement, `ISSUES.md` item 9 | [../backlog/05-r2-bucket-cors.md](backlog-05-r2-bucket-cors.md) |
| 8 | Refresh the GitHub PAT (classic, `public_repo`); the stored one returns Bad credentials. Blocks one docs push in a sibling repo. | minutes | backlog 09 residue | [../backlog/00-INDEX.md](backlog-00-INDEX.md), order 09 |
| 9 | Generate a NEW testnet deployer key for backlog 07 and fund it via the public faucet (reCAPTCHA-gated), then say yes to the broadcast. The key generated on 2026-08-02 no longer exists on this machine (`contracts/.env` is gone) and its address holds nothing; funding it would strand the tokens. | minutes + one yes | backlog 07 retirement | [../backlog/00-INDEX.md](backlog-00-INDEX.md), order 07 |
| 10 | The marketplace-listing pack needs its email OTP as `claude@three.ws` for two reads (the approval status of the listing resubmitted on chain 2026-08-27, and the chat-bot session), plus buyer-wallet funding for the real-payment gauntlet and an AI-provider key on the chat-bot service, whose Cloud Run deploy is also owner-gated (it has never reported a heartbeat). | minutes + funding | The pack's orders 04, 07, 08 and backlog 08 | that pack's `RUNBOOK.md` and `e2e-evidence/FUNDING-REQUEST.md` |
| 11 | Clear the commit gate for the backlog orders whose diffs reference third-party projects (07 through 10), per the CLAUDE.md coin rule, if that work should land in history. | one yes each | backlog 07 to 10 commits | [../backlog/00-INDEX.md](backlog-00-INDEX.md) |
| 12 | Multiplayer scale decision: the world service is a pinned single instance with a measured 400-concurrent ceiling and no autoscale (room affinity needs Redis first). Decide whether to fund or approve the Redis-backed scale-out. | decision | quality-bar 03 scope | [../event/PROGRESS.md](event-PROGRESS.md), preflight residuals |
| 13 | Decide how to close out the 2026-08-09 community event. Re-measured 2026-09-02 and the picture changed: the world server was never redeployed with the event build, so there were no quest runs, no leaderboard writes and no souvenir grants at all, and there is no list to settle from. The countdown, the `/event` page and the in-world meetup layer did run. Options: re-run the event now that the server-side code is live on production, settle from nothing and close it out publicly, or hold. Two reads that would overturn this finding are in row 15. | decision | event 08 closeout | [PROGRESS.md](event-PROGRESS.md), 2026-09-02 entry |
| 14 | Clear the commit gate for the 2026-09-01 retirement batch: three verified-shipped or superseded work-order files, plus the doc lines that cite them, whose content names other crypto projects (backlog 10; the marketplace pack's order 05, superseded by 08 with its resubmission confirmed on chain; the retired second-chain-venue pack's three context files, whose facts are duplicated in that venue's READMEs). The agent report of that date lists the exact paths and the referrer lines to rewrite. | one yes | Those deletions and the stale doc lines | [PROGRESS.md](production-100-PROGRESS.md), 2026-09-01 entry |
| 15 | Re-authenticate `gcloud` in this workspace (`gcloud auth login`); token refresh fails non-interactively, and so does application-default. Blocks the Cloud Scheduler comparison (fix-queue 03), the master-key config change (03), row 18, and every fleet check in quality-bar 03. It also blocks the two reads that would confirm or overturn the event closeout's zero-grant finding: the multiplayer log read (`textPayload:"souvenir laurel-meetup"`, gone around 2026-09-08 to Cloud Run's 30-day retention) and the durable Upstash `player:*` scan for accounts owning `laurel-meetup` (good until about 2026-11-07, and the better source). Both queries are written out in the event pack's 2026-09-02 entry. | minutes | fix-queue 03, 03, 13, 18, quality-bar 03 | CLAUDE.md self-unblock playbook, [PROGRESS.md](event-PROGRESS.md) |
| 16 | Create the `three-ws` GitHub organization and `three-ws/examples` (public), then run the push command `npm run export:satellites` prints. The export stages 70 files offline today; the repo does not exist. | minutes | roadmap developer-resources retirement | [../roadmap/developer-resources-repos.md](roadmap-developer-resources-repos.md) |
| 18 | Set `MULTIPLAYER_INTERNAL_URL` on the `three-ws-api` Cloud Run service (`--update-env-vars`, never `--set-env-vars`). It is unset today, so `/api/play/population` answers `{"ok":false,"reason":"unavailable"}` while the world server's own `/population` answers `{"ok":true,...}` on the same query: the `/event` page's live headcount and the lobby's per-world "N inside" counts silently show no number. Needs row 15 first. | one command | The live headcount on `/event` and the `/play` lobby | [PROGRESS.md](event-PROGRESS.md), 2026-09-02 entry |
| 17 | Apple Developer account for the WidgetKit extension (home-screen widget task 4) and, separately, publish the Android 1.1.0 build (versionCode 2) to Play. | account + minutes | roadmap native-widgets task 4 and its release | [../roadmap/native-widgets.md](roadmap-native-widgets.md) |

Deleted 2026-09-01: the former row 5 (`WALLET_ENCRYPTION_KEY_PREVIOUS` policy), which
declared itself "delete on reading" and had outlived that by three weeks.

## How agents use this file

- Add a row the moment an owner-only remainder appears; never end a session holding one
  silently.
- Never convert a row back into a mid-task question. The work order routes around the gap
  and finishes everything else; the row waits here.
- Keep rows honest: if you discover a row's premise no longer holds, fix or delete it and
  note why in [PROGRESS.md](production-100-PROGRESS.md).
