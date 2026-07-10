# The Fable Playbook — using Claude Fable 5 to compound three.ws toward real revenue

Claude Fable 5 (Anthropic's Mythos-class model, above Opus) is unusually strong at
exactly our stack: Three.js, glTF/GLB, skeletal animation, shaders, WebGL/WebGPU,
and long-horizon autonomous engineering across a large monorepo. This document is
the operating strategy for converting that into shipped features, external revenue,
and a defensible position — not a wishlist. Every play below names the real surface
it builds on (see `STRUCTURE.md`) and the doc that governs it.

Companion docs (read-order): [00-README.md](00-README.md) (roadmap prompts +
regression gate), [REUSE-MAP.md](REUSE-MAP.md) (license-vetted OSS),
[../x402-revenue.md](../x402-revenue.md) (how money is measured),
[../improvement-plans/README.md](../improvement-plans/README.md).

---

## 1. What Fable specifically changes

Be precise about the delta, because the strategy follows from it:

1. **3D depth previous models lacked.** Retargeting math, IK, quaternion
   gotchas, GPU skinning limits, shader/TSL authoring, meshopt/Draco tradeoffs,
   gaussian splatting internals. Work that used to need a senior graphics
   engineer — procedural animation, WebGPU migration, custom post-processing —
   is now in reach of an agent session.
2. **Long-horizon autonomy.** Fable runs multi-hour tasks: the whole regression
   gate, a full roadmap prompt, a cross-repo migration — without hand-holding.
   The bottleneck moves from "can the model do it" to "is the work queued and
   verifiable."
3. **Multi-agent orchestration.** Workflows/subagent fleets make exhaustive
   audits, N-perspective reviews, and repo-wide sweeps cheap. Quality gates that
   were aspirational (adversarially-verified review before every feature claim)
   are now routine.
4. **Scheduled, unattended operation.** Cron routines turn Fable into standing
   infrastructure: OSS scouting, docs-drift checks, changelog publishing, health
   monitoring — headcount-free ops.

The strategic conclusion: **our constraint is no longer engineering capacity, it
is prioritization and verification.** This playbook is the prioritization; the
regression gate (`npm run gate`) plus browser verification is the verification.

---

## 2. Operating model — how to run Fable day to day

### The work queue is already written
`prompts/roadmap/01…10` are self-contained prompts. Feed them to fresh Fable
sessions in the documented order (01 first — it hardens the gate that protects
everything else). Each session: gate-before → build → verify in browser → gate-after.
Don't invent new work while numbered prompts sit unexecuted; they were sequenced
deliberately.

### Session patterns that fit Fable
- **One prompt, one session.** Roadmap prompts assume a fresh context. Don't chain.
- **Ultra review before "done".** `/code-review ultra` (multi-agent cloud review)
  on any branch touching money paths (`api/x402*`, `workers/agent-sniper`,
  `api/_lib/economy-*`), rigging cores (`src/glb-canonicalize.js`,
  `src/animation-retarget.js`), or published SDK surfaces.
- **Fleets for sweeps, not features.** Repo-wide mechanical work (route audits,
  dependency bumps, doc-link validation) goes to parallel subagents; product
  features stay single-session so one mind owns the integration.
- **Concurrent-agent hygiene** (known trap): explicit-path staging only,
  re-check `git status` before commit, `git push threews main` on push (only target).

### Standing routines (schedule these once, they run forever)
| Routine | Cadence | What it does |
|---|---|---|
| OSS scout | weekly | Scan npm + GitHub for movement in our dependency frontier (three.js releases, gltf-transform, meshoptimizer, gsplat, model-viewer, TalkingHead, Metaplex). Diff against `REUSE-MAP.md`; open a dated addendum with license verdicts. |
| Docs drift | weekly | Cross-check `STRUCTURE.md`, `docs/`, and `data/pages.json` against the tree; fix stale rows in-place per the docs rules in `CLAUDE.md`. |
| Gate + smoke health | daily | Run `npm run gate`; on red, bisect and report — never let the baseline rot. |
| Changelog → distribution | on deploy | `npm run changelog:push` (Telegram) + turn each entry into an X post via the vendored [xactions/](../../xactions) toolkit. Every ship becomes content. |
| Revenue readout | weekly | Pull `/api/x402/analytics` + `x402_audit_log`, split **external vs internal (ring)** revenue, report the external number. That is the only number that counts toward §4. |

---

## 3. Engineering plays, ranked by (revenue impact × Fable advantage)

These extend — never replace — the numbered roadmap prompts. Each is additive,
flag-gated, and sourced from `REUSE-MAP.md` where OSS applies.

### Tier 1 — direct revenue or conversion
1. **Forge as a paid service, hardened** (improvement-plan 10; wraps
   `packages/forge/`, `api/forge*.js`). The text→3D API is our cleanest
   product-shaped revenue: metered x402 pricing (USDC + $THREE), free TRELLIS
   lane as the funnel, paid tiers for quality/speed/rigging. Fable's job:
   latency (caching, warm lanes), output quality (prompt-director tuning,
   auto-repair of bad meshes via `@three-ws/glb-tools`), and reliability SLOs.
   Everything else in this tier feeds this endpoint.
2. **Asset pipeline compression** (REUSE-MAP §1): gltf-transform + meshopt at
   build time, meshopt decoder in the viewer. Smaller GLBs → faster first
   render → higher conversion on every surface (viewer, diorama, labs, embeds)
   and lower egress cost per generation.
3. **AR everywhere** (REUSE-MAP §2): server-side `USDZExporter` → every
   generated model gets an iOS Quick Look link, every embed gets `<model-viewer ar>`.
   "See it in your room" is the single most shareable artifact a 3D platform
   produces — it is marketing that compounds per generation.
4. **Embed + oEmbed + OG thumbnails** (roadmap 10, REUSE-MAP §10): `/embed/:id`,
   `/api/oembed`, `poppygl`-rendered OG PNGs. Every model shared on X/Discord
   unfurls as a live card linking back. Distribution wired into the artifact.

### Tier 2 — moats only a 3D-native model builds cheaply
5. **Procedural animation layer**: runtime IK (look-at, foot planting, reach),
   layered on the existing retarget pipeline (`src/animation-retarget.js`,
   universal-rig doctrine in `CLAUDE.md`). This is graphics-engineer work that
   competitors can't hire cheaply and Fable does natively. Makes every avatar —
   page-agent, walk companion, Agora citizens — feel alive instead of looped.
6. **Gaussian splatting lane** (REUSE-MAP §6, all ✅-licensed: gsplat, brush,
   supersplat): photo/video → splat → embeddable scene. A second content type
   with the same monetization rails (x402 generation, gallery, embeds), and
   `brush` trains in the visitor's browser — zero server GPU cost.
7. **WebGPU/TSL migration, flag-gated**: three.js's WebGPU renderer behind a
   query flag on the viewer. Not for hype — for the perf ceiling on splats,
   crowds (Agora), and post-processing, and to be early on the platform shift
   instead of chasing it.
8. **Text → playable microgame**: the diorama pipeline (`src/diorama/`,
   `packages/scene-mcp`) already goes sentence → explorable world. Add
   win-conditions, spawn rules, and the existing walk/platformer controller
   (`walk-sdk/`) → sentence → shareable game with a permalink. Highest
   screenshot-and-share potential of anything we can build this quarter.

### Tier 3 — ecosystem leverage
9. **Open-core the rigging pipeline**: publish `glb-canonicalize` +
   `animation-retarget` as a standalone MIT package ("universal humanoid
   retargeting for three.js"). It is genuinely best-in-class, it earns GitHub
   stars and inbound developers, and the hosted Forge/animation service remains
   the paid path. The `packages/*` promotion path in `STRUCTURE.md` already
   defines the mechanics.
10. **Upstream PRs as marketing**: when Fable fixes or extends a dependency
    (three.js examples, model-viewer, gltf-transform), submit it upstream under
    the three.ws org per the ecosystem mindset in `CLAUDE.md`. Maintainer-level
    presence in the three.js ecosystem is acquisition we can't buy.

---

## 4. The revenue ladder — what "unicorn" actually requires

A $1B valuation at developer-infrastructure multiples (10–20× ARR) means
**$50–100M ARR**. Nobody grinds to that in one motion; the ladder is:

| Rung | External MRR | What gets us there |
|---|---|---|
| 1 | $1k | Forge paid tier + agent-sniper paid API used by strangers. Proof that x402 metering works with non-ring wallets. |
| 2 | $10k | Embeds/AR/oEmbed funnel converting; `@three-ws/*` SDK installs turning into API keys; AWS Marketplace listing live (`docs/aws-marketplace.md` kit exists). |
| 3 | $100k | B2B: white-label page-agent + avatar SDK seats; marketplace take rate + on-chain skill licenses at volume; intel/signals data via x402. |
| 4 | $1M+ | Category ownership: "the 3D layer for the agent internet" — every MCP-speaking agent renders, pays, and transacts through three.ws rails. |

Rules that keep the ladder honest:

- **External revenue only.** The x402 ring (`docs/x402-ring-economy.md`) is
  dogfooding and is already labeled internal in `x402_audit_log`. Never report
  ring volume as traction — to the team or anyone else.
- **Unit economics per generation.** Every paid Forge/splat lane must price
  above its GPU + egress cost. Fable maintains a cost model per tier in
  `docs/x402-revenue.md` when tiers change.
- **The funnel is: OSS/MCP → free lane → paid x402 → B2B.** 38 MCP servers in
  the public registry and the free TRELLIS lane are top-of-funnel; don't
  paywall the top, don't give away the bottom.
- **Prerequisite unblock:** paid Solana settlement needs
  `X402_FEE_PAYER_SECRET_BASE58` set in production (owner action) — until then
  Solana-side revenue is structurally off.

---

## 5. Open source: what we take in, what we give out

**In** — governed by [REUSE-MAP.md](REUSE-MAP.md), which is license-vetted and
verified. The rules: prefer ✅ MIT/Apache picks; the ⛔ list (non-commercial
splatting rasterizers, capped 3D models, unlicensed layout tools) is a hard no
regardless of technical appeal; the weekly OSS-scout routine (§2) keeps the map
current instead of letting it rot. Check `package.json` before adding anything —
much of the map is already a dep.

**Out** — three motions, in priority order:
1. Open-core the retargeting pipeline (§3.9) — our strongest OSS asset.
2. Upstream fixes to dependencies we touch (§3.10).
3. Keep the MCP registry presence (38 servers) healthy and documented — it is
   simultaneously OSS contribution and distribution.

---

## 6. Outside the box — the things a features-only plan misses

1. **Distribution beats features from here.** The platform already out-builds
   its awareness. `llms.txt`, sitemap, and changelog rails exist; what's
   missing is the *automated* loop: every changelog entry → X post (xactions),
   every generation → OG-unfurling permalink, every model → AR link. Wire
   sharing into artifacts (§3.3–4) rather than adding surfaces.
2. **Trust is a sellable feature.** We already run a hash-chained economy
   ledger, breach monitoring, risk-acknowledgment gating, spend guards, and
   fail-closed trading rules. "Agents that touch real money, auditable by
   design" is a positioning competitors in the agent space cannot claim.
   Document it as a customer-facing page, not just ops docs.
3. **The data moat is already accruing.** `pump_snapshot`, sniper journals,
   agora task history, x402 volume metrics — longitudinal agent-economy data
   nobody else has. Package reads as paid x402 endpoints (`@three-ws/intel`
   already wraps some); Fable can build the derived-signal layer.
4. **Partnership pipelines are half-built — finish them.** NVIDIA Inception,
   IBM (watsonx MCP + webinar runbook), AWS Marketplace, SNS — each has a doc
   in-tree. A routine that maintains these listings and drafts the follow-ups
   converts dormant docs into channels.
5. **Grants and ecosystem funding.** Solana Foundation, Metaplex, and
   AI-agent-ecosystem grant programs fund exactly what we ship (open-source
   Solana tooling, x402 adoption, MCP infrastructure). Low-cost, non-dilutive;
   Fable drafts the applications from existing docs.
6. **Fable as standing headcount.** The §2 routines are the equivalent of an
   ops engineer, a devrel writer, and a QA engineer running continuously. Treat
   routine coverage as an org chart: when a recurring human task appears twice,
   schedule it.
7. **Guard the downside.** Autonomy that moves real SOL has already produced
   incidents (fail-open rules, synthetic circulation burn). Every new
   autonomous money path ships with: fail-closed defaults, spend caps via
   `@three-ws/agent-guards`, ledger coverage, and a kill flag. Unicorns die of
   blowups more often than of slow quarters.

---

## 7. What we deliberately do NOT do

- No rewriting infrastructure that already works (RPC failover, retarget core,
  x402 settlement) — extend behind flags, prove with the gate.
- No mocks, stubs, or fake traction — external numbers only (§4).
- No ⛔-licensed OSS, however good the demo.
- No promoting any coin but $THREE; the commit gate in `CLAUDE.md` governs
  everything else.
- No new top-level surfaces while numbered roadmap prompts are unexecuted —
  depth on existing rails compounds; sprawl doesn't.

---

## Sequencing summary

**Now:** roadmap 01 (gate hardening) → 02 (Forge quality) → compression + AR +
embeds (§3.2–4) → schedule the §2 routines.
**Next:** procedural animation, splat lane, text→game (§3.5–8) → rung-2 revenue
motions (SDK→key funnel, AWS listing).
**Then:** open-core the retargeter, data-moat endpoints, partnership routines →
rung 3.

Review this playbook quarterly against the external-revenue readout. If a play
hasn't moved that number or its leading indicator (generations, embeds live,
SDK installs) in a quarter, cut it and promote the next one.
