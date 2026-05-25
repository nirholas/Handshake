# Fix: GET /api/permissions/list — 2 × 500 errors, unlogged DB failure

## Context

`GET /api/permissions/list` returns 500 on 2 requests. The endpoint manages agent delegation permissions. The error message does not appear in Vercel logs at a level visible in the export, which makes diagnosis impossible without surfacing the actual Postgres error code.

## Root Cause

Read `api/permissions/[action].js` lines 310–430 in full before touching anything.

The `handleList` function runs two separate DB queries: a public query and an auth-gated query. Both are wrapped in try/catch blocks (lines 371 and 425) that call `console.error`. However, the error message format uses `err?.message || err` which omits the Postgres error code — making it impossible to distinguish a 42703 (missing column), 42P01 (missing table), 42P18 (type inference), or ECONNRESET (connection failure) in the logs.

The most likely root causes:
1. A referenced column in `agent_delegations` doesn't exist (e.g., `delegation_hash`, `chain_id`, `contract_address`).
2. The `isDelegationValid()` call or an on-chain verification step is throwing an unhandled error.
3. The `agent_delegations` table itself is missing or has a schema mismatch.

## What You Must Fix — Completely

### Step 1: Add full error context to both catch blocks

In `api/permissions/[action].js`, update both error catch blocks in `handleList`:

**Public query catch (around line 371):**
```javascript
} catch (err) {
    console.error('[permissions/list] public query failed', err?.code, err?.message || err);
    return error(res, 500, 'db_error', 'Failed to load permissions');
}
```

**Auth query catch (around line 425):**
```javascript
} catch (err) {
    console.error('[permissions/list] auth query failed', err?.code, err?.message || err);
    return error(res, 500, 'db_error', 'Failed to load permissions');
}
```

### Step 2: Verify the agent_delegations table schema

Connect to the production Neon database and check:

```sql
-- Verify agent_delegations exists and has required columns
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'agent_delegations'
ORDER BY ordinal_position;

-- Verify agent_identities referenced columns
SELECT column_name FROM information_schema.columns
WHERE table_name = 'agent_identities'
AND column_name IN ('id', 'user_id', 'deleted_at');

-- Verify user_wallets referenced columns
SELECT column_name FROM information_schema.columns
WHERE table_name = 'user_wallets'
AND column_name IN ('user_id', 'address');
```

If any column is missing from `agent_delegations`, create a migration in `api/_lib/migrations/` to add it with `ADD COLUMN IF NOT EXISTS`.

### Step 3: Check the delegations query for 42P18

Read the SQL query in `handleList`. If it has `LIMIT $N OFFSET $N` in LIMIT/OFFSET position without a `::int` cast, add the cast:

```sql
-- Change:
LIMIT ${limit} OFFSET ${offset}
-- To:
LIMIT ${limit}::int OFFSET ${offset}::int
```

### Step 4: Verify the fix

1. Start the dev server (`npm run dev`)
2. Request `GET /api/permissions/list` as an authenticated user — must return 200 with a `permissions` array (empty is fine if no delegations exist)
3. Request `GET /api/permissions/list` as an unauthenticated user — must return 200 with public delegations only

No 500 errors after these tests.

## Do Not

- Do not return empty results silently when the DB query fails — log the error and return a proper 500.
- Do not alter the delegations schema without adding a migration file.

## Related Files

- `api/permissions/[action].js:310–430` — `handleList` function
- `api/_lib/migrations/` — where schema fix migrations go
