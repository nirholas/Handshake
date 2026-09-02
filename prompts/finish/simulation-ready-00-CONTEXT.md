# simulation-ready/: shared facts for the physics-grade asset campaign

The frontier bet produced by [../masters/09-the-frontier.md](../masters/09-the-frontier.md) on
2026-08-13. Read this file first; every work order in this pack assumes it. Nothing here is a
status claim to trust: re-derive with the commands in "Measured starting state" before you act.

---

## The bet, in one sentence

**Generative 3D produces pictures of things; embodied AI needs things.** three.ws already
generates, rigs, textures and provenance-signs 3D assets at scale on its own GPU fleet. Almost
none of that output, and almost none of the world's 3D asset supply, can be dropped into a
rigid-body simulator and behave correctly. The bet is to close that gap mechanically: grade
every asset for simulation readiness, repair what can be repaired, anchor it to real-world
units, publish the mass properties and a collision proxy alongside the GLB, and sign the whole
thing into the existing provenance credential so a robot-learning pipeline can consume it
without a human in the loop.

## The user and the moment

A robot-learning engineer is assembling a training scene. They need forty household props with
correct scale, mass, inertia and collision geometry so a policy trained in simulation transfers
to the real arm. Today they either buy a curated library, spend a week in Blender closing holes
and guessing masses, or accept a domain gap they cannot measure. They arrive at three.ws from a
search for simulation-ready assets or from an agent calling our MCP server mid-pipeline, type
what they need, and get back a GLB whose report says watertight, 0.31 m tall, 0.42 kg at
polypropylene density, inertia tensor attached, convex hull attached, credential signed. "It
worked" means they never open a mesh editor and the numbers survive their own audit.

The second user is the agent itself. The same report is what makes an asset machine-buyable:
an autonomous pipeline can filter on `verdict == "simulation_ready"` before it spends anything,
which no asset marketplace currently lets it do.

## The capability intersection this joins

Three live surfaces that have never met (see [../../STRUCTURE.md](../../STRUCTURE.md)):

1. **Generative 3D on our own fleet** (Forge lanes, auto-rigging worker, catalog quality gate).
2. **Verifiable 3D provenance** (`specs/PROVENANCE_3D.md`, ed25519 credential, Solana anchor).
3. **The x402 economy** (self-facilitator, the 480k-endpoint datapoint fabric pattern, Receipt
   Vault), which is what turns a graded asset into something an agent can buy mid-run.

The world made this possible only recently: text-to-3D crossed usable quality in 2026,
generated-world reinforcement learning was shown to transfer to real hardware (EmbodiedGen V2
reports simulation success 9.7% to 79.8% and real-robot task success 21.7% to 75.0%), and x402
gave machines a payment rail (Solana carrying the majority of agent payment volume, protocol
governance under the Linux Foundation since April 2026). Each existed separately a year ago.
Nobody hosts the bridge.

## Measured starting state (2026-08-13, measured, not remembered)

```bash
node scripts/sim-readiness-probe.mjs --limit 10 --out tasks/sim-readiness/probe-$(date +%F).json
npx vitest run tests/sim-readiness.test.js
grep -rniE "urdf|mujoco|watertight|inertia" STRUCTURE.md docs/ specs/   # expect: only this campaign
```

| Fact | Value | How it was read |
|---|---|---|
| Assets graded | 20 real GLBs pulled live from production | `scripts/sim-readiness-probe.mjs --limit 10` |
| Our own Forge output that is simulation ready | **0 of 10** | probe summary, `forge` row |
| Human-authored CC0 output that is simulation ready | **2 of 10** | probe summary, `authored` row |
| Forge assets sound in geometry, blocked only on units | 3 of 10 (`needs_scale`) | same |
| Dominant blocker, our lanes | `scale_normalized` (8 of 10), every mesh fitted to a unit box | same |
| Dominant blocker, authored lanes | `open_surface` (7 of 10) | same |
| Median grade time, fetch included | ~1.6 s per asset | probe row `ms` |
| Prior art in this repo | none | the grep above |

The evidence file for that run is [../../tasks/sim-readiness/probe-2026-08-13.json](../../tasks/sim-readiness/probe-2026-08-13.json).

## The proven kernel

The riskiest assumption was: *an arbitrary generated GLB can be graded for simulation readiness
deterministically, in process, with no human input and no model call.* It holds.

- [../../api/_lib/sim-readiness.js](../../api/_lib/sim-readiness.js) grades a GLB into one of
  four verdicts (`simulation_ready`, `needs_scale`, `needs_repair`, `unusable`) with the
  blockers named. It computes volume, centroid and the unit-density inertia tensor by
  divergence-theorem tetrahedron accumulation, checks edge manifoldness and winding consistency
  over position-welded topology, reads world-space extents in meters per the glTF unit
  convention, detects the generator unit-box normalization signature, and builds a convex hull
  proxy with a convexity ratio. It reads Draco and meshopt compressed input.
- [../../tests/sim-readiness.test.js](../../tests/sim-readiness.test.js) pins the math against
  closed forms: a cube of side s at unit density must return V = s³ and I = s⁵/6, and it does to
  float32 accessor precision. Open surfaces, flipped winding, node transforms and non-GLB input
  each have a case.
- [../../scripts/sim-readiness-probe.mjs](../../scripts/sim-readiness-probe.mjs) runs it against
  live production assets. No fixtures, no cache.

What the numbers proved beyond the assumption: the control group discriminates. A CC0 cleaner
bottle graded `simulation_ready` at 0.32 m tall, 2.98 kg at water density, convexity 0.898,
which is what that object physically is. The grader is measuring, not pattern matching.

## v1: the deliberately cut vertical slice

One complete user-visible slice, not all layers half-done.

**In:** grading every new Forge creation at write time and storing the report; a public free
`GET /api/sim-readiness?src=<glb>` that returns the report for any https GLB, matching the
existing free `GET /api/provenance?src=` shape; the verdict badge and the numbers on
`/m/:id` and the viewer; the `sim_readiness` field inside the provenance credential so the
grade is signed rather than merely asserted; one MCP tool (`grade_sim_readiness`, free) on the
3D Studio server so an agent can ask before it buys.

**Out of v1, on purpose:** automatic repair of open surfaces, scale inference from the prompt
or from a reference object, URDF/USD/MJCF export, collision decomposition beyond a single convex
hull, and any paid endpoint. Each is a later slice and each is worth more once the grade exists.
Repair is the obvious second slice: `needs_scale` is 3 of 10 of our output and the cheapest fix
on the board.

## What this compounds into

Every asset three.ws has ever generated gains a machine-readable physical description. That
upgrades the catalog quality gate (a physics grade is a harder quality signal than triangle
count), the provenance credential (signed physical claims, not just lineage), the x402 fabric
(a filterable, machine-buyable asset market), the Object Library, and any future robotics or
world-model surface. It is infrastructure, not a leaf.

---

## Work orders

| # | Order | State |
|---|---|---|
| 01 | [The simulation-readiness grade, v1](simulation-ready-01-architecture.md) | designed, ready to build |

---

## The candidate table (all scored, 1 to 5 per axis)

Pull = who wants it tomorrow. Window = why now and why nobody has. Fit = machinery reused.
Kernel = provable in one session. Compound = does it strengthen everything after it.

| # | Candidate (capability intersection) | Pull | Window | Fit | Kernel | Compound | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | **Simulation-ready asset lane** (generative 3D × provenance × x402) | 5 | 5 | 4 | 5 | 5 | **CHOSEN** |
| 2 | Bidirectional 3D under the MCP Apps extension: click the model, it calls a tool back (Spatial MCP × MCP distribution) | 4 | 5 | 5 | 2 | 4 | runner-up 1 |
| 3 | Signed provenance on every MCP tool result, C2PA for agent output (provenance × MCP) | 4 | 4 | 4 | 4 | 5 | runner-up 2 |
| 4 | Living agent body inside Claude via MCP Apps (embodiment × MCP), today ChatGPT only | 3 | 4 | 5 | 2 | 2 | port, not a bet |
| 5 | Asset-level x402 fabric: every catalog asset its own paid endpoint (catalog × datapoint fabric) | 3 | 3 | 5 | 4 | 3 | folds into 1 |
| 6 | Sign to your agent and it signs back (ASL recognition × gesture vocabulary × embodiment) | 3 | 3 | 5 | 3 | 2 | leaf, delightful |
| 7 | Buy a garment from inside an assistant (Fits × x402 × MCP) | 3 | 3 | 4 | 2 | 3 | spend-gated kernel |
| 8 | Rig Doctor as an interactive in-assistant repair loop (Rig Doctor × MCP Apps) | 3 | 4 | 5 | 2 | 2 | narrow |
| 9 | Shared AR scene as a multi-agent workspace (AR Studio rooms × agent shell) | 2 | 3 | 4 | 3 | 3 | no clear buyer |
| 10 | Choreographer exposed as an MCP motion tool (motion library × MCP) | 2 | 2 | 5 | 4 | 2 | leaf |
| 11 | Economy sonification as a live paid feed (Agent Symphony × datapoint fabric) | 2 | 2 | 4 | 4 | 1 | leaf |
| 12 | Robot policy playground inside world.three.ws (multiplayer world × 1) | 4 | 4 | 2 | 1 | 4 | needs 1 to exist first |

Killed on the stated rules: none required a new paid external API, none breaches a CLAUDE.md
gate, and none duplicates [../backlog/](../backlog/) or [../roadmap/](../roadmap/), both of
which were swept (the backlog is entirely money-rail and hosting durability; the roadmap is
generation suite, creation consolidation, parametric avatar editor, developer resources and the
pump.fun trading track). Candidate 12 was demoted for kernel provability, not ambition.

## Runners-up and their trigger conditions

- **Candidate 2 (bidirectional 3D under MCP Apps).** Becomes the right choice the moment a host
  we ship on renders MCP Apps resources for a server we control and we can observe the round
  trip. Our MCP servers currently advertise protocol `2025-06-18` and expose the widget only
  through the OpenAI Apps SDK path (`_meta["openai/outputTemplate"]`,
  `ui://widget/three-studio-model.html` in `api/_mcp-studio/component.js`). The official
  extension keys on `_meta.ui.resourceUri` with a JSON-RPC bridge over postMessage. Adopting it
  is a contained change and worth doing regardless of this bet; it was not chosen because the
  load-bearing uncertainty is host-side and cannot be settled from this repo in one session.
- **Candidate 3 (signed provenance on MCP tool results).** Becomes the right choice as soon as a
  second party asks how to verify a tool result we produced, or the first time a downstream
  agent is burned by a tampered artifact. It also becomes nearly free once this bet ships, since
  the grade is already being folded into the credential.

## Never blocked

| Blocker | Do this |
|---|---|
| The grader disagrees with a well-known asset | Trust the closed forms first: `tests/sim-readiness.test.js` pins the math. Add the asset as a case before changing any threshold. |
| An asset is Draco or meshopt compressed | Already handled; `draco3dgltf` and `meshoptimizer` are registered dependencies of the shared IO. A decode failure is a real finding, not a reason to skip the asset. |
| Real-world scale cannot be inferred | Report `needs_scale` and stop. Never fabricate a size. Scale inference is a later slice with its own evidence bar. |
| A skinned or animated mesh comes through | It is graded at bind pose and the report says so (`skinned_geometry_graded_at_bind_pose`). Do not silently grade a posed mesh as a rigid body. |
| The forge gallery is empty or the probe cannot reach production | Point the probe at a local server with `--base http://localhost:3000`, or grade a single asset with `--url`. |
| Someone proposes shipping a fabricated mass or a guessed density | Refuse. The report carries unit-density inertia so a caller multiplies by a density they choose; that is the whole point. |

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'simulation-ready-00-CONTEXT' prompts/finish/
       git rm prompts/finish/simulation-ready-00-CONTEXT.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
