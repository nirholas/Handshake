# P100-01: Ship readiness, the standing deploy order

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/production-100-01-ship-readiness.md`".
Read [00-INDEX.md](production-100-00-INDEX.md) and `CLAUDE.md` first.

**This order is standing, not one-shot.** Run it whenever production trails `main` and the
owner wants (or has approved) a ship. It retires only when the campaign's Definition of 100%
holds and no further deploys are pending; until then, finishing a run of it means logging in
[PROGRESS.md](production-100-PROGRESS.md), not deleting the file.

## Binding operating clause

1. Finish 100% of what this machine can do. Never end with a question or an unexecuted plan.
2. The deploy submission itself is CLAUDE.md stop-and-ask gate 2. Everything before it
   (cleaning, building, verifying) and after it (purge, smoke, health reads) is yours to do
   without asking. If the owner's instruction this session already approves shipping, gate 2
   is satisfied and you run the whole chain.
3. Hard rules: no mocks, no shortcuts, no `tail` piped onto test commands (it masks exit
   codes), explicit-path commits only, no em-dash characters in anything you write.

## Step 0: re-derive the state (do all of these, trust none from memory)

```bash
curl -s https://three.ws/api/version          # prod commit vs:
git rev-parse --short main                    # local main
curl -s https://three.ws/api/healthz | head -c 2000
npm run clean:worktrees                       # report first; add --apply to act
df -h /workspaces | tail -1                   # the 2026-08-04 disk-full trap
uptime                                        # load average; concurrent agents thrash this box
npm run db:status                             # migrations pending behind the deploy?
```

If production already equals `main` and healthz is clean, this run is a no-op: log that
measurement in [PROGRESS.md](production-100-PROGRESS.md) and stop.

## Tasks

1. **Reclaim disk.** `npm run clean:worktrees --apply`. Stale deploy worktrees filled the
   disk to 100% on 2026-08-04 and the failure surfaces as a misleading mid-checkout error.
2. **Get the repo green enough to ship.** `npm run gate` must exit 0. If it is red on
   something in [../fix-queue/](fix-queue-00-INDEX.md), fix it via that order's file (and
   retire that file per the standard) rather than masking it. A red caused by another agent's
   in-flight work: capture the baseline, coordinate or route around it, never ship over it.
3. **One clean `npm test` on a quiet box.** This has been owed since 2026-08-08: every prior
   attempt died to load average 200+ from concurrent agents, not to code. If the box is
   thrashing (load average well above 16), wait for a quiet window or coordinate; a SIGTERM
   kill at load 250 tells you nothing. Do not pipe through `tail`. Record the summary line.
4. **Run the preflight agent.** Launch the `deploy-preflight` subagent and act on every
   finding. It checks the load-bearing build order, worktree artifacts, service-account pins,
   and changelog wiring.
5. **Build in a clean worktree at a pinned SHA**, exactly per the CLAUDE.md deploy runbook:
   `git worktree add --detach /workspaces/.deploy-wt <pinned SHA>`, hardlink `node_modules`,
   `chat/node_modules`, and `character-studio/build` with `cp -al`, copy `.env`, then
   `npm run build:gcp` inside it. Pin the SHA explicitly; `main` has moved 80+ commits during
   a single build before. Never hand-run the chain out of order.
6. **Present the ship (gate 2), then execute on yes.** Render for the owner: the pinned SHA,
   a one-paragraph summary of what ships (read `git log <prod-sha>..<pinned-sha> --oneline`
   yourself and summarize by theme, do not paste 80 lines), and the single command:
   `gcloud builds submit --config server/cloudbuild.yaml --region us-central1 --project aerial-vehicle-466722-p5 --substitutions=SHORT_SHA=manual$(date +%s)`
   from the worktree. If the owner already approved this session, run it now.
7. **After the submit lands:** `npm run deploy:gcp:purge-cdn` (synchronous, never `--async`),
   then verify: `curl -s https://three.ws/api/version` shows the pinned SHA,
   `npm run smoke:prod` passes, healthz subsystems are no worse than the step 0 read, and
   any deploy-armed surfaces flipped (whatever this map's other orders were waiting on; as of
   authoring: `/event.json` serving JSON, `/api/fact-check-benchmark` answering
   `source: "database"`, the discovery paging fix live).
8. **Clean up.** `git worktree remove --force /workspaces/.deploy-wt`. Log the run in
   [PROGRESS.md](production-100-PROGRESS.md): prod SHA before and after, test summary, smoke result,
   anything that flipped.

## Definition of done (per run)

- [ ] `curl -s https://three.ws/api/version` reports the pinned SHA on a new revision.
- [ ] `npm run smoke:prod` exit 0.
- [ ] `npm run gate` exit 0 at the shipped SHA.
- [ ] One clean full `npm test` recorded, with its summary line, on a box under load.
- [ ] Post-ship healthz no worse than pre-ship, and every regression explained.
- [ ] Deploy worktree removed; run logged in [PROGRESS.md](production-100-PROGRESS.md).

## Never blocked

| Blocker | Resolution |
|---|---|
| Owner has not said yes to the ship | Do everything up to and including step 6's rendering, so the ship is one command, then log and stop. That is a finished run, not a blocked one. |
| `gcloud` missing or auth dead | `export PATH="$HOME/google-cloud-sdk/bin:$PATH"`; revive auth with `gcloud auth login --no-launch-browser` fed through a fifo. Verify with a real read (`gcloud run services describe three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 --format='value(status.latestReadyRevisionName)'`), not with `auth list`. |
| Build dies `No space left on device` | Step 1 was skipped. Run it. |
| Build OOMs or exits 143 | Load, not code. Retry in a quiet window; check `uptime` first. |
| `check:dist` fails on a missing bundle | The build chain ran out of order or `build:vercel` was hand-run as the frontend build. Re-run `npm run build:gcp` from clean. |
| `db:check` exits 4 | Pending migrations. Read `npm run db:status`, understand every pending migration (they all apply at once), then `npm run db:migrate` only when they are all intended. |
| Post-deploy pages look stale | The CDN purge was skipped or run async. Re-run `npm run deploy:gcp:purge-cdn`. |

## Report format

Prod before -> after (SHAs, revision), what shipped (themes), test summary line, smoke result,
healthz delta, worktrees cleaned, and the one thing most worth shipping next.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/production-100-01-ship-readiness.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
