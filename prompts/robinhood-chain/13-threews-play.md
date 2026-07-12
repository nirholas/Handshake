# 13 — three.ws integration: /play worlds for Robinhood Chain coins

Read `prompts/robinhood-chain/_shared.md` first. Wave 3. MODIFIES THE three.ws APP — commit gate
applies: build in the working tree, do NOT commit.

## Mission
Port the /play formula — "every pump.fun coin gets a deterministic 3D world you walk into as
your avatar, with live trades animating the space" — to Robinhood Chain coins. Study the
existing implementation FIRST (the /play feature pages, `multiplayer/` rooms, the pump.fun feed
plumbing, `three-ws-pump-fun:reactive` skill wiring) and reuse its architecture wholesale; this
prompt adds a chain, not a new engine.

## Deliverables

1. **Firehose service** — the PumpPortal-equivalent for chain 4663 (nothing like it exists;
   this is also sellable later): a worker (`workers/robinhood-feed/` following existing worker
   conventions, with README) that consumes `wss://feed.mainnet.chain.robinhood.com` + RPC logs
   and emits normalized events — `launch` (NOXA/Odyssey creations), `trade` (launchpad +
   Uniswap swaps for tracked coins), `graduation` — over an internal WS/SSE endpoint with the
   same shape our pump feed consumers expect (map fields 1:1 where semantics align; document
   divergences). Reconnect + gap-fill; SOL-price-style shared USD conversion for ETH/USDG.
2. **World generation** — deterministic 3D world per Robinhood Chain coin, seeded by its
   address (reuse the existing deterministic world-gen path for pump coins; same visual system,
   new chain-flavored palette/skybox variant so RH-chain worlds are recognizably distinct —
   subtle, tasteful, no Robinhood trademark assets/branding).
3. **/play surface** — Robinhood Chain coins appear in the /play lobby (own filter/tab beside
   pump.fun coins), each with its world route; in-world: live trade events animate the space
   exactly like pump worlds (holders chat, trades ripple), and the coin's stats HUD reads from
   the prompt-12 API endpoints. Multiplayer via the existing `multiplayer/` room system.
4. **Stretch (build if the core lands solid, else document as next):** Stock Token "trading
   floors" — one ambient world per ticker driven by the live Chainlink tape + DEX trades
   (display-only, no purchase, no geo issue). AAPL's floor at 2am Saturday is the screenshot.
5. **Docs + changelog + pages.json + STRUCTURE.md** per the Documentation rules; lobby rate
   limiting uses the dedicated bucket pattern (429-starvation lesson), and mind the /walk
   WebGL-context-exhaustion lesson if embedding world previews in the lobby.

## Requirements
- CLAUDE.md Definition of Done in full — dev server, real browser, zero console errors, all
  states designed. E2E: join a Robinhood coin world locally and observe REAL live trades
  animating it (pick an active coin; capture the session in the report). Multiplayer smoke:
  two clients, one room.
- The firehose worker runs standalone (`npm start` with env-documented config) and has its own
  tests (event normalization against captured real feed frames — capture during your run).
- Do not regress pump.fun worlds: existing /play tests stay green; shared code changes get a
  test.

## Done checklist
- [ ] Firehose worker: live session evidence (event counts by type over ≥ 10 min).
- [ ] A Robinhood coin world joinable locally, animated by real trades; lobby tab wired.
- [ ] Existing /play + `npm test` green. pages.json/changelog/STRUCTURE/docs updated.
- [ ] NOTHING committed. Report: files changed, deploy steps (worker + Scheduler/Run), stretch status.
