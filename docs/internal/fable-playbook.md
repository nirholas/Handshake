# The Fable Playbook: compounding three.ws toward real revenue

Internal strategy. `docs/internal/` is excluded from the public site build and
from `ALL.md` (`vite.config.js`, `scripts/combine-docs.mjs`), which is
deliberate: this document states what our external revenue actually is, and that
number is ours to know before it is anyone else's to read.

Claude Fable 5 (Anthropic's Mythos-class model) is unusually strong at exactly
our stack: Three.js, glTF/GLB, skeletal animation, shaders, WebGL/WebGPU, and
long-horizon autonomous engineering across a large monorepo. This document is the
operating strategy for converting that into shipped features and external
revenue. Every play names the real surface it builds on (see `STRUCTURE.md`) and
the doc that governs it.

Companion reading: [`prompts/finish/roadmap-00-README.md`](../../prompts/finish/roadmap-00-README.md)
(the open work orders and the regression gate),
[`prompts/finish/roadmap-REUSE-MAP.md`](../../prompts/finish/roadmap-REUSE-MAP.md)
(license-vetted OSS), [financial controls](../financial-controls.md) (how money
is governed), [the x402 ring economy](../x402-ring-economy.md) (what internal
volume is and why it is labeled).

---

## 1. What Fable specifically changes

Be precise about the delta, because the strategy follows from it:

1. **3D depth previous models lacked.** Retargeting math, IK, quaternion
   gotchas, GPU skinning limits, shader/TSL authoring, meshopt/Draco tradeoffs,
   gaussian splatting internals. Work that used to need a senior graphics
   engineer is now in reach of an agent session.
2. **Long-horizon autonomy.** Fable runs multi-hour tasks: the whole regression
   gate, a full work order, a cross-repo migration, without hand-holding. The
   bottleneck moves from "can the model do it" to "is the work queued and
   verifiable."
3. **Multi-agent orchestration.** Subagent fleets make exhaustive audits and
   repo-wide sweeps cheap, so quality gates that were aspirational become
   routine.
4. **Scheduled, unattended operation.** Cron routines turn Fable into standing
   infrastructure: OSS scouting, docs-drift checks, health monitoring.

The strategic conclusion: **our constraint is no longer engineering capacity, it
is prioritization and honest measurement.** This playbook is the prioritization.
`npm run gate` plus browser verification is the engineering verification.
`npm run readout:revenue` is the commercial one, and §4 explains why it had to
be built before any claim in §4 could be trusted.

---

## 2. Operating model: how to run Fable day to day

### The work queue

The original ten numbered roadmap prompts all shipped and were retired; they are
readable in git history (`git log --diff-filter=D --name-only -- prompts/roadmap/`).
The open work orders now live in `prompts/finish/` with a `roadmap-` prefix, and
[`roadmap-00-README.md`](../../prompts/finish/roadmap-00-README.md) lists which
are open and what each owns. Feed one file to one fresh session. Do not invent
new work while those sit unexecuted; they were sequenced deliberately.

### Session patterns that fit Fable

- **One work order, one session.** Each assumes a fresh context. Do not chain.
- **Ultra review before "done".** `/code-review ultra` on any branch touching
  money paths (`api/x402*`, `api/_lib/x402/`, `workers/agent-sniper`,
  `api/_lib/economy-*`), rigging cores (`src/glb-canonicalize.js`,
  `src/animation-retarget.js`), or published SDK surfaces. It is user-triggered
  and billed, so ask for it rather than trying to launch it.
- **Fleets for sweeps, not features.** Repo-wide mechanical work (route audits,
  dependency bumps, doc-link validation) goes to parallel subagents; product
  features stay single-session so one mind owns the integration.
- **Concurrent-agent hygiene.** Explicit-path staging only, re-check
  `git status` before commit, `git push threews main` on push (the only target).

### Standing routines

| Routine | Cadence | What it does | Backing |
|---|---|---|---|
| OSS scout | weekly | Scan npm and GitHub for movement in our dependency frontier (three.js releases, gltf-transform, meshoptimizer, gsplat, model-viewer, Metaplex tooling). Diff against the REUSE-MAP; open a dated addendum with license verdicts. | Manual. No script yet; this is the next routine worth automating. |
| Docs drift | weekly | Cross-check `STRUCTURE.md`, `docs/`, and `data/pages.json` against the tree; fix stale rows in place. | `.claude/workflows/docs-drift.js`, `npm run audit:docs` |
| Gate health | daily | Run the regression gate; on red, bisect and report. Never let the baseline rot. | `npm run gate` |
| Production sweep | daily | Health, logs, TLS, fleet readiness, live pages, crons, migrations. | the `gcp-triage` skill, `npm run smoke:prod` |
| Changelog to community | on deploy | Nothing to run. `/api/cron/changelog-push` reads the feed baked into the running image and posts new entries to the community Telegram channel on its own. **Do not run `npm run changelog:push`**: its file-based state is separate from the cron's DB state, so a manual push double-posts. The script survives for `--dry-run` previews and owner-directed backfills only. X delivery is retired. | Cloud Scheduler |
| Revenue readout | weekly | Split settled x402 volume into external, internal ring, and synthetic; report the external number. That is the only number that counts toward §4. | `npm run readout:revenue` |

---

## 3. Engineering plays, ranked by (revenue impact x Fable advantage)

These extend, never replace, the open work orders. Each is additive, flag-gated,
and sourced from the REUSE-MAP where OSS applies. State as of 3 September 2026 is
noted per item so nobody rebuilds what already exists.

### Tier 1: direct revenue or conversion

1. **Forge as a paid service, hardened** (wraps `packages/forge/`, `api/forge*.js`).
   The text-to-3D API is our cleanest product-shaped revenue: metered x402
   pricing, free TRELLIS lane as the funnel, paid tiers for quality, speed and
   rigging. The work is latency (caching, warm lanes), output quality
   (prompt-director tuning, auto-repair of bad meshes), and reliability SLOs.
   Everything else in this tier feeds this endpoint. **This is the one Tier 1
   item still substantially open, and it is where effort should go.**
2. **Asset pipeline compression.** *Shipped.* `@gltf-transform/*` and
   `meshoptimizer` are dependencies and the decode path is enforced: any worker
   reading a caller's mesh routes through `gltf_meshopt.decode_if_meshopt`
   (`npm run check:vendored` keeps the vendored copies honest). Remaining upside
   is measurement, not plumbing: prove the byte and first-render win per surface.
3. **AR everywhere.** *Shipped.* `src/usdz-pipeline.js`, `src/usdz-animated.js`,
   `src/ar-studio.js`, `api/ar.js` and `api/_lib/ar-launch.js` exist, with an AR
   MCP tool at `api/_mcp3d/tools/ar.js`. Remaining upside is placement: make the
   AR link unmissable on every generated artifact rather than a page you find.
4. **Embed, oEmbed and OG thumbnails.** *Shipped.* `api/agent-oembed.js`,
   `api/play-oembed.js`, the `/embed/*` route family in `vercel.json`, and OG
   image endpoints (`api/avatar-og.js`, `api/avatar-detail-og.js`,
   `api/og/`). Remaining upside is the same as 3: distribution is wired but not
   yet defaulted into every share path.

The honest reading of 2 through 4: the capability is built, the funnel is not
measured. A generation that produces an AR link nobody clicks converts nothing.
Before building the next lane, instrument the ones that exist.

### Tier 2: moats only a 3D-native model builds cheaply

5. **Procedural animation layer.** Runtime IK (look-at, foot planting, reach)
   layered on the existing retarget pipeline (`src/animation-retarget.js`, and
   the universal-rig doctrine in `CLAUDE.md`: no rig allowlist). This is graphics
   work competitors cannot hire cheaply and Fable does natively. It makes every
   avatar feel alive instead of looped.
6. **Gaussian splatting lane.** Partially present (`src/splat-viewer.js`,
   `pages/splat.html`). The open half is the pipeline: photo or video to splat to
   embeddable scene, on the same monetization rails as Forge. All REUSE-MAP
   splatting picks in the allowed column are permissively licensed; the
   non-commercial rasterizers are a hard no regardless of demo quality.
7. **WebGPU/TSL migration, flag-gated.** three.js ships a WebGPU renderer;
   ours appears only inside the vendored scene-studio editor today. Put it behind
   a query flag on the viewer, for the perf ceiling on splats, crowds and
   post-processing, not for the headline.
8. **Text to playable microgame.** The diorama pipeline (`src/diorama/`,
   `packages/scene-mcp`) already goes sentence to explorable world. Add
   win-conditions, spawn rules, and the existing walk controller (`walk-sdk/`)
   and a sentence becomes a shareable game with a permalink. Highest
   screenshot-and-share potential of anything in this list.

### Tier 3: ecosystem leverage

9. **Open-core the rigging pipeline.** Publish `glb-canonicalize` plus
   `animation-retarget` as a standalone package: universal humanoid retargeting
   for three.js. It is genuinely best in class, it earns stars and inbound
   developers, and the hosted Forge and animation service remain the paid path.
10. **Upstream PRs as marketing.** When Fable fixes or extends a dependency,
    submit it upstream per the ecosystem mindset in `CLAUDE.md`. Maintainer-level
    presence in the three.js ecosystem is acquisition we cannot buy.

---

## 4. The revenue ladder, and where we actually stand

A $1B valuation at developer-infrastructure multiples (10x to 20x ARR) means
$50M to $100M ARR. The ladder:

| Rung | External MRR | What gets us there |
|---|---|---|
| 1 | $1k | Forge paid tier and agent-sniper paid API used by strangers. Proof that x402 metering works with non-ring wallets. |
| 2 | $10k | Embed, AR and oEmbed funnel converting; SDK installs turning into API keys; the AWS Marketplace listing live (kit exists at [`docs/aws-marketplace.md`](../aws-marketplace.md)). |
| 3 | $100k | B2B: white-label page-agent and avatar SDK seats; marketplace take rate and on-chain skill licenses at volume; intel and signals data via x402. |
| 4 | $1M+ | Category ownership: the 3D layer for the agent internet. |

### The measured position

Run `npm run readout:revenue -- --window all`. As of 3 September 2026 that
returns:

- **38,620 settled x402 payments, $972.098 gross.**
- **38,614 of them (99.98%, $972.092) are the internal ring**: platform-controlled
  wallets paying platform endpoints on a cron. Real money on a real chain, and
  entirely our own.
- **2 calls, $0.002, are synthetic**: a literal `PAYER` string from a
  replay-test path. Not a buyer, not money.
- **External, all time: 4 calls from 3 addresses, $0.004**, across
  `/api/x402/skill-marketplace` and `/api/x402/solana-register-health`, the most
  recent in August 2026.

So we are not on rung 1. We are below it, and the gross ledger hides that by a
factor of roughly 240,000. This is the single most important fact in this
document, and until this readout existed it was not visible to anyone reading
the numbers the platform reported about itself.

### Rules that keep the ladder honest

- **External revenue only.** This is now mechanically enforced rather than
  merely asserted. `api/_lib/x402/revenue-split.js` is the one classifier;
  `npm run readout:revenue` and the paid `x402_volume` analytics report both go
  through it, so they cannot disagree. The readout refuses to print an external
  figure when the controlled-wallet registry fails to resolve, because a shrunk
  controlled set reclassifies our own wallets as customers and inflates exactly
  the number we are least allowed to inflate.
- **Never report ring volume as traction**, to the team or anyone else. The ring
  is dogfooding and is documented as such in [the ring economy doc](../x402-ring-economy.md).
- **Unit economics per generation.** Every paid Forge or splat lane must price
  above its GPU and egress cost. Keep the cost model per tier in
  [`docs/x402-endpoints.md`](../x402-endpoints.md) current when tiers change.
- **The funnel is OSS and MCP, then the free lane, then paid x402, then B2B.**
  The MCP registry presence and the free TRELLIS lane are top of funnel. Do not
  paywall the top; do not give away the bottom.
- **Solana settlement is live.** `X402_FEE_PAYER_SECRET_BASE58` resolves on the
  Cloud Run service (`node scripts/read-service-env.mjs '^X402_FEE_PAYER' --names`
  confirms it as a Secret Manager reference). The old note that Solana-side
  revenue was structurally blocked on an owner action is obsolete: nothing
  external is blocking Solana revenue, which means the gap is demand, not
  plumbing.

---

## 5. Open source: what we take in, what we give out

**In**, governed by the [REUSE-MAP](../../prompts/finish/roadmap-REUSE-MAP.md).
Prefer the permissively licensed picks; the excluded list (non-commercial
splatting rasterizers, capped 3D models, unlicensed layout tools) is a hard no
regardless of technical appeal. Check `package.json` before adding anything: much
of the map is already a dependency.

**Out**, three motions in priority order:

1. Open-core the retargeting pipeline (§3.9), our strongest OSS asset.
2. Upstream fixes to dependencies we touch (§3.10).
3. Keep the MCP registry presence healthy and documented. It is simultaneously
   OSS contribution and distribution. For the current server and package counts,
   read the ecosystem doc rather than quoting a number from here; those figures
   move weekly and a stale one in a strategy doc reads as fact.

---

## 6. What a features-only plan misses

1. **Distribution beats features from here.** The platform out-builds its
   awareness. `llms.txt`, the sitemap and the changelog rails exist; the missing
   piece is the loop that turns every artifact into a share. Wire sharing into
   artifacts (§3.3, §3.4) rather than adding surfaces. Note that the X lane is
   retired and the toolkit that drove it is no longer vendored here: it lives at
   `nirholas/XActions` and on npm (see `STRUCTURE.md`).
2. **Trust is a sellable feature.** We run a hash-chained economy ledger, breach
   monitoring, risk-acknowledgment gating, spend guards, and fail-closed trading
   rules. "Agents that touch real money, auditable by design" is positioning
   competitors in the agent space cannot claim. The revenue split in §4 is part
   of that story: a platform that publishes which of its own volume is internal
   is making a claim its competitors would rather not have to answer.
3. **The data moat is accruing.** `pump_snapshot`, sniper journals, agora task
   history, x402 volume metrics: longitudinal agent-economy data nobody else has.
   Package reads as paid x402 endpoints (`packages/intel` already wraps some).
4. **Partnership pipelines are half-built.** NVIDIA Inception, IBM, AWS
   Marketplace, each has a doc in `docs/`. A routine that maintains these
   listings and drafts the follow-ups converts dormant docs into channels.
5. **Grants and ecosystem funding.** Solana ecosystem and AI-agent ecosystem
   grant programs fund exactly what we ship: open-source Solana tooling, x402
   adoption, MCP infrastructure. Low cost, non-dilutive, and Fable can draft the
   applications from existing docs.
6. **Fable as standing headcount.** The §2 routines are the equivalent of an ops
   engineer, a devrel writer and a QA engineer running continuously. When a
   recurring human task appears twice, schedule it.
7. **Guard the downside.** Autonomy that moves real SOL has already produced
   incidents. Every new autonomous money path ships with fail-closed defaults,
   spend caps via `packages/agent-guards`, ledger coverage, and a kill flag.
   Companies die of blowups more often than of slow quarters.

---

## 7. What we deliberately do not do

- No rewriting infrastructure that already works (RPC failover, retarget core,
  x402 settlement). Extend behind flags, prove with the gate.
- No mocks, stubs, or fabricated traction. External numbers only, per §4.
- No non-commercially-licensed OSS, however good the demo.
- No promoting any coin but $THREE; the commit gate in `CLAUDE.md` governs
  everything else.
- No new top-level surfaces while open work orders sit unexecuted. Depth on
  existing rails compounds; sprawl does not.

---

## Sequencing

**Now.** Instrument the shipped Tier 1 funnel (compression, AR, embeds) so the
conversion question has an answer, and harden Forge as the paid product. Both
report into `npm run readout:revenue`. Getting the external figure off zero is
the whole job at this stage; nothing in Tier 2 matters until a stranger pays us
twice.

**Next.** Procedural animation, the splat pipeline, text to game (§3.5 to §3.8),
alongside the rung-2 motions (SDK to key funnel, the AWS listing).

**Then.** Open-core the retargeter, the data-moat endpoints, partnership
routines.

Review quarterly against the readout. If a play has not moved the external
number or its leading indicator (generations, embeds live, SDK installs) in a
quarter, cut it and promote the next one.
