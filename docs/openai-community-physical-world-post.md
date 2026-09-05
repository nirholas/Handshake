---
title: "From a 3D connector to a physical-world API: what we shipped after the ChatGPT 3D Studio app"
venue: OpenAI Developer Community (community.openai.com)
account: nichxbt
category: API (Apps SDK / Actions / MCP)
tags: [chatgpt, apps-sdk, mcp, actions, 3d, agents]
description: "A long technical follow-up on the three.ws 3D Studio connector: the eleven keyless MCP tools, the surfaces we built on top of them, the 72-server MCP fleet behind them, and what building tools that spend money and touch physical objects taught us about tool design."
status: draft, not yet posted
---

# From a 3D connector to a physical-world API: what we shipped after the ChatGPT 3D Studio app

_Forum post for the [OpenAI Developer Community](https://community.openai.com), posted from the nichxbt account. Category: API (Apps SDK / Actions). First person, technical, no marketing voice. Every URL in this post is live, and every endpoint marked free is keyless: you can paste the curl commands into a terminal right now and get a real answer. three.ws is a Select Partner in the OpenAI Partner Network; the usual caveat applies, it is not an OpenAI product and is not endorsed by OpenAI beyond that designation._

---

Some months ago I wrote up how we shipped [three.ws](https://three.ws) 3D Studio into ChatGPT twice: once as an Apps SDK connector over MCP, and once as a custom GPT over Actions. That post was about getting a minute-long GPU job to survive a 45 second Action timeout and render inline in a chat.

This is the follow-up, and it is a different kind of post. The interesting problems stopped being about latency. Once an assistant can call a tool that produces a real 3D asset, the next questions are much harder to design around:

- What happens when a tool spends the user's money?
- What happens when a tool moves an object in the physical world, like a printer or a deadbolt?
- What does an agent do with a `.glb` URL it cannot see?
- How do you tell an agent that a tool it wants is degraded rather than broken?
- And once you have fifty tool servers, how does anything discover the right one?

We have shipped answers to all five, and I want to write them down properly, because I could not find them written down anywhere when I needed them. Everything below is open source (Apache-2.0) and readable at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws).

**Short version:** the free connector is still eleven tools and still keyless. On top of it we added a vision tool so the model can look at its own output, a physics grade so a simulator knows if an asset is usable, a manufacturing API so an agent can order a physical print of what it just generated, a home-control MCP server whose dangerous tools refuse over stdio by design, an open CC0 response shape for 3D results, and a set of health primitives that answer "can this agent act right now" instead of "is the process up". Behind all of it sits 72 MCP servers in the official registry and 91 npm packages, which is its own design problem and gets its own section.

**Contents**

1. Where things stand on the two ChatGPT surfaces
2. Tools that are not free and not reversible
3. `look_at_model`: the agent could not see its own output
4. Simulation readiness: a grade a physics engine can act on
5. Materialize: when the tool call ends in a cardboard box
6. `home-mcp`: the tool that refuses over stdio
7. Spatial MCP: a 3D scene should not be a URL in a text block
8. "Can it act?" is not "is it up?"
9. Where the model goes after the chat: embedding, and the animation problem
10. The fleet problem: 72 servers, and how a client is supposed to find one
11. Your coding agent has a face now
12. The whole surface, in tables
13. Affiliations, stated precisely
14. What I would like this forum's opinion on

---

## 1. Where things stand on the two ChatGPT surfaces

### The connector (Apps SDK / MCP)

`https://three.ws/api/mcp-studio`, Streamable HTTP, MCP protocol `2025-06-18`, no auth. It is deliberately scoped to 3D only: no wallet, no payments, no token, nothing a reviewer has to think twice about. `GET` is intentionally not offered (there is no server-initiated stream), every request is answered synchronously over `POST`, and `OPTIONS` is handled for CORS. Ask it what it has:

```bash
curl -s https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Eleven tools, as of today:

| Tool | What it does |
|---|---|
| `forge_free` | text to a textured GLB |
| `text_to_avatar` | text to a rigged humanoid, skinned, with 52 ARKit blendshapes |
| `mesh_forge` | image or sketch to a mesh |
| `rig_mesh` | add a humanoid skeleton to a static GLB you already have |
| `forge_avatar` | photo to avatar |
| `refine_model` | iterate on a previous result; every refinement is its own version with its own AR link |
| `check_job` | collect a generation that outran the tool call |
| `look_at_model` | render a model to images the assistant can actually see (section 3) |
| `create_agent_persona` | give a rigged body a name and a personality |
| `get_agent_persona` | read one back |
| `persona_say` | make it say a line, with real lipsync, on a living page |

Each generation tool renders inline through an Apps SDK widget (`ui://widget/three-studio-model.html`) with a rotatable viewer and a **View in your space** button for AR. If the result is rigged, the response also carries an `irlUrl` and the button becomes **Bring it to life**. The persona tools render in their own widget (`ui://widget/three-studio-persona.html`).

The one production gotcha from the original post is still the most common failure I get asked about, so I will repeat it: **the widget's `openai/widgetCSP` allowlist must include the origin your GLB is served from.** Real ChatGPT enforces that CSP. A widget that renders in a permissive local harness and shows a blank viewer in production is almost always this, and there is no console error you will see from the outside.

### The custom GPT (Actions)

Same free lane as plain REST, for people whose plan does not do connectors. OpenAPI 3.1 served at `https://three.ws/.well-known/3d-studio-openapi.yaml`, imported by URL rather than pasted inline (pasting means the GPT builder holds a snapshot that silently drifts from the contract you actually serve).

```bash
curl -s -X POST https://three.ws/api/3d/studio \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'
```

Submit never blocks. It answers `pending` with a `poll` path that already carries the job handle and title, an `etaSeconds`, a `watchUrl` the user can open (it shows the concept art and a real countdown and opens the finished model by itself), and frequently a `previewImageUrl`, because our text-to-3D path goes through an intermediate image and there is no reason to hide it. The GPT shows that image as markdown while it waits. It is a cheap trick and it makes the minute feel like fifteen seconds.

The poll endpoint returns `429` with a `retry_after` if the model polls too fast, and the GPT's instructions tell it to honour that rather than to tell the user something broke. That one line removed most of our "it says it failed but the model arrived" reports.

---

## 2. The design problem nobody warns you about: tools that are not free and not reversible

A read-only tool has one failure mode: it returns nothing useful. A tool that spends money or moves matter has a completely different risk surface, and MCP's annotation vocabulary (`readOnlyHint`, `destructiveHint`, `openWorldHint`) is necessary but nowhere near sufficient. Annotations tell the client what a tool is. They do not stop the tool.

We ended up with four rules, each learned the hard way.

**Rule 1: the refusal lives on the server, not in the prompt.** Any guard that exists only as instruction text is a guard an assistant can be argued out of. In our smart home tools, a household member with the `guest` role cannot approve unlocking a door. Not "the UI hides the button": the server refuses, so no client, ours or anyone else's, could offer it. We wrote the refusal into the API first and the interface second, deliberately.

**Rule 2: charge nothing until the refusal has run.** Our [Knock](https://three.ws/knock) surface lets someone pay to get one message to a stranger. Price, daily cap, message length limit, and block list are all evaluated **before** any payment is attempted, so a knock that was never going to land is never a knock somebody paid for. Sequencing the check after the charge is the natural way to write it and it is wrong.

**Rule 3: a tool that makes a physical object needs a content gate that is allowed to say no.** Our [Materialize](https://three.ws/materialize) lane turns a generated model into a real printed object shipped to an address. It screens and refuses weapons, functional key duplicates, and third-party brand marks before anything reaches production. A print bureau has a human at that checkpoint. An API where an agent is the buyer does not, so the checkpoint has to be code.

**Rule 4: keep the free surface and the paid surface on different servers.** Not a flag, not a scope: different origins with different code. Our free 3D server has no payment code in it at all. Not disabled, absent. A reviewer can verify that in a minute, and so can we, forever. The paid sibling lives at `/api/mcp-3d` and shares none of the free server's surface.

If you are shipping a plugin whose tools cost the user money, the OpenAI review guidelines on deceptive commerce are worth reading as a design spec rather than a compliance checklist. The rule that matters in practice: never present a call as free and then charge for it.

---

## 3. `look_at_model`: the agent could not see its own output

Every text-to-3D API, ours included, historically answered with a URL to a binary file. A human clicks it. **An agent cannot.** A `.glb` is opaque to a language model, so the assistant that just spent GPU time generating an asset has no way to tell a clean mesh from a melted one. It hands over the link and hopes.

That is the reason agentic 3D stalls after one shot: there is no feedback signal to iterate on.

`look_at_model` renders the model from several angles and returns the frames as **MCP image content blocks**, so a multimodal client renders them straight into the conversation and the model looks at the thing it made. Alongside the frames it returns geometry facts (triangle count, bounds, material count, whether it is skinned) and a plain-language reading of them.

Three ways in, depending on what you are:

| You are | Use | You get |
|---|---|---|
| An MCP client | tool `look_at_model` on `/api/mcp-studio` | frames as MCP image blocks, rendered inline |
| A Node program | [`@three-ws/see`](https://www.npmjs.com/package/@three-ws/see) | `see(url)` gives views, stats, notes |
| Anything with HTTP | `POST /api/3d/look` | JSON with a frame URL per angle |

```bash
curl -s -X POST https://three.ws/api/3d/look \
  -H 'content-type: application/json' \
  -d '{"src":"https://three.ws/avatars/cesium-man.glb"}'
```

The loop this unlocks is the whole point: generate, look, judge, call `refine_model`, look again. If you take one idea from this post, take this one: **any tool that hands an agent a binary is a tool that needs a companion that renders it into the agent's own modality.** Ours was 3D. Yours might be a PDF, a spreadsheet, a waveform, a CAD file.

A neighbour of this that came from the same insight: [`@three-ws/glb-diff`](https://www.npmjs.com/package/@three-ws/glb-diff) and the [Model Diff](https://three.ws/diff) page, which answer "what actually changed between these two versions of the mesh" structurally rather than by eyeballing two viewers. An agent iterating on an asset needs to know whether its last edit did anything.

---

## 4. Simulation readiness: a grade a physics engine can act on

A renderer forgives almost everything. A rigid-body solver forgives nothing. The same mesh that looks perfect in a viewer can sink through the floor in MuJoCo, spin like it is hollow in Bullet, or turn out to be a metre tall when you asked for a teapot, because the generator fitted it to a unit box and nothing in the file says so.

So we published a grade, free and keyless:

```bash
curl "https://three.ws/api/sim-readiness?src=https://three.ws/avatars/cesium-man.glb"
```

```jsonc
{
  "verdict": "simulation_ready",
  "blockers": [],
  "warnings": ["skinned_geometry_graded_at_bind_pose"],
  "grader": "threews.sim.readiness.v1",
  "glbSha256": "b7001eaeea8254bd…"
}
```

Four verdicts, and the distinction between the middle two is the useful part:

| Verdict | Meaning | What you do |
|---|---|---|
| `simulation_ready` | Closed surface, consistent winding, positive volume, real-world extents | Use it as a rigid body, and trust the reported mass |
| `needs_scale` | Geometry is sound, only the units are missing | Multiply to the intended size; mass properties scale with it |
| `needs_repair` | Open, non-manifold, or inconsistently wound | Close the surface first; do not trust the mass |
| `unusable` | No triangles, or zero volume | Reject it |

There is a fifth value, `unreadable`, for bytes that are not binary glTF 2.0 at all, kept deliberately distinct from `unusable`: one is a broken file, the other is a valid file with nothing to simulate.

The grade is content-addressed by the GLB's SHA-256, so the same bytes always get the same verdict and the result caches cleanly. The spec is CC0 ([`specs/SIM_READINESS.md`](https://github.com/nirholas/three.ws/blob/main/specs/SIM_READINESS.md)) and the grader is a pure function you can vendor. It is also permanently free as a tool (`grade_sim_readiness`) on our **paid** MCP server, which is a deliberate exception: an assurance check that costs money is a check nobody runs, and a check nobody runs prevents nothing.

If you are building anything where an LLM produces assets for a simulator, a game engine, or a robotics stack, please steal this idea even if you never touch our endpoint. The absence of a machine-readable claim about physical usability is a real hole in the glTF ecosystem.

---

## 5. Materialize: what happens when the tool call ends in a cardboard box

[Materialize](https://three.ws/materialize) is the physical lane. Describe an object, generate it, then have it printed in resin, nylon, colour sandstone, or steel and shipped. The whole loop is also an API, which means an autonomous agent can order a physical object of a model it just generated with no human in the loop.

```
  a forge creation            a GLB you upload            an agent
        │                           │                           │
        └───────────────┬───────────┴───────────────────────────┘
                        ▼
        POST /api/print/quote      printability report + itemized price
                        │          + a signed quote token (24 hours)
                        ▼
        POST /api/print/orders     human checkout
        POST /api/x402/print-order agent checkout, same pipeline
                        ▼
        safety screening ──▶ production ──▶ quality check ──▶ shipped
                        ▼
        certificate of authenticity, QR in the box
```

1. **Analysis, free and keyless.** `POST /api/print/quote` with a model returns the printability report before any price: whether the mesh is a closed solid, how many separate bodies it contains, where its holes are, its thinnest wall, its exact volume, and a 0 to 100 score with named deductions written for a person, not a slicer. Free because an agent that can check printability before paying to generate spends less overall.
2. **A signed quote token**, valid 24 hours, so the price an agent was quoted is the price it pays and nothing in between can move it.
3. **Two checkouts, one pipeline.** A human pays in the browser; an agent pays over HTTP 402. Same order record, same statuses, same fulfillment.
4. **Safety screening** before production, as described above.
5. **Provenance in the box.** Every print ships with a certificate of authenticity, attested publicly, with a QR code, so the object can prove which generation produced it. Creators can cap how many copies of a model will ever exist.
6. **Order tracking at every step**, because "the agent bought something and nobody can say where it is" is not a shippable state.

The design lesson for tool authors: **an irreversible tool needs a free, honest dry run in front of it.** Quote is free, detailed, and refusable. Order is the only call that costs anything, and by then every question has already been asked and answered by a machine that could still change its mind.

---

## 6. `home-mcp`: the tool that refuses over stdio

This is the surface I would most like feedback on, because I think the pattern generalises past homes.

[three.ws Home](https://three.ws/smart-home) connects an agent to a real house through [Home Assistant](https://www.home-assistant.io), which already owns the device layer (1,500-plus integrations, every protocol we would otherwise implement, around 90k stars) and speaks MCP natively. We wrote no device code at all. What we added is the part nobody ships: a 3D presence that stands in a live model of your home, reacts to it, and talks to you.

We also published [`@three-ws/home-mcp`](https://www.npmjs.com/package/@three-ws/home-mcp), five tools that let any MCP assistant read the house, list entities, list the scenes the household already built, run one, and call a service:

```bash
claude mcp add home \
  -e HOME_ASSISTANT_URL=https://example.ui.nabu.casa \
  -e HOME_ASSISTANT_TOKEN=... \
  -- npx -y @three-ws/home-mcp
```

Every call that would open the house passes through a physical-action gate, and **over stdio that gate refuses**. Not "prompts". Refuses. The reasoning: a stdio MCP server has no user-visible surface of its own, no session, and no way to prove that a human saw the request and approved it. Anything that presents itself as consent in that environment is a fiction. So unlocking is only available on surfaces where a real person can be shown a real prompt, and the local server tells the assistant plainly that it will not do it and why. The gate has one implementation shared with [`@three-ws/home-bridge`](https://www.npmjs.com/package/@three-ws/home-bridge) rather than a second copy that can drift.

Adjacent decisions from the same wave, since they are all the same trust question:

- **Households and five roles**, each stating in plain language, at the moment you pick it, what it can and cannot do. A guest can turn on lights and can never approve unlocking anything. Scoped guests receive only the rooms they were given: the others are **removed from the payload**, not hidden in the UI, so their client never learns those rooms exist. Invitations work once, expire after a week, and can be withdrawn. Removing someone revokes every standing allowance they ever approved, in the same instant. Every action in the home log is attributed to the person who took it.
- **A relay for houses with no public address**, which is the default Home Assistant install. The house dials us over one outgoing WebSocket; we never dial the house, no port is forwarded, no tunnel daemon runs, and **we never receive a Home Assistant token**, because the integration mints its own credential locally and it never leaves the building. The threat model is published.
- **Voice**, hands-free, with an explicit rule that a background "yeah" can never approve a lock: confirmation for a physical action requires an intentional utterance, not an affirmative-sounding noise.
- **A Home Assistant voice satellite can wear the agent's face**, so the assistant already in the kitchen gets a body rather than a speaker grille.
- **Data**: see, export, and delete everything a connected home stores, on one page.
- **We evaluated exposing the agent as a Matter device, measured it, and decided against it for now**, and published the negative result instead of quietly dropping it.

The car surface came out of the same design ([three.ws Drive](https://three.ws/drive)), and it is worth a sentence here because it is a pure Apps-SDK-shaped constraint problem: in a car, voice is not one interface among several, it is the only one that is legal. iOS 26.4 added a CarPlay category for voice-based conversational apps with its own entitlement, and iOS 27 let the Voice Control template overlay other templates. What Apple does **not** give a conversational app is a drawing surface, so the honest architecture is a voice-first agent whose control surface is Apple's templates and whose face lives on the phone in the cradle, the passenger display, or an open head unit. The Android Auto car app is written and compiled; the CarPlay scene is written and waiting on Apple's entitlement grant.

---

## 7. Spatial MCP: a 3D scene should not be a URL in a text block

A tool that returns a 3D result today returns a link. The client prints it. The user clicks it and leaves the conversation. That is the whole state of the art, and it is bad for exactly the same reason a chart returned as a URL would be bad.

[Spatial MCP](https://three.ws/spatial-mcp) is the open response shape we published for this: a renderer-agnostic, CC0 description of a 3D scene that an MCP client can render natively as a result, rather than a string containing an address. three.ws is the reference implementation, the validator and conformance fixtures are published as [`@three-ws/spatial-mcp`](https://www.npmjs.com/package/@three-ws/spatial-mcp), and the shape carries no payment, wallet, or token surface at all, because a wire format that smuggles commerce into it will never be adopted by anyone.

I would genuinely like other 3D tool authors here to adopt or fork it. A shared shape is worth more to all of us than our particular version of it.

---

## 8. "Can it act?" is not the same question as "is it up?"

Every liveness check we had was correct, and none of them could tell us that ten of twelve armed autonomous agents had not attempted an action in weeks. The process was `Ready`, the feed was streaming, every row said `enabled = true`.

Three unrelated things were wrong: the deployed worker image predated the commit that moved the free model chain onto models that still exist, so the whole chain answered 404 and 410; the surviving providers were out of credit or on a billing hold; and several agent wallets could not fund a single action.

Liveness measures the process. Acting requires a chain of preconditions the process knows nothing about. So we built [agent vitals](https://three.ws/docs/agent-vitals): preconditions declared as **vitals** with `needs` edges, actions as **capabilities** that AND over them, and attestation that returns the **root** blocker rather than a symptom.

```
deploy-fresh ──> cognition ──┐
                             ├──> [enter]
armed, solvency, feed, rpc ──┘

rpc ─────────────────────────────> [exit]
```

It is a framework-agnostic package with no dependencies ([`packages/agent-vitals`](https://github.com/nirholas/three.ws/tree/main/packages/agent-vitals)). Nothing about it is specific to our platform, and if you run an agent fleet I think you want something like it. "Healthy and structurally unable to work" will not show up in your existing metrics.

Two neighbours from the same problem:

- [Brownout](https://three.ws/brownout) and [`@three-ws/brownout`](https://www.npmjs.com/package/@three-ws/brownout): read where an API's data came from and how fresh it is, and publish **proven** fallbacks rather than promised ones. A failover path nobody has exercised under load is a hypothesis, not a fallback.
- [x402 Preflight](https://three.ws/preflight) and [`@three-ws/x402-preflight`](https://www.npmjs.com/package/@three-ws/x402-preflight): ask a paid seller whether it can actually settle before signing anything.

And a third, which is a testing tool rather than a runtime one: [`@three-ws/witness`](https://www.npmjs.com/package/@three-ws/witness) records what a person actually did and compiles it into a Playwright spec that is **red while the bug exists and green once it is fixed**. A bug report is a description of an experiment somebody else has to reconstruct, the reconstruction is where most reports die, and it is the part a machine can do. It works on any site, with or without the rest of our stack.

---

## 9. Where the model goes after the chat

A recurring question in the original thread was some version of "great, I generated a fox in ChatGPT, now what". The answer is the part of the platform that has nothing to do with OpenAI, and it is worth summarising because it is what makes the connector more than a toy.

**Embedding.** Every generated avatar is a web component. One tag on any page:

```html
<script type="module" src="https://three.ws/embed.js"></script>
<agent-3d agent="<id>"></agent-3d>
```

There are also framework and use-case wrappers: [`@three-ws/react`](https://www.npmjs.com/package/@three-ws/react), an avatar overlay that reacts to buttons and navigation, a floating concierge chat widget, a page narrator that reads the page it lives on, a walk companion that roams a corner of the screen, and a guided tour agent. All of them are paste-in snippets with no backend on your side.

**Animation, which is the part people underestimate.** A rigged model is useless if your clip library only fits one naming convention. Ours canonicalises bone names across Mixamo, Avaturn, Unreal, VRM and VRoid, VRM 1.0, Daz/Genesis, MakeHuman, Blender `.L`/`.R`, and simple `shoulderL` rigs, then retargets idle, walk and the rest onto whatever came in, legs included. There is **no rig allowlist**: a model that genuinely cannot be skeleton-driven falls back to a default rig rather than a bind-pose T-pose. That logic is published as [`@three-ws/retarget`](https://www.npmjs.com/package/@three-ws/retarget). If you have ever hand-mapped a skeleton, this is the package to steal.

**Delivery.** [`@three-ws/avatar-stream`](https://www.npmjs.com/package/@three-ws/avatar-stream) packs a GLB into a layered progressive stream over plain HTTP, so a heavy avatar shows something correct early instead of blocking on the whole file. [`@three-ws/render`](https://www.npmjs.com/package/@three-ws/render) renders rigged avatars to PNG, GIF, and truecolor terminal frames server-side, which is how the same agent shows up in a GitHub README, a Slack message, and a Windows 11 widget board.

**One command, if you want the whole thing scaffolded:**

```bash
npx @three-ws/create-agent
```

That goes from a sentence to a rigged, animated 3D agent you can embed.

**And the odd one out:** [Portal](https://three.ws/portal) turns any website into a walkable 3D world by reading the page's real structure, and exposes that shape over MCP. The reason it belongs in this post: an agent that fetches a page gets a wall of text, but over Portal it gets the page's *shape*, which is small enough to reason about and spatial enough to hand back as somewhere a human can actually go.

---

## 10. The fleet problem: 72 servers, and how a client is supposed to find one

This is the section I would have wanted to read a year ago.

As of a footprint audit on 2026-08-25, three.ws publishes **72 MCP servers in the official Model Context Protocol registry** under one namespace (`io.github.nirholas`), and **91 packages on npm** under `@three-ws`, 39 of which are MCP servers in this repository. That is not a brag, it is a confession: it is too many, and the reason it happened is instructive.

Every capability that felt independently useful became its own server, because a server is cheap to publish and MCP has no first-class notion of a namespace or a bundle. The result is a discovery problem that the registry alone does not solve, and every multi-server publisher I have talked to has it.

What we do about it, in the order we found it worked:

1. **One tightly scoped server per audience, not per capability.** The ChatGPT-facing server is exactly the 3D tools and nothing else. The plugin guidelines reward tightly scoped apps and reject generic ones, and thirty-seven separately submitted servers would read as directory spam even if each one were good. Submit one, document the rest as direct connections.
2. **One hosted server behind OAuth 2.1** (`https://three.ws/api/mcp`) that carries the whole platform for clients that want everything, with `/.well-known/oauth-protected-resource` discovery routed properly. Discovery metadata that 404s is the single most common reason an otherwise-correct server fails a client's auth handshake.
3. **Typed tool authoring, shared.** [`@three-ws/tool-sdk`](https://www.npmjs.com/package/@three-ws/tool-sdk) gives us `defineTool` and `defineExec` so annotations, schemas, and error shapes cannot drift server to server. Fifty servers written by hand will disagree about error shape by the third one.
4. **Publish where clients actually look.** The registry is necessary and not sufficient: 18 of ours are indexed on PulseMCP and 10 on Glama, a LobeHub plugin manifest is served from our own domain, and four Claude Code plugins ship from the repo's own marketplace.

If you are about to publish your fifth MCP server, my honest advice is to stop and ask whether it is a server or a tool namespace inside one. We answered that question late.

---

## 11. Your coding agent has a face now

Not an OpenAI surface, but it is the thing developers respond to most, so it belongs here. `npx @three-ws/tty-avatar <id>` draws any three.ws avatar in colour at 24fps in a plain terminal, no browser and no GPU, using truecolor half-blocks, braille cells (2x4 dots per cell for four times the vertical detail), or a plain luminance ramp when the output is piped.

The second half is the point:

```bash
npx @three-ws/tty-avatar install-hooks --write
```

That merges hook entries into your coding agent's settings (leaving any you already have alone, and it is idempotent). Open two panes: viewer in one, agent in the other. The avatar looks up and thinks while the agent reads your prompt, nods while it edits and runs commands, shakes when a tool fails, pulses when it is waiting on you, and bounces when it finishes, with a caption saying what it is doing right now (`editing index.js`, `$ npm test`, `searching`).

An ambient face in a second pane turns out to be a much better progress indicator than a spinner, because you read its posture without switching focus. The renderer core is separately published as [`@three-ws/tty-3d`](https://www.npmjs.com/package/@three-ws/tty-3d) if you want to draw something else.

---

## 12. The whole surface, in tables

**Free and keyless.** Paste and run.

| What | Endpoint |
|---|---|
| 3D Studio MCP, 11 tools | `POST https://three.ws/api/mcp-studio` |
| 3D Studio Actions | `POST https://three.ws/api/3d/studio` |
| Look at a model | `POST https://three.ws/api/3d/look` |
| Simulation readiness | `GET https://three.ws/api/sim-readiness?src=…` |
| Printability report and quote | `POST https://three.ws/api/print/quote` |
| Live commit and revision of production | `GET https://three.ws/api/version` |

**Paid or gated**, on separate servers from the free ones.

| What | Where | Payment |
|---|---|---|
| Full platform MCP | `https://three.ws/api/mcp` | OAuth 2.1 |
| Paid 3D studio (rig, animate, retexture, analyse) | `https://three.ws/api/mcp-3d` | OAuth 2.1 or per call over HTTP 402 |
| Print order | `POST /api/print/orders` or the 402 lane | per order |
| Reach a person | [`@three-ws/knock-mcp`](https://www.npmjs.com/package/@three-ws/knock-mcp) | the door owner's price |
| Home control | [`@three-ws/home-mcp`](https://www.npmjs.com/package/@three-ws/home-mcp) | free, gated, refuses over stdio |

**The footprint behind it**, from an audit dated 2026-08-25 unless noted:

| | |
|---|---|
| npm packages under `@three-ws` | 91 in this repo (101 across the wider scope at audit time) |
| MCP servers in the official registry | 72, namespace `io.github.nirholas` |
| GPU and service workers | 32 in-repo, running open model families (Hunyuan3D, TRELLIS, TripoSG, TripoSR) plus rig, remesh, texture, segment, stylize, rembg, motion and vision lanes |
| Public pages | 795, of which 128 were added since 1 August 2026 |
| Specs | 31, including the CC0 Spatial MCP and simulation-readiness shapes |
| Test files | around 1,750 |

Every generation lane has a failover chain, so a single model being unavailable degrades quality rather than failing the request. `GET /api/version` returns the exact commit production is running, so you can check that what is deployed is what is on GitHub.

---

## 13. Affiliations, stated precisely

I would rather over-disclose than let a reader assume something wrong:

- **OpenAI**: three.ws is a **Select Partner in the OpenAI Partner Network**. That is a partner designation, not an endorsement, and three.ws is not an OpenAI product. The free connector is the surface submitted for the plugin directory; the ChatGPT app and the custom GPT are our own builds against public APIs. Our Cookbook PR is open and unmerged; I mention it because pretending otherwise would be silly.
- **IBM**: Business Partner. Agents can run on IBM Granite models served through watsonx.ai. Our public Granite-backed demo endpoints are independent developer tools, not IBM products, not endorsed by IBM.
- **AWS**: AWS Partner, with a built and deployed Marketplace SaaS integration. The listing itself is not yet public, so there is nothing to subscribe to on the AWS side today.
- **Google Cloud**: member of Google Cloud for Web3 Startups. Production (API, frontend, GPU workers) runs on Cloud Run, with Vertex AI in the model chain.
- **NVIDIA**: Inception member since July 2026. A startup programme, not a partnership or an endorsement.
- **Alibaba Cloud**: listed on the Alibaba Cloud International Marketplace, with Qwen models as lanes in the model router.
- **Solana Mobile**: the Android app is live on the Solana dApp Store. The iOS app exists in the repo and has not been submitted.

---

## 14. What I would like this forum's opinion on

1. **Physical-action tools and MCP annotations.** `destructiveHint` covers "this deletes something". It does not distinguish "this spends $40" from "this unlocks a door in a house where a child is asleep". Is anyone modelling that distinction in a way clients could act on, or are we all inventing per-server gates?
2. **Consent in stdio MCP servers.** Our answer was to refuse outright. Is there a pattern where a stdio server can obtain provable human consent without pushing the user to a hosted surface?
3. **Long jobs in Actions.** Our submit-and-poll shape with `etaSeconds`, a `watchUrl`, a preview image, and an honoured `429 retry_after` works well, but every builder reinvents it. Is there appetite for a convention?
4. **Binary results.** `look_at_model` was the highest-leverage tool we shipped this year, and it exists only because a binary URL is useless to a model. What other formats does your agent hand back to itself blind?
5. **Fleet discovery.** If you publish more than a handful of MCP servers, how are you handling namespacing and discovery? I do not think the answer we arrived at is the right one, only the one that worked.

Happy to answer anything about the internals. The whole stack is Apache-2.0 at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws), and the docs index is at [three.ws/docs](https://three.ws/docs).
