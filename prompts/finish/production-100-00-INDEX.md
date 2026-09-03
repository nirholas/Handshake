# production-100: the run to 100%

**How to run this:** this file is a map, not a work order. Pick ONE open work order from the
tables below, paste that file into a fresh Claude Code chat opened in `/workspaces/three.ws`,
and run it to completion. Read [../README.md](../README.md) (the work-order standard) and
`CLAUDE.md` first; every order assumes both.

The goal of this campaign is a mechanically checkable end state: **100% production ready,
roadmap complete.** The campaign is finished when the "Definition of 100%" section at the
bottom passes in full, and not before.

---

## Operating standard (binding for every order run from this map)

These rules apply on top of the work-order standard in [../README.md](../README.md) and the
CLAUDE.md hard rules. They exist because each failure mode below has happened more than once.

1. **One order per chat, finished 100%.** Never end a session with a question, an unexecuted
   plan, or "let me know if". Work until the order's definition of done is verified, or until
   you hit a literal CLAUDE.md stop-and-ask gate. Never lazy: no shortcuts, no mocks, no
   half-wired features, no "good enough".
2. **Step 0 always: re-derive the current state.** Every order names its measurement commands.
   Status text in any file, including this one, rots within weeks. Measure first, skip what
   already shipped, and correct the order's own claims if they have drifted.
3. **Delete the prompt when complete.** When every line of an order's definition of done is
   verified, delete the work-order file in the same commit as (or immediately after) the final
   change, and log the outcome in the owning pack's `production-100-PROGRESS.md`. A completed order left on
   disk reads as open work and wastes the next agent's session. Never delete on a claim alone;
   verify first (retirement policy, [../README.md](../README.md)).
4. **Follow-up protocol.** If anything remains when you stop (an owner action, a third-party
   dependency, an adjacent defect you found), write it down before ending the session:
   an agent-doable remainder becomes a new numbered `.md` work order in the owning pack,
   written to the full standard (how-to-run line, binding clause, step 0, tasks with real
   paths, checkable definition of done, never-blocked table, report format); an owner-only
   remainder becomes a row in [OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md). A remainder with no file
   is an unfinished task.
5. **Chunk protocol.** If an order is too large for one session, do not thrash: finish a
   coherent chunk completely (built, wired, verified), then rewrite the order file so it
   contains only what remains, with the state re-measured, and log the handoff in
   `production-100-PROGRESS.md`. The next agent must be able to start from your rewrite without archaeology.
6. **Commit etiquette.** Explicit paths only, never `git add -A`; `npm run check:rules --
   --paths <files you touched>` before committing; topical commit messages that describe the
   diff. Some packs below reference third-party crypto projects; their files carry the
   CLAUDE.md commit gate and say so at the top. This pack's own files are written to stay
   outside that gate.

---

## The map (re-measured 2026-09-01)

Every row below was verified against the code, git history and the live site on
2026-09-01, not copied from a pack's own status text. Orders verified shipped that day were
deleted (event 01/03/04/05/07, backlog 02/03/04/06, the OpenAI pack's briefs 01 to 05, the
fable-audit index); the ones listed here are what is genuinely open. Categories are
run-orderable: A gates everything user-visible, B gates platform health, C through G can
run in parallel, H waits on owner gates, I is anytime, J is the parallel swarm.

### A. Ship (do this first; production is 107 commits behind main)

| Order | State |
|---|---|
| [01-ship-readiness.md](production-100-01-ship-readiness.md) | Open every cycle. Production `ad7b54c16` (2026-08-28) vs `main` `73c8ccbb7`; `smoke:prod` fails on seven routes that only exist in newer commits; no ship run has been logged here since 2026-08-09 although production was redeployed twice. Retires last in this category. |

### B. Money rail and platform health

| Order | State |
|---|---|
| [../backlog/01-x402-settle-runway.md](backlog-01-x402-settle-runway.md) | Code complete; outcome false: settle 5.9%, `cause: sponsor_floor`. The dry-run reclaim line it was waiting on is fixed (`afd349790`, pinned by tests). Capital is OWNER-ACTIONS row 2. |
| [../backlog/11-agent-index-lag.md](backlog-11-agent-index-lag.md) | New 2026-09-01: healthz reports `agent_index` down (1,092 of 1,602 Solana agents erroring, EVM cursors 3,039 hours stale) and nothing owned it. |

### C. Repo and product defects

| Order | State |
|---|---|
| [../fix-queue/03-cron-drift-garment-sweep.md](fix-queue-03-cron-drift-garment-sweep.md) | Open; the scheduler comparison cannot run while `gcloud` auth is dead here (OWNER-ACTIONS row 15). |

### D. Quality bar

| Order | State |
|---|---|
| [../quality-bar/03-gpu-fleet-scaleout.md](quality-bar-03-gpu-fleet-scaleout.md) | Partial: cold-start UX and keep-warm shipped; load test and scale ceilings open. |
| [../quality-bar/04-pbr-texture-material-realism.md](quality-bar-04-pbr-texture-material-realism.md) | Mostly open; `api/_lib/glb-pbr-derive.js` exists and is imported but never called. |
| [../quality-bar/06-forge-ux-flow.md](quality-bar-06-forge-ux-flow.md) | Partial: the result-moment click-through table and the audits are still owed. |
| [../quality-bar/07-design-system-sweep.md](quality-bar-07-design-system-sweep.md) | Open and regressed: raw-hex count 4,787 to 5,426 since 2026-08-02; `audit:tokens` 10 vs a baseline of 0. |
| [../quality-bar/08-mobile-performance.md](quality-bar-08-mobile-performance.md) | Partial: touch targets shipped; the after-table, default GLB compression and the WebGL budget are open. |
| [../quality-bar/10-avatar-likeness-irl-people.md](quality-bar-10-avatar-likeness-irl-people.md) | Partial: animation dignity 10/10 rigs; the likeness audit's only complete run shows no improvement. |

### E. Roadmap features

| Order | State |
|---|---|
| [../roadmap/generation-suite.md](roadmap-generation-suite.md) | Partial: tools, smoke cron and gallery shipped; PBR map outputs, job webhooks and the API contract doc open. |
| [../roadmap/creation-consolidation.md](roadmap-creation-consolidation.md) | Partial: redirects and the save fix shipped; Studio wardrobe, the `/embed` retirement and the `/start` decision open. |
| Parametric avatar editor | Done 2026-09-03: 306 sliders, server-side proportion bake, free-sculpt brush, `specs/PARAMETRIC_AVATAR.md`. |
| [../roadmap/developer-resources-repos.md](roadmap-developer-resources-repos.md) | Agent side shipped (`export:satellites` stages 70 files offline); blocked on OWNER-ACTIONS row 16, then the cross-links. |
| [../roadmap/native-widgets.md](roadmap-native-widgets.md) | All four tasks built. The card endpoint, the Android widget and the Windows manifest are live in production (verified 2026-09-03); task 4's WidgetKit extension, Mac app and iOS target are in `apple/` and guarded by `npm run check:apple-widget`. What is left is not code: signing and shipping the two Apple binaries needs row 17, and an in-board Windows check needs a Windows 11 machine. |
| [../gcp-credits/05-catalog-animation-seeding.md](gcp-credits-05-catalog-animation-seeding.md) | Partial: the catalog seed runs at scale (56,898 avatars); the generated motion library has 0 clips. |
| Materialize (retired 2026-09-02) | Shipped: the print engine, quote and catalog, checkout on both lanes, fulfillment adapters and the operator console, on-chain certificates, the fabrication gate, docs and `specs/PRINT_PIPELINE.md`. Evidence in [materialize-PROGRESS.md](materialize-PROGRESS.md). |
| [../simulation-ready/01-architecture.md](simulation-ready-01-architecture.md) | Kernel, spec and schema exist; 0.5 of 8 build tasks done. |
| Trading trio (see [../roadmap/00-README.md](roadmap-00-README.md)) | Three plans, largely absorbed by shipped surfaces; every commit touching them is gated. |

Strategy for what to run next inside E: [the Fable playbook](../../docs/internal/fable-playbook.md).

### F. Trust and benchmarks

| Order | State |
|---|---|
| [04b-fact-check-publish-run.md](production-100-04b-fact-check-publish-run.md) | Open; the `mixed` fix shipped 2026-09-02 (a fourth `partial` stance, counted by `computeVerdict`) but nothing has measured it: the in-process runner needs an LLM lane this machine does not have. |

### G. Event (two polish orders)

| Order | State |
|---|---|
| Closeout | Done 2026-09-02, order file retired. The world server never shipped the event build, so nothing was granted and no standing ever existed: [../event/PROGRESS.md](event-PROGRESS.md). Its remainder is OWNER-ACTIONS rows 13, 15 and 18. |
| [../event/02-play-polish-sweep.md](event-02-play-polish-sweep.md) | Open, rewritten to its remainder. The world does boot headless here and the existing harness reaches every surface; what is left is one run on a quiet box. |
| [../event/06-photo-mode-share.md](event-06-photo-mode-share.md) | Open, with another agent actively on it as of 2026-09-02. Cross-engine verification and the changelog entry remain. |

### H. Distribution and listings (owner- or commit-gated)

| Order | State |
|---|---|
| [../openai-pr/00-START-HERE.md](openai-pr-00-START-HERE.md) | Briefs 06 (tool count drifted to 11 across the kit) and 07 (the go/no-go, never run); the portal submit is the owner's. |
| [../store-submissions/01-submission-closeout.md](store-submissions-01-submission-closeout.md) | Open; the tracker still reads 2026-07-15 and the server counts disagree (44 / 39 / 42). |
| Marketplace listing pack (see the table in [../README.md](../README.md)) | Three open orders (04, 07, 08): the real-payment gauntlet waits on funding and a login; the relisting itself was submitted on chain 2026-08-27 and is under review. |
| [../backlog/00-INDEX.md](backlog-00-INDEX.md), orders 05 and 07 to 10 | One credential, one new funded testnet key, the chat-bot host, a sibling repo this workspace cannot see, and one verified-shipped file whose deletion waits on the commit gate (row 14). |

### I. Audit residuals (anytime)

| Order | State |
|---|---|
| [../fable-audit/RESIDUALS.md](fable-audit-RESIDUALS.md) | Task 1 partial (guard test exists, no negative fixture, no OIDC step), task 2 API-only (its page was removed 2026-08-05), task 3 six seed drifts behind the commit gate. |

### J. The swarm (parallel-safe, self-retiring)

| Pack | State |
|---|---|
| [../swarm-100/README.md](swarm-100-README.md) | 157 of 696 files remain: 151 route audits, 4 repo-wide sweeps, 1 roadmap slice. By the pack's protocol a file present is open (a finished order is deleted in its closing commit); 539 have retired that way since 2026-08-10. `docs/ops/swarm-100-audit.md` reconciles the ledger against git history. |

A headless probe of all 151 remaining routes on 2026-09-01 (Chromium, local dev server,
1440/768/320 px, then a reload with every `/api/*` request blocked) found: every route 200
locally and in production, every route with a title, 150 with a meta description; 56 pass
every mechanical check (zero console errors, zero failed requests, one h1, no horizontal
overflow, a designed error state when the API is blocked) and 95 have at least one measured
defect. Largest classes: no visible error state under a blocked API (64, of which the ten
`/features/*` pages and other static pages make no API call and are false positives), real
failed requests (31), console errors (29), h1 count not one (19), dead anchors (15), 320 px
overflow (`/economy`, `/ibm/hello`, `/showcase`), an uncaught exception on load (`/launch`,
`/launch-studio`: `/launch/launch.js` answers 500 on the dev server), and `/dashboard`
rendering an empty shell signed out. Recurring root causes: `/three/draco/gltf/draco_decoder.wasm`
404 on the 3D pages, ipfs.io images blocked on `/launches`, signed-out 401s on `/my-agents`,
`/guardian` and `/temporary`, `/api/galaxy` 503. The probe cannot verify the DoD lines about
every button working, empty and loading states, or `npm test`, so a mechanically clean route
is not proven done and none was retired on that evidence. The other agent's audit doc counts
125 clean with a looser check set; the two agree on status, title, meta and h1 and differ
only on the error-state and failed-request heuristics.

Of the five non-route files: `sweep-i18n.md` is untouched (`npm run i18n:lint` reports
44,104 problems across 81 locales); `sweep-console.md` is open (the sweep still exits 1,
`/fees` alone logs seven 404s); `sweep-authed-audit.md` is partial (its premise is stale,
the QA login exists, and the last authed report of 2026-08-19 had 33 pages with error
findings); `sweep-perf.md` is partial (eight pages measured 2026-08-15, three under 80 with
documented irreducible costs, no re-measure after the 2026-09-01 fixes);
`roadmap-p2-memory-seed-x.md` is built, tested and documented, and closes after one
end-to-end run on a real account, which needs the X OAuth credentials that live only on the
Cloud Run service.

---

## Definition of 100% (the campaign's own definition of done)

Every line is a command or an observable, not an opinion. The campaign is complete when all
of these hold at once:

1. **No open work orders.** `find prompts -name '[0-9]*.md' -not -path '*production-100*' -not -path '*masters*'`
   returns nothing (the masters are reusable prompts and never retire), and this pack holds only this index, `production-100-OWNER-ACTIONS.md` (with no
   unactioned rows), and `production-100-PROGRESS.md`. Every deletion followed the verify-then-retire rule.
2. **The repo is green.** `npm run gate` exits 0, and one full `npm test` completes cleanly
   on a box that is not thrashing (load average under the core count).
3. **Production is current.** `curl -s https://three.ws/api/version` reports the same commit
   as `git rev-parse --short main`, and `npm run smoke:prod` passes every page in
   `data/pages.json`.
4. **Production is healthy.** `curl -s https://three.ws/api/healthz` reports no subsystem
   down; anything degraded traces to an open row in [OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md)
   (for example capital), not to code.
5. **The audits are clean.** `npm run audit:docs`, `npm run audit:links`,
   `npm run check:pages`, and `npm run check:cron-drift` all exit 0 against a fresh build.
6. **The benchmark is live.** `curl -s https://three.ws/api/fact-check-benchmark` answers
   with `source: "database"` and a published run.

When all six hold: delete this pack too, and record the retirement in
[../README.md](../README.md) the way retired campaigns are recorded there.

## Never blocked

The CLAUDE.md self-unblock playbook answers nearly every historical stall; each order also
carries its own table. Two environment facts worth repeating because they burn sessions:
`gcloud` is not on PATH here (`export PATH="$HOME/google-cloud-sdk/bin:$PATH"`), and a lapsed
`gcloud` auth can be revived in-session with `gcloud auth login --no-launch-browser` fed
through a fifo; an ACTIVE account listing does not prove auth works, so test with a real read
before trusting it.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'production-100-00-INDEX' prompts/finish/
       git rm prompts/finish/production-100-00-INDEX.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
