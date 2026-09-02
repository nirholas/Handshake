# FA-RESIDUALS: the three open items from the 2026-07-11 deep audit

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/fable-audit-RESIDUALS.md`". Each task below is
independently shippable; do them in order and commit each as its own small, revertible commit.
Also read `CLAUDE.md`.

Everything else from that audit shipped and its work orders were retired; the findings, fixes
and evidence remain readable in git history.

## Binding operating clause

1. Finish 100% of what this machine can do. Never end with a question about scope or design.
2. Task 3 ends at a commit gate that only the owner can clear (its diff touches other-project
   skill content). Prepare it completely, verify it, leave it staged-but-uncommitted, and say
   so in one line. That is a finished task, not a blocked one.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no commented-out code, no em-dash or
   en-dash characters. Stage explicit paths only. Deploys and pushes are owner-gated.

## Task 1: OIDC-authenticated invoker for `/api/cron/*` (defense in depth)

Cron auth is already correct and fail-closed (constant-time `CRON_SECRET`, no unguarded cron
handler). This adds a second layer so a future handler that forgets the guard is not directly
internet-exploitable.

**Order matters and getting it wrong 401s every cron at once:** attach an OIDC service-account
token to every Cloud Scheduler job FIRST, verify each job still succeeds, and only then require
the audience at the edge.

1. Cheap interim control, ship this regardless of cloud access: a test that asserts every file
   under `api/cron/` calls the cron guard. Put it next to `tests/cron-auth-fail-closed.test.js`
   and make it fail on a deliberately unguarded fixture before you trust it.
2. `gcloud scheduler jobs update http <job> --oidc-service-account-email <the three-ws runtime SA>`
   across the whole job set (enumerate from Cloud Scheduler, not from memory).
3. Add the audience check at the edge in `server/index.mjs` for `/api/cron/*`, accepting the
   existing `CRON_SECRET` path as well until every job is confirmed migrated.
4. Verify by triggering one real job and reading its execution result, then remove nothing:
   both layers stay.

If `gcloud` auth is dead (`invalid_rapt`, the recurring sperax.io Workspace reauth policy), ship
step 1, write steps 2 to 4 as exact ready-to-run commands in the report, and note that one
`gcloud auth login` clears them.

## Task 2: payment-outcome observability

`recordPaymentMetric` in `api/_lib/axiom.js` already emits x402 verify, failed and settled
events with reasons, including `payment_replayed` from the spent-payment guard. Nothing surfaces
them, so the griefing classes the audit found are invisible until the economy halts.

Ship an ops view (follow the existing internal-page pattern, for example `/quality-bench`, which
is deliberately not in `data/pages.json`) showing, over a selectable window:

- verify-reject rate and the top reject reasons;
- settle-fail rate and the top failure reasons;
- replay-rejection rate split by stage (`pre_handler` vs `post_settle`);
- sponsor and fee-wallet SOL balance against the configured floor, because settle-floor
  starvation and dry wallets look identical from outside and have opposite fixes.

Real data only, from the real metric stream and the real ledger. No sample arrays, no synthetic
series. Designed empty, loading and error states. Document it in `docs/` and add a
`STRUCTURE.md` row.

## Task 3: regenerate `data/skills/seed.json` from source

The generator and drift gate already exist: `scripts/build-skills-seed.mjs`,
`npm run build:skills-seed`, `npm run check:skills-seed`. The regeneration itself was never
committed because its diff touches skill bodies that reference other crypto projects.

1. Run `npm run check:skills-seed` and record every drift it reports.
2. Run `npm run build:skills-seed`, then `check:skills-seed` again (it must pass) and a second
   build (it must write nothing: the generator is idempotent).
3. Review the diff line by line. Anything referencing a crypto project other than $THREE means
   the commit needs explicit owner approval.
4. Leave it staged and uncommitted, and state in one line exactly what the owner is approving.

## Deliberately not a task

**Splitting the god files** (`src/irl.js` ~386 KB, `src/marketplace.js` ~342 KB,
`src/dashboard/dashboard.js` ~238 KB, `src/walk.js` ~216 KB). A batch refactor of 1.1 MB has no
runtime effect, cannot be verified by anything narrower than a full browser sweep of four of the
busiest pages, and would collide head-on with the other agents editing this worktree. The
correct trigger is the next feature that opens one of these files: extract the region being
touched and leave the entrypoint intact. Do not schedule it as its own session.

## Definition of done

- [ ] Task 1: the guard test exists and fails on an unguarded fixture; the OIDC steps are either
      executed and verified against a real job run, or written as exact commands with the reason.
- [ ] Task 2: the ops view renders real metrics, with designed empty, loading and error states,
      verified in a real browser; documented and rowed in `STRUCTURE.md`.
- [ ] Task 3: `npm run check:skills-seed` passes after regeneration, the build is idempotent,
      and the diff is staged with the one-line approval request.
- [ ] `npm test` green; `npm run gate` no worse than when you started.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.
- [ ] `data/changelog.json` entry only for what users or operators can see (task 2 qualifies;
      tasks 1 and 3 do not).

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| `gcloud` auth dead | Expected and recurring. Ship the non-cloud half in full, write the cloud half as exact commands, and name the single `gcloud auth login`. |
| The metric stream looks empty | Check whether the sink is configured on the running service before assuming there is no traffic; an unset sink and zero payments look the same. |
| The seed regeneration hits the commit gate | That is the designed end state. Stage it, do not commit, and say what is being approved. |
| A metric page needs a new dependency | Use the existing page and chart patterns in the repo. Do not add a charting library for one internal page. |

## Report format

Per task: what shipped, what is staged for approval, the exact owner commands if any, and the
verification output. No recap of this file.

## History of the pack (kept here since the index file retired 2026-09-01)

The 2026-07-11 maximum-depth audit produced one work order per finding: C1, C2, H1 to H7,
M1 to M7, plus two batch records (`ENHANCEMENTS.md`, `LEAN-deletions.md`). Every numbered
finding shipped and its order was retired; the sixteen finding files were deleted in
`ab6b52c5a` (2026-07-28) and the two batch records in `96a06c6c9` (2026-08-01). Each is
readable with `git show <sha>^:prompts/fable-audit/<file>.md`, and
`git log --diff-filter=D --name-only -- prompts/fable-audit/` lists them all. The pack's
index duplicated this file's three-item table and pointed at a snapshot ref that no longer
resolves, so it was folded in here rather than kept.

Measured state of the three tasks on 2026-09-01: task 1 has its guard test
(`tests/api/cron-auth-sweep.test.js`) but no negative fixture and no OIDC step executed;
task 2 shipped the API (`api/ops/payment-outcomes.js`, live and auth-gated) and its doc,
while the page that rendered it was removed with the admin panel on 2026-08-05, so its
definition of done is the API-only scope unless a new surface is chosen; task 3's seed drift
stands at six differences (`npm run -s check:skills-seed` exits 1) and ends at the commit gate
as designed.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/fable-audit-RESIDUALS.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
