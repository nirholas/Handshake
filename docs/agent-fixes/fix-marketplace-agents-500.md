# Fix: GET /api/marketplace/agents — 105 × 500 errors, likely 42P18 on LIMIT/OFFSET

## Context

`GET /api/marketplace/agents` (the main public marketplace listing) returns 500 on ~105 requests. This is the highest-traffic public endpoint — every visitor to the marketplace page hits it. The error body contains no upstream detail because the log line is `console.error('[marketplace/list]', err?.message || err)` which truncates the message.

## Root Cause

Read `api/marketplace/[action].js` lines 342–412 in full before touching anything.

The `handleList` function at line 367 runs a `sql.transaction()` with two queries. The second query ends with:

```javascript
LIMIT ${limit + 1} OFFSET ${offset}
```

`limit` and `offset` are JavaScript numbers (validated by `Number()` + `Math.min/max`). However, when passed as template literal interpolations into a Neon `sql\`...\`` tag inside `sql.transaction()`, PostgreSQL's extended query protocol cannot infer their types — they appear as bare `$N` parameters in LIMIT/OFFSET position with no type context.

This produces PostgreSQL error **42P18** (`could not determine data type of parameter $N`), the same class of bug that affects `api/billing/withdrawals/index.js`. The fix is identical: add `::int` casts.

Additionally, audit that all referenced tables and columns exist in the production Neon database. The query joins `skill_purchases`, `agent_reviews`, `asset_prices`, and `avatars` — any missing column causes a different class of 500 that would also be visible in logs.

## What You Must Fix — Completely

### Fix 1: Add `::int` casts to LIMIT and OFFSET in `handleList`

In `api/marketplace/[action].js` at the marketplace listing query (around line 406):

**Change:**
```javascript
LIMIT ${limit + 1} OFFSET ${offset}
```

**To:**
```javascript
LIMIT ${limit + 1}::int OFFSET ${offset}::int
```

The `::int` cast is a PostgreSQL-side type annotation. It appears as `LIMIT $N::int OFFSET $N::int` in the prepared statement, giving the query planner the type context it needs.

Also check the second `handleList` function (for the "mine" or admin variant if one exists, around line 437) — if it also has `LIMIT/OFFSET` interpolations, apply the same cast.

### Fix 2: Verify referenced tables and columns exist

Run these queries against the production Neon database (use `psql "$DATABASE_URL"` or the Neon console):

```sql
-- Verify all tables used in the marketplace join exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('agent_identities', 'avatars', 'users', 'skill_purchases', 'agent_reviews', 'asset_prices')
AND table_schema = 'public';

-- Verify specific columns used in the query
SELECT column_name FROM information_schema.columns
WHERE table_name = 'skill_purchases' AND column_name IN ('agent_id', 'status', 'created_at', 'confirmed_at');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'agent_reviews' AND column_name IN ('agent_id', 'rating');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'asset_prices' AND column_name IN ('item_type', 'item_id', 'is_active', 'amount', 'currency_mint', 'chain', 'mint_decimals');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'avatars' AND column_name IN ('id', 'thumbnail_key', 'deleted_at');
```

If any column is missing, add it with a migration in `api/_lib/migrations/`. Do not alter the query to skip columns — add the missing columns.

### Fix 3: Improve error logging to surface the full error

The current `console.error('[marketplace/list]', err?.message || err)` truncates stack traces. Change it to log the full error code:

```javascript
} catch (err) {
    console.error('[marketplace/list]', err?.code, err?.message || err);
    return error(res, 500, 'db_error', 'Failed to load marketplace listing');
}
```

The `err.code` will be `'42P18'` if it's a type inference error, or another Postgres error code if something else is failing. This makes future diagnosis instant.

### Verify the fix

1. After making the code change, run the module syntax check:
   ```bash
   node --input-type=module <<'EOF'
   import('./api/marketplace/[action].js').then(() => console.log('OK')).catch(e => console.error(e.message))
   EOF
   ```

2. Start the dev server (`npm run dev`) and navigate to the marketplace page. The agent listing must load without errors and the network tab must show a successful response from `/api/marketplace/agents`.

3. Verify no 42P18 or other 500 errors appear in Vercel logs for this endpoint after deploy.

## Do Not

- Do not add a try/catch around the `sql.transaction()` that returns an empty array on DB error — fix the root cause.
- Do not remove the `sql\`SET LOCAL statement_timeout = '8000'\`` line — it protects against query hangs and must stay.
- Do not switch to raw string interpolation for limit/offset even though they're validated integers — parameterized queries with `::int` casts is the correct pattern.

## Related Files

- `api/marketplace/[action].js:367–411` — `handleList`, the broken query
- `api/billing/withdrawals/index.js` — same 42P18 pattern (see `fix-billing-withdrawals-42p18.md` for reference)
