# Sweep: Console audit clean

How to run: paste this file's repo path into a fresh Claude Code chat in this
repository and say "run this work order". This file is fully self-contained:
it depends on no other prompt file anywhere. If sibling swarm-100 files in
prompts/finish/ are gone, that work is done; if present, ignore them.
Every claim below rots; step 0 re-measures, and what you measure wins.

## Operating clause (binding)

- Read CLAUDE.md first. Its rules override everything, including this file.
- Finish 100% in this session. Never end the turn with a question, an option
  list, or an unexecuted plan. A judgment call goes in one line of the final
  report; it never becomes a question that halts work.
- The only permitted stops are the CLAUDE.md stop-and-ask gates: spending real
  funds or any irreversible on-chain write, git push or a production deploy,
  committing content that references a crypto project other than $THREE, and
  destroying unrecoverable data.
- No mocks, no fake data, no placeholder stubs, no unfinished-work markers, no
  commented-out code. Real APIs and real integrations only.
- The em-dash and en-dash characters are banned in everything you write.
- Concurrent agents share this worktree: stage explicit paths only (never a
  bare add-everything), and commit finished work promptly.
- Before committing, run: npm run check:rules -- --paths <files you touched>.
  It must exit 0.

## State on 2026-09-04 (measured, not claimed)

A full sweep ran that day with the page-side fixes below already in place. The
desktop pass measured **770 of 780 routes clean**. Every one of the ten
remaining routes was traced to a named cause, and **none of them is open page
code**: each is either already fixed on `main` and waiting for a production
deploy, or a page that is correct on the origin it actually runs on.

Fixed and committed that day (page code, root causes):

| Route | Cause | Fix |
|---|---|---|
| `/launches` | The shared coin card painted token art straight from a public gateway that now answers 429 behind a sunset notice. One paint logged 89 blocked requests. | `src/pump/coin-status-card.js` routes art through `/api/img` (gateway retry, painted-size resize, deterministic placeholder). `src/launches.js` does the same for agent thumbnails. Commit `795becc00`. |
| `/creations` | Gallery models were read straight from the asset bucket, whose CORS policy allowlists the production origin by name, so model-viewer died with "Failed to fetch" on every other origin. | New `proxiedModelURL` in `src/ipfs.js` routes them through `/api/glb`; `src/model-diff.js` dropped its private copy of the rule; covered by `tests/ipfs-image-url-safety.test.js`. Commit `795becc00`. |
| `/ibm/x402-demo`, `/ibm/hello.live` | Both pages loaded their own `x402.js` by absolute URL, so the browser refused it on any origin but production and the paid demos never armed. | They load `/x402.js` now; the copyable snippet still shows the absolute URL an embedder needs. `scripts/build-ibm-shell.mjs` absolutizes root-relative asset URLs when baking the publish-once page, which also repaired its language switcher. Commits `b1f6db3be`, `6cf18771d`. |

Waiting on the production deploy, not on code (verified by running this repo's
own API server and re-requesting each endpoint, see step 0):

| Route | What the sweep sees | Where the fix already is |
|---|---|---|
| `/fees` | 7 chain-icon 404s from the upstream icon host | `cc5dbb211` repairs the URLs and falls back to a neutral disc |
| `/markets`, `/markets/news` | `/api/news/image` 404s | `f32c2987f` answers 204 for an article that simply has no picture |
| `/oracle-lab` | `/api/oracle/model` 500 | `272b659fc`, and the endpoint answers 200 against this tree |
| `/smart-home`, `/smart-home/plan`, `/smart-home/satellite`, `/smart-home/privacy` | `/api/home` 404 | `e6a32da61`; the handler exists here and answers 401 signed out, as designed |

`/ibm/hello` is the one route that is correct as it stands: it is the
publish-once page IBM hosts on its own domain, so it deliberately fetches
`https://three.ws/ibm/hello.live` and its assets by absolute URL. On a localhost
sweep those reads are cross-origin and refused; on the origin the page is
actually served from they are same-origin. Do not "fix" it by making those
relative, which is what breaks the IBM-hosted copy.

Four routes carried warnings rather than errors. Three are closed; the fourth is
a production configuration gap that no page edit can close:

| Route | Warning | Disposition |
|---|---|---|
| `/play/war` | Two assets "preloaded but not used" | **Fixed.** `src/play/war.js` returns early with "No battle to join" when the link carries no pairing, so a static `<link rel=preload>` in the head downloaded a manifest and an avatar the page never read. `pages/play/war.html` now injects the two preloads from the head only when `match`, `ticket` and `coin` are all present, which keeps the head start on the real path and emits nothing on the dead one. `/play/arena` keeps its static pair because it always loads both, which is why it never warned. |
| `/create/selfie` | `gl_context.cc:1118] OpenGL error checking is disabled` | **Filtered.** MediaPipe's native logger, glog-formatted, written by the C++ library with no JS frame of ours in it and no verbosity control on the JS API. Added to `scripts/lib/console-noise.mjs` beside the other headless-GL driver lines. |
| `/avatar-sdk` | `RGBELoader has been deprecated. Please use HDRLoader instead.` | **Intentional, documented.** `avatar-sdk/src/viewer.js` explains it: the SDK's peer range is `three >= 0.150.0`, `HDRLoader.js` does not exist before r180, and a bundler resolves the literal dynamic import statically, so renaming trades one cosmetic console line on new `three` for a hard "module not found" build failure for every consumer on older `three`. Revisit when the peer floor moves to `>= 0.180.0`. |
| `/clash` | `clash: CoinCommunities unconfigured, polling stopped` | **Not a code defect: one missing credential.** `CC_API_KEY` is absent from `.env`, `.env.local` and the `three-ws-api` service (`node scripts/read-service-env.mjs '^CC_API_KEY$' --names` finds no match), and production's `/api/clash/state` answers `503 cc_unconfigured` for the same reason. The page is fully wired behind the var and degrades as designed: one request per page view, poll cancelled, the designed unavailable state on both tabs. The warning names a real operational gap and stays. Supplying `CC_API_KEY` is the fix, and it is the owner's. |

## Step 0: re-derive the current state

    npm run audit:console

Capture the full output to the session scratchpad; do not work from an excerpt.

Then separate deploy lag from page defects before you touch any page code, or
you will spend the session chasing production's staleness. The dev server
proxies `/api/*` to https://three.ws, so an API finding measures the DEPLOYED
code, not this tree. Point the proxy at the repo's own server instead:

    node --env-file-if-exists=.env --env-file-if-exists=.env.local server/index.mjs &
    DEV_API_PROXY=http://localhost:8080 npx vite --port 3211 --strictPort &
    AUDIT_BASE=http://localhost:3211 npm run audit:console

A finding that clears under that run is deploy lag: record it and move on. The
reverse also holds, so judge it both ways: endpoints whose credentials live only
on the deployed service answer `not_configured` (503) locally and are fine in
production.

## Task

Run the console audit across pages. Every console error is a defect: fix it at
root in the page or module that throws. Warnings from our own code get fixed
too; third-party warnings we cannot control get documented in the report.

Fix everything found in this sweep's scope. Findings that belong to a different
surface entirely (and would take this session off its one task) go in the report
as named follow-ups instead; everything in scope gets fixed here, at root, with
no masking.

## Definition of done

- [ ] The command above exits 0 (or, for measurement-style sweeps, the report
      carries the measured numbers and every committed fix).
- [ ] Every fix is a root-cause fix; no check was weakened, skipped, or
      quarantined to get to green.
- [ ] npm run check:rules -- --paths <touched files> exits 0; npm test passes
      if code changed.

**The one line that cannot pass without an owner:** the sweep exits 0 only once
production serves the four deploy-lag fixes above. That is the ship order
(`production-100-01-ship-readiness.md`), owner-gated, and it is the whole
remainder of this file. Re-run step 0 after the next deploy; if the four rows
clear, this order is done and the file retires.

## Never blocked

| Blocker | Resolution (act, do not ask) |
|---|---|
| Missing env var or credential | Check .env and .env.local, then the Cloud Run service env, then Secret Manager (the CLAUDE.md self-unblock playbook has the exact commands). If it truly exists nowhere, wire the code fully behind the env var, prove the wiring with a dry run, and name the single missing var in the report. |
| gcloud not on PATH | Run: export PATH="$HOME/google-cloud-sdk/bin:$PATH" |
| Dev server port 3000 busy | Another agent may be serving this repo; probe it and reuse if so. Otherwise start your own on a free port: npx vite --port 3101 |
| Playwright browser missing | npx playwright install chromium |
| A surface needs a signed-in user | Register a fresh account through the real /register flow against the real API and use it. Never mock the session. |
| A defect sits in code you did not touch | Fix it if it blocks a Definition of done line (root cause it, never mask it). Otherwise note it in the report and continue. |
| An unrelated test is red | Same rule. Never pipe npm test through tail; it masks exit codes. |
| `ENOSPC` mid-run, or a build dying with exit 144 | The shared disk is full. `npm run clean:worktrees` (add `--apply`), and never delete a worktree holding uncommitted work. The sweep writes nothing large, but Vite's optimizer cache does. |

## Close out (required)

1. Verify every Definition of done line with the actual command output in
   front of you. Never claim a line you did not verify.
2. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares).
3. Delete this prompt file in that same commit:

       git rm prompts/finish/swarm-100-sweep-console.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
