# three.ws Home: the agent as the interface to your physical space

**Status:** research complete, architecture decided, implementation staged.
**Date:** 2026-09-02.
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
| [matter-js/matter.js](https://github.com/matter-js/matter.js) | 894 | Apache-2.0 | 2026-09-02 | TypeScript | **Phase 3.** A full Matter controller *and device* implementation in TypeScript. HA is migrating its own Matter integration onto it. This is how three.ws eventually talks to devices with no hub at all, and how a three.ws agent can *present itself* as a Matter device. |
| [zwave-js/zwave-js](https://github.com/zwave-js/zwave-js) | 887 | MIT | 2026-09-02 | TypeScript | Indirect. HA's Z-Wave layer is already this. |
| [Luligu/matterbridge](https://github.com/Luligu/matterbridge) | 963 | Apache-2.0 | 2026-09-02 | TypeScript | Reference. Best worked example of matter.js in the "expose things as Matter devices" direction. |

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
2. **`mcp_server` for actions.** The user's home becomes just another MCP server in an
   ecosystem where we already run 40+ of them. No new wire format, no new auth story, no
   custom command schema, and every capability the user exposes to their own LLM is exposed
   to their three.ws agent with identical permissions.
3. **`home-assistant-js-websocket` for state.** MCP is request/response. A living 3D scene
   needs a push stream. This library is first-party, dependency-free, and reconnects itself.
4. **HA scenes and scripts for macros.** "Good night" and "I'm leaving" are not new concepts
   we invent. They are `scene.turn_on` and `script.turn_on`, already modelled, already
   editable by the user in an interface they know. Our agent resolves intent to an existing
   scene, and only falls back to composing individual calls when no scene fits.

### Explicitly do not build

- A device driver, of any kind, for anything.
- A hub, a broker, or an automation rules engine.
- Another HA MCP server. The first-party one exists.
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
3. **A three.ws HA add-on that dials out.** A small custom component that opens an outbound
   WebSocket to three.ws and relays the two channels. This is the only option that works for
   an untouched LAN-only install, it is the one that ships through HACS, and it is phase 2.

We will not pretend option 1 covers everyone, and we will not ship option 3 as a stub.

### Permission model

Non-negotiable, and it borrows the shape of the existing on-chain spend gate: **an action
that changes physical state in a home is confirmed, not inferred.** Reads are free. Writes
are scoped to what the user exposed to the LLM API in Home Assistant itself (HA already has
this control, so we inherit it rather than inventing a parallel one). Locks, garage doors,
alarm panels, and anything HA marks as a security entity require an explicit confirmation
every time until the user grants a standing allowance per entity. A voice channel that can
unlock a front door on a misheard phoneme is not a feature, and the first-party HA exposure
setting is the correct place for that boundary to live.

---

## 5. Build plan

Each phase is shippable on its own and none of them block on the next.

**Phase 1: connect and act.**
`packages/home-bridge/` holds one client with the two channels (MCP over
`@modelcontextprotocol/sdk`, which is already a dependency at `^1.29.0`, and state over
`home-assistant-js-websocket`). A home connection record, a `/home` connect flow that takes
a base URL and a long-lived token, and the home tools registered into the existing agent
tool catalog. Verified against a real Home Assistant instance in Docker, not a fixture.

**Phase 2: the 3D home.** `/home` renders a live scene from the entity registry: areas
become rooms, lights become lights, and the agent stands in it. Scene lighting is driven by
real light state. This is the phase that produces the screenshot.

**Phase 3: voice, both directions.** The browser voice loop gains wake word and barge-in
(openWakeWord, silero-vad). Separately, we speak Wyoming so a Home Assistant pipeline can
select a three.ws agent as its satellite and get a face.

**Phase 4: past the house.** matter.js lets an agent be a Matter controller with no hub, and
lets a three.ws agent present itself as a Matter device. That is the door to cars, offices,
and robots, and it is the same protocol either way.

---

## 6. Licensing

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

## Sources

- [home-assistant/core](https://github.com/home-assistant/core)
- [Home Assistant: Model Context Protocol Server integration](https://www.home-assistant.io/integrations/mcp_server/)
- [Home Assistant: Model Context Protocol integration](https://www.home-assistant.io/integrations/mcp/)
- [home-assistant/home-assistant-js-websocket](https://github.com/home-assistant/home-assistant-js-websocket)
- [Home Assistant WebSocket API reference](https://developers.home-assistant.io/docs/api/websocket/)
- [matter-js/matter.js](https://github.com/matter-js/matter.js) and [`@matter/main` on npm](https://www.npmjs.com/package/@matter/main)
- [rhasspy/wyoming-satellite](https://github.com/rhasspy/wyoming-satellite)
- [Home Assistant: about wake words](https://www.home-assistant.io/voice_control/about_wake_word/)
- [dscripka/openWakeWord](https://github.com/dscripka/openWakeWord), [snakers4/silero-vad](https://github.com/snakers4/silero-vad)
- [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat), [livekit/agents](https://github.com/livekit/agents)
- [ExperienceLovelace/ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan)
