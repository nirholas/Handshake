# Roadmap build: Phase 1: GPU reconstruction backend wired end to end

How to run: paste this file's repo path into a fresh Claude Code chat in this
repository and say "run this work order". This file is fully self-contained:
it depends on no other prompt file anywhere. If neighboring files in
prompts/swarm-100/ are gone, that work is done; if present, ignore them.
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

## Context

This order builds one roadmap slice from the README Roadmap (the canonical
phase plan). It is independent of every other roadmap order: if adjacent
slices are absent, build to this slice's boundary with clean interfaces and
never block on them. Solana leads on every chain decision; EVM legs ship
behind flags and never stall the Solana path.

## Task

The roadmap's open item: capture UX and quality gates shipped, GPU
reconstruction backend wiring is the gap. Wire the capture output through the
reconstruction worker fleet so a real 3-selfie capture produces a rigged GLB.

Step 0: map what exists now: workers/avatar-reconstruction, workers/rig,
workers/avatar-pipeline-controller, api handlers matching reconstruct, and
the cron reconstruct-sweep. Run one reconstruction against the deployed
worker (or start it locally per its README) and record where the chain
breaks today.

Build: the missing wiring from capture submission to worker job to stored
rigged GLB, with job status a client can poll, failures surfaced as designed
errors with retry, and the result registered in the same stores the Forge
uses (so galleries, embeds, and provenance all see it). GCP credits are
pre-approved for GPU capacity; prefer GCP over any third-party API.

Documentation is part of the feature, not a follow-up: update the docs layer
that applies (data/pages.json for a new page, README for a new directory,
docs/ for a developer capability, specs/ for a wire format) and append a
holder-readable entry to data/changelog.json for anything user-visible.

## Definition of done

- [ ] One real capture-to-rigged-GLB run completed end to end and its asset
      URL plus job trail recorded in the report.
- [ ] Failure path proven: a bad capture produces a designed, actionable error
      state, not a hang.
- [ ] Job status endpoint covered by a test; npm test green; check:rules
      clean.
- [ ] Any deploy needed to activate it is prepared and flagged (owner-gated).
- [ ] Docs and changelog layers updated per the CLAUDE.md documentation
      rules; npm run audit:docs clean if docs changed.
- [ ] git diff reviewed line by line before claiming completion.

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

## Close out (required)

1. Verify every Definition of done line with the actual command output in
   front of you. Never claim a line you did not verify.
2. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares).
3. Delete this prompt file in that same commit:

       git rm prompts/swarm-100/roadmap-p1-reconstruction-backend.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
