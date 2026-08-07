# Event readiness: prompt pack

Twenty-four self-contained agent prompts to get three.ws, and especially the /play world, to 100% before the event. Files 01-10 audit and fix what exists; files 11-16 build new event features; files 17-24 build new capabilities, things players can DO in the virtual world, by wiring in subsystems that are already built but unreachable from /play. Each file is a complete prompt: paste it into a fresh Claude Code session (or hand it to a subagent) and it runs end to end, fixing or building, then reporting.

Suggested order and parallelism (audits):

| # | Prompt | Surface | Can run in parallel with |
|---|--------|---------|--------------------------|
| 1 | [01-play-first-impression.md](01-play-first-impression.md) | /play load, intro, onboarding UX | 4, 5, 7, 8 |
| 2 | [02-play-mobile.md](02-play-mobile.md) | /play on phones (stability + touch) | 7, 8 |
| 3 | [03-play-performance.md](03-play-performance.md) | /play load weight, FPS, memory | 7, 8 |
| 4 | [04-play-multiplayer-net.md](04-play-multiplayer-net.md) | WebSocket, reconnects, voice, crowd | 1, 5 |
| 5 | [05-play-economy-loops.md](05-play-economy-loops.md) | Store, bank, wheel, combat, quests, cosmetics | 1, 4 |
| 6 | [06-play-auth-errors.md](06-play-auth-errors.md) | Sign-in, gates, error/empty states, console | after 1 |
| 7 | [07-platform-smoke-sweep.md](07-platform-smoke-sweep.md) | Every page on the live site | 1, 2, 3 |
| 8 | [08-api-production-health.md](08-api-production-health.md) | Cloud Run, crons, logs, DB, x402 | 1, 2, 3 |
| 9 | [09-accessibility-i18n.md](09-accessibility-i18n.md) | Keyboard, ARIA, contrast, translations | after 1 |
| 10 | [10-event-day-runbook.md](10-event-day-runbook.md) | Pre-scale, monitoring loop, rollback | last, after all fixes deploy |

Feature builds (run after audits 1-3 land, or in parallel if staffed; 12, 14, and 16 interlink but each stands alone):

| # | Prompt | Builds | Depends on |
|---|--------|--------|------------|
| 11 | [11-event-live-ops.md](11-event-live-ops.md) | Operator broadcast, go-live moment, live event config | nothing |
| 12 | [12-photo-mode-share.md](12-photo-mode-share.md) | Photo mode with branded one-tap share | nothing |
| 13 | [13-event-quests-leaderboard.md](13-event-quests-leaderboard.md) | Time-boxed quest line + live leaderboard + cosmetic reward | nothing (better with 12) |
| 14 | [14-welcome-concierge.md](14-welcome-concierge.md) | Greeter NPC, guided tour, event-aware opening line | nothing |
| 15 | [15-live-hype-feed.md](15-live-hype-feed.md) | Activity ticker + market hype moments | nothing (better with 13) |
| 16 | [16-invite-flow.md](16-invite-flow.md) | Invite sheet, QR, OG card truth, arrival continuity | nothing (better with 14) |

Capability builds (17-24): each wires an existing, finished subsystem into the world or adds a missing social primitive. All stand alone; the noted pairings just make them better together.

| # | Prompt | Builds | Wires in / pairs with |
|---|--------|--------|-----------------------|
| 17 | [17-plaza-live-show.md](17-plaza-live-show.md) | Live hosted show on a plaza stage, with $THREE tips | StageRoom + ShowDirector (built, unreachable from /play) |
| 18 | [18-coin-wars-portal.md](18-coin-wars-portal.md) | In-world Coin Wars portal: standings, queue, spectate | ClashRoom + war standings (built, arena-page only) |
| 19 | [19-forge-props-live.md](19-forge-props-live.md) | Text-to-3D prop generation inside build mode | Forge lane + the networked prop pipeline |
| 20 | [20-world-chat-scrollback.md](20-world-chat-scrollback.md) | Chat scrollback for late joiners + community-feed bridge | the WalkRoom relay + api/community/messages |
| 21 | [21-party-system.md](21-party-system.md) | Parties: form, see, reach, and talk to your crew | friends/presence stack; pairs with 13, 16 |
| 22 | [22-venue-projector-mode.md](22-venue-projector-mode.md) | Broadcast spectator view for the venue big screen | camera rig + event.json; pairs with 15, 16, 17 |
| 23 | [23-signature-wall.md](23-signature-wall.md) | Persistent signature wall, the event's artifact | world-persist patterns + name safety |
| 24 | [24-dance-off.md](24-dance-off.md) | Judged dance-off rounds with crowd voting and tips | dance floor beat + King of the Totem round machine |

Rules that apply to every prompt in this pack:

- The canonical test URL for the world is the $THREE community: `https://three.ws/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three&image=%2Fapi%2Fimg%3Furl%3Dhttps%253A%252F%252Fipfs.io%252Fipfs%252Fbafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q%26seed%3DFeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`
- Fix what you find. Do not produce a findings report and stop; the report is what you fixed plus what genuinely cannot be fixed in-session and why.
- Verify locally with `npm run dev` (port 3000) plus the named audit scripts before claiming done. `npm test` must stay green.
- Commit finished work promptly with explicit paths (concurrent agents share this worktree; never `git add -A`).
- Deploys stay owner-gated. Prepare everything so shipping is one command (`npm run deploy:gcp:full`), then say so in the report.
