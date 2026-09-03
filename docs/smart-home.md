# three.ws Home: the agent as the interface to your physical space

**Status:** shipped. The connection store, the API surface, the agent tools, the `/smart-home`
page, the 3D scene, the household roster, the relay for LAN-only houses and the voice satellite
are all in the tree. What is not shipped is named as such in section 5.
**Researched:** 2026-09-02. **Last measured against the tree:** 2026-09-03.
**Question asked:** can the three.ws 3D agent control a real home, and how much of it already exists in open source?

**Short answer:** almost all of it exists, and it is better than anything we would write.
Home Assistant already owns the device layer (90k stars, 1,500+ integrations, every
protocol we would otherwise implement) and, since the `mcp_server` integration, it speaks
Model Context Protocol natively. three.ws already speaks MCP in 40+ packages. The two
halves meet without either side inventing a protocol.

What is genuinely missing in the world, and what three.ws is uniquely positioned to build,
is the **face**: a real-time 3D presence that stands in a live model of your home, reacts
to it, and talks to you. Nobody ships that. That is the part we build.

---

## 1. Why this is not a side quest

Read the current product in one line: three.ws gives an AI a body, a voice, memory, and an
identity. Every one of those is currently confined to a browser tab.

A smart home is the first place where all four pay off at once:

- **Body**: a home has rooms and objects. An agent with a 3D presence can *be somewhere* in
  it rather than being a text box.
- **Voice**: hands-free is the only interface that works when you are carrying groceries.
  Voice is already the weakest-value feature on a website and the highest-value feature in
  a kitchen.
- **Memory**: "the usual" only means something to an agent that remembers your evenings.
- **Identity**: a household agent that persists across devices and rooms is exactly the
  agent-identity story we already tell on-chain.

It is also the natural bridge to the rest of the list (cars, offices, hotels, robots),
because every one of those already speaks the same protocols the home does.

---

## 2. The landscape, measured

All figures pulled from the GitHub API on 2026-09-02. Nothing here is quoted from a blog post.

### Device control layer

| Project | Stars | License | Last push | Language | Verdict |
|---|---|---|---|---|---|
| [home-assistant/core](https://github.com/home-assistant/core) | 90,225 | Apache-2.0 | 2026-09-02 | Python | **Adopt.** The device layer. 1,500+ integrations, local-first, already installed in millions of homes. |
| [homebridge/homebridge](https://github.com/homebridge/homebridge) | 25,472 | Apache-2.0 | 2026-08-30 | TypeScript | Skip. HomeKit-shaped; HA covers its device set and more. |
| [node-red/node-red](https://github.com/node-red/node-red) | 23,614 | Apache-2.0 | 2026-09-01 | JavaScript | Skip as a dependency. It is the automation UI we are replacing with natural language. |
| [Koenkk/zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt) | 15,592 | GPL-3.0 | 2026-09-02 | TypeScript | Indirect. Users run it; we reach it through HA. GPL keeps it out of our process anyway. |
| [esphome/esphome](https://github.com/esphome/esphome) | 11,628 | Apache-2.0 + GPL | 2026-09-02 | C++ | Indirect, and the DIY-hardware on-ramp later. |
| [project-chip/connectedhomeip](https://github.com/project-chip/connectedhomeip) | 8,916 | Apache-2.0 | 2026-09-02 | C++ | Reference only. The Matter spec implementation, C++, not our runtime. |
| [openhab/openhab-core](https://github.com/openhab/openhab-core) | 1,137 | EPL-2.0 | 2026-09-01 | Java | Skip. Real, mature, and an order of magnitude smaller in reach than HA. |
| [matter-js/matter.js](https://github.com/matter-js/matter.js) | 894 | Apache-2.0 | 2026-09-02 | TypeScript | **Measured, not adopted.** A full Matter controller *and device* implementation in TypeScript, and it does what it says: a three.ws agent built on it commissioned into a real Home Assistant in 744 ms. The reason it is not in the tree is a product reason, not a technical one. [Section 8](#8-matter-direct-control-measured-and-not-yet-built). |
| [zwave-js/zwave-js](https://github.com/zwave-js/zwave-js) | 887 | MIT | 2026-09-02 | TypeScript | Indirect. HA's Z-Wave layer is already this. |
| [Luligu/matterbridge](https://github.com/Luligu/matterbridge) | 963 | Apache-2.0 | 2026-09-02 | TypeScript | Reference. Best worked example of matter.js in the "expose things as Matter devices" direction. Read it before any second attempt at [section 8](#8-matter-direct-control-measured-and-not-yet-built). |

### Agent-to-home bridge

| Project | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| [Home Assistant `mcp_server`](https://www.home-assistant.io/integrations/mcp_server/) | in core | Apache-2.0 | shipping | **Adopt.** First-party. Exposes `/api/mcp` over streamable HTTP, authenticated by OAuth (IndieAuth, no pre-registered client id, the client id is just our base URL) or a long-lived access token. This is the single most important finding in this document. |
| [home-assistant/home-assistant-js-websocket](https://github.com/home-assistant/home-assistant-js-websocket) | 410 | Apache-2.0 | 2026-08-31 | **Adopt.** First-party JS client, zero dependencies, auto-reconnect, auto-resubscribe. MCP gives us *actions*; this gives us the *live state stream* the 3D scene needs. |
| [homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp) | 4,601 | MIT | 2026-09-02 | Reference. The best third-party HA MCP server; useful as a tool-design reference, but adding a Python hop between us and a first-party endpoint is strictly worse. |
| [tevonsb/homeassistant-mcp](https://github.com/tevonsb/homeassistant-mcp) | 575 | Apache-2.0 | 2026-01-25 | Skip. Stalled since January. |

### Voice layer

| Project | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | 15,144 | BSD-2 | 2026-09-02 | Reference. Python; our voice loop is already in the browser. |
| [livekit/livekit](https://github.com/livekit/livekit) + [livekit/agents](https://github.com/livekit/agents) | 20,660 / 13,966 | Apache-2.0 | 2026-09-02 | **Phase 4 candidate** for always-on room audio at scale. Not needed for v1. |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 25,200 | MIT | 2025-11-19 | Indirect. This is what a local HA Assist pipeline already runs for STT. |
| [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) | 5,432 | GPL-3.0 | 2026-08-29 | Indirect, and GPL. Runs inside the user's HA, never inside our process. |
| [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | 10,111 | MIT | 2026-08-24 | **Adopt** for barge-in in the browser voice loop. |
| [dscripka/openWakeWord](https://github.com/dscripka/openWakeWord) | 2,727 | Apache-2.0 | 2025-12-30 | Adopt for a browser wake word ("hey <agent name>"). |
| [rhasspy/wyoming-satellite](https://github.com/rhasspy/wyoming-satellite) | 1,244 | MIT | 2026-01-24 | **Adopt the protocol, not the code.** Wyoming is a tiny TCP + JSONL protocol. Speaking it makes the three.ws avatar a first-class HA voice satellite. |

### Adjacent, worth knowing

[blakeblackshear/frigate](https://github.com/blakeblackshear/frigate) (35,578, MIT) for camera
events, [ExperienceLovelace/ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan)
(1,601, Apache-2.0) as the closest prior art to our 3D scene and proof that the 2D version of
the idea already has an audience, and [hacs/integration](https://github.com/hacs/integration)
(7,674, MIT) as the distribution channel for any custom HA component we ship.

---

## 3. The decision

### Adopt outright

1. **Home Assistant as the device layer.** We write zero device drivers. Not one. Zigbee,
   Z-Wave, Matter, Thread, BLE, cloud APIs, IR blasters, the long tail of 1,500 integrations:
   that is a decade of work by 10,000 contributors and it is already in the user's house.
2. **`home-assistant-js-websocket` as the always-available channel.** State *and* actions.
   It is first-party, dependency-free, reconnects and resubscribes itself, and works on any
   instance with nothing but a token. MCP is request/response; a living 3D scene needs a push
   stream, and this is it.
3. **`mcp_server` as the capability upgrade.** When a home has it enabled, that home becomes
   just another MCP server in an ecosystem where we already run 40+ of them: no new wire
   format, no new auth story, no custom command schema, and every capability the user exposed
   to their own LLM is exposed to their three.ws agent with identical permissions. Verified
   against a live instance: 29 real tools, no code of ours behind any of them. It is an
   upgrade rather than a requirement because it has to be set up first, and a bridge that
   only worked on configured instances would leave most homes out.
4. **HA scenes and scripts for macros.** "Good night" and "I'm leaving" are not new concepts
   we invent. They are `scene.turn_on` and `script.turn_on`, already modelled, already
   editable by the user in an interface they know. Our agent resolves intent to an existing
   scene, and only falls back to composing individual calls when no scene fits.

### Explicitly do not build

- A device driver, of any kind, for anything.
- A hub, a broker, or an automation rules engine.
- Another HA MCP server. The first-party one exists, and `packages/home-mcp` is not one: it does
  not reimplement Home Assistant's `mcp_server`, it packages our own bridge and our own gate so an
  assistant can reach a house without writing a client.
- A local speech stack. The user's HA already runs Whisper and Piper locally, or their
  browser already runs ours.

### What we build, because nobody has

1. **The live 3D home.** The agent standing in a scene that *is* the house: lights that dim
   when the real lights dim, a door that shows locked, a thermostat reading the real
   temperature. Everyone who has done this shipped a flat SVG floorplan. We already ship a
   Three.js renderer, an avatar pipeline, and a physics-capable scene. This is the thing
   people screenshot.
2. **The avatar as a Wyoming satellite.** Today an HA voice assistant is a speaker with an
   LED ring. Point an HA pipeline at a three.ws agent and it gains a face, an expression,
   lip sync, and a body that turns toward you. That is a genuinely new product for 90k
   stars' worth of existing users, and it is a distribution channel, not just a feature.
3. **Home as agent memory.** An agent that remembers your house across sessions, and whose
   on-chain identity is the same identity that holds its wallet and its skills, is a
   different object from a voice assistant. This is where the rest of the platform pays off.

---

## 4. Architecture

```
  three.ws agent (browser: 3D avatar, voice loop, lip sync)
         |
         |  1. actions      2. live state          3. voice
         v                       v                      v
  +--------------+   +------------------------+   +-------------------+
  | MCP client   |   | WS state subscriber    |   | Wyoming endpoint  |
  | @mcp/sdk     |   | home-assistant-js-ws   |   | (we speak it)     |
  +------+-------+   +-----------+------------+   +---------+---------+
         |                       |                          |
         +-----------+-----------+--------------------------+
                     v
          Home Assistant  ( /api/mcp , /api/websocket )
                     |
     Zigbee | Z-Wave | Matter | Thread | BLE | Wi-Fi | 1,500 integrations
```

**Three independent channels, one connection record.** A home is stored once (base URL plus
credential); the three channels are three views of it. Losing one does not break the others:
if MCP is unreachable the scene still renders live state, and if the state socket drops the
agent can still act.

### Reachability, stated honestly

Home Assistant lives on a LAN. three.ws runs in the cloud and is served over HTTPS, so a
browser tab cannot open `http://homeassistant.local:8123` (mixed content), and our servers
cannot route to RFC1918 space. This is the real engineering constraint and it has three
honest answers, in order of preference:

1. **Remote HTTPS URL.** Home Assistant Cloud, or the user's own reverse proxy or tunnel.
   Works today with a long-lived token, zero new code on their side. This is v1.
2. **Browser-local direct connect.** For users who open three.ws from inside their own
   network, over a local HTTPS origin. Narrow, but zero-latency and fully private.
3. **A three.ws integration that dials out.** A Home Assistant custom integration that opens
   one outbound WebSocket to three.ws and carries the state and action channels over it. The
   only option that works for an untouched LAN-only install, and the one that ships through
   HACS.

**Option 3 is built and verified, not planned.** It is
[`services/home-relay/`](../services/home-relay/README.md) plus
[`home-assistant-integration/`](../home-assistant-integration), it is proven end to end against
a real Home Assistant on a network the caller cannot route to, and a home connected that way
stores no Home Assistant token at all: the integration authenticates locally and nothing
crosses. See [home-relay.md](home-relay.md) and
[home-relay-threat-model.md](home-relay-threat-model.md).

A **custom integration rather than an add-on**, and the distinction is load-bearing: an add-on
only runs on Home Assistant OS and Supervised, while an integration runs on all four install
types including Container and Core, and HACS distributes integrations rather than add-ons.
Since the whole point is reaching the installs a remote URL misses, the option with the wider
reach wins.

We will not pretend option 1 covers everyone, and we did not ship option 3 as a stub.

### Permission model

Non-negotiable, and it borrows the shape of the existing on-chain spend gate: **an action
that changes physical state in a home is confirmed, not inferred.** Reads are free. Writes
are scoped to what the user exposed to the LLM API in Home Assistant itself (HA already has
this control, so we inherit it rather than inventing a parallel one). Locks, garage doors,
alarm panels, and anything HA marks as a security entity require an explicit confirmation
every time until the user grants a standing allowance per entity. A voice channel that can
unlock a front door on a misheard phoneme is not a feature, and the first-party HA exposure
setting is the correct place for the outer boundary to live.

One finding from building this makes the gate non-optional, and it is not obvious from the
outside. Home Assistant's own Assist tools are polymorphic, and its published description of
`intent__HassTurnOff` reads:

> Turns off/closes a device or entity. **For locks, this performs an 'unlock' action.**

So a model that has been told to turn something off can unlock a front door, and nothing in
the tool name says so. Confirmed against a live instance: with a lock exposed to Assist (which
is exactly what a user who wants voice lock control does), `HassTurnOff` on it really does
unlock the door. Our gate therefore has to sit in front of the MCP channel too, resolving each
call's targets to real entities and working out the service each one would actually perform.
That is `classifyMcpCall` in the bridge.

### What is stored, and what deliberately is not

The device layer is Home Assistant's, and so is the data in it. What three.ws persists is
small and sharp: the connection record and its encrypted credential, who you shared the home
with, the standing allowances you granted, and a log of every action the agent took. What it
never persists is the part that would matter most if it did: **the names of your rooms and
devices, and their states.** Those are read live and held in memory only while the connection
is open, because a stored history of when a household's lights go on and off is a record of
when they are home.

The action log is the one genuinely difficult call, and it is settled at 90 days by default,
owner-adjustable down to a day and up to ten years with a written reason. The full inventory,
the retention decision and its justification, the export and deletion paths, and the
disclosure copy shown at connect and at the voice opt-in are in
[Home privacy and retention](./home-privacy.md).

---

## 5. What shipped, and what has not

Each phase was shippable on its own. This section is a map of the tree, not a plan: every path
below exists, and anything that does not exist says so.

### Shipped

| Piece | Where |
|---|---|
| The client library: state and action channel, MCP channel, room graph, intent resolution, the gate | [`packages/home-bridge/`](../packages/home-bridge/README.md) |
| The connection store: schema, encrypted credentials, lifecycle | [`api/_lib/home/store.js`](../api/_lib/home/store.js), 8 migrations under `api/_lib/migrations/*_home_*.sql` |
| The bridge runtime: pooled per-home connections, refcounting, breaker, backpressure ladder | [`api/_lib/home/runtime.js`](../api/_lib/home/runtime.js), [`admission.js`](../api/_lib/home/admission.js) |
| The `/api/home/*` surface: REST, SSE stream, the error contract | [`api/home/`](../api/home) |
| Agent tools and the confirmation protocol | [`api/_lib/home/tools.js`](../api/_lib/home/tools.js), [`confirm.js`](../api/_lib/home/confirm.js), wired into `api/chat.js` and `api/_mcp/tools/home.js` |
| The connect flow and the household page | `/smart-home` ([`pages/smart-home.html`](../pages/smart-home.html), [`src/home/`](../src/home)) |
| The live 3D home | [`src/home/scene-render.js`](../src/home/scene-render.js), [`scene-model.js`](../src/home/scene-model.js) |
| Households: roles, per-member scopes, invites | [`api/_lib/home/members.js`](../api/_lib/home/members.js), [docs/home-households.md](home-households.md) |
| Privacy, retention, export and deletion | [`api/_lib/home/privacy.js`](../api/_lib/home/privacy.js), [docs/home-privacy.md](home-privacy.md) |
| The dial-out relay for LAN-only houses | [`services/home-relay/`](../services/home-relay/README.md) plus [`home-assistant-integration/`](../home-assistant-integration) |
| The browser voice loop: wake word, barge-in, a confirmation grammar speech cannot satisfy | [`src/voice/home-voice.js`](../src/voice/home-voice.js), [`home-voice-ui.js`](../src/voice/home-voice-ui.js), surfaced at `/voice/home` |
| The Wyoming voice satellite | [`services/home-satellite/`](../services/home-satellite/README.md) |
| A standalone MCP server, so any assistant can run a house | [`packages/home-mcp/`](../packages/home-mcp/README.md) |
| A real Home Assistant on demand, for every live test | [`scripts/home-test-instance.mjs`](../scripts/home-test-instance.mjs) |
| The tutorial | [docs/tutorials/connect-your-home.md](tutorials/connect-your-home.md) |

### The connect flow, state by state

`/smart-home` ([`pages/smart-home.html`](../pages/smart-home.html) + [`src/home/connect.js`](../src/home/connect.js)
+ [`src/home/manage.js`](../src/home/manage.js)) is the front door. It is written as an explicit
state machine rather than a happy path with error handling bolted on, because the interesting
half of connecting a house is everything that is not the happy path. `STATE` in `connect.js` is
the list; `render()` is the only place a state is entered, so "which state am I in" is always
answerable from `#hm-root[data-state]`, which is also how the e2e suite drives it.

| State | When | What it must do |
|---|---|---|
| `signed_out` | no session | Explain the feature and offer sign-in. Never a disabled form. |
| `empty` | signed in, no homes | The connect card, with the token instructions one disclosure away. |
| `private_host` | the address is LAN-only | Name the address class and give the two real routes out. |
| `verifying` | the handshake is running | Named steps, cancellable. Never a bare spinner or a fake progress bar. |
| `connected` / `many` | one or more homes | The measured summary per home, plus grants, log, health and household. |
| `one_home` | `/smart-home/:id` | That home alone, with a way back up to the list. |
| `not_found` | an id that is not this account's | Reveals nothing about whether the id exists. |
| `auth_failed` | Home Assistant rejected the token | Say so, refocus the token field, keep the URL. |
| `unreachable` | no answer | Separate "wrong address" from "house offline". |
| `quota_reached` | the plan ceiling | Offer the upgrade and nothing that would fail again. |
| `revoked` | the last home was disconnected | Say what happened to the stored credential. |
| `pairing` | the relay is waiting for the house to dial out | Poll, and stop the animation when the poll stops. |

Two invariants hold the surface together, and both are asserted in
[`tests/e2e/home-connect.spec.js`](../tests/e2e/home-connect.spec.js) rather than left as prose.

**The token goes to the server once and never comes back.** The field is `type="password"` with
a reveal toggle and `autocomplete="off"`; the value is never written to `localStorage` or
`sessionStorage`, never placed in a URL, never logged, and never echoed by any endpoint. It is
gone from the DOM the moment a connect succeeds. Reconnecting a house that is already on the
account prefills the label and the address, and deliberately does not prefill the token: there
is nowhere it could be read back from.

**Reachability is decided in the browser, before the network.** `checkReachable()` uses
`normalizeBaseUrl` and `isPrivateHost` from `@three-ws/home-bridge/url`, the same functions the
server validates with, so the two cannot disagree about what is reachable. The order of the
checks is load-bearing: a private host is diagnosed **before** the scheme, because
`http://192.168.1.10:8123` is the single most common thing a person pastes and it is both plain
http and unroutable. Answering it with "use https" sends someone off to configure TLS on a
machine three.ws still could not reach; "that address only exists on your home network" is the
true answer and the actionable one. The refusal costs zero network requests, which the e2e suite
asserts by counting requests across the submit.

The subpath import matters for a third reason: `@three-ws/home-bridge/url` pulls in nothing but
`errors.js`, while the package root pulls the Home Assistant WebSocket client and the MCP SDK.
Importing the root here would have shipped both to every visitor for two pure string functions.

Everything a house supplies (a label, an entity id, an area name) is rendered with
`textContent`. These are strings a stranger or a compromised integration can influence, they
flow into a page and into a model prompt, and there is a physical actuator on the other end.

### Not shipped

- **Matter direct control.** Built as a throwaway kernel, measured, and deliberately not kept.
  It works; it is not yet worth shipping. The evidence and the conditions that would change that
  answer are in [section 8](#8-matter-direct-control-measured-and-not-yet-built). Nothing of it
  is in the tree.
- **A floorplan editor.** The 3D scene derives its layout from the area graph. Authoring and
  persisting a hand-drawn floorplan is not built.

## 6. What was actually verified

Nothing in this document is inferred from documentation alone. A real Home Assistant
(`ghcr.io/home-assistant/home-assistant:stable`, the `demo` integration, 122 entities across
three areas and one floor, plus two user scenes named "Bedtime" and "Away Mode") was run in
Docker and driven through the bridge:

| Claim | How it was checked | Result |
|---|---|---|
| The WebSocket channel needs nothing but a token | `HomeBridge.connect()` against the live instance | Connected, 3 rooms, 1 floor, 122 entities |
| Live state drives the 3D scene | Ran the house's "Bedtime" scene, read the room graph back | Bedroom brightness fell to 0.157 with colour `[255, 164, 82]`, other rooms went dark |
| A macro resolves to the user's own scene | `activate('good night')` in a house with no scene called "Good night" | Resolved to `scene.bedtime` at 0.95 confidence and ran it |
| A macro with no match stays silent | `activate('movie time')` in a house with no movie scene | No match, nothing fired |
| The gate blocks an unlock | `call('lock', 'unlock', ...)` with no confirmation | Refused; door stayed locked |
| Confirmation lets it through | The same call with `{ confirmed: true }` | Door unlocked |
| Locking up never prompts | `call('lock', 'lock', ...)` | Ran, no prompt |
| `mcp_server` gives us the user's tools | Enabled the integration, opened the MCP channel | 29 real tools; a tool call turned on a real light |
| HA's own `HassTurnOff` unlocks locks | Exposed a lock to Assist, called it through the gate | Gate refused; with `{ confirmed: true }` the door really did unlock |
| A bad token reads as auth, not as an outage | Connected with a junk token | `code: 'auth'` |
| A home without `mcp_server` is not an error | Opened the MCP channel against a nonexistent API | `code: 'no_mcp'` with a recovery message |

### Re-measured against the shipped tree (2026-09-03)

The house was `scripts/home-test-instance.mjs --up --onboard --seed`: Home Assistant 2026.9.0, one
floor, four areas, 122 entities, two user scenes (Bedtime, Away Mode), four locks.

| Claim | How it was checked | Result |
|---|---|---|
| The client library still works end to end | `npx vitest run packages/home-bridge` with the house configured | 37 passed (30 pure, 7 live) |
| Every code example in the `home-bridge` README runs | Each one executed against that instance in order | All ran, including the MCP channel: 29 real tools, and a tool call that turned on a real light |
| The MCP channel is present on a seeded instance | `connectHomeMcp` against it | 29 tools |
| `activate('good night')` still resolves to the house's own scene | Ran it against a house with no scene called "Good night" | `scene.bedtime`, confidence 0.95, and the bedroom went dark |
| A phrase with no match still runs nothing | `activate('launch the shuttle')` | `{ ran: false, match: null }` |
| The standalone MCP server refuses a guarded action over real stdio | Spawned `packages/home-mcp` as a child process, spoke MCP to it, then asked Home Assistant | Refused; `lock.front_door` still `locked` |
| A confirmation cannot be smuggled into service data | Same, with `{confirmed:true}`, `{confirm:'yes'}`, `{confirmed:true,user_said_yes:true}` | All three refused; door still `locked` |
| A standing allowance stays per entity | Same call with `HOME_ALLOWED_ENTITIES=lock.kitchen_door` | Refused; door still `locked` |
| The operator's own allowance does work | Same call with `HOME_ALLOWED_ENTITIES=lock.front_door` | Ran; door `unlocked`, then re-locked |
| Locking up never prompts | `lock.lock` through the server with no allowance at all | Ran |
| The relay allowlist has not drifted from the protocol | `npx vitest run tests/home-relay-protocol.test.js` | 30 passed |
| A house on a network the caller cannot route to is driven through the relay | `scripts/home-relay-e2e.mjs` from a container on a second Docker bridge, with no route to the house | 10/10, including a real light toggled, a real door unlocked through the gate, and four allowlist refusals |
| The platform really will not dial a private address | Posted a loopback URL to `POST /api/home` on a local server against the live database | `unreachable`, with the LAN explanation, and nothing stored |

The registry snapshot from that instance is checked in as the package's test fixture
(`packages/home-bridge/tests/fixtures/home.json`, regenerated by
`scripts/capture-home-fixture.mjs`), so a Home Assistant registry change shows up as a failing
test rather than as a surprise in someone's house. The live checks above are also a test file
(`packages/home-bridge/tests/live-home.test.js`), which skips itself unless it is given a house:
`HOME_LIVE=1` lets the harness build one, and `HOME_ASSISTANT_URL` plus `HOME_ASSISTANT_TOKEN`
point it at one you already have.

### The supported version range, measured

Home Assistant ships a release every month, so the lane's correctness depends on a third party's
release cadence. `npm run home:matrix` (`scripts/home-version-matrix.mjs`) runs the real client
library against every release we claim to support and fills in this table from the runs. The
release set is derived, never hardcoded: Home Assistant's own analytics
(<https://analytics.home-assistant.io/data.json>, roughly 676,000 opted-in installs) carry the live install share
per release, and the set is the current stable, the two releases before it, and the oldest
release still in contiguous wide use at or above one percent of installs. The floor moves on its
own as the world upgrades.

Measured 2026-09-03:

| Version | Share | Connect | Registries | State stream | Service call | Scenes | `mcp_server` | Notes |
|---|---|---|---|---|---|---|---|---|
| `2026.9` (current stable) | 4.17% | pass (2026.9.0) | pass (1f/4a/62d/92e) | pass (push) | pass (gated) | pass (scene) | pass (29 tools) | exposes via `homeassistant/expose_entity` |
| `2026.8` (previous release) | 50.41% | pass (2026.8.3) | pass (1f/4a/62d/92e) | pass (push) | pass (gated) | pass (scene) | pass (29 tools) | exposes via `homeassistant/expose_entity` |
| `2026.7` (previous release) | 13.21% | pass (2026.7.4) | pass (1f/4a/61d/87e) | pass (push) | pass (gated) | pass (scene) | pass (29 tools) | exposes via `homeassistant/expose_entity` |
| `2025.10` (oldest in wide use) | 1.05% | pass (2025.10.4) | pass (1f/4a/52d/79e) | pass (push) | pass (gated) | pass (scene) | pass (22 tools) | exposes via `homeassistant/expose_entity` |

**Supported range: 2025.10 and newer.** Every capability the platform depends on works across it.
The floor is where install share falls below one percent, not where the code stops working;
nothing was found that a 2025.10 house cannot do.

One version difference was found, and it is handled by asking the house rather than by reading
its version number:

| Difference | Releases | How it is handled |
|---|---|---|
| The MCP endpoint moved. Through 2025.10 `mcp_server` served only the SSE transport at `/mcp_server/sse`; the Streamable HTTP endpoint at `/api/mcp` arrived later. | 2025.10 and older vs 2026.7 and newer | `connectHomeMcp` tries Streamable HTTP, and on a 404 falls back to SSE. It reports which transport answered (`transport`, `endpoint`). Before this, a 2025.10 house with a loaded `mcp_server` entry and 22 real tools was reported as having no MCP at all. |
| The exposure command was renamed from `homeassistant/expose_entity/set` to `homeassistant/expose_entity`. | older releases vs the whole supported range | The test harness sends the current name and falls back on `unknown_command`. Every release in the supported range answers to the current name, so the fallback covers only houses below the floor. |
| The `mcp_server` config flow's `llm_hass_api` field is a multi-select. | whole supported range | The harness reads the flow's own `data_schema` and sends the shape it asks for, rather than assuming a string. |

Feature detection, never version sniffing: nothing in the client library branches on a version
string. `HomeBridge.haVersion` exists to be reported to a person, not to be compared against.

---

## 7. Licensing

Everything we take into our own process is permissive: Apache-2.0 (Home Assistant, the JS
WebSocket client, matter.js, openWakeWord), MIT (Wyoming's reference implementation,
silero-vad), BSD-2 (pipecat, if we ever use it). The GPL-licensed pieces in this space
(zigbee2mqtt, Piper) run inside the user's own Home Assistant and are reached over a network
boundary, which is exactly where they belong. No copyleft enters the three.ws build.

One obligation we do take on: this plan is built on the back of a very large volunteer
project. The "open source first" rule in `CLAUDE.md` says we are participants, not
extractors. Anything we fix in `home-assistant-js-websocket` or matter.js goes upstream, and
the HA add-on in phase 2 ships publicly through HACS rather than only to our own users.

---

## 8. Matter direct control: measured, and not yet built

Phase 4 of the original plan was "past the house": use
[matter.js](https://github.com/matter-js/matter.js) to let a three.ws agent talk to devices with
no hub, and to let a three.ws agent **present itself** as a Matter device that any Matter
controller can see. On 2026-09-03 that was built as a throwaway kernel, driven against real
software, measured, and then deleted. This section is the record, so the next attempt starts
from data rather than from the idea.

**The answer is: it works, and it is not yet worth shipping.** Both halves of that matter, so
both are evidenced below.

### The landscape, re-measured on 2026-09-03

The campaign's numbers were read on 2026-09-02. One day later nothing had moved:

| Fact | Value |
|---|---|
| `matter-js/matter.js` | 894 stars, Apache-2.0, last push `2026-09-02T21:52:32Z`, not archived |
| `Luligu/matterbridge` | 963 stars, Apache-2.0, last push `2026-09-02T20:19:51Z` |
| `@matter/main` on npm | `0.17.9` |
| Controller used | `ghcr.io/home-assistant-libs/python-matter-server:stable`, SDK `2025.7.0`, schema 11 |

### What was built and what it proved

A `ServerNode` on `@matter/main` in a `node:24-alpine` container, presenting two endpoints
chosen because they are the two directions an agent needs and nothing more:

- an **On/Off Plug-in Unit**, which is Home Assistant asking the agent for something, and
- an **Occupancy Sensor**, which is the agent telling the house something.

It was commissioned over IP into a real Home Assistant (2026.9.0, the `demo` integration) through
a real python-matter-server, on an IPv6-enabled Docker network. No Bluetooth, no Thread, no
radio of any kind: `bluetooth_enabled: false` on the controller for the whole run.

| Claim | How it was checked | Result |
|---|---|---|
| A matter.js node stands up and is commissionable | Booted the container, read its own advertisement | Online, advertising `_matterc._udp`, manual pairing code `34970112332` |
| It commissions over plain IP, with no BLE and no Thread | `commission_with_code` with `network_only: true` | Commissioned as node 1 in **744 ms** |
| Home Assistant sees the agent as a first-class device | Read the device registry | One device: manufacturer `three.ws`, model `three.ws Agent`, serial `SN-THREEWS-0001`, five entities |
| It can be put in a room | Assigned the device to an area over the WebSocket API | All five entities moved to `Living Room` |
| Home Assistant reaches the agent | `switch.turn_on` on `switch.three_ws_agent` | The node's handler fired **328 ms** later; `turn_off` in 195 ms |
| The agent reaches Home Assistant | Flipped the node's occupancy attribute | `binary_sensor.three_ws_agent_occupancy` went `on` in **531 ms**, and back to `off` in 894 ms |
| A guarded action cannot ride in on a Matter automation | A real HA automation whose action turns on the Matter switch; the agent then tried `lock.unlock` on a real lock | Refused, `needs_confirmation`; `lock.front_door` still `locked` |
| The confirmation is real, not decorative | Replayed the pending action with an explicit human confirmation | Executed; the door unlocked |
| The node survives its own restart | Replaced the container on the same volume | Came back `commissioned=true`, no pairing code, no re-commissioning |
| It survives a restart of the controller and Home Assistant | Restarted both | Rediscovered on mDNS and resubscribed in ~1.5 s, no re-commissioning |
| Control comes back on its own after the node restarts | Restarted the node, then polled until a command landed | Recovered unattended in **39 s**; command latency back to 247 ms |

Steady-state cost of the agent's Matter node: **73 MB RSS and 0.03% of one CPU**, from a 430 MB
image. That is small enough that cost is not the objection.

### The one failure worth writing down

On the first pass the node never came back after a restart: Home Assistant held it
`unavailable` for twenty minutes while the node was up, reachable, and re-advertising. The
controller's own log gave it away: `The SDK is communicating with the device using
fe80::...`, and a `ping_node` answered `true` on the node's IPv4 and its ULA but `false` on
that link-local address. The CHIP SDK had picked an IPv6 link-local address it could not route
across a Docker bridge. Starting python-matter-server with `--primary-interface eth0` fixed it,
and the same restart then recovered unattended in 39 seconds.

It is an artefact of running the controller in a bridged container rather than on the host, so
it will not bite a normal household install, where Home Assistant is on host networking. It is
written down because it presents as "Matter is flaky" and is nothing of the kind.

### Why it is not built

Two reasons, in order of weight.

**1. A narrower pipe than the one already shipped.** The argument for an agent presenting itself
as a Matter device was that it becomes addressable by infrastructure the user already owns. That
argument was written before this campaign shipped the
[Home Assistant integration](../home-assistant-integration) and the
[dial-out relay](../services/home-relay/README.md). Those already put three.ws inside the user's
Home Assistant, with the full agent connection: tools, voice, the room graph, and the
confirmation protocol. Matter's device model would give that same Home Assistant a switch and a
sensor. Building it would spend real effort to offer a worse version of a channel that exists.

**2. The identity is a test identity.** The kernel commissioned as vendor ID `0xFFF1`, which the
CSA's own Distributed Compliance Ledger lists by the name **"Test"**, and it was accepted only
because the controller ships the `Chip-Test-PAA-FFF1` root certificate. python-matter-server
takes that; the major consumer ecosystems do not. Reaching a controller outside Home Assistant,
which is the entire point of "past the house", needs a real CSA vendor ID and certified device
attestation certificates. That is a membership and certification programme, not an afternoon.

A third, smaller reason: a Matter node has to sit on the user's own network, so it needs the
in-house deployment channel the HACS integration already occupies. Shipping it would mean asking
a household to install a second local component.

**Capability A, three.ws as a hub-less controller, is weaker still.** It is a substitute for
something the user already has. Anyone willing to run local software can run Home Assistant, and
get 1,500 integrations instead of the Matter subset. Worse, this lab proved IP commissioning for
an IP-based device we wrote ourselves; the consumer Matter devices a user would actually want to
adopt commission over BLE or Thread, which needs radio hardware on the user's network. Capability
A buys a smaller device set for a larger hardware requirement. Do not build it.

### What would have to change

Any one of these turns the answer over, and none of them is true today:

- **A controller outside Home Assistant becomes the goal.** A real CSA vendor ID and certified
  attestation are on the critical path from that day, so start there and not with the code.
- **The lane reaches steady operation.** Order 20 has not returned a go, and Matter is a horizon
  order for exactly this reason: it is a research project competing with a product that has not
  launched.
- **The endpoint model gets richer than a switch.** If a three.ws agent has something to say that
  Matter models well and the WebSocket channel models badly, that is a reason. Nothing found so
  far qualifies.

The safety rule is unchanged and is not negotiable if this is ever revisited: **a Matter fabric
is not a human saying yes.** A command arriving over Matter is a request, and anything guarded
still mints a confirmation. The kernel proved the existing gate already holds that line without
modification, including when the command arrives from an automation the user set up themselves.

---

## Security

The threat model for this lane, the injection boundary, the SSRF guard every server-side dial
goes through, and the residuals we accepted on purpose: [Home security](./home-security.md). It
is written about a building rather than about a database, and every claim in it is enforced by
[`tests/home-security.test.js`](../tests/home-security.test.js).

---

## Sources

- [home-assistant/core](https://github.com/home-assistant/core)
- [Home Assistant: Model Context Protocol Server integration](https://www.home-assistant.io/integrations/mcp_server/)
- [Home Assistant: Model Context Protocol integration](https://www.home-assistant.io/integrations/mcp/)
- [home-assistant/home-assistant-js-websocket](https://github.com/home-assistant/home-assistant-js-websocket)
- [Home Assistant WebSocket API reference](https://developers.home-assistant.io/docs/api/websocket/)
- [matter-js/matter.js](https://github.com/matter-js/matter.js) and [`@matter/main` on npm](https://www.npmjs.com/package/@matter/main)
- [home-assistant-libs/python-matter-server](https://github.com/home-assistant-libs/python-matter-server), the controller Home Assistant's Matter integration talks to
- [CSA Distributed Compliance Ledger](https://webui.dcl.csa-iot.org/), which is where vendor ID `0xFFF1` is listed as "Test"
- [rhasspy/wyoming-satellite](https://github.com/rhasspy/wyoming-satellite)
- [Home Assistant: about wake words](https://www.home-assistant.io/voice_control/about_wake_word/)
- [dscripka/openWakeWord](https://github.com/dscripka/openWakeWord), [snakers4/silero-vad](https://github.com/snakers4/silero-vad)
- [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat), [livekit/agents](https://github.com/livekit/agents)
- [ExperienceLovelace/ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan)
