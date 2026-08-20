# Plan: ship Oracle and the autonomous trading agents as MCP servers

**Status:** planned, not started. Written 2026-08-19.
**Goal:** make [Oracle](https://three.ws/oracle) and the autonomous trading agents first-class,
discoverable MCP servers, publish them to the official MCP registry
(`registry.modelcontextprotocol.io`), document them, and announce them in one plain-language X post.

This document is the build order. Everything in "What already exists" was verified against the
tree and the live registry on 2026-08-19, so the plan starts from facts, not assumptions.

---

## Why this is worth doing

Oracle is the best thing we run and almost nobody can find it from an agent client.

Its four MCP tools (`oracle_top_plays`, `oracle_coin`, `oracle_arm_watch`, `oracle_watch_status`)
live inside the main `https://three.ws/api/mcp` server, buried among 40+ avatar, model, animation,
sign-language, memory, and market tools. In the registry that server is listed as
"3D avatars, embeds, glTF tools, agent memory, and on-chain agent identity". An agent looking for
a conviction signal on a new launch has no way to find it, and a human browsing the registry has
no reason to click.

The same is true of the autonomous side. `oracle_arm_watch` is the single most interesting write
tool on the platform (it arms an agent to trade a live conviction stream inside a spend leash), and
it is discoverable only by reading a 40-tool list on an avatar server.

The fix is not new capability. It is **packaging**: two focused servers, named for what they do,
listed under their own registry entries.

---

## What already exists (verified 2026-08-19)

### Oracle

| Layer | Location | State |
|---|---|---|
| Conviction engine | `api/_lib/oracle/` + `conviction-model.json` | Live, fitted model, AUC 0.879 on holdout |
| Public API | `api/oracle/*.js` (26 endpoints) | Live: `feed`, `coin`, `signal`, `stats`, `backtest`, `calibration`, `leaderboard`, `wins`, `movers`, `categories`, `search`, `history`, `market`, `social`, `trades`, `wallet`, `watch`, `agent-stats`, `action-stream`, `activity`, `follow`, `batch`, `stream`, and more |
| Pages | `/oracle`, `/oracle/docs`, `/oracle/arm` (in `data/pages.json`) | Live |
| Reference doc | `docs/oracle.md` | Complete, long-form |
| MCP tools | `api/_mcp/tools/oracle.js`, 4 tools | Live, but only inside the main server |
| Dedicated MCP server | none | **This is the gap** |

### Autonomous trading agents

| Surface | Location | Registry state |
|---|---|---|
| Sniper engine (library + CLI + MCP + x402 API) | `packages/agent-sniper`, `workers/agent-sniper` | `io.github.nirholas/agent-sniper` @ 0.1.5 published; local `server.json` is 0.1.6, so a bump is pending |
| Autopilot control plane | `packages/autopilot-mcp` | `io.github.nirholas/autopilot-mcp` @ 0.2.0 published |
| Copy-trade follows | `packages/copy-mcp` | published @ 0.1.1 |
| Signal marketplace | `packages/signals-mcp` | published @ 0.1.1 |
| Portfolio + PnL | `packages/portfolio-mcp` | published @ 0.1.1 |
| Market intel | `packages/intel-mcp`, `packages/kol-mcp` | published |
| Oracle-armed agent loop | `api/oracle/watch.js`, `api/oracle/action-stream.js`, `api/oracle/agent-stats.js` | **No dedicated server. Only the two tools inside `/api/mcp`.** |

61 distinct servers are already published under the `io.github.nirholas` namespace, so the
publishing path is proven and boring. `scripts/publish-mcp-servers.mjs` (`npm run publish:mcp`)
handles npm plus registry, idempotently, and skips anything already at the target version.

### The publishing machinery (already built, do not rebuild)

- `scripts/publish-mcp-servers.mjs`: npm publish, then registry publish, per server. Auth resolves
  `MCP_REGISTRY_TOKEN`, then the owner's GitHub PAT from git config or `~/.git-credentials`, then
  `GITHUB_TOKEN`.
- `npm run audit:mcp` / `audit:mcp-golden` / `audit:mcp-safety` / `audit:mcp-catalog`: manifest,
  golden-transcript, safety-annotation, and catalog checks. All four are in `npm run gate`.
- `npm run smoke:mcp`: hits the hosted remotes for real.
- `public/.well-known/mcp.json`: the hand-maintained hosted-server directory (7 entries today).
- `public/mcp-catalog.json` + `/mcp-tools` page: the human-facing catalog, built by
  `scripts/build-mcp-catalog.mjs`.

---

## The plan

Five phases. Phases 1 and 2 are independent and can run in parallel; 3 depends on both; 4 and 5
close it out.

### Phase 1: `@three-ws/oracle-mcp` and the hosted Oracle remote

Two faces of one server, mirroring the pattern already used for 3D Studio
(`packages/*` stdio package plus `api/mcp-3d.js` remote plus `server-3d.json`).

**1a. Hosted remote: `api/mcp-oracle.js` + `server-oracle.json`**

Copy the structure of `api/mcp-3d.js` exactly: Streamable HTTP, shared OAuth/x402 plumbing from
`api/_mcp/auth.js` and `api/_mcp/payments.js`, per-IP rate limits, SSE on GET, terminate on DELETE.
Registry name `io.github.nirholas/threews-oracle`, URL `https://three.ws/api/mcp-oracle`.

Route it in `vercel.json` (both the handler entry and the
`/api/mcp-oracle/.well-known/oauth-protected-resource` route, matching the `/api/mcp` precedent at
`vercel.json:525`), and add the entry to `public/.well-known/mcp.json`.

**1b. stdio package: `packages/oracle-mcp`**

Read-only, public, no key, no signer, no payment, over the live public API. This is the one people
will actually install, so it has to be free and instant. Model it on `packages/intel-mcp`, which is
already exactly this shape.

**Tool surface (both faces).** The four existing tools stay, and the rest are thin wrappers over
endpoints that are already live and public:

| Tool | Backing endpoint | Auth |
|---|---|---|
| `oracle_getting_started` | local, static | free |
| `oracle_top_plays` | `/api/oracle/signal` | free |
| `oracle_coin` | `/api/oracle/coin`, `/api/oracle/signal?mint=` | free |
| `oracle_feed` | `/api/oracle/feed` | free |
| `oracle_search` | `/api/oracle/search` | free |
| `oracle_movers` | `/api/oracle/movers` | free |
| `oracle_wins` | `/api/oracle/wins` | free |
| `oracle_backtest` | `/api/oracle/backtest` | free |
| `oracle_calibration` | `/api/oracle/calibration` | free |
| `oracle_leaderboard` | `/api/oracle/leaderboard` | free |
| `oracle_wallet` | `/api/oracle/wallet` | free |
| `oracle_stats` | `/api/oracle/stats` | free |
| `oracle_arm_watch` | `POST /api/oracle/watch` | account-scoped (hosted remote only) |
| `oracle_watch_status` | `GET /api/oracle/watch` | account-scoped (hosted remote only) |

The two write tools ship on the hosted remote only. The stdio package advertises them as
"available on the hosted server" in its getting-started text rather than shipping a half-wired
auth path locally.

**Honesty requirements, non-negotiable, already enforced by the existing tests in
`tests/api/mcp-oracle-tools.test.js`:** a degraded feed or intel store reports as transient, never
as an empty market, and an unknown coin is distinguished from an outage. Any new tool inherits
that rule and gets a case in that test file.

**Backwards compatibility:** the four tools stay in the main `/api/mcp` catalog. Nothing that works
today stops working. `api/_mcp/tools/oracle.js` becomes the shared definition both catalogs import.

### Phase 2: `@three-ws/agent-trader-mcp`, the autonomous trading control plane

One server that answers "arm my agent on Oracle, then show me what it did and let me stop it."
Today that story is split across `oracle_arm_watch`, the sniper package, autopilot, and the
portfolio server, so no single entry in the registry tells it.

Registry name `io.github.nirholas/threews-agent-trader`, npm `@three-ws/agent-trader-mcp`, stdio,
authenticated with a three.ws API key. Model it on `packages/autopilot-mcp`, which already has the
right posture for a write-heavy, real-money server.

| Tool | Backing surface | Kind |
|---|---|---|
| `trader_getting_started` | local, static | free |
| `agent_arm` | `POST /api/oracle/watch` | write, guarded |
| `agent_disarm` | `POST /api/oracle/watch` (`armed:false`) | write, the kill switch |
| `agent_status` | `GET /api/oracle/watch` | read |
| `agent_actions` | `/api/oracle/action-stream`, `/api/oracle/activity` | read |
| `agent_performance` | `/api/oracle/agent-stats` | read |
| `agent_positions` | portfolio API | read |
| `agent_guardrails` | agent guards / spend-envelope API | write, guarded |

**Safety posture, copied from `packages/autopilot-mcp` because it is correct:**

- `mode` defaults to `simulate`. Live spend is opt-in, per call, never sticky by accident.
- Every boundary (scopes, per-trade SOL, daily SOL cap, max open positions) is enforced
  server-side. The MCP server cannot widen a leash the backend refuses.
- `agent_disarm` is documented as the kill switch and must work with only an agent id, no other
  arguments, because that is what someone types when something is going wrong.
- The `README` and `server.json` description both say, in the first two lines, that this server can
  move real SOL.
- Arming live still routes through the platform's existing owner-confirmation path. This server
  does not become a way around the spend gate in `CLAUDE.md`.

### Phase 3: publish to the registry

Nothing new to build here. In order:

```bash
npm run audit:mcp            # manifest validation
npm run audit:mcp-safety     # tool annotation / safety audit
npm run audit:mcp-golden     # golden transcripts
npm run audit:mcp-catalog    # catalog is in sync
npm run test:mcp             # every MCP server's own tests
npm run publish:mcp:dry      # report exactly what would publish, publish nothing
npm run publish:mcp          # npm, then registry, idempotent
npm run smoke:mcp            # hit the hosted remotes for real
```

Also in this phase, because they are one-line fixes that are currently drifted:

- Bump `packages/agent-sniper` to publish 0.1.6 (registry has 0.1.5, the tree has 0.1.6).
- Add both new remotes to `public/.well-known/mcp.json` (7 entries today, 8 after Phase 1).
- Add both new server keys to the `SERVERS` array in `scripts/publish-mcp-servers.mjs`. A server
  that is not in that array is invisible to the publisher, which is the single easiest way for
  this whole plan to silently ship nothing.

Verify after publishing:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=threews-oracle" | jq '.servers[].server.name'
```

### Phase 4: documentation

Per the documentation rules in `CLAUDE.md`, all of these apply and none are optional:

- `packages/oracle-mcp/README.md` and `packages/agent-trader-mcp/README.md`: what it does, install,
  full tool table, one runnable example each. Package README coverage is currently 100% and this
  plan must not be what breaks it.
- `docs/mcp.md`: update the server count (it currently says 44) and add both servers to the hosted
  and install-and-run lists.
- `docs/oracle.md`: expand the existing "the MCP path" section into a real quickstart with the new
  server name and a copy-pasteable client config.
- `docs/agent-trading-mcp.md`: new. The autonomous trading story end to end, linked from
  `docs/start-here.md`.
- `STRUCTURE.md`: rows for both new package directories.
- `data/pages.json`: only if a new public page lands. No new page is planned.
- `data/changelog.json`: one entry, tags `feature` and `sdk`. Holder-readable, no commit jargon.
  Something like "Oracle is now its own MCP server: any AI agent can pull live conviction scores,
  and arm a trading agent, without touching the website."

### Phase 5: the X post

Draft lives at [`docs/oracle-trading-mcp-x-post.md`](x-posts/oracle-trading-mcp-x-post.md). Written before
the work ships so the announcement shapes the scope rather than the reverse: if a claim in that
post is not true when the phases are done, the phases are not done.

Post it only after `npm run smoke:mcp` passes against the live remotes and both registry entries
resolve. Announcing an MCP server nobody can connect to is the one failure mode that costs more
than shipping late.

---

## Definition of done

- [ ] `https://three.ws/api/mcp-oracle` responds to `initialize` and `tools/list` unauthenticated.
- [ ] `npx @three-ws/oracle-mcp` connects from a clean machine with no key and returns a live score.
- [ ] `npx @three-ws/agent-trader-mcp` arms an agent in simulate mode and disarms it.
- [ ] Both servers resolve in `registry.modelcontextprotocol.io`.
- [ ] `npm run gate` passes (all four MCP audits are inside it).
- [ ] `npm run smoke:mcp` passes.
- [ ] Every doc in Phase 4 is written, and `npm run audit:docs` is clean.
- [ ] The changelog entry is in and `npm run build:pages` accepts it.
- [ ] The X post claims nothing that is not live.

## Risks and how they get handled

| Risk | Handling |
|---|---|
| Registry publish 403s on the wrong account | Known trap, documented in the publish script: the git PAT outranks `GITHUB_TOKEN` because a Codespace token can belong to a different account. If it 403s, check `npm whoami` and the PAT source before touching anything else. |
| Tool sprawl makes the new servers as unfindable as the old one | Hard cap: Oracle ships at most 14 tools, agent-trader at most 8. A tool that does not earn its place in the getting-started text does not ship. |
| Someone arms live spend from an MCP client by accident | `simulate` default, server-side leash, per-call opt-in, kill switch that takes one argument. Same posture as `packages/autopilot-mcp`. |
| The X post outruns the deploy | Post gated on `smoke:mcp` plus both registry lookups resolving. |
| The main `/api/mcp` server loses the Oracle tools in the refactor | The four tool definitions stay in `api/_mcp/tools/oracle.js` and both catalogs import them. `tests/api/mcp-oracle-tools.test.js` already covers them and must stay green. |
