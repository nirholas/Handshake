# 01. Architecture: the simulation-readiness grade, v1

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](simulation-ready-00-CONTEXT.md) first; this file assumes it and does
not repeat the bet. Produced by the architect pass on 2026-08-13 from the frontier HANDOFF.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no em-dash or en-dash, explicit-path commits, pushes and deploys
owner-gated. Every architectural decision in this file is already made; if you disagree with one,
implement it and say so in your report rather than stopping to relitigate it.

**Nothing in this file is a status claim to trust.** Step 0 below re-measures.

---

## Step 0: re-derive the current state

```bash
npx vitest run tests/sim-readiness.test.js               # the kernel: expect 6/6
node -e "import('./api/_lib/sim-readiness.js').then(m=>console.log(Object.keys(m)))"
npm run db:status                                        # MUST read the draft below as pending
ls specs/SIM_READINESS.md api/_lib/migrations/20260813180000_sim_readiness_grades.sql
grep -rn "sim.readiness\|sim_readiness" api/ src/ pages/ --include=*.js -l   # what is already wired
curl -s "https://three.ws/api/provenance?src=https://three.ws/avatars/cesium-man.glb" | head -c 300
```

`npm run db:status` could not be run by the architect pass: this worktree's `.env` carries no
`DATABASE_URL` and `gcloud` is not installed in the container, so the draft migration was written
and deliberately left unapplied without a live pending-check. **Run it before you touch the
schema, and read its full output**: `npm run db:migrate` applies every pending migration in
`api/_lib/migrations/`, not only this one.

## Contracts (already committed, do not redesign)

| Artifact | Path | Status |
|---|---|---|
| The grade contract | [../../specs/SIM_READINESS.md](../../specs/SIM_READINESS.md) | committed |
| Storage schema | [../../api/_lib/migrations/20260813180000_sim_readiness_grades.sql](../../api/_lib/migrations/20260813180000_sim_readiness_grades.sql) | committed, **not applied** |
| The grader | [../../api/_lib/sim-readiness.js](../../api/_lib/sim-readiness.js) | live, 6/6 tests |
| Kernel evidence | [../../tasks/sim-readiness/probe-2026-08-13.json](../../tasks/sim-readiness/probe-2026-08-13.json) | 20 live assets |

### API shape

`GET /api/sim-readiness?src=<https glb url>` or `?hash=<64-hex sha256>`

Mirrors [`api/provenance.js`](../../api/provenance.js) exactly: same `wrap`/`cors` boundary, same
`GET,OPTIONS`, no auth, no payment, no coin surface, thin wrapper over the MCP tool handler so the
two can never disagree.

| Case | Status | Body |
|---|---|---|
| Graded (fresh or cached) | 200 | `{ cached, gradedAt, ...report }` per the spec |
| `?hash=` never graded | 404 | `{ error: "not graded" }` (never fetches bytes) |
| Missing/malformed `src` and `hash` | 400 | `{ error: "…" }` |
| `src` not https, or a blocked host | 400 | `{ error: "src must be a public https URL" }` |
| Asset over the byte cap | 413 | `{ error: "asset exceeds 64 MB" }` |
| Upstream fetch failed | 502 | `{ error: "could not fetch the asset", status }` |
| Not binary glTF 2.0 | 200 | `{ readable: false, verdict: "unreadable", blockers: ["unreadable_glb"] }` |

Caching: `cache-control: public, max-age=60, s-maxage=300` on a hit, `no-store` on every error.
A grade for fixed bytes is immutable, so the only thing that expires it is a grader version bump.

Rate bucket: the same one `/api/provenance` uses. Grading is 100× the cost of a hash lookup, so
`?src=` on an ungraded asset is the expensive path and must share the forge-class bucket, not the
free-read bucket. Reuse the existing limiter; do not invent a second one.

MCP: one free tool, `grade_sim_readiness`, registered in `api/_mcp3d/tools/` following the exact
shape of `verify_provenance` in [`api/_mcp3d/tools/provenance.js`](../../api/_mcp3d/tools/provenance.js)
(`annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`,
`inputSchema` with `glb_url` and `hash`, report returned as `structuredContent`). Free, so it ships
on both stores. Zero coin surface, like `verify_provenance`.

---

## Data flow, hop by hop

Every hop names a real source. There are no `TBD` hops.

**A. Grading our own output (the write path)**

1. A forge lane finishes and `materializeCreation` in [`api/_lib/forge-store.js`](../../api/_lib/forge-store.js) copies the GLB into R2 and writes the `forge_creations` row (`glb_key`, `glb_url`, `size_bytes`).
2. Same function, immediately after: read the GLB bytes it already holds, compute `sha256`, call `gradeSimReadiness(buf)`.
3. Upsert `sim_readiness_grades` keyed by `glb_sha256`, carrying `creation_id`, `grader_version`, `grade_ms`, and the full report.
4. Failure at step 2 or 3 never fails the generation. The creation is returned to the user either way; an ungraded asset simply has no row.

**B. Grading anything else (the read path)**

1. `GET /api/sim-readiness?src=…` → SSRF guard and https check (reuse the guard `anchor_provenance` already uses; do not write a second one).
2. Fetch the bytes with the 64 MB cap.
3. `sha256` → look up `sim_readiness_grades`. Hit at the current `grader_version` → return it with `cached: true`, no grading.
4. Miss → `gradeSimReadiness(buf)` → upsert → return with `cached: false`.
5. `?hash=` skips hops 1, 2 and 4 entirely: a pure lookup, 404 on miss.

**C. Signing the grade (the trust path)**

1. `anchor_provenance` already fetches the GLB and computes `glbSha256`.
2. Look up (or compute) the grade for that hash.
3. Pass the signed subset from [`specs/SIM_READINESS.md`](../../specs/SIM_READINESS.md#in-the-content-credential) into `buildCredential` as `simReadiness`.
4. `buildCredential` gains one optional field and the credential version becomes `threews.provenance.3d.v2`, per that spec's own additive-field rule. **Old v1 credentials must keep verifying unchanged**; `decideVerdict` selects behaviour by `version` and is the file to read before touching this.

**D. Rendering it (the surface path)**

1. `/m/:id` and `/viewer?src=` already call `GET /api/provenance` for the verify badge. They gain a second call to `GET /api/sim-readiness` on the same asset.
2. The verdict renders as a badge beside the provenance badge; the numbers render in a details panel.

**E. Agent consumption**

1. An assistant calls `grade_sim_readiness` with a `glb_url` from anywhere (ours or not).
2. It receives the report as `structuredContent` and can gate on `verdict` before spending anything.

---

## Failure modes, every hop

| Hop | Slow | Down | Garbage | Nothing |
|---|---|---|---|---|
| R2 / CDN fetch (B2) | 15 s timeout, then 502 with the elapsed time in the log | 502 `could not fetch the asset`; nothing is cached | Not glTF → 200 with `readable: false`, `unreadable_glb`. This is a valid grade, not an error. | 0-byte body → `unreadable_glb` |
| Draco / meshopt decode | Bounded by the byte cap | Decoder module missing → `unreadable_glb` with the decode error. Never a silent skip. | Corrupt stream → same | n/a |
| `gradeSimReadiness` | Hull construction dominates; 85 k triangles measured at 3.0 s. Cap input at 64 MB and grade in-process. | Cannot be down (pure, in-process) | Never throws by contract; returns `unreadable` | Zero triangles → `verdict: "unusable"`, `no_triangles` |
| Postgres upsert (A3, B4) | Fire-and-forget on the write path; the creation never waits on it | Grade is still returned to the caller, just uncached. Log and continue. | Constraint violation → log, return the computed grade | Miss on read is the normal cold case, not an error |
| Forge write path (A) | Grading adds ~1.5 s median to a generation that already takes tens of seconds | Grading failure must never fail a generation. Wrap it, log it, return the creation. | n/a | An ungraded creation renders the `ungraded` UI state |
| Credential signing (C) | n/a | Missing issuer key already returns a coded error; unchanged | A grade that cannot be computed omits `simReadiness` rather than signing a null | Unanchored assets keep working exactly as today |
| Viewer fetch (D) | Badge shows its loading state; never blocks the model render | Badge shows `ungraded`, not an error toast | Malformed JSON → treat as ungraded | 404 → `ungraded` |

**Every UI state the Designer must build** (this list is inherited verbatim):

1. **Loading**: grade requested, not back. Skeleton, never a spinner. Must not shift the model layout.
2. **`simulation_ready`**: the affirmative badge. The one state worth screenshotting.
3. **`needs_scale`**: sound geometry, unknown units. Must read as "nearly there", not as failure, and must say what to multiply by.
4. **`needs_repair`**: names the blockers in human language ("the surface has 111 open edges"), and must visually suppress the mass numbers so nobody quotes them.
5. **`unusable`**: terse and final.
6. **`ungraded`**: no row for these bytes. Offers the grade action; never reads as an error.
7. **`unreadable`**: not a valid GLB. Distinct from `unusable`.
8. **Error**: the fetch itself failed. Actionable and retryable.
9. **Overflow**: a report with many blockers and warnings must not blow the panel out.
10. **Details expanded**: the full numbers: inertia tensor, hull, topology counts. Copyable as JSON, because the robotics user's next move is pasting it into their own pipeline.

---

## Scale envelope

Measured, from [the probe run](../../tasks/sim-readiness/probe-2026-08-13.json), n = 20 real assets, 73 MB total.

| Quantity | Measured |
|---|---|
| Grade latency, fetch included | min 184 ms, median 1551 ms, max 4840 ms |
| Cost per geometry | ~72 ms per 1 000 triangles |
| Largest asset graded | 85 718 triangles, 1.2 MB, 3 015 ms |
| Report size | ~1.7 KB of JSON per asset |

| Volume | Behaviour |
|---|---|
| 10 users | Every asset graded inline on the forge write path. No queue. Nothing to tune. |
| 1 000 users | Still inline. At ~1.5 s per grade against generations that take tens of seconds, grading is under 5% of the lane's wall clock. The read path is cache-dominated: a repeat `?src=` is a hash lookup. |
| 100 000 users | Grading moves off the request path into a worker fed by the existing forge completion path, and the free `?src=` endpoint grades at most N concurrently with the rest queued behind a 202. Backfilling the existing catalog is a cron over `where grader_version <> $current`, which is exactly why that index exists. |

Hard limits to implement in v1: **64 MB byte cap** (already in the probe), **20 000 hull sample points**
(already in the grader), **15 s fetch timeout**. Pagination is not needed in v1: nothing lists grades
yet. When a browse surface lands it paginates on `idx_sim_readiness_verdict`.

Caching: grades are immutable for fixed bytes and a fixed grader, so the DB row IS the cache and the
CDN layer only needs the short `s-maxage` above. No second cache tier in v1.

---

## The build plan

Each task is one commit with explicit paths. Ordered by risk: the task most likely to invalidate the
design comes first.

| # | Task | Files | Why it is at this position |
|---|---|---|---|
| 1 | Version the grader. Export `SIM_READINESS_VERSION = 'threews.sim.readiness.v1'` and include it as `grader` on every report. Update the spec's example only if the shape drifts. | [`api/_lib/sim-readiness.js`](../../api/_lib/sim-readiness.js), [`tests/sim-readiness.test.js`](../../tests/sim-readiness.test.js) | Everything downstream stores and signs this string. Getting it wrong later means a migration of signed data. |
| 2 | Apply the schema. Read `npm run db:status` in full first, then `npm run db:migrate`. Add the store module with `getGrade(sha256)` / `putGrade(row)`. | [`api/_lib/migrations/20260813180000_sim_readiness_grades.sql`](../../api/_lib/migrations/20260813180000_sim_readiness_grades.sql), new `api/_lib/sim-readiness-store.js` | The riskiest irreversible step. If the promoted-column choice is wrong, it is far cheaper to learn now than after the endpoint ships. |
| 3 | The MCP tool `grade_sim_readiness`, free, with the SSRF guard, byte cap and fetch timeout. | new `api/_mcp3d/tools/sim-readiness.js`, plus its registration | The handler the REST route wraps. Building it first means the two cannot disagree. |
| 4 | The free REST route, a thin wrapper over task 3's handler. | new `api/sim-readiness.js` (filesystem-routed, no `vercel.json` entry needed) | Mechanical once 3 exists. |
| 5 | Grade on the forge write path, wrapped so a grading failure never fails a generation. | [`api/_lib/forge-store.js`](../../api/_lib/forge-store.js) | Needs 2 and 3. Turns the lane from on-demand into a growing corpus. |
| 6 | The credential extension: `simReadiness` in `buildCredential`, version bump to `threews.provenance.3d.v2`, v1 credentials still verifying. | [`api/_lib/provenance-3d.js`](../../api/_lib/provenance-3d.js), [`api/_mcp3d/tools/provenance.js`](../../api/_mcp3d/tools/provenance.js), [`specs/PROVENANCE_3D.md`](../../specs/PROVENANCE_3D.md), [`tests/provenance-3d.test.js`](../../tests/provenance-3d.test.js) | Touches signed bytes, so it lands only once the grade shape is settled by 1 to 5. |
| 7 | The viewer and `/m/:id` badge plus details panel, all ten states. | [`public/viewer.html`](../../public/viewer.html), the `/m/:id` page module | The Designer stage owns the polish; this task owns reachability. |
| 8 | Docs and changelog: `docs/sim-readiness.md` linked from `docs/start-here.md`, a `STRUCTURE.md` row, a `data/changelog.json` entry, `data/pages.json` if a page lands. | as listed | The Storyteller stage's input, but the entry is mandatory per CLAUDE.md. |

## Second-order effects (the Integrator's list)

- **Catalog quality gate**: a physics verdict is a harder signal than triangle count. The gate should be able to read it.
- **Object Library**: 8 of 10 CC0 assets grade `needs_repair`. Grading the library is a cron over an existing R2 manifest and immediately makes the library filterable.
- **Rig Doctor**: the same file, two questions ("will it animate?" and "will it simulate?"). They belong on the same page.
- **Spatial MCP**: a spatial payload could carry the verdict alongside its affordances, which is what makes a returned scene physically usable.
- **x402 datapoint fabric**: a graded asset is a filterable, machine-buyable asset. This is the compounding step, and it is a later slice, not v1.
- **Search and Atlas**: `verdict` becomes a facet the moment a browse surface exists.
- **Solana first**: nothing in v1 moves value. The credential anchor already on Solana is the only chain touchpoint and it is unchanged.

## Never blocked

| Blocker | Do this |
|---|---|
| `DATABASE_URL` missing locally | It is not in this worktree's `.env` and `gcloud` is absent from this container. Get it from the Cloud Run service per the CLAUDE.md playbook on a machine that has `gcloud`, or build tasks 1, 3 and 4 first (they need no DB) and land 2 and 5 when the DB is reachable. Never mock the store. |
| `npm run db:status` shows other agents' pending migrations | Read them. If they are unrelated and safe, applying them is normal (that is what the command does). If any looks destructive, stop at that one and report it; do not apply blind. |
| The credential version bump feels risky | It is the smallest correct change: `decideVerdict` selects by `version`, and `tests/provenance-3d.test.js` must gain a case proving a v1 credential still verifies. Do not add the field without the bump. |
| Grading slows a generation noticeably | It is ~5% of the lane's wall clock. If a specific lane proves otherwise, move grading behind the existing completion path rather than dropping it. |
| An asset grades differently on a re-run | It must not: sampling is fixed-stride and the math is deterministic. A genuine non-determinism is a bug in the grader and blocks the lane; root-cause it. |
| Someone proposes storing the grade on `forge_creations` | Rejected in the schema header, with the reason. A grade is a property of bytes; the same bytes appear on four surfaces. |

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/simulation-ready-01-architecture.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
