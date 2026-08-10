# Cron audit batch 07: /api/cron/copy-fanout and 7 more

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

## Step 0: re-derive the current state

1. Confirm each cron below still exists in vercel.json crons; removed ones are
   out of scope.
2. Scheduler truth (crons run on Cloud Scheduler, never in-process):

       export PATH="$HOME/google-cloud-sdk/bin:$PATH"
       gcloud scheduler jobs list --project aerial-vehicle-466722-p5 --location us-central1 | grep -E 'copy-fanout|mirror-fanout|signal-fanout|strategy-fanout|index-delegations|run-dca|run-subscriptions|run-x-scheduled-posts'

3. Production behavior, last 72h, per cron:

       gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" textPayload:"<cron name>"' --freshness=72h --limit 50 --project aerial-vehicle-466722-p5

## Task: verify and fix these scheduled jobs

Crons in this batch:

- /api/cron/copy-fanout
- /api/cron/mirror-fanout
- /api/cron/signal-fanout
- /api/cron/strategy-fanout
- /api/cron/index-delegations
- /api/cron/run-dca
- /api/cron/run-subscriptions
- /api/cron/run-x-scheduled-posts

For each cron:

1. Read the handler and its auth guard (crons authenticate; find the shared
   pattern in api/_lib before invoking anything).
2. Invoke it once against a locally started server with the proper cron auth
   from .env. It must complete without an unhandled error and be safe to run
   twice (idempotent); if a local run would move real funds or write on-chain,
   audit its dry-run or validation path instead and say so in the report.
3. Production logs from step 0: zero unhandled errors and evidence it actually
   fires on schedule. A cron that exists in vercel.json but has no scheduler
   job, or vice versa, is drift: fix it (npm run check:cron-drift helps).
4. Fix every failure at root: the handler, the schedule, or the env it needs.

## Definition of done

- [ ] Every cron in the batch has a scheduler job, a clean local invocation
      (or an audited dry-run path for money-moving crons), and 72h of
      production logs free of unhandled errors.
- [ ] npm run check:cron-drift and npm run check:cron-syntax pass.
- [ ] npm run check:rules -- --paths <touched files> exits 0; vitest passes if
      code changed.

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

       git rm prompts/swarm-100/cron-batch-07.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
