---
title: "From a 3D connector to a physical-world API: what we shipped after the ChatGPT 3D Studio app"
venue: OpenAI Developer Community (community.openai.com)
account: nichxbt
category: API (Apps SDK / Actions / MCP)
tags: [chatgpt, apps-sdk, mcp, actions, 3d, agents]
description: "A long technical follow-up on the three.ws 3D Studio connector: the eleven keyless MCP tools, the twelve surfaces we added on top of them, and what building tools that spend money and touch physical objects taught us about tool design."
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
- How do you tell an agent that a tool it wants is temporarily degraded rather than broken?

We now have shipped answers to all four, and I want to write them down properly, because I could not find them written down anywhere when I needed them. Everything below is open source (Apache-2.0) and readable at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws).

**Short version:** the free connector is still eleven tools and still keyless. On top of it we added a vision tool so the model can look at its own output, a physics grade so a simulator knows if an asset is usable, a manufacturing API so an agent can order a physical print of what it just generated, a home-control MCP server whose dangerous tools refuse over stdio by design, and a set of health primitives that answer "can this agent act right now" instead of "is the process up".

---

## 1. Where things stand on the two ChatGPT surfaces

### The connector (Apps SDK / MCP)

`https://three.ws/api/mcp-studio`, Streamable HTTP, MCP protocol `2025-06-18`, no auth. It is deliberately scoped to 3D only: no wallet, no payments, no token, nothing a reviewer has to think twice about. Ask it what it has:

```bash
curl -s https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Eleven tools, as of today:

| Tool | What it does |
|---|---|
| `forge_free` | text to a textured GLB |
| `text_to_avatar` | text to a rigged humanoid, skinned, with ARKit blendshapes |
| `mesh_forge` | image or sketch to a mesh |
| `rig_mesh` | add a humanoid skeleton to a static GLB you already have |
| `forge_avatar` | photo to avatar |
| `refine_model` | iterate on a previous result; every refinement is its own version |
| `check_job` | collect a generation that outran the tool call |
| `look_at_model` | render a model to images the assistant can actually see (section 3) |
| `create_agent_persona` / `get_agent_persona` / `persona_say` | give a rigged body a name, a voice line, and a living page |

Each generation tool renders inline through an Apps SDK widget with a rotatable viewer and a **View in your space** button for AR. If the result is rigged, the button becomes **Bring it to life**.

The one production gotcha from the original post is still the single most common failure I get asked about, so I will repeat it: **the widget's `openai/widgetCSP` allowlist must include the origin your GLB is served from.** Real ChatGPT enforces that CSP. A widget that renders in a permissive local harness and shows a blank viewer in production is almost always this, and there is no console error you will see from the outside.

### The custom GPT (Actions)

Same free lane as plain REST, for people whose plan does not do connectors. OpenAPI 3.1 served at `https://three.ws/.well-known/3d-studio-openapi.yaml`, imported by URL rather than pasted inline.

```bash
curl -s -X POST https://three.ws/api/3d/studio \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'
```

Submit never blocks. It answers `pending` with a `poll` path, an `etaSeconds`, a `watchUrl` the user can open, and (because our text-to-3D path goes through an intermediate image) frequently a `previewImageUrl` of the concept art the geometry model is about to sculpt. The GPT shows that image while it waits. It is a cheap trick and it makes the minute feel like fifteen seconds.

---

## 2. The design problem nobody warns you about: tools that are not free and not reversible

A read-only tool has one failure mode: it returns nothing useful. A tool that spends money or moves matter has a completely different risk surface, and MCP's annotation vocabulary (`readOnlyHint`, `destructiveHint`, `openWorldHint`) is necessary but nowhere near sufficient. Annotations tell the client what a tool is. They do not stop the tool.

We ended up with three rules, each learned the hard way.

**Rule 1: the refusal has to live on the server, not in the prompt.** Any guard that exists only as instruction text is a guard an assistant can be argued out of. In our smart home tools, a household member with the `guest` role cannot approve unlocking a door. Not "the UI hides the button": the server refuses the call, so there is no version of any client, ours or yours, that could offer it. When we scoped the household roles we wrote the refusal into the API first and the interface second, on purpose.

**Rule 2: charge nothing until the refusal has run.** Our [Knock](https://three.ws/knock) surface lets someone pay to get one message to a stranger. Price, daily cap, message length limit, and block list are all evaluated **before** any payment is attempted, so a knock that was never going to land is never a knock somebody paid for. Sequencing the check after the charge is the natural way to write it and it is wrong.

**Rule 3: a tool that makes a physical object needs a content gate that is allowed to say no.** Our [Materialize](https://three.ws/materialize) lane turns a generated model into a real printed object shipped to an address. It screens and refuses weapons, functional key duplicates, and third-party brand marks before anything reaches production. A print bureau has a human at that checkpoint. An API where an agent is the buyer does not, so the checkpoint has to be code.

If you are shipping a plugin whose tools cost the user money, the OpenAI review guidelines on deceptive commerce are worth reading as a design spec rather than a compliance checklist. The rule that matters in practice: never present a call as free and then charge for it. Our paid tools live on a completely separate server from the free ones, and the free server has no payment surface at all to get confused about.

---

## 3. `look_at_model`: the agent could not see its own output

Every text-to-3D API, ours included, historically answered with a URL to a binary file. A human clicks it. **An agent cannot.** A `.glb` is opaque to a language model, so the assistant that just spent GPU time generating an asset has no way to tell a clean mesh from a melted one. It hands over the link and hopes.

That is the reason agentic 3D stalls after one shot: there is no feedback signal to iterate on.

`look_at_model` renders the model from several angles and returns the frames as **MCP image content blocks**, so a multimodal client renders them straight into the conversation and the model looks at the thing it made. Alongside the frames it returns geometry facts (triangle count, bounds, material count, whether it is skinned) and a plain-language reading of them.

The loop this unlocks is the whole point: generate, look, judge, call `refine_model`, look again. Same over plain HTTP if you are not in an MCP client:

```bash
curl -s -X POST https://three.ws/api/3d/look \
  -H 'content-type: application/json' \
  -d '{"src":"https://three.ws/avatars/cesium-man.glb"}'
```

---

## 4. Simulation readiness: a grade a physics engine can act on

A renderer forgives almost everything. A rigid-body solver forgives nothing. The same mesh that looks perfect in a viewer can sink through the floor in MuJoCo, spin like it is hollow in Bullet, or turn out to be a metre tall when you asked for a teapot, because the generator fitted it to a unit box and nothing in the file says so.

So we published a grade, free and keyless:

```bash
curl "https://three.ws/api/sim-readiness?src=https://three.ws/avatars/cesium-man.glb"
```

Four verdicts, and the distinction between the middle two is the useful part:

| Verdict | Meaning |
|---|---|
| `simulation_ready` | Closed surface, consistent winding, positive volume, real-world extents. Use the reported mass. |
| `needs_scale` | Geometry is sound, only the units are missing. Multiply and go. |
| `needs_repair` | Open, non-manifold, or inconsistently wound. Mass properties are reported but not trustworthy. |
| `unusable` | No triangles, or zero volume. |

The spec is CC0 ([`specs/SIM_READINESS.md`](https://github.com/nirholas/three.ws/blob/main/specs/SIM_READINESS.md)) and the grader is a pure function you can vendor. It is also a free tool (`grade_sim_readiness`) on our paid 3D MCP server, permanently free on purpose: an assurance check that costs money is a check nobody runs, and a check nobody runs prevents nothing.

If you are building anything where an LLM produces assets for a simulator, a game engine, or a robotics stack, please steal this idea even if you never touch our endpoint. The absence of a machine-readable claim about physical usability is a real hole in the glTF ecosystem.

---

## 5. Materialize: what happens when the tool call ends in a cardboard box

[Materialize](https://three.ws/materialize) is the physical lane. Describe an object, generate it, then have it printed in resin, nylon, colour sandstone, or steel and shipped. The whole loop is also an API, which means an autonomous agent can order a physical object of a model it just generated with no human in the loop.

The pipeline, and the reasons each stage exists:

1. **Analysis, free and keyless.** `POST /api/print/quote` with a model returns a printability report before any price: is the mesh a closed solid, how many separate bodies, where the holes are, thinnest wall, exact volume, and a 0 to 100 score with named deductions written in plain language. Free because an agent that can check printability before paying to generate spends less overall.
2. **A signed quote token**, valid 24 hours, so the price an agent was quoted is the price it pays.
3. **Checkout, two ways.** A human pays in the browser; an agent pays over HTTP 402 against the same pipeline. Same order, same statuses.
4. **Safety screening**, described above, before production.
5. **A certificate of authenticity** attested on-chain, with a QR code in the box, so the object can prove which generation produced it. Limited editions can cap how many copies of a model will ever exist.

The design lesson for tool authors: **an irreversible tool needs a free, honest dry run in front of it.** Quote is free, detailed, and refusable. Order is the only call that costs anything, and by then every question has already been answered.

---

## 6. `home-mcp`: the tool that refuses over stdio

This is the surface I would most like feedback on from this forum, because I think the pattern generalises.

[three.ws Home](https://three.ws/smart-home) connects an agent to a real house through [Home Assistant](https://www.home-assistant.io), which already owns the device layer (1,500-plus integrations, every protocol we would otherwise have to implement) and speaks MCP natively. We wrote no device code at all. What we added is the part nobody ships: a 3D presence that stands in a live model of your home, reacts to it, and talks to you.

We also published [`@three-ws/home-mcp`](https://www.npmjs.com/package/@three-ws/home-mcp), five tools that let any MCP assistant read the house, list entities, list the scenes the household already built, run one, and call a service:

```bash
claude mcp add home \
  -e HOME_ASSISTANT_URL=https://example.ui.nabu.casa \
  -e HOME_ASSISTANT_TOKEN=... \
  -- npx -y @three-ws/home-mcp
```

Every call that would open the house goes through a physical-action gate, and **over stdio that gate refuses**. Not "prompts". Refuses. The reasoning: a stdio MCP server has no user-visible surface of its own, no session, and no way to prove that a human saw the request and approved it. Anything that presents itself as consent in that environment is a fiction. So unlocking is only available on the surfaces where a real person can be shown a real prompt, and the local server tells the assistant plainly that it will not do it and why.

Adjacent decisions from the same wave, since they are all about the same trust question:

- **Households and roles.** Five roles, each stating in plain words at the moment you pick it what it can and cannot do. A guest can turn on the lights and can never approve unlocking anything. Scoped guests receive only the rooms they were given; the others are removed from the payload rather than hidden in the UI, so their client never learns those rooms exist. Removing a person revokes every standing allowance they ever approved, in the same instant.
- **A relay for houses with no public address**, which is the default Home Assistant install. The house dials us over one outgoing WebSocket; we never dial the house, no port is forwarded, and **we never receive a Home Assistant token**: the integration mints its own credential locally and it never leaves the building. Threat model is published.
- **Voice.** Hands-free in a kitchen, with an explicit design rule that a background "yeah" can never approve a lock. Confirmation for a physical action requires an intentional utterance, not an affirmative-sounding noise.
- **We tried making the agent a Matter device, measured it, and decided against it for now**, and published that negative result rather than quietly dropping it.

---

## 7. "Can it act?" is not the same question as "is it up?"

Every liveness check we had was correct, and none of them could tell us that ten of twelve armed autonomous agents had not attempted an action in weeks. The process was `Ready`, the feed was streaming, every row said `enabled = true`.

Three unrelated things were wrong: the deployed worker image predated the commit that moved the free model chain onto models that still exist, so the whole chain answered 404; the surviving providers were out of credit or on a billing hold; and several agent wallets could not fund a single action.

Liveness measures the process. Acting requires a chain of preconditions the process knows nothing about. So we built [agent vitals](https://three.ws/docs/agent-vitals): preconditions declared as vitals with `needs` edges, actions as capabilities that AND over them, and attestation returns the **root** blocker rather than a symptom. It is a framework-agnostic package with no dependencies ([`packages/agent-vitals`](https://github.com/nirholas/three.ws/tree/main/packages/agent-vitals)); nothing about it is specific to our platform, and if you run an agent fleet I think you want something like it.

Two neighbours from the same problem: [Brownout](https://three.ws/brownout), which publishes proven fallbacks rather than promised ones (a fallback nobody has exercised is not a fallback), and [x402 Preflight](https://three.ws/preflight), which answers whether a paid endpoint can actually settle before you send it anything.

---

## 8. The odd one: your coding agent has a face now

Not an OpenAI surface, but it is the thing developers in this community respond to most, so it belongs here. `npx @three-ws/tty-avatar <id>` draws any three.ws avatar in colour at 24fps in a plain terminal, no browser and no GPU, using truecolor half-blocks or braille cells.

The second half is the point: wire it to a coding agent's hooks once, and the avatar becomes that agent's face. It looks up and thinks while the agent reads your prompt, nods while it edits, shakes when a tool fails, pulses when it is waiting on you, and bounces when it finishes, with a caption saying what it is doing right now. It turns out that an ambient face in a second pane is a much better progress indicator than a spinner, because you read its posture without switching focus.

---

## 9. Everything, in one table

Free and keyless unless marked. Paid surfaces settle per call over HTTP 402 and never appear on the free server.

| Surface | Where | Cost |
|---|---|---|
| 3D Studio MCP (11 tools) | `POST https://three.ws/api/mcp-studio` | free |
| 3D Studio Actions | `POST https://three.ws/api/3d/studio` | free |
| Look at a model | `POST https://three.ws/api/3d/look` | free |
| Simulation readiness | `GET https://three.ws/api/sim-readiness` | free |
| Print quote and printability report | `POST https://three.ws/api/print/quote` | free |
| Print order | `POST https://three.ws/api/print/orders` (human), x402 (agent) | paid |
| Home control | [`@three-ws/home-mcp`](https://www.npmjs.com/package/@three-ws/home-mcp) | free, gated |
| Reach a person | [`@three-ws/knock-mcp`](https://www.npmjs.com/package/@three-ws/knock-mcp) | door owner sets the price |
| Full platform MCP (OAuth 2.1) | `https://three.ws/api/mcp` | mixed |
| Paid 3D studio | `https://three.ws/api/mcp-3d` | mixed, some tools free forever |

There are 39 MCP packages in the repo under `packages/*-mcp` and 32 GPU and service workers under `workers/`. The generation lanes run on open models (the Hunyuan3D, TRELLIS, TripoSG and TripoSR families) on our own GPU fleet, with a failover chain per lane so a single model being unavailable degrades quality rather than failing the request.

---

## 10. Affiliations, stated precisely

I would rather over-disclose than let a reader assume something wrong:

- **OpenAI**: three.ws is a **Select Partner in the OpenAI Partner Network**. That is a partner designation, not an endorsement, and three.ws is not an OpenAI product. The free connector is the surface submitted for the plugin directory; the ChatGPT app and the custom GPT are our own builds against public APIs.
- **IBM**: three.ws is an IBM Business Partner and agents can run on IBM Granite models served through watsonx.ai. Our public Granite-backed demo endpoints are independent developer tools, not IBM products and not endorsed by IBM.
- **AWS**: three.ws is an AWS Partner with a built and deployed Marketplace SaaS integration. The listing itself is not yet public, so there is nothing to subscribe to on the AWS side today.
- **Google Cloud**: member of Google Cloud for Web3 Startups. Production (the API, the frontend, and the GPU workers) runs on Cloud Run.
- **NVIDIA**: Inception member since July 2026. Membership is a startup program, not a partnership or an endorsement.
- **Alibaba Cloud**: the product is listed on the Alibaba Cloud International Marketplace, and Qwen models are lanes in our model router.

---

## 11. What I would like this forum's opinion on

1. **Physical-action tools and MCP annotations.** `destructiveHint` covers "this deletes something". It does not distinguish "this spends $40" from "this unlocks a door in a house where a child is asleep". Is anyone modelling that distinction in a way clients could actually act on, or are we all inventing per-server gates?
2. **Consent in stdio MCP servers.** Our answer was to refuse outright. Is there a pattern where a stdio server can obtain provable human consent without pushing the user to a hosted surface?
3. **Long jobs in Actions.** Our submit-and-poll shape with `etaSeconds`, a `watchUrl` and a preview image works well, but every builder I know reinvents it. Is there appetite for a convention here?
4. **Asset feedback loops.** `look_at_model` was the single highest-leverage tool we shipped this year, and it exists only because a binary URL is useless to a model. What other formats does your agent hand back to itself blind?

Happy to answer anything about the internals. The whole stack is Apache-2.0 at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws), and the docs index is at [three.ws/docs](https://three.ws/docs).
