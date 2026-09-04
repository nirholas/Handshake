# three.ws Continuous-Improvement & New-3D Roadmap (runnable prompts)

> Retirement note (2026-07-28): work orders verified fully shipped were deleted from this pack per owner directive; their files remain in git history. Links below to missing files refer to retired, completed work orders. Remaining files are open or partial.

> **creation-consolidation closed 2026-09-03.** Both blocked redirects shipped once the capability
> gaps behind them were closed. Avatar Studio reached edit-mode parity with the avatar editor
> (wardrobe + closet, auto-rig, walk preview, "Play as this", `?equip-*`), and the Widget Studio
> absorbed the `/embed` editor (no-account snippets, an Agent Chat widget type, deep-linkable
> config on the same parameter names, raw GLB/VRM URLs, platform paste instructions), so `/embed`
> now 301s to `/studio` with `has`-gated rewrites for every parameter-carrying form. Two placement
> decisions were resolved in place: `/start` **stays** as guided onboarding (it is the onboarding
> tour's target and composes the canonical `/api/agents`; the alternative, retiring it, would have
> broken the tour, the `/features` CTAs, the sitemap and the localized page set), and `/pose`
> **stays in Build** under `tier: 'advanced'` (it already appeared exactly once in `public/nav-data.js`,
> and it is the most-linked authoring tool on the site; the alternative, Labs-only, would bury it).
> The bare `/avatar-edit` landing keeps its existing 301 to `/dashboard/avatars` rather than moving
> to `/avatar-studio`: a bare `/avatar-edit` means "edit one of my avatars", and Studio's create
> mode answers a different question. Route contract: `tests/creation-surface-redirects.test.js`.

Each file here is a **self-contained prompt** you paste into a fresh Claude Code chat in this repo. Each one improves an existing surface or adds a new 3D / crypto / AI capability — **additively, without breaking the current architecture.**

Read this file once; every prompt assumes it.

**Strategy layer:** [the Fable playbook](../../docs/internal/fable-playbook.md) is the operating strategy
above these prompts — how to deploy Claude Fable 5 across them, the revenue ladder,
OSS in/out motions, and standing routines. Read it to decide *what to run next*;
read this file to run it safely.

---

## The prime safety doctrine (every prompt obeys this)

three.ws is a large, live, single monorepo (see `STRUCTURE.md` for the full surface map). The #1 rule for this roadmap: **do not break what exists.**

1. **Additive, not destructive.** New endpoints, new tools, new flags, new modules. Do not change the signature/behavior of a shared core (`src/glb-canonicalize.js`, `src/animation-retarget.js`, `api/_mcp*/`, published `@three-ws/*` SDKs, viewer web components) unless you preserve 100% backward compatibility and prove it with tests.
2. **Gate before and after.** Run the **regression gate** below at the start (capture the green baseline) and again before claiming done. Nothing you do may turn a green check red.
3. **Flag new behavior.** New runtime behavior on an existing surface ships behind a feature flag / new route / new opt-in param, defaulting to current behavior, until verified.
4. **No mocks, no fake data, no TODOs, no stubs** (CLAUDE.md). Real APIs, real implementations, real verification in a browser for UI.
5. **$THREE is the only coin**, everywhere. Crypto features use $THREE + USDC settlement only.
6. **Concurrent agents share this worktree.** Stage explicit paths only; re-check `git status` before any commit. Commit/push only when the human asks — then `git push threews main`, the only push target. Never push, pull, fetch, or merge `threeD` (the retired `nirholas/3D-Agent` mirror; its `main` has diverged with foreign history).
7. **Changelog.** User-visible changes get a `data/changelog.json` entry; `npm run build:pages` validates.
8. **Watch the esbuild trap.** `npx vercel build` overwrites `api/*.js` with bundles — check `head -1` of changed `api/` files for `__defProp` before committing; `npm run guard:esbuild`.

### The regression gate (copy/run at start and end of every prompt)
```bash
npm run gate
```
This alias (added to `package.json`) runs the **offline-safe** checks only:
`test:gate` (curated money/auth unit tests) + `test:gate-3d` (glb-canonicalize /
animation-retarget / viewer-framing contract tests — the universal shared 3D
cores) + `audit:mcp` + `audit:mcp-golden` (golden-snapshot tripwire over every
hosted MCP tool contract; on an *intentional* contract change run
`node scripts/audit-mcp-golden.mjs --update` and commit the fixture) +
`audit:routes` + `audit:handlers` + `audit:pages` + `audit:hidden-guard` +
`audit:x402-catalog` + `audit:tokens`. It is intentionally the
*offline* subset — the project doctrine (see `scripts/test-gate.mjs`) keeps
catalog/handler-heavy and browser specs in `npm test`, because importing a hosted
MCP catalog pulls in DB/RPC clients that **block without live credentials** (an
import alone exceeds 60s). Do NOT write tests that `import` an `api/_mcp*/catalog.js`
— they hang the suite. Verify MCP tool contracts against a *running* server
(`npm run dev` → `tools/list`, or `npm run test:mcp`/`smoke:mcp` with creds), not by importing.

For full local verification when you have credentials + a browser: also run
`npm run typecheck` and `npm test`. Save the gate baseline to
`prompts/roadmap/_generated/<prompt>/gate-before.txt` and the final to `gate-after.txt`.
**`gate-after` must be no worse than `gate-before`.**

### Reuse before you build
`prompts/finish/roadmap-REUSE-MAP.md` is a verified (June 2026) catalog of permissively-licensed
OSS to integrate instead of reinventing — compression, AR/USDZ, lipsync, text/image→3D,
splatting, PBR/restyle, scene layout, Solana minting, embed/OG. Each roadmap prompt's
"reuse" needs are covered there. Check it first; prefer ✅-licensed options; avoid the
⛔ list (non-commercial / unlicensed).

---

## What is in this directory

The original ten numbered track prompts (regression safety net, forge quality, embodiment and
lipsync, viewer performance and AR, text to world, material restyle, new input modalities,
crypto-native creation, creator marketplace, agent-native 3D and embed) all shipped and were
retired; they remain readable in git history
(`git log --diff-filter=D --name-only -- prompts/roadmap/`).

### Runnable work orders (paste one into a fresh chat)

| File | Owns | State |
|---|---|---|
| [generation-suite.md](roadmap-generation-suite.md) | Meshy and Tripo class parity, and production truth for every generation endpoint | Open. Step 0 and tasks 1 and 2 are done (2026-09-03): the truth table was rebuilt from live probes, and every row is green except the undeployed talking-avatar lane. That sweep found the default free image lane failing 44 of 49 generations for 12 hours while every status surface read green; it is restored and hardened, and `trellis_selfhost` now has a live health probe. Tasks 3 to 8 (pipeline tools in `/forge`, preview then refine, export formats, PBR controls, job webhooks, community gallery) are untouched. |
| [developer-resources-repos.md](roadmap-developer-resources-repos.md) | The public examples satellite repo and its one-way export | Done, retired 2026-09-03. `npm run export:satellites` stages 72 files and passes all four smoke stages; the docs, `llms.txt` and `llms-full.txt` cross-links are live. Only the owner-gated publish remains (create the `three-ws` org, run the printed push), tracked as row 16 of [production-100-OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md). |
| [native-widgets.md](roadmap-native-widgets.md) | Native widgets on the Android, Windows, macOS and iOS home screens | Built, all four surfaces. Android and Windows are live in production; the Apple sources are in `apple/`. Open only on what code cannot do: an Apple Developer account to sign the two binaries (owner action 17) and a Windows 11 machine for the in-board check, which wants a deploy carrying 2026-09-04's service worker fix. |

### Strategy and reference (read, do not execute)

| File | What it is |
|---|---|
| [the Fable playbook](../../docs/internal/fable-playbook.md) | The operating strategy above these work orders: what to run next, the revenue ladder, standing routines. Promoted out of this directory into `docs/internal/` on 2026-09-03, since it is durable strategy rather than a one-shot order. |
| [REUSE-MAP.md](roadmap-REUSE-MAP.md) | License-vetted OSS to integrate instead of reinventing. Check it before building anything here. |
| [pumpfun-trading.md](roadmap-pumpfun-trading.md), [pumpfun-trading-arena.md](roadmap-pumpfun-trading-arena.md) | Two overlapping strategy documents for the trading product. They are plans, not work orders. The wedge delta was retired on 2026-09-03 (readable in git history) once its inventory was checked against the repo: the wedge itself (`/claim-wallet`), the Trader Passport, the meta-allocator, fade-the-influencer (`/ghost-copy`), the Clip Director and the 3D trading floor had all shipped, and the last unshipped, non-owner-gated mechanic (alpha-drip, tiered release of a leader's signal) shipped with it. What the wedge left open is owner-gated, not unbuilt: a per-copy execution fee is a pricing decision, and a house-bankrolled first trade spends real money per new user. Its §6 consolidation (fold the arena draft into the master plan) stays open on purpose: both drafts predate the em-dash ban, so folding them verbatim would add hundreds of lines that `npm run check:rules` rejects, and rewriting a whole plan's prose to move it is the catastrophic diff that rule exists to avoid. Fold it when one of the two is being rewritten anyway. |

## Key surfaces (from STRUCTURE.md)
- Forge: `packages/forge/`, `api/forge*.js`, `api/mcp-3d.js` (free TRELLIS lane + paid tiers + auto-rig, IBM Granite prompt director).
- Scene Studio: `src/scene-studio/` → `/scene` (three.js r184 editor). `packages/scene-mcp/` (text→3D dioramas).
- Animation: `public/animations/`, `scripts/build-animations.mjs`, `src/animation-{retarget,manager,library}.js`, `src/glb-canonicalize.js`.
- Audio/lipsync: `packages/audio-mcp/` (TTS, STT, audio-to-face lipsync, motion capture).
- Viewer/SDK: `avatar-sdk/` → `@three-ws/avatar` (`<agent-3d>`), `walk-sdk/`, `page-agent-sdk/`.
- Creator gallery: `packages/loom-mcp/` (Loom 3D-creation gallery browse/fetch/submit).
- Crypto: `contracts/` (ERC-8004, skill-license SPL NFTs, agent-invocation), `packages/provenance-mcp/` (signed on-chain-verifiable action log), launches feed (`/api/pump/launches`, `pump_agent_mints`), x402 rails.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'roadmap-00-README' prompts/finish/
       git rm prompts/finish/roadmap-00-README.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
