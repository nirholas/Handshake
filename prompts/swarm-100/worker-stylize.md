# Worker audit: workers/stylize

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

1. Read workers/stylize/README.md and its build config (cloudbuild.yaml,
   Dockerfile, package.json; whichever exist).
2. Is it deployed?

       export PATH="$HOME/google-cloud-sdk/bin:$PATH"
       gcloud run services list --project aerial-vehicle-466722-p5 --region us-central1 | grep -i "stylize" || echo "not deployed as its own service"

3. If deployed: which commit is the running revision built from, and does main
   contain fixes it has not picked up? A fix in main can sit undeployed for
   days; never call a bug unfixed without checking the running revision.
4. Logs, last 24h, if deployed:

       gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="<service name from step 2>"' --freshness=24h --limit 100 --project aerial-vehicle-466722-p5

## Task: bring this worker to verified-healthy

1. README accuracy: what it does, how to run it, its inputs and outputs. Fix
   every stale claim; a README that lies fails the audit.
2. Build it the way its own config says. The build must succeed from a clean
   checkout of this worktree. Model workers that need weights stage them from
   gs://three-ws-model-weights (staging weights is part of the job, not a
   blocker).
3. Run its tests; add a smoke test if it has none that proves its core path.
4. If deployed: last 24h of logs free of unhandled errors; fix root causes in
   code and commit. Redeploying is owner-gated: prepare everything so the
   deploy is one command and say so in the report.
5. If not deployed by design: its README must state how and where it runs, and
   that path must be verified locally.

## Definition of done

- [ ] Build succeeds from this worktree with the worker's own config.
- [ ] Tests pass, including at least one core-path smoke test.
- [ ] README verified accurate against the code.
- [ ] If deployed: running revision identified, 24h logs clean or root causes
      fixed and committed (deploy itself flagged for the owner).
- [ ] npm run check:rules -- --paths <touched files> exits 0.

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

       git rm prompts/swarm-100/worker-stylize.md

   The shrinking directory is this campaign's only progress ledger; there is
   no progress log to update.
4. Final report: what step 0 measured, what changed (file list), evidence per
   Definition of done line, and any one-line judgment calls. No trailing
   questions, no unexecuted plans.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns
it. Never delete this file on a partial.
