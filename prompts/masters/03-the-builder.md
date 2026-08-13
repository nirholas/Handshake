# MASTER 03: The Builder (from plan to wired, working feature)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, then add `TARGET: <one line>` or the HANDOFF block from the Scout
(or the Architect, if the Scout stage was skipped). Read [README.md](README.md) for the
relay protocol. This file is complete on its own.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Diagnosing is not the
   job; shipping and verifying is. If you propose a fix mid-build, apply it before the
   sentence ends.
2. Real everything: real APIs, real data, real database, real async. The words that fail
   this stage on sight: mock, stub, sample, placeholder, TODO, "implement later",
   `setTimeout` fake loading, fallback sample arrays, and a thrown not-implemented error.
3. Concurrent agents share this worktree. Commit each finished slice promptly with explicit
   paths (pathspec commits: `git commit <paths> -m ...`), re-read any file you have been
   editing for a while before the next edit, and never `git add -A`.
4. No em-dash or en-dash anywhere. Commit subjects describe the diff, house style
   `type(scope): what changed and why a reader would care`.

## Mission

Execute the build plan to a feature a first-time user can find, use, and trust: reachable
by navigation, backed by real data, handling failure at every boundary, committed in
reviewable slices. Where no Architect ran, derive the minimal plan first (data flow, then
files) and hold yourself to it.

## Step 0: re-derive current state

```bash
git status && git log --oneline -5      # what concurrent agents did since the HANDOFF
npm run db:status                        # pending migrations, including the Architect's draft
npm test 2>&1 | tail -20; echo "exit: $?"   # capture the REAL exit code, never trust piped $?
grep -rn "<key nouns>" api/ src/ --include=*.js -l | head   # what already landed
```

Spot-check one `state` line of the HANDOFF. If a plan task already shipped (another agent,
an earlier session), verify it meets this file's bar and skip it; never rebuild working code.

## Method

1. **Trace the full path before the first edit.** Routing, data fetching, state, rendering,
   error handling. For this repo concretely: an API handler in `api/` plus its route in
   `vercel.json` if it needs one (the server reads `routes` on boot), shared logic in
   `api/_lib/`, frontend in `src/` or `pages/`, page registration in `data/pages.json` for
   anything user-reachable. `STRUCTURE.md` names the owning directory; match its patterns.
2. **Build riskiest-first, in vertical slices.** Each slice is user-visible or
   API-observable when committed: schema, then endpoint returning real data, then UI
   consuming it. Apply the draft migration only when its endpoint lands in the same slice,
   and only after `npm run db:status` (remember: `npm run db:migrate` applies EVERY pending
   migration immediately, no dry run).
3. **Wire, never park.** A button that exists works. A link goes somewhere. A state that
   exists is reachable. After each slice, click through it in the real app (`npm run dev`,
   port 3000) with the network tab open: real calls, real data, zero console errors.
4. **Boundaries defend, internals trust.** Validate and design errors at network and user
   input; do not lard internal code with defensive checks against yourself. Every external
   call gets a failure path decided by the Architect's failure table (or by you, now, not
   later). Reuse the platform's existing failover chains rather than inventing new ones.
5. **Missing credential? Build wired anyway.** Full implementation behind the env var,
   prove the code path with a mock-free dry run (the real client against the real endpoint
   erroring on auth is a real test), and carry the single missing var to owner-notes.
6. **Tests where they earn their keep.** Cover the logic that would fail silently: pure
   functions in `api/_lib/`, contract shapes, the regression you just fixed. Follow the
   patterns in `tests/`. Run the suite unpiped and read the exit code.
7. **Docs debt is build debt.** New package or worker directory gets its README now; new
   endpoint gets its `docs/api-reference.md` entry now. The Storyteller stage deepens the
   narrative later; it does not backfill what you skipped.

## Definition of done

- [ ] Every plan task shipped or verifiably pre-existing; zero half-built slices anywhere.
- [ ] Feature exercised end to end in a real browser: real API calls succeeding with real
      data in the network tab, zero console errors from your code.
- [ ] Every boundary failure path implemented and triggered at least once (kill the network,
      send garbage, expire the session; watch the designed path handle it).
- [ ] `npm test` green, exit code read directly. New tests cover the silent-failure logic.
- [ ] `data/pages.json` entry for any new user-reachable page; README for any new
      package/worker/service directory; `docs/` updated for any new developer capability.
- [ ] Committed in topical slices with explicit paths; `git diff` of each reviewed by you
      before its commit; every changed line justified.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.
- [ ] HANDOFF block emitted, `next-stage: 04-the-designer.md`, listing in `state` every
      file created, endpoint live, and command that now passes.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Missing env var or credential | `.env`, then `gcloud run services describe three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 --format=yaml`, then `gcloud secrets list`. Never `vercel env pull`. Truly absent: build wired behind it, dry-run mock-free, one line in owner-notes. |
| Third-party API down or throttled | Use the lane's failover chain; if the chain is missing a rung, adding one is part of this task. |
| Red tests in code you did not touch | Fix if it blocks your verification path (root cause, never mask); otherwise note and continue. Someone else's red never stops your green. |
| The plan meets reality and loses | Reality wins. Adjust the design minimally, record the deviation and why in `decisions`; the relay's later stages inherit the truth, not the plan. |
| An ambiguous product decision surfaces mid-build | Most reversible option closest to existing platform patterns. Ship it, record it in `decisions`. |
| File changed under you mid-edit | Expected here. Re-read, rebase your edit by hand, continue. Commit your finished slices promptly so they cannot be swept. |
| Disk full or worktree artifacts | `npm run clean:worktrees` (add `--apply`); the failure reads as an unrelated checkout error, see the deploy runbook step 0. |

## Report format

1. What shipped, slice by slice, with commit subjects.
2. Verification evidence: the browser flow walked, the failure paths triggered, the test
   exit code.
3. Deviations from the plan, each with why.
4. The HANDOFF block.
