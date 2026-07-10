# Hand-off: apply forge multi-view migrations to production (A3)

_Historical record: this is a point-in-time hand-off for the A3 task (forge multi-view migrations `20260606…`/`20260607…`, ~June 2026). It is not current guidance — it may already be resolved. For the live migration-and-deploy flow use [docs/ops/gcp-production.md](gcp-production.md) (`npm run db:status` / `db:migrate` against the production Neon `DATABASE_URL`)._

**Status:** code verified, **prod DB action pending a human with prod credentials.**

## Why

Production logs show:

```
[forge-store] listCreations failed: column "views_used" does not exist
```

`listCreations` in [api/_lib/forge-store.js](../../api/_lib/forge-store.js#L246) selects
`views_used, multiview, backend, tier, path` from `forge_creations`. Those columns are added by two
committed migrations that have **not** been applied to the production Neon database:

- `api/_lib/migrations/20260606000000_forge_multiview.sql` — adds `views_requested`, `views_used`,
  `multiview`, `backend` (the column that errors).
- `api/_lib/migrations/20260607000000_forge_tier_path.sql` — adds `tier`, `path` (also read by the
  same `SELECT`; without it the query errors on `tier`/`path` once `views_used` is fixed).

Both are idempotent (`add column if not exists`) and safe to re-run.

## What a human must run

The agent could **not** apply these: this environment has no prod `DATABASE_URL` / Neon credentials
(`.env` holds only x402/payment keys; `npm run db:status` exits with "DATABASE_URL is not set").

Use the repo's established runner (`scripts/apply-migrations.mjs`, tracked in `schema_migrations`).
With the production `DATABASE_URL` set in `.env.local` or the shell:

```sh
# 1. Review what is pending against prod (no writes)
npm run db:status

# 2. Apply the two forge migrations explicitly (scoped, conservative)
node scripts/apply-migrations.mjs --apply --file 20260606000000_forge_multiview.sql
node scripts/apply-migrations.mjs --apply --file 20260607000000_forge_tier_path.sql
```

> `npm run db:migrate` would apply **all** pending migrations in `api/_lib/migrations/`, including any
> untracked working-tree files (e.g. `2026-06-08-coin-holder-cohorts.sql`, which belongs to a
> different task and is not committed). Prefer the scoped `--file` form above for A3, or run the full
> `db:migrate` only after reviewing the complete `db:status` output.

## Verify after applying

```sh
# Columns now present on prod:
#   views_requested, views_used, multiview, backend, tier, path

# Gallery no longer 500s — expect 200 with creations (or an empty list):
curl -fsS https://<prod-host>/api/forge-gallery | head

# Reading code paths align with the migration's column names:
rg -n views_used api src
```

No code changes were needed — the migration SQL and the reading code
([api/forge.js](../../api/forge.js#L407), [src/forge.js](../../src/forge.js#L660),
[api/_lib/forge-store.js](../../api/_lib/forge-store.js#L246)) already agree on the column names.

## Pre-verified end-to-end against a real Postgres 16

Because no prod DB was reachable, the full chain was reproduced and fixed against a throwaway
Postgres 16 container (the migration `.sql` is plain DDL — `psql` runs the exact file body the
runner's `pool.query(body)` would, so the SQL semantics are identical):

1. Applied only the **base** `20260604000000_forge_creations.sql`, inserted a `done` row, and ran
   the **exact** `listCreations` SELECT → reproduced prod's `ERROR: column "views_used" does not exist`.
2. Applied `20260606000000_forge_multiview.sql` then `20260607000000_forge_tier_path.sql` → all six
   columns present with correct types (`views_requested`/`views_used` smallint, `multiview` boolean,
   `backend`/`tier`/`path` text).
3. Re-ran the exact `listCreations` SELECT → **succeeds**, returns the row (no 500).
4. Re-applying both migrations → no-op (`add column if not exists`), confirming idempotency.
5. Exercised the **write/poll** paths too: `createCreation` insert (all columns) and `findByJob`
   SELECT both succeed against the migrated schema → no submit/poll regression.

So the documented commands are known-good; the only remaining variable is prod connectivity.
