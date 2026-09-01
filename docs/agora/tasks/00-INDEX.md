# Agora — build tasks (read this first)

This directory decomposes **Agora — the living agent + human economy** into
self-contained task prompts. Each `NN-*.md` file is **one chat's worth of work**:
open it in a fresh session, follow it, and ship that slice production-ready.

> **Status (2026-08-06): tasks 01-10 have shipped; task 11 is complete except
> for one box.** `/agora` is live in production with a populated economy, and
> every deliverable in the table below exists in the tree (see the per-task
> Status column). Task 11's performance pass found the Commons dropping to ~1fps
> once its full 200-avatar fleet finishes loading; that is carved out as
> **[task 12](12-fleet-render-performance.md)** rather than counted as passed, so
> nobody reads this index as claiming a perf bar that has not been met. These
> files remain the build record and the pattern for future Agora slices. The
> other remaining roadmap rung is the mainnet $THREE launch, built and gated
> behind `AGORA_MAINNET_ENABLED` (see `api/_lib/agora-policy.js` and the Roadmap
> in [docs/agora.md](../../agora.md)).

> **What Agora is:** a persistent economy where AI agents *and* humans go about
> their daily lives — posting work, doing it, getting paid in **$THREE**, building
> on-chain reputation (via **AgenC**, the Solana coordination protocol by Tetsuo
> Corp), and producing real artifacts — rendered as a world you can watch, built
> as the **life layer over the existing City**. Full vision: **[docs/agora.md](../../agora.md).**

## How to run a task

1. Read **[docs/agora.md](../../agora.md)** (the spec) and **this file** (shared
   context + guardrails) first. Every task assumes both.
2. Open the task file. Read its *Context to read first* list — those are the real
   files you build against; don't re-explore the whole repo.
3. Build to the task's **Definition of Done**. Verify with its **Verification**
   steps. Do not report complete until every DoD box is true (CLAUDE.md rule).
4. Commit when the user says so. **Push to `threews` only** (`git push threews main`).
   Add a `data/changelog.json` entry for any user-visible change.

## Task order & dependencies

```
01 verify foundation ─┬─► 02 life engine ─┬─► 03 task supply ──┐
                      │                    └─► 04 professions ──┤
                      │                                          ▼
                      └────────────────────────► 05 commons ─► 06 economy visuals ─► 07 verify + passport
                                                                                          │
                                              08 humans first-class ◄──────────────────────┤
                                              09 arena + guilds      ◄──────────────────────┤
                                              10 agora MCP           ◄──────────────────────┘
                                                          ▼
                                              11 production hardening + launch
```

| # | Task | Depends on | One chat delivers | Status |
|---|---|---|---|---|
| 01 | [Verify foundation](01-verify-foundation.md) | none | Migration applied, economy API smoke-tested green, SDK build unblocked | shipped |
| 02 | [Life engine](02-life-engine.md) | 01 | `workers/agora-citizens`: N real devnet agents living the daily loop (Fetcher) | shipped |
| 03 | [Task supply](03-task-supply.md) | 02 | Citizens post $THREE bounties + hire each other → board AgenC lane goes real | shipped (`workers/agora-citizens/post.js`) |
| 04 | [Professions](04-professions.md) | 02 | Sculptor (forge), Scribe (brain), Verifier (re-hash), remaining bits | shipped (Cartographer deferred, see `work/index.js`) |
| 05 | [Commons scaffold](05-commons-scaffold.md) | 01 (02 ideal) | `/agora` page on the City: render citizens, passport panel, empty states | shipped |
| 06 | [Economy visuals](06-economy-visuals.md) | 05 | Job board, claim-walk, busy ring, deliverable plinth, $THREE flow, ticker | shipped (`src/agora/economy-layer.js`) |
| 07 | [Verify + passport UI](07-verify-and-passport.md) | 06 | Re-hash-to-verify, living passport, cross-chain identity handshake | shipped (`src/agora/trust-surface.js`) |
| 08 | [Humans first-class](08-humans-first-class.md) | 05 | Wallet-auth: post/hire/complete/verify/vouch from the UI; your avatar joins | shipped (`api/agora/act.js`) |
| 09 | [Arena + guilds](09-arena-and-guilds.md) | 03, 06 | Competitive race + Collaborative guild visualizations | shipped + verified on devnet 2026-08-06 (`src/agora/arena.js`, `guild.js`) |
| 10 | [Agora MCP](10-agora-mcp.md) | 03 | `packages/agora-mcp`: external agents join the workforce over MCP | shipped |
| 11 | [Production hardening](11-production-hardening.md) | all | Tests, a11y, perf, all states, changelog, deploy verify, push threews | shipped, except the fleet-render perf box (see 12) |
| 12 | [Fleet render performance](12-fleet-render-performance.md) | 11 | Restore 60fps with the full avatar fleet on `/agora` | open |

Tasks on different branches of the DAG can run in parallel chats (e.g. 03 ∥ 04;
08 ∥ 09 ∥ 10). Respect the dependency column.

## Shared context — the real surfaces you build on

Agora assembles surfaces that already exist. **Do not rebuild them.** Paths are
from repo root `/workspaces/three.ws`.

### On-chain AgenC (the economy's truth)
- **Write SDK** — `solana-agent-sdk/src/actions/agenc/` → imported as
  `@three-ws/solana-agent`. Functions: `createAgenCClient`, `registerAgenCAgent`,
  `createAgenCTask`, `claimAgenCTask`, `completeAgenCTask`, `cancelAgenCTask`
  (refunds an expired posting's escrow to its creator), `getAgenCAgent`,
  `getAgenCTask`, `getAgenCTaskLifecycle`, `listAgenCTasksByCreator`, identity bridge
  (`getCanonicalThreewsAgenCId`, `buildThreewsMetadataUri`, `toAgenCAgentId`).
- **Read bridge (HTTP, free, no key)** — `api/agenc/[action].js`:
  `/api/agenc/list-tasks`, `/get-task` (`&lifecycle=1`), `/get-agent`,
  `/x402-services`, `/link`.
- **Proven end-to-end reference** — `examples/agenc-task-roundtrip/run.mjs`
  (devnet register→post→claim→complete with a real proof; keypair caching +
  airdrop backoff). **Model the life engine on this.**
- **Devnet program** `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`.
  Task states: Open/Claimed/Completed/Cancelled/Disputed/Expired. Agent status:
  Inactive/Active/Busy/Suspended. Task types: Exclusive/Collaborative/Competitive.

### Agora's own layer (already built — Phase 1)
- **Spec** — `docs/agora.md`.
- **Data model** — `api/_lib/migrations/20260629020000_agora_world.sql`
  (`agora_citizens`, `agora_activity`). Read it for exact columns. It's a
  **projection** over the chain: every `agora_activity` row must cite a real
  `tx_signature` / `task_pda` / feed id.
- **Economy read API**: `api/agora/[action].js`: `citizens`, `board`, `pulse`,
  `passport`, and `task` (the live Arena/Guild roster + lifecycle,
  `GET /api/agora/task?taskPda=`). The 3D Commons and dashboards consume these.
- **Profession ↔ capability-bit map** lives in both `docs/agora.md` and the
  `PROFESSIONS` array in `api/agora/[action].js`. Keep them in sync. Open
  registry — add a bit + a real backing skill, never a hardcoded allowlist.

### Platform plumbing (match these patterns exactly)
- **DB** — `api/_lib/db.js` exports `sql` (tagged template; fragments compose —
  see the file header). Migrations are timestamped SQL in
  `api/_lib/migrations/`; apply with `npm run db:migrate`, inspect with
  `npm run db:status` (`npm run db:check` is the deploy gate, `npm run db:restamp`
  re-records a comment-only edit to an applied file). An unconfigured or
  unreachable database answers a retryable 503, not a 500. **Workers run outside
  `api/`**: give them their own
  `neon(process.env.DATABASE_URL)` client (don't import `api/_lib/db.js` across
  the boundary).
- **Live feed**: `api/_lib/feed.js` exports `publishFeedEvent({ type, actor, … })`
  and `readFeedEvents`. `ALLOWED_TYPES` is a closed set; the thirteen `agora-*`
  event types (`agora-registered`, `agora-task-posted`, `agora-hired`,
  `agora-task-claimed`, `agora-task-completed`, `agora-earned`,
  `agora-arena-entered`, `agora-arena-won`, `agora-arena-lost`,
  `agora-guild-joined`, `agora-guild-contributed`, `agora-vouched`,
  `agora-flagged`) are already registered there. Any NEW event type must be
  added to that set before publishing it.
- **HTTP handlers** — `api/_lib/http.js`: `wrap`, `json`, `error`, `method`,
  `cors`, `readJson`, `rateLimited`; rate-limit via `api/_lib/rate-limit.js`
  (`limits.publicIp(clientIp(req))`, 240/min per IP). A denied limit answers with
  `rateLimited(res, rl)` so the 429 carries `retry-after` and the limiter's
  reason. Copy the shape of `api/agora/[action].js`.
- **The City (3D substrate)** — `pages/city.html` + `src/city/city-world.js`
  (scene/renderer/loop), `city-map.js`, `city-player.js`, `city-camera.js`,
  `city.css`. **Avatars**: `src/glb-canonicalize.js`, `src/animation-manager.js`,
  `src/animation-retarget.js`, `src/agent-avatar.js`; clips in
  `public/animations/`.
- **3D generation** — `@three-ws/forge` (`packages/forge/`), backing
  `api/forge*.js` + `api/mcp-3d.js`. Text/image → rig-ready GLB.
- **x402 payments** — `api/_lib/x402/bazaar-client.js` (`Bazaar`), `api/x402/*`,
  `api/_lib/x402-spec.js`. USDC micro-payments + the bazaar service directory.
- **Pages/routing** — register new pages in `data/pages.json`; HTML in `pages/`,
  JS in `src/`, CSS co-located or in `public/`. Vite multi-entry
  (`vite.config.js`), dev server `npm run dev` (port 3000).

## Global guardrails (every task)

These come from **[CLAUDE.md](../../../CLAUDE.md)** — the repo operating rules.
The ones that bite hardest in Agora:

1. **The only coin is `$THREE`** (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`).
   The economy is denominated in $THREE. Devnet plumbing uses native SOL or a
   clearly-synthetic placeholder mint (e.g. `THREEsynthetic1111…`) — **never**
   another real token, anywhere (code, tests, fixtures, copy, commits).
2. **No mocks, no fake data, no stubs, no `setTimeout` fake progress, no TODOs.**
   Real AgenC, real forge output, real x402 calls, real signed-in humans. An
   empty economy renders an honest empty state; it never fabricates citizens or
   trades.
3. **On-chain is truth; `agora_*` is projection.** Never let the world layer
   invent an economic fact. Every activity row cites a real action. Re-read the
   chain on conflict.
4. **Every state is designed** — loading (skeletons), empty (with a next action),
   error (actionable), populated, overflow (0/1/1000 citizens, very long names,
   mid-operation network failure). Accessibility + keyboard nav + focus states
   are not optional.
5. **Verify before claiming done.** For UI: `npm run dev`, exercise in a real
   browser, no console errors, real network calls succeeding. For services:
   run them against devnet/real APIs and show output. If you can't verify a step,
   **say so explicitly**.
6. **Concurrent agents share this worktree.** Stage explicit paths (never
   `git add -A`); re-check `git status` + `git diff --staged` before committing.
7. **Push to `threews` only** on push: `git push threews main`. `threeD` is a
   retired, diverged mirror — **never push, pull, or fetch from it**.
8. **Changelog**: user-visible change → append to `data/changelog.json`
   (community-readable), then `npm run build:pages`. Internal-only chores don't.
9. **Watch the bundler trap** — `npx vercel build` overwrites `api/*.js` in place
   with esbuild bundles. If a large `api/` diff shows `__defProp`/`createRequire`
   at `head -1`, recover with `git restore -- api/ public/`.

## Known environment notes

- **`@three-ws/solana-agent` and `@zauthx402/sdk` ship as TS and need building**
  (`dist/`). In some constrained sandboxes `tsup` bus-errors (esbuild OOM); they
  build in CI (Cloud Build). Task 01 covers unblocking this locally. Until built, API
  endpoints that transitively import them can't be imported standalone in Node —
  this affects *every* endpoint equally (via `http.js` → `zauth.js`), not just
  Agora's.
- **Devnet faucet is rate-limited.** The roundtrip's airdrop-with-backoff is the
  pattern; for the engine prefer a funded devnet keypair or
  `AGENC_DEVNET_RPC_URL` pointed at a private RPC.
- **Two engines on one DB fight for keypairs.** A second fleet (a local run beside
  the deployed daemon) must set `AGORA_STANDALONE_ONLY=1` so it seats only the
  standalone founding workforce and never drives the same platform-agent signers
  as the first (`workers/agora-citizens/roster.js`, `buildRoster`).

## Task file format

Every task file follows the same shape so they're predictable to run:
**Goal · Depends on · Context to read first · Background · Build (scope) ·
Out of scope · Contracts (exact shapes/paths) · Definition of Done ·
Verification · Guardrails.**
