# fix-queue progress log

The only memory between chats. Append, never rewrite. Newest at the bottom.

Format: `YYYY-MM-DD | work order | what changed | verification`.

---

2026-08-01 | pack opened | 8 work orders written from a live sweep of this
worktree and of production. Sweep commands: `npm run gate`, `npm run lint`,
`npm run audit:links`, `npm run audit:tour-atlas`, `npm run check:cron-drift`,
`npm run check:runnable-docs`, `npm run audit:docs`, `npm run check:claude`,
`npm run check:browser-graph`, `npm run test:core` (timed out), plus
`GET /api/version` and `GET /api/healthz` against production | each work order
carries the verbatim output that reproduced it

2026-08-01 | pack trimmed | six ISSUES.md-derived work orders (x402 settle,
Solana RPC, LLM lanes, R2 CORS, fact-check benchmark, BNB and OKX blockers) were
deleted an hour after being written, because a concurrent agent shipped
`prompts/backlog/` covering the same items with an equally current measured
snapshot. Keeping both would have guaranteed drift. fix-queue now owns only
defects reproduced by running the repo's own checks; backlog owns the
infrastructure and owner-gated items | `ls prompts/backlog prompts/fix-queue`

2026-08-01 | 08-avatar-optimize-inflates | new finding, not in any tracker:
`/api/avatar/optimize?draco=1` returns output larger than its input on both
production sample avatars (default.glb 748,088 to 890,160; michelle.glb 849,756
to 974,036), and the Draco output still carries `EXT_meshopt_compression`. Note
this supersedes the older `ISSUES.md` item 9 claim of a 500 `transcode_failed`,
which is fixed | sizes measured with `curl -w '%{size_download}'`

2026-08-09 | 02-lint-errors | eslint now exits 0 with zero errors. The three
original errors were partly fixed by earlier sessions (the vite.config
duplicate key was gone); this session cleared the rest plus four newer ones:
the money-test precision literal replaced with Number.MAX_SAFE_INTEGER + 2
(same guarantee, no lossy literal; 22/22 tests pass), .claude/workflows/**
added to eslint ignores beside scripts/wf-*.mjs (same Workflow-DSL rationale),
an unknown-rule disable comment removed from agent-runtime UsageCounter, three
case-block declarations braced and one intentionally yield-less error-path
generator annotated in agent-runtime runtime.test.js (48/48 tests pass) |
npm run lint exit 0 (8352 warnings remain, all pre-existing)

2026-08-13 | 01-gate-red-hidden-guard | the hidden-guard defect this order was
written for is gone (`audit-hidden-guard: all 348 pages resolve the [hidden]
guard`), but the gate was still red on a different check: `audit:x402-catalog`
found `/api/x402/inference-verify` shipped with no row in
`docs/x402-endpoints.md`. Catalogued it in the free read surfaces table. The
order's actual done-when is a green gate, so it is met | `npm run gate` exit 0

2026-08-13 | 04-tour-atlas-broken-stops | no work needed, verified already
fixed by an earlier session | `npm run audit:tour-atlas` exit 0, "264 stops,
all anchored and photographed (35 curated, 229 generic)"

2026-08-13 | 05-stub-hrefs-dead-paths | no work needed, verified already fixed
by an earlier session. The 108 dead `#` links are gone | `npm run audit:links`
exit 0, "Stub hrefs (#, void(0)) : 0" across 2021 files

2026-08-13 | 06-runnable-docs-401 | two samples were red, not one. Both are
annotation defects exactly as the order predicted, and both were settled with
evidence rather than silenced: logged in as the QA account against production
and `GET /api/irl/world-lines/mine` returns 200 with the documented
`{world_lines, heatmap}` shape, so 401 is the correct unauthenticated answer;
`/api/permissions/verify?hash=0x00` is a deliberately malformed hash whose live
400 body still matches the documented one byte for byte. Both fences now carry a
`<!-- runnable: <status> reason -->` stating the true contract. Swept the rest of
both doc families | `npm run check:runnable-docs` exit 0, "all 86 documented
calls answer as documented"; `npm run audit:docs` clean

2026-08-13 | 07-test-core-timeout | it was slow, not stuck, and the cause was
`--maxWorkers=1` on `test:core` (added 2026-06-05 in a config sweep with no
stated reason). Serialized, imports alone take ~470s and tests ~440s. At the
default fork count the same 22,258 tests finish in 88s, 182s and 308s over
three runs. The "single worker avoids CPU-contention flake" rationale in
tests/README.md does not survive measurement: two back-to-back full runs on one
commit failed 10 files then 2, and all 8 that moved (branding,
thumbnail-url-guard, no-nul-bytes, asset-host-liveness, setup-git-hooks,
skill-royalty, node-operator, play-gate) scan the working tree, shell out to
real git, or reach the network, and each passes in isolation at full
parallelism. In a shared worktree a single worker widens that window. `test:core`
is now plain `vitest run`; `test:serial` keeps `--maxWorkers=1` as a diagnostic;
`slowTestThreshold: 5_000` makes a creeping total visible. Also corrected
tests/README.md, which documented a `.github/workflows/ci.yml` that does not
exist and that CLAUDE.md bans | `npm run test:core` exit 0 in 308s, "Test Files
1572 passed | 3 skipped", "Tests 22222 passed | 36 skipped"

2026-08-13 | 08-avatar-optimize-inflates | mechanism confirmed, not guessed:
the source is quantized AND meshopt-packed, gltf-transform keeps
`EXT_meshopt_compression` on the Document after reading, so `draco()` layered a
second mesh-compression scheme beside the meshopt payload and re-quantized
attributes `KHR_mesh_quantization` had already packed. Draco now disposes the
competing scheme and dequantizes first, both encodings are written and the
smaller one wins, and a final guard returns the untouched source bytes when
nothing beat the original. That guard is keyed on whether a transform actually
changed the model, so an ineffective lod/morph/texture cap cannot cost bytes
while a real decimation is still delivered. `x-three-ws-optimize`
(draco|meshopt|none|source) and `x-three-ws-optimize-refused` report which
happened, and all four `x-three-ws-*` headers are now in
`access-control-expose-headers`, which they were not. Pipeline extracted as
`optimizeGlb()` so the test needs no network. ISSUES.md item 9 rewritten |
9 parameter combinations across both production sample avatars: draco=1 went
from +19.0% to 0.0% on default.glb and from +14.6% to -4.4% on michelle.glb; no
combination exceeds its source except a lod that genuinely collapsed vertices
(8026 to 8018). `npx vitest run tests/avatar-optimize-never-inflates.test.js
tests/avatar-optimize-source-cap.test.js` 15 passed

2026-08-13 | 03-cron-drift-garment-sweep | NOT retired, one owner action left.
Step 2 answered: the handler is a thin authenticated proxy to the worker's
/sweep, and the worker claims at most `MAX_CONCURRENT` (default 2) ids per tick
via atomic generation-matched writes, so a first run against a backlog is safe
at `*/10`. Step 5 was already done by an earlier session: `check-cron-drift` is
registered in data/guards.json with stages [gate, manual], `needs: gcloud`, and
a `why` splitting the offline expression check (in the gate, as
`check:cron-syntax`) from the live comparison. Step 3 is blocked: this workspace
has NO gcloud credentials at all (`gcloud auth list` reports no credentialed
accounts, and .env carries only AUDIT_EMAIL/AUDIT_PASSWORD), so neither the job
creation nor the live drift comparison can run here. Needs one owner
`gcloud auth login` plus CRON_SECRET | `npm run check:cron-syntax` exit 0, "All
cron expressions are valid (offline mode: live jobs not compared)"

2026-09-02 | 03-cron-drift-garment-sweep | Still NOT retired, still one owner
action, but step 1 no longer needs the owner. An unauthenticated probe of
https://three.ws/api/cron/garment-job-sweep answers 401 (not 404) on revision
three-ws-api-00404-ph7, which is the exact distinction `classifyMissing()` in
scripts/check-cron-drift.mjs draws: the handler is live in the running revision,
so only the Cloud Scheduler write is missing and the job can be created now
rather than waiting for a deploy. Work order updated with that finding, and its
"Done when" no longer pins the fleet at the stale 101 (vercel.json declares 111
and the checker derives the count). gcloud is still dead here: `gcloud auth
list` shows nich@sperax.io but both `gcloud auth print-access-token` and the
application-default variant fail with "Reauthentication failed. cannot prompt
during non-interactive execution", so steps 3 and 4 remain owner-gated on one
interactive login | `curl -o /dev/null -w '%{http_code}'` on the cron path = 401;
`npm run check:cron-syntax` exit 0 with 111 declared crons all valid;
`npx vitest run tests/cron-scheduler-sync.test.js tests/cron-drift-classify.test.js`
25 passed

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'fix-queue-PROGRESS' prompts/finish/
       git rm prompts/finish/fix-queue-PROGRESS.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
