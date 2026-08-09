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
   change, and log the outcome in the owning pack's `PROGRESS.md`. A completed order left on
   disk reads as open work and wastes the next agent's session. Never delete on a claim alone;
   verify first (retirement policy, [../README.md](../README.md)).
4. **Follow-up protocol.** If anything remains when you stop (an owner action, a third-party
   dependency, an adjacent defect you found), write it down before ending the session:
   an agent-doable remainder becomes a new numbered `.md` work order in the owning pack,
   written to the full standard (how-to-run line, binding clause, step 0, tasks with real
   paths, checkable definition of done, never-blocked table, report format); an owner-only
   remainder becomes a row in [OWNER-ACTIONS.md](OWNER-ACTIONS.md). A remainder with no file
   is an unfinished task.
5. **Chunk protocol.** If an order is too large for one session, do not thrash: finish a
   coherent chunk completely (built, wired, verified), then rewrite the order file so it
   contains only what remains, with the state re-measured, and log the handoff in
   `PROGRESS.md`. The next agent must be able to start from your rewrite without archaeology.
6. **Commit etiquette.** Explicit paths only, never `git add -A`; `npm run check:rules --
   --paths <files you touched>` before committing; topical commit messages that describe the
   diff. Some packs below reference third-party crypto projects; their files carry the
   CLAUDE.md commit gate and say so at the top. This pack's own files are written to stay
   outside that gate.

---

## The map

Categories are run-orderable: A gates everything user-visible, B gates platform health,
C through G can run in parallel, H waits on owner gates, I is anytime. Within a category,
top to bottom.

### A. Ship (do these first; production is behind main until A is done)

| Order | What |
|---|---|
| [01-ship-readiness.md](01-ship-readiness.md) | The standing deploy order: clean test run, preflight, staged build, one-command ship for the owner, post-ship verification. Retires last in this category. |
| [../fix-queue/01-gate-red-hidden-guard.md](../fix-queue/01-gate-red-hidden-guard.md) | `npm run gate` must be green before any ship. |
| [../fix-queue/02-lint-errors.md](../fix-queue/02-lint-errors.md) | Lint errors, one a real bug in a money test. |
| [../fix-queue/07-test-core-timeout.md](../fix-queue/07-test-core-timeout.md) | `test:core` must finish; a hanging suite hides regressions. |

### B. Money rail (Solana first; the platform's observable health)

| Order | What |
|---|---|
| [../backlog/01-x402-settle-runway.md](../backlog/01-x402-settle-runway.md) | Settle runway. Agent slice largely landed (see the pack's PROGRESS.md); verify live post-deploy, then retire or rewrite to the remainder. Capital is an owner row. |
| [../backlog/02-solana-rpc-capacity.md](../backlog/02-solana-rpc-capacity.md) | RPC capacity and call-shape routing. |
| [../backlog/03-sponsor-runway-automation.md](../backlog/03-sponsor-runway-automation.md) | Runway measurement and alerting. Code complete per PROGRESS.md; verify live post-deploy, then retire. |
| [02-stranded-wallet-reclaim.md](02-stranded-wallet-reclaim.md) | Kill the phantom dry-run reclaim plan; make stranded custodial funds visible; prepare the owner decision on the customer SOL. |
| [03-master-key-hygiene.md](03-master-key-hygiene.md) | Move the plaintext master wallet secret into Secret Manager; sweep for siblings. |

### C. Repo and product defects (from the live 2026-08-01 sweep)

| Order | What |
|---|---|
| [../fix-queue/03-cron-drift-garment-sweep.md](../fix-queue/03-cron-drift-garment-sweep.md) | A declared cron that has never run. |
| [../fix-queue/04-tour-atlas-broken-stops.md](../fix-queue/04-tour-atlas-broken-stops.md) | 17 broken guided-tour stops. |
| [../fix-queue/05-stub-hrefs-dead-paths.md](../fix-queue/05-stub-hrefs-dead-paths.md) | Dead `#` links across the site. |
| [../fix-queue/06-runnable-docs-401.md](../fix-queue/06-runnable-docs-401.md) | A documented API call that no longer answers as documented. |
| [../fix-queue/08-avatar-optimize-inflates.md](../fix-queue/08-avatar-optimize-inflates.md) | The optimizer that returns a bigger file, silently. |

### D. Quality bar (the GCP-credit quality campaign)

| Order | What |
|---|---|
| [../quality-bar/03-gpu-fleet-scaleout.md](../quality-bar/03-gpu-fleet-scaleout.md) | GPU fleet scale-out. |
| [../quality-bar/04-pbr-texture-material-realism.md](../quality-bar/04-pbr-texture-material-realism.md) | PBR texture and material realism. |
| [../quality-bar/06-forge-ux-flow.md](../quality-bar/06-forge-ux-flow.md) | Forge UX flow. |
| [../quality-bar/07-design-system-sweep.md](../quality-bar/07-design-system-sweep.md) | Design-system sweep. |
| [../quality-bar/08-mobile-performance.md](../quality-bar/08-mobile-performance.md) | Mobile performance. |
| [../quality-bar/10-avatar-likeness-irl-people.md](../quality-bar/10-avatar-likeness-irl-people.md) | Avatar likeness for real people. |

### E. Roadmap features

| Order | What |
|---|---|
| [../roadmap/generation-suite.md](../roadmap/generation-suite.md) | The generation suite. |
| [../roadmap/creation-consolidation.md](../roadmap/creation-consolidation.md) | Creation-surface consolidation. |
| [../roadmap/avatar-parametric-editor.md](../roadmap/avatar-parametric-editor.md) | Parametric avatar editor. |
| [../roadmap/developer-resources-repos.md](../roadmap/developer-resources-repos.md) | Developer resources and repos. |
| [../gcp-credits/05-catalog-animation-seeding.md](../gcp-credits/05-catalog-animation-seeding.md) | Catalog and animation-library seeding on credits. |
| Trading trio (see [../roadmap/00-README.md](../roadmap/00-README.md)) | Three orders on the trading arena wedge. Their content is commit-gated (they reference a third-party launchpad); the files carry the gate. |

Strategy for what to run next inside E: [../roadmap/fable-playbook.md](../roadmap/fable-playbook.md).

### F. Trust and benchmarks

| Order | What |
|---|---|
| [../backlog/04-fact-check-benchmark-run.md](../backlog/04-fact-check-benchmark-run.md) | Benchmark published to the DB; flips live with the next deploy. Verify `source: "database"` post-deploy, then retire. |
| [04-fact-check-mixed-verdicts.md](04-fact-check-mixed-verdicts.md) | The `mixed` verdict class scores 0/10 and is the single biggest accuracy lever. |

### G. Event (window and closeout)

| Order | What |
|---|---|
| [../event/README.md](../event/README.md) | The Community Day pack. Code shipped; every surface is dark until the A-category deploy lands. Preflight is order 07. |
| [../event/08-event-closeout.md](../event/08-event-closeout.md) | Post-event: export the standings before the Redis TTL eats them, recap, winner handoff to the owner. |

### H. Distribution and listings (owner- or commit-gated; run when the gate clears)

| Order | What |
|---|---|
| [../store-submissions/01-submission-closeout.md](../store-submissions/01-submission-closeout.md) | MCP marketplace submission closeout. |
| Marketplace listing pack (see the table in [../README.md](../README.md)) | Three orders to approved status; each batches its OTP and funding needs into one owner message. |
| [../backlog/00-INDEX.md](../backlog/00-INDEX.md), orders 07 through 10 | Second-chain testnet deploys, the partner chat bot, feed-bot push, registry listing. All four are commit-gated (they reference third-party projects); their files say so. |

### I. Audit residuals (anytime)

| Order | What |
|---|---|
| [../fable-audit/RESIDUALS.md](../fable-audit/RESIDUALS.md) | Three independent hardening tasks from the 2026-07-11 deep audit. |

---

## Definition of 100% (the campaign's own definition of done)

Every line is a command or an observable, not an opinion. The campaign is complete when all
of these hold at once:

1. **No open work orders.** `find prompts -name '[0-9]*.md' -not -path '*production-100*'`
   returns nothing, and this pack holds only this index, `OWNER-ACTIONS.md` (with no
   unactioned rows), and `PROGRESS.md`. Every deletion followed the verify-then-retire rule.
2. **The repo is green.** `npm run gate` exits 0, and one full `npm test` completes cleanly
   on a box that is not thrashing (load average under the core count).
3. **Production is current.** `curl -s https://three.ws/api/version` reports the same commit
   as `git rev-parse --short main`, and `npm run smoke:prod` passes every page in
   `data/pages.json`.
4. **Production is healthy.** `curl -s https://three.ws/api/healthz` reports no subsystem
   down; anything degraded traces to an open row in [OWNER-ACTIONS.md](OWNER-ACTIONS.md)
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
