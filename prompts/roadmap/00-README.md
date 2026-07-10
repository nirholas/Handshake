# three.ws Continuous-Improvement & New-3D Roadmap (runnable prompts)

Each file here is a **self-contained prompt** you paste into a fresh Claude Code chat in this repo. Each one improves an existing surface or adds a new 3D / crypto / AI capability — **additively, without breaking the current architecture.**

Read this file once; every prompt assumes it.

**Strategy layer:** [fable-playbook.md](fable-playbook.md) is the operating strategy
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
`prompts/roadmap/REUSE-MAP.md` is a verified (June 2026) catalog of permissively-licensed
OSS to integrate instead of reinventing — compression, AR/USDZ, lipsync, text/image→3D,
splatting, PBR/restyle, scene layout, Solana minting, embed/OG. Each roadmap prompt's
"reuse" needs are covered there. Check it first; prefer ✅-licensed options; avoid the
⛔ list (non-commercial / unlicensed).

---

## Tracks & run order

### Track 1 — Foundation & continuous improvement (do first)
1. `01-regression-safety-net.md` — strengthen the gate itself so every later prompt is protected (golden snapshots for MCP `tools/list`, route/handler audits, a headless viewer render smoke test).
2. `02-forge-generation-quality.md` — improve the existing text/image→3D Forge pipeline: quality, reliability, caching, formats, speed. Additive tiers/params.
3. `03-embodiment-animation-lipsync.md` — expand the animation library, emotion/expression states, and audio-driven lipsync (reuse `audio-mcp`). New rig conventions.
4. `04-viewer-scene-studio-perf-ar.md` — viewer + Scene Studio performance, mobile, accessibility, and AR/USDZ Quick Look. No API breaks.

### Track 2 — New 3D creation tools
5. `05-text-to-world-scenes.md` — compositional scene/world generation (extend `scene-mcp`): place/arrange objects, environments, HDRI, export.
6. `06-material-restyle-variants.md` — re-texture, PBR material editing, style/variant generation on existing GLBs.
7. `07-new-input-modalities.md` — sketch→3D, photo→avatar, multi-image→3D, voice→scene. New on-ramps into generation.

### Track 3 — New ways to create & use (3D + crypto + AI)
8. `08-crypto-native-creation.md` — mint generated 3D as on-chain assets with signed provenance; token-gated/premium generation via x402; $THREE utility; royalties.
9. `09-creator-marketplace-remix.md` — gallery, remix, discovery, creator profiles, leaderboards (build on the Loom gallery + launches feed).
10. `10-agent-native-3d-and-embed.md` — MCP tools + agents that autonomously create and use 3D; embeddable/social distribution so the platform spreads.

**Sequencing:** 01 first (it protects everything after). Then any track in any order; within a track, low number → high. Each prompt is independently runnable in its own chat.

## Key surfaces (from STRUCTURE.md)
- Forge: `packages/forge/`, `api/forge*.js`, `api/mcp-3d.js` (free TRELLIS lane + paid tiers + auto-rig, IBM Granite prompt director).
- Scene Studio: `src/scene-studio/` → `/scene` (three.js r184 editor). `packages/scene-mcp/` (text→3D dioramas).
- Animation: `public/animations/`, `scripts/build-animations.mjs`, `src/animation-{retarget,manager,library}.js`, `src/glb-canonicalize.js`.
- Audio/lipsync: `packages/audio-mcp/` (TTS, STT, audio-to-face lipsync, motion capture).
- Viewer/SDK: `avatar-sdk/` → `@three-ws/avatar` (`<agent-3d>`), `walk-sdk/`, `page-agent-sdk/`.
- Creator gallery: `packages/loom-mcp/` (Loom 3D-creation gallery browse/fetch/submit).
- Crypto: `contracts/` (ERC-8004, skill-license SPL NFTs, agent-invocation), `packages/provenance-mcp/` (signed on-chain-verifiable action log), launches feed (`/api/pump/launches`, `pump_agent_mints`), x402 rails.
