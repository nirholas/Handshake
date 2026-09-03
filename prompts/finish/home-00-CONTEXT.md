# home/: shared facts for the three.ws Home campaign

Taking the agent past the screen and into the physical world: a three.ws agent that runs a
real house by voice, with a 3D body standing in a live model of that house.

**Read this file first. Every work order in this pack assumes it and does not repeat it.**
Nothing here is a status claim to trust: re-derive with the commands in "Measured starting
state" before you act. Produced 2026-09-02 from the investigation in
[../../docs/smart-home.md](../../docs/smart-home.md).

---

## The bet, in one sentence

**The device layer is solved and the face is not.** Home Assistant is 90,225 stars, 1,500+
integrations, local-first, already installed in millions of houses, and since its `mcp_server`
integration it speaks Model Context Protocol natively. three.ws already speaks MCP in 40+
packages. The two halves meet without either side inventing a protocol, so we write **zero
device code, ever**, and spend the entire budget on the part nobody has built: a 3D agent with
a voice and a memory that stands in a live model of your home and acts in it safely.

## The user and the moment

Someone is carrying groceries into a dark kitchen. They say "I'm home" and the lights come up,
the thermostat moves, the door locks behind them, and their agent, visible on the kitchen
display, turns to face them and says what it did. Later, from bed, "turn the AC down two
degrees" works without finding a phone. "It worked" means they stopped opening an app.

The second user is an enterprise: a hotel, an office, a serviced building. Same protocol, same
agent, plus roles, audit trails, SSO and an SLO. That is why this campaign is scoped to
enterprise-complete rather than to a demo.

## What is already built and verified (2026-09-02)

[`packages/home-bridge/`](../../packages/home-bridge) is live and tested against a real Home
Assistant. It is a **client library**, not a product, and every order below builds on it:

| Piece | Where | State |
|---|---|---|
| WebSocket channel (state + actions), reconnecting | [`src/bridge.js`](../../packages/home-bridge/src/bridge.js) | live, verified against a real instance |
| MCP channel over `/api/mcp` | [`src/mcp.js`](../../packages/home-bridge/src/mcp.js) | live, 29 real tools pulled from a real instance |
| Room graph (floors, areas, per-room lighting/climate/security rollups) | [`src/rooms.js`](../../packages/home-bridge/src/rooms.js) | live |
| Intent resolution to the house's own scenes | [`src/intents.js`](../../packages/home-bridge/src/intents.js) | live |
| The physical-action gate, both channels | [`src/safety.js`](../../packages/home-bridge/src/safety.js) | live |
| URL and reachability handling | [`src/url.js`](../../packages/home-bridge/src/url.js) | live |
| Tests: 30 pure over a real-instance recording, 6 live | [`tests/`](../../packages/home-bridge/tests) | 36 passing |
| Fixture capture from any instance | [`../../scripts/capture-home-fixture.mjs`](../../scripts/capture-home-fixture.mjs) | live |

**Nothing above is wired into the product.** There is no schema, no endpoint, no page, no tool
in the chat loop, no voice path. That is what this campaign builds.

## The security fact that shapes every order

Home Assistant's own Assist tools are polymorphic. Its published description of
`intent__HassTurnOff` reads: *"Turns off/closes a device or entity. For locks, this performs an
'unlock' action."* An agent told to turn something off can open a front door and nothing in the
tool name says so. Verified: with a lock exposed to Assist, that call really does unlock it.

Therefore, in every order:

- **Reads are free. Writes that open the house stop and ask.** The rule is asymmetric: locking
  up, closing the garage and arming the alarm never prompt; unlocking, opening and disarming
  always do, until the user grants a standing allowance for that one entity.
- **`confirmed: true` represents a human saying yes.** It is never set from model output, never
  inferred from phrasing, and never defaulted on. Treat it exactly like the CLAUDE.md on-chain
  spend gate.
- **Entity names, area names and scene names are untrusted input.** They are strings a stranger
  or a compromised integration can control, they flow into a model prompt, and they are a
  prompt-injection surface with a physical actuator on the other end. See order 11.

## Reachability, stated honestly (do not paper over this)

Home Assistant lives on a LAN. three.ws is served over HTTPS from Cloud Run. A browser cannot
open `http://homeassistant.local:8123` from an https page (mixed content) and our servers
cannot route to RFC1918 space at all. Three honest answers, in this order:

1. **Remote https URL** (Home Assistant Cloud, or the user's own reverse proxy). Works today
   with a long-lived token and zero new code on their side. This is v1, orders 01 to 06.
2. **Browser-local direct connect** for a user on their own network. Narrow, zero latency,
   fully private. Falls out of order 03 for free.
3. **A three.ws add-on that dials out** from inside the LAN. The only option that works for an
   untouched LAN-only install, and the one that ships through HACS. Order 10.

Never claim option 1 covers everyone, and never ship option 3 as a stub.

## Architecture, one picture

```
  browser: 3D agent, voice loop, lip sync, the live home scene
        |  SSE state stream            |  POST actions           |  voice
        v                              v                         v
  ================= three.ws (Cloud Run, api/home/*) ==================
   connection store (encrypted)  bridge runtime (pooled, per-home)
   action gate + audit log       agent tools (chat + MCP)
  =====================================================================
        |                                            |
        |  wss + https, user's token                 |  outbound relay (order 10)
        v                                            v
        Home Assistant  ( /api/websocket , /api/mcp )
        Zigbee | Z-Wave | Matter | Thread | BLE | 1,500 integrations
```

**Three independent channels, one connection record.** Losing one never breaks the others: if
MCP is unreachable the scene still renders live state, and if the state socket drops the agent
can still act.

## Measured starting state (2026-09-02, measured, not remembered)

```bash
npx vitest run packages/home-bridge                     # expect 30 passed, 6 skipped
ls packages/home-bridge/src                             # the client library
grep -rn "home_connections\|api/home" api/ src/ pages/ vercel.json --include=* -l   # expect: nothing yet
ls api/_lib/migrations | grep -i home                   # expect: nothing yet
node -e "console.log(require('./vercel.json').crons.length)"
npm run db:status                                       # read in full before any migration
```

| Fact | Value | How it was read |
|---|---|---|
| Client library | 8 modules, 36 tests | `npx vitest run packages/home-bridge` |
| Product surface | none | the grep above |
| Schema | none | `ls api/_lib/migrations \| grep -i home` |
| Verified against | a real HA (docker `stable`, demo integration, 122 entities, 3 areas, 1 floor, 2 user scenes) | [`docs/smart-home.md` section 6](../../docs/smart-home.md) |
| Test fixture | a recording of that instance | `packages/home-bridge/tests/fixtures/home.json` |

## Platform machinery every order reuses (never rebuild these)

| Need | Use | Not |
|---|---|---|
| HTTP boundary | `wrap`, `cors`, `json`, `method`, `error`, `rateLimited` from [`api/_lib/http.js`](../../api/_lib/http.js) | a bare handler |
| Auth | `getSessionUser`, `getRequestUser`, `authenticateBearer` from [`api/_lib/auth.js`](../../api/_lib/auth.js) | a second session scheme |
| CSRF | `requireCsrf` from [`api/_lib/csrf.js`](../../api/_lib/csrf.js) | nothing |
| Secrets at rest | `encryptSecret` / `decryptSecret` / `isEncryptedSecret` from [`api/_lib/secret-box.js`](../../api/_lib/secret-box.js) (AES-256-GCM, `WALLET_ENCRYPTION_KEY`, per-record salt, rotation-tolerant decrypt) | plaintext, base64, or a new crypto path |
| Database | `sql` from [`api/_lib/db.js`](../../api/_lib/db.js), `withDbRetry` from [`api/_lib/db-retry.js`](../../api/_lib/db-retry.js) | a new client |
| Rate limits | `limits`, `clientIp` from [`api/_lib/rate-limit.js`](../../api/_lib/rate-limit.js) | a second limiter |
| Audit trail | `logAudit` from [`api/_lib/audit.js`](../../api/_lib/audit.js) | console.log |
| Alerts | `sendOpsAlert` from [`api/_lib/alerts.js`](../../api/_lib/alerts.js) | a new channel |
| Health | `gatherSubsystemHealth` in [`api/_lib/ops/subsystem-health.js`](../../api/_lib/ops/subsystem-health.js), surfaced by [`api/healthz.js`](../../api/healthz.js) | a new health endpoint |
| Chat tool calls | `ACTION_TOOLS` in [`api/chat.js`](../../api/chat.js) (line ~255) | a parallel chat path |
| MCP tools | [`api/_mcp/catalog.js`](../../api/_mcp/catalog.js) + a new file in [`api/_mcp/tools/`](../../api/_mcp/tools), shaped like [`memory.js`](../../api/_mcp/tools/memory.js) | a second MCP server |
| OAuth scopes | [`api/_lib/oauth-scopes.js`](../../api/_lib/oauth-scopes.js) | ad hoc strings |
| Design tokens | `public/tokens.css`, see [`../../DESIGN-TOKENS.md`](../../DESIGN-TOKENS.md) | a new palette |
| Page routing | a `routes` entry in [`../../vercel.json`](../../vercel.json) plus `pages/<name>.html` + `src/<name>.js`, as `/materialize` does | a client-side router |
| e2e | [`tests/e2e/`](../../tests/e2e) with [`playwright.config.js`](../../playwright.config.js) | a new runner |

## A real Home Assistant, in one command (every order that touches the wire needs this)

```bash
docker run -d --name threews-ha -p 8123:8123 -v "$PWD/.ha-config:/config" ghcr.io/home-assistant/home-assistant:stable
# wait for a 302 on http://localhost:8123/, then add `demo:` to .ha-config/configuration.yaml and restart:
printf '\ndemo:\n' >> .ha-config/configuration.yaml && docker restart threews-ha
```

Onboarding, long-lived token minting, area assignment and scene creation are all API-driven and
were scripted during the investigation; the shapes are in
[`docs/smart-home.md`](../../docs/smart-home.md) and
[`scripts/capture-home-fixture.mjs`](../../scripts/capture-home-fixture.mjs). Add `.ha-config/`
to `.gitignore` if it is not already ignored, and never commit a token.

**Never mock Home Assistant.** A fake instance would have hidden the `HassTurnOff` unlock, which
is the single most important thing we learned. If you need an instance, run one.

## Work orders

Run in order within a lane; lanes 1 to 4 are mostly parallelizable once lane 1 lands.

| # | Order | Lane |
|---|---|---|
| 01 | [Connection store: schema, encrypted credentials, lifecycle](home-01-connection-store.md) | foundation |
| 02 | [Bridge runtime: the multi-tenant connection manager](home-02-bridge-runtime.md) | foundation |
| 03 | [The `/api/home/*` surface: REST, SSE, error contract](home-03-api-surface.md) | foundation |
| 04 | [Agent tools: chat actions, MCP tools, the confirmation protocol](home-04-agent-tools.md) | agent |
| 05 | [The connect flow: `/home` onboarding, every state](home-05-connect-flow.md) | surface |
| 06 | [The live 3D home](home-06-3d-home-scene.md) | surface |
| 07 | [Floorplan authoring and layout persistence](home-07-floorplan-editor.md) | surface |
| 08 | [The browser voice loop: wake word, barge-in, latency](home-08-voice-loop.md) | voice |
| 09 | [three.ws as a Home Assistant voice satellite (Wyoming)](home-09-wyoming-satellite.md) | voice |
| 10 | [The dial-out add-on and relay for LAN-only homes](home-10-addon-relay.md) | reachability |
| 11 | [Security hardening: threat model, injection boundary, abuse](home-11-security.md) | enterprise |
| 12 | [Households: members, roles, per-member scopes, SSO](home-12-households-rbac.md) | enterprise |
| 13 | [Observability, SLOs, alerting, incident runbook](home-13-observability.md) | enterprise |
| 14 | [Reliability and the scale envelope](home-14-reliability-scale.md) | enterprise |
| 15 | [Privacy, retention, export and deletion](home-15-privacy-retention.md) | enterprise |
| 16 | [The test program: e2e, HA version matrix, live harness](home-16-test-program.md) | quality |
| 17 | [Accessibility, 87 locales, mobile and PWA](home-17-a11y-i18n-mobile.md) | quality |
| 18 | [Docs, SDK publish, the home MCP server package](home-18-docs-and-sdk.md) | quality |
| 19 | [Plans, entitlements and quotas](home-19-plans-entitlements.md) | commercial |
| 20 | [Launch readiness: the go/no-go](home-20-launch-readiness.md) | launch |
| 21 | [Matter direct control: past the house](home-21-matter-direct.md) | horizon |

## Never blocked (campaign-wide)

| Blocker | Do this |
|---|---|
| No Home Assistant to test against | Run one. The docker command is above and takes two minutes. Never mock it. |
| No `DATABASE_URL` | `.env.local` carries it (Neon). `.env` alone does not, which is why a script that loads only `.env` dies on `missing required env var: DATABASE_URL`. Production's copy is on the Cloud Run service. |
| `npm run db:status` shows other agents' pending migrations | Read them. Applying unrelated safe ones is normal; that is what the command does. Stop and report only on something destructive. Never run `db:migrate` without reading `db:status` first: it applies every pending migration, not just yours. |
| A Home Assistant API shape differs from this pack | The pack was written against a live `stable` instance on 2026-09-02. Trust the instance in front of you, fix the order's claim in the same commit, and say so in your report. |
| An HA feature needs the user to configure something (`mcp_server`, exposing an entity) | That is an ordinary state, not an error. It gets a designed UI state that says what to turn on and where, never a stack trace. |
| Someone proposes writing a device integration | Refuse. Home Assistant owns the device layer. If a device is missing, the answer is an HA integration upstream, not code here. |
| Someone proposes defaulting `confirmed: true`, or inferring it from the model | Refuse. It is the CLAUDE.md spend gate applied to physical actuators. |
| A dependency is needed for a solved problem | Search npm and GitHub first per the CLAUDE.md open-source rule. `@leeoniya/ufuzzy`, `home-assistant-js-websocket` and `@modelcontextprotocol/sdk` are already here. |
| The work is bigger than one session | Finish the orders you can finish completely, update this file's table, and append to `home-PROGRESS.md`. Never leave a half-wired surface. |

## Retire this file when the campaign is done (required)

Shared context outlives the orders that cite it. Delete it in the commit that closes the LAST
order of this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'home-00-CONTEXT' prompts/finish/
       git rm prompts/finish/home-00-CONTEXT.md

While any sibling order is still on disk, leave this file in place and keep it accurate instead.
The shrinking directory is the only signal to the next agent that a campaign is closed.
