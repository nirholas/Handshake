# swarm-100: one small task per file, run to 100%

This pack decomposes "100% production ready, fully audited, roadmap built
out" into 696 self-contained work orders. Each file is one small task.
Any file can be pasted into a fresh Claude Code chat and executed to
completion with zero questions asked; no file depends on any other file
being done first, so any number can run in parallel in any order.

The deletion protocol IS the progress ledger: an agent that finishes a work
order verifies its Definition of done, then deletes the file in the same
commit as the work (git rm with the explicit path). The directory shrinks
toward empty; an empty directory means the campaign is complete. There is no
PROGRESS.md by design, and nothing here needs cross-session handoff state.

Deviation from the pack convention, on purpose: these work orders do not
open with "read the index first". Each file carries its own binding
operating clause and never-blocked table inline, because the independence
requirement forbids any shared-file dependency. This README is orientation
for humans, not a runtime dependency.

## Contents

| Prefix | Count | What each file covers |
|---|---|---|
| route- | 284 | One interactive route from data/pages.json (sections main, build, labs, crypto, agent-tools, account): full browser audit and fix |
| docs-batch- | 44 | Eight docs/learn routes per file: rendering, links, accuracy, runnable samples |
| blog-batch- | 4 | Ten blog routes per file: rendering and link mechanics |
| legal-pages | 1 | The legal section |
| machine- | 2 | Discovery endpoints (.well-known, MCP) and crawler feeds (sitemap, llms.txt, openapi) |
| api- | 224 | Up to ten api/ handler files per file: endpoint or code-and-test audit |
| cron-batch- | 13 | Eight scheduled jobs per file: handler, scheduler, production logs |
| worker- | 33 | One workers/ directory: build, tests, README, deployed health |
| service- | 4 | One services/ directory |
| packages-batch- | 11 | Six packages/ directories per file |
| sdk- | 23 | One top-level SDK or module directory |
| sweep- | 30 | One repo-wide audit command or cross-cutting concern, run and fixed to green |
| roadmap- | 23 | One README-roadmap slice (phases 1 through 4), built for real behind the CLAUDE.md gates |

## Provenance

Generated 2026-08-10 from the repo's own inventories: data/pages.json
(routes), vercel.json (crons), and filesystem listings of api/, workers/,
services/, packages/, and the top-level SDK directories. Work orders
deliberately re-derive state in their step 0, so inventory drift after
generation costs a skipped file, never a wrong fix. If a listed file or
route no longer exists, the work order says to note it and move on; if a new
surface lands without a work order here, add one following any neighbor's
format.

## Relation to other packs

prompts/production-100/ remains the sequenced master campaign; this pack is
the unsequenced, parallel-safe decomposition of the same goal. The open work
orders in prompts/backlog/, prompts/fix-queue/, prompts/quality-bar/,
prompts/roadmap/, prompts/gcp-credits/, and prompts/okx-ai/ still stand on
their own and are not duplicated here; where a sweep in this pack overlaps
one of them, both re-derive state first, so whichever runs second verifies
and closes cleanly.

## Running at scale

Any number of these can run concurrently, but concurrent sessions share this
worktree: orders touching the same shared module can collide. The orders
already mandate explicit-path staging and prompt commits, which keeps
collisions cheap. Re-running a half-finished order is always safe; step 0
re-measures everything.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'swarm-100-README' prompts/finish/
       git rm prompts/finish/swarm-100-README.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
