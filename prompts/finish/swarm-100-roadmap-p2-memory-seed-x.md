# Roadmap build: Phase 2: agent memory seeding from X with explicit consent

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

Roadmap: memory seeding from connected accounts with explicit user consent.
This order covers X.

Step 0: read the existing memory system (packages/agent-memory, agent-memory
api handlers, docs/memory) and any existing X integration (the platform has
X credentials on the Cloud Run service for other lanes; check what scopes
exist before assuming).

Build: a consent-first connect flow where a user links their X account,
reviews exactly what will be ingested, and seeds their agent's memory from
their public posts. Consent is explicit, revocable, and revocation deletes
the seeded memories. Seeded memory must observably inform agent replies.

Documentation is part of the feature, not a follow-up: update the docs layer
that applies (data/pages.json for a new page, README for a new directory,
docs/ for a developer capability, specs/ for a wire format) and append a
holder-readable entry to data/changelog.json for anything user-visible.

## Definition of done

- [ ] Connect, consent, seed, converse, revoke, and verify-deleted exercised
      end to end on a real account.
- [ ] The consent screen states exactly what is read and stored; nothing else
      is read or stored.
- [ ] npm test green covering the seeding transform; check:rules clean.
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

       git rm prompts/finish/swarm-100-roadmap-p2-memory-seed-x.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
