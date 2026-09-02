# QB-08: Mobile experience and asset performance

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/quality-bar-08-mobile-performance.md`".
It is complete on its own. Also read `prompts/finish/quality-bar-_shared.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan.
2. Blockers have pre-answered routes at the bottom.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no em-dash or en-dash characters. Stage
   explicit paths only. Publish only real measured numbers, never estimates.

## Mission

A crypto-native audience lives on phones. Make the platform genuinely excellent on a mid-tier
phone: fast first paint, smooth 3D, no WebGL exhaustion, small GLB payloads, thumb-friendly
controls.

## Step 0: re-derive current state (trust nothing below)

A measured baseline already exists. Read it, then re-measure, because production has moved:

```bash
sed -n '1,40p' prompts/quality-bar/_generated/08/baseline.md
sed -n '1,40p' prompts/quality-bar/_generated/08/touch-baseline.md
node scripts/mobile-perf.mjs            # Playwright field-style metrics, NOT Lighthouse
npm run audit:mobile-touch              # scripts/mobile-touch-audit.mjs
```

The 2026-07-29 baseline measured `/play` LCP 37.7 s, `/marketplace` 30.4 s, `/` 27.4 s,
`/forge` TBT 56 s on a throttled Pixel 5. Those are the pages that matter most; if your fresh
run disagrees, trust your run and say so.

Lighthouse is not installed and must not be added. `scripts/mobile-perf.mjs` measures LCP, CLS,
FCP and a long-task blocking-time proxy directly through `PerformanceObserver` under emulated
mobile hardware and network. Quote its numbers with that caveat attached, exactly as
`baseline.md` does.

## Tasks

1. **Fix the worst pages first, in baseline order.** For each of the top five worst LCP or TBT
   pages: find the actual cause (main-thread blocking module, unlazy 3D, oversized image,
   render-blocking fetch), fix it, re-measure the same page with the same harness, and record
   the delta. A fix that does not move the number is not a fix.
2. **GLB delivery.** `scripts/compress-glbs.mjs` already runs dedup, prune, resample, quantize,
   `EXT_meshopt_compression` and WebP textures. Make it the default on the serve path: models
   written through `api/_lib/r2.js` callers get compressed at upload or finalize time, with the
   full-res original still available on the download action. Target: a typical forge output
   under 8 MB over the wire with no visible quality loss. Feature-detect decoder support and
   fall back to uncompressed.
3. **WebGL context discipline.** No page may hold more than two live WebGL contexts. Verify on
   real mobile viewports; grid pages use static thumbnails that upgrade to live 3D on tap. The
   `GL made/live/visible` column in `mobile-perf` output is your evidence.
4. **Input ergonomics.** 44 px minimum touch targets, viewer gestures not fighting page scroll
   (correct `touch-action`), primary actions reachable at the bottom of generation flows,
   safe-area insets respected. `npm run audit:mobile-touch` must come back clean.
5. **Network resilience.** Generations survive tab backgrounding and flaky networks: poll with
   backoff and resume, never lose a finished result because a socket dropped. Test by
   throttling to slow 3G mid-generation and by backgrounding the tab.
6. **Re-measure everything and publish honestly.** Same harness, same pages, before and after
   table. Only real numbers go in the changelog.

## Definition of done

- [ ] Before and after table for every top-15 page, produced by the same harness, in the report
      and committed under `prompts/quality-bar/_generated/08/`.
- [ ] Compressed GLB path proven under Playwright WebKit and Android Chrome emulation, with the
      real-device caveat stated.
- [ ] No page exceeds two live WebGL contexts; grid pages tap-to-activate.
- [ ] `npm run audit:mobile-touch` clean; `npm test` green.
- [ ] `data/changelog.json` entry quoting only measured numbers; docs updated where embed or
      SDK behavior changed.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Lighthouse is missing | Deliberate. Use `scripts/mobile-perf.mjs` and keep its caveat wording. Never add Lighthouse as a dependency. |
| `@gltf-transform` version conflicts with the tree's three.js | Pin the CLI as a devDependency and run it from scripts at build time; leave the runtime untouched. |
| KTX2 or WebP decode fails on an old device | Serve the transcoder assets locally (never hotlink a CDN) and fall back to png/jpg textures on decode failure. |
| Old GLBs already on R2 | Compress at write time for new assets and add a lazy migrate-on-first-serve for old ones. Never bulk-rewrite storage. |
| A page's slowness is caused by someone else's in-flight change | Re-measure after `git pull` is not an option here (shared worktree); measure against production instead and say which revision you measured. |

## Report format

The before and after table, the cause you found per page, the compression byte deltas, and any
single remaining owner action. No recap of this file.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/quality-bar-08-mobile-performance.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
