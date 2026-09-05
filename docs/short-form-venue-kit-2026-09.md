---
title: "Short-form venue kit, September 2026"
description: "Paste-ready copy for the venues that take a paragraph rather than an article: Show HN, Product Hunt, five subreddits, LinkedIn, the Alibaba Cloud developer community, and a Khronos glTF discussion opener. Each entry carries the venue's own rules, the copy, and the first comment."
status: drafts, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# Short-form venue kit, September 2026

The long-form drafts live one per file (see [publishing-program-2026-09.md](./publishing-program-2026-09.md) for the full matrix). This file holds the venues where the unit of publication is a paragraph, a title, or a first comment.

**Rules that apply to every entry here.** Post as a participant, not as a brand voice: each of these communities punishes marketing register and rewards a specific technical claim with a link that backs it. Never post the same text to two subreddits. Answer replies yourself, in your own words. If a claim is not checkable in a live endpoint or the repository, cut it.

---

## 1. Show HN

**Venue:** news.ycombinator.com, "Show HN". One submission, then you live in the comments for six hours.
**Rules that matter:** the title must describe the thing, not sell it; no superlatives; the URL should be the thing itself, not a blog post about it.

**Title (78 characters)**

```
Show HN: Free physics-readiness grade for any glTF file, and a CC0 spec for it
```

**URL**

```
https://three.ws/docs/sim-readiness
```

**First comment (post immediately after submitting)**

> A renderer forgives almost everything. A rigid-body solver forgives nothing. The same mesh that looks perfect in a viewer can sink through the floor in MuJoCo, spin like it is hollow, or turn out to be a metre tall because the generator fitted it to a unit box. Nothing in the file says so, so every robotics, game-physics and world-model pipeline rediscovers the same defects by hand, one asset at a time.
>
> This is a mechanical answer to the question a physics engine actually asks: can I use this as a rigid body right now, and if not, what exactly is wrong. Four verdicts. `simulation_ready` is the only one that licenses trusting the reported mass. `needs_scale` means the geometry is sound and only the units are missing. `needs_repair` means the surface is open, non-manifold, or inconsistently wound, so mass properties are reported but unreliable. `unusable` means no triangles or zero volume. A fifth value, `unreadable`, is for bytes that are not glTF at all, deliberately distinct from a valid file with nothing to simulate.
>
> Free and keyless, because a check that costs money is a check nobody runs:
>
>     curl "https://three.ws/api/sim-readiness?src=https://three.ws/avatars/cesium-man.glb"
>
> The spec is CC0 and the grader is a pure function you can vendor. I would rather this became something other people implement than something people call. Source is Apache-2.0 at github.com/nirholas/three.ws. Context: I build a text-to-3D platform, and we needed this badly enough to write it, then realised nobody should have to write it twice.
>
> The part I would most like criticism on: the boundary between `needs_repair` and `unusable`, and whether "real-world extents" is a defensible heuristic or whether it should be a warning rather than a verdict change.

**Alternate submission, if the readiness one has already run:** `Show HN: A live 3D avatar in your terminal, as your coding agent's face` pointing at the `@three-ws/tty-avatar` README.

---

## 2. Product Hunt

**Venue:** producthunt.com. Ship Tuesday to Thursday, 00:01 PT.
**Rules that matter:** tagline maximum 60 characters, description around 260, first comment is where the launch is actually won.

**Name**

```
Materialize by three.ws
```

**Tagline (57 characters)**

```
Describe an object, get it printed and posted to your door
```

**Description (254 characters)**

```
Type a description, three.ws generates the 3D model, and Materialize prints it in resin, nylon, colour sandstone or steel and ships it. Free printability report before any price. Every step is also an API, so an AI agent can order a physical object by itself.
```

**Topics:** 3D, Artificial Intelligence, Design Tools, Developer Tools, Hardware

**Maker's first comment**

> Hi Product Hunt. I build three.ws, an open-source platform that turns a sentence into a rigged 3D character. Materialize is the part that leaves the screen.
>
> The loop: describe something, we generate it, and then it gets manufactured and posted to you. What I care about most is the order the steps happen in.
>
> **The analysis is free and comes first.** Before any price, you get a printability report: whether the mesh is a closed solid, how many separate bodies it has, where the holes are, the thinnest wall, the exact volume, and a 0 to 100 score with named deductions written for a person rather than a slicer. Free because a check that costs money is a check nobody runs.
>
> **The quote is signed and lasts 24 hours,** so the price you were shown is the price you pay.
>
> **Every print ships with proof it is the one you ordered:** a certificate of authenticity with a QR code in the box, and creators can cap how many copies of a model will ever exist.
>
> **It refuses things.** No weapons, no functional key duplicates, no third-party brand marks, screened before production. A print bureau has a human at that checkpoint. We have an API where the buyer might be a machine, so the checkpoint has to be code.
>
> That last part is the unusual bit: an AI agent can run the whole loop, quote and order included, with no human in it. As far as I know this is the first API where an agent can pay for manufacturing.
>
> Free to try the generation half with no account: three.ws/forge. Everything is Apache-2.0. Happy to answer anything, including what it costs and what it cannot print.

---

## 3. Reddit

Five subreddits, five different posts. Never cross-post the same body.

### r/homeassistant

**Title:** `Built a HACS integration that dials out over one WebSocket, so a LAN-only HA can drive a 3D assistant. The lock handling is the interesting part.`

**Body:**

> Most HA installs cannot be reached from the internet: no forwarded port, no public address. That is the default install, not an edge case. So this integration works the other way around: the house dials out over a single outgoing WebSocket and the service never dials the house. Nothing listens on your network, no port forwarding, no tunnel daemon, and the service never receives an HA token (the integration mints its own credential locally and it never leaves the house).
>
> What it connects to is a 3D agent that stands in a live model of your home and talks to you, plus an MCP server so Claude, Cursor or your own assistant can read and drive the house.
>
> The part I would like this sub to pull apart is locks. Every call that would open the house passes through one physical-action gate, and over stdio that gate **refuses outright**. My reasoning: a local stdio MCP server has no user-visible surface, no session, and no way to prove a human saw the request and approved it, so any "confirm?" it prints is a string the model can answer itself. Household roles are enforced server-side too: a guest can turn on lights and can never approve unlocking anything, and a scoped guest's other rooms are removed from the payload rather than hidden in the UI.
>
> Also: we evaluated exposing the agent as a Matter device, measured it, and decided against it for now, and published why.
>
> Repo: github.com/nirholas/three-ws-home-assistant (HACS custom repository). Docs and the relay threat model: three.ws/docs/smart-home. Apache-2.0.
>
> Is the stdio refusal right, or is it paternalistic? That is a genuine question and I have not settled it.

### r/threejs

**Title:** `Five things we open-sourced after animating characters nobody on our team modelled (retargeting with no rig allowlist, progressive GLB, glTF diffing, a physics grade, a terminal renderer)`

**Body:** short pointer to the [three.js forum post](./threejs-forum-post.md), with the retargeting section quoted in full and a request for rig conventions we have not mapped.

### r/LocalLLaMA

**Title:** `Every text-to-3D API answers with a URL to a binary the model cannot read. We fixed the loop by rendering results back into the model's own modality.`

**Body:**

> This is the smallest change we made this year and the one that changed the most.
>
> A `.glb` is opaque to a language model. So an agent that just spent GPU time generating an asset cannot tell a clean mesh from a melted one; it hands the link to a human and hopes. No error signal means no loop, which is why agentic 3D has been one-shot since it existed.
>
> The fix: render the result from several angles and return the frames as MCP image content blocks, so a multimodal model looks at what it made. Then it can judge it, refine it, and look again. Alongside the frames we return geometry facts and a plain-language reading of them.
>
> The generalisation is not about 3D at all: **any tool that hands an agent a binary needs a companion that renders it into the agent's own modality.** PDFs, spreadsheets, audio, CAD, compiled artifacts. If your agent cannot perceive its own output, it is guessing.
>
> Free and keyless if you want to try it against your own stack: `POST https://three.ws/api/3d/look`, or the tool `look_at_model` on `https://three.ws/api/mcp-studio`. Everything Apache-2.0.

### r/3Dprinting

**Title:** `We built a free printability report API (closed solid, separate bodies, thinnest wall, exact volume, 0-100 score with named deductions) and made it the step before any price is quoted`

**Body:** the analysis-first argument, the four things it measures, an honest note that the printing lane behind it is a paid service, and an invitation to tell us which deductions are wrong. Lead with the free endpoint; the sub is allergic to advertising and fine with tools.

### r/robotics

**Title:** `A generated mesh that renders perfectly can be unusable as a rigid body, and the file never says so. Free grade plus a CC0 spec.`

**Body:** the four verdicts, the `needs_scale` versus `needs_repair` distinction, the content-addressed caching, the request for adversarial review from people who have shipped assets into MuJoCo or Isaac in anger.

---

## 4. LinkedIn article

**Venue:** LinkedIn article from the founder account, not a company post.
**Audience:** partners, enterprise readers, and people evaluating the company.

**Title**

```
The quarter our AI agents left the browser tab
```

**Opening (first 210 characters are the preview, make them count)**

> For most of this year our agents lived in a browser tab, and the worst thing a wrong decision could produce was a bad sentence. This quarter they got a house, a car, and a factory, and that changed the engineering.

**Structure:** the blast-radius argument; the three capabilities (home, car, manufacturing); the governance layer that became load-bearing; the operating principle that a refusal must live on the server and not in a prompt; the honest partner and listing status list; and a close on what it takes to make an agent economy that is not a demo. Keep it to 900 words, no code blocks, one link at the end.

---

## 5. Alibaba Cloud developer community

**Venue:** the Alibaba Cloud developer community, following our existing marketplace listing and the editorial feature already published on the marketplace blog.
**Angle:** the model router. Qwen models are first-class lanes in a multi-provider brain router that any agent can be pointed at, reached through DashScope alongside the other providers, and there is a published MCP server (`@three-ws/alibaba-cloud-mcp`) exposing Qwen chat and embeddings to any MCP client.

**Working title**

```
Adding Qwen as a first-class lane in a multi-provider agent brain, and what a router owes each provider
```

**The one non-obvious point to build the piece around:** a router that treats providers as interchangeable produces empty answers on the rungs that are working, because reasoning families, tool-call shapes, and streaming conventions differ. The router's job is not to hide the provider, it is to normalise the parts that must be uniform and to report the model that actually answered, so callers can tell.

---

## 6. Khronos glTF discussion opener

**Venue:** the glTF project's public discussion tracker on GitHub (a discussion, not an issue, and not a pull request).
**Purpose:** find out whether a machine-readable physical-usability claim belongs anywhere near the ecosystem, before proposing anything formal.

**Title**

```
Discussion: is there appetite for a machine-readable "can this be simulated" claim for glTF assets?
```

**Body**

> Context, briefly: we run a text-to-3D service and every downstream consumer of our output (physics engines, game engines, robotics stacks) rediscovers the same defects by hand. A glTF file carries no claim about whether it can be used as a rigid body, so the checks get re-implemented per pipeline, inconsistently.
>
> We wrote and published one (CC0 spec, free endpoint, pure-function grader) covering four verdicts: closed surface with consistent winding and positive volume and plausible real-world extents, versus geometry that is sound but unit-scaled, versus an open or non-manifold surface whose mass properties are unreliable, versus nothing to simulate at all.
>
> I am not proposing an extension here, and I would like to understand the shape of the problem first:
>
> 1. Is this a file-level claim, a validator concern, or purely an application concern?
> 2. If it belongs anywhere in the ecosystem, is it an extension, a validator rule set, or a convention?
> 3. Is "plausible real-world extents" defensible as part of a verdict, or should unit ambiguity only ever be a warning?
>
> Happy for the answer to be "this is an application concern, keep it out of the format". That is useful too.
