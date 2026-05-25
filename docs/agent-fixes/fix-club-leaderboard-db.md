# Fix: GET /api/club/leaderboard — 16 × 500 errors, missing DB column or table

## Context

`GET /api/club/leaderboard` returns 500 on 16 requests. No error message appears in the Vercel logs for these failures, which means the error is being swallowed without logging — or the log is being emitted at a severity level that doesn't appear in the log export.

## Root Cause

Read `api/club/leaderboard.js` in full before touching anything.

The leaderboard query joins `club_dancer_wallets` with `club_tips`. The query references `t.paid_at` (the timestamp of a completed tip payment). Most likely:
1. The `paid_at` column does not exist on `club_tips` in the production database, causing a PostgreSQL column-not-found error.
2. OR one of the two tables (`club_dancer_wallets`, `club_tips`) does not exist at all.

A secondary possibility is that the `wrap()` HTTP helper catches the error and returns 500 but does not log it with the full error context. Investigate the error path fully.

## What You Must Fix — Completely

### Step 1: Identify the actual error

Read `api/club/leaderboard.js` fully. Identify where `runForWindow()` or the main query runs, and confirm the try/catch path logs the error with full context including `err.code` and `err.message`.

If the current catch block is:
```javascript
} catch (err) {
    console.error('[club/leaderboard]', err?.message || err);
```

Change it to:
```javascript
} catch (err) {
    console.error('[club/leaderboard]', err?.code, err?.message || err);
    throw err; // or return error(res, 500, ...)
```

This ensures the Postgres error code (`42703` for column not found, `42P01` for table not found) appears in logs.

### Step 2: Audit the DB schema

Connect to the production Neon database and verify:

```sql
-- Verify tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('club_dancer_wallets', 'club_tips')
AND table_schema = 'public';

-- If club_tips exists, verify columns
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'club_tips'
ORDER BY ordinal_position;

-- If club_dancer_wallets exists, verify columns
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'club_dancer_wallets'
ORDER BY ordinal_position;
```

### Step 3: Add missing columns or tables

If `club_tips.paid_at` is missing, add it:
```sql
ALTER TABLE club_tips ADD COLUMN IF NOT EXISTS paid_at timestamptz;
```

If `club_dancer_wallets` is missing, check `api/_lib/migrations/` for the migration that creates it and apply it:
```bash
psql "$DATABASE_URL" -f api/_lib/migrations/<relevant-file>.sql
```

Record the fix in `api/_lib/migrations/` with a new idempotent SQL file. Do not apply ad-hoc schema changes without a migration file — every schema change must have a corresponding migration.

### Step 4: Verify the leaderboard endpoint works

After fixing the schema:
1. Start the dev server (`npm run dev`)
2. Request `/api/club/leaderboard` — it must return 200 with valid JSON containing `{ leaderboard: [...] }` (or equivalent structure)
3. If no club_tips rows exist, the endpoint must return an empty leaderboard, not an error

Confirm no 500 errors appear in Vercel logs after deploy.

## Do Not

- Do not return empty results silently when the DB query fails — the error must be logged with full context.
- Do not remove the leaderboard feature if the DB tables are missing — create the migration.
- Do not apply schema changes directly in Neon console without also adding a migration file in `api/_lib/migrations/`.

## Related Files

- `api/club/leaderboard.js` — the endpoint handler
- `api/_lib/migrations/` — where the fix migration must go if schema changes are needed
