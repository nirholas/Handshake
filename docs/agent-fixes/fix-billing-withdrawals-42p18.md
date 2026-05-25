# Fix: GET /api/billing/withdrawals returns 500 — SQL 42P18 LIMIT/OFFSET type error

## Context

Every authenticated user who loads the monetize/billing page triggers a 500 from `GET /api/billing/withdrawals?limit=50`. The page cannot display withdrawal history. This has been firing continuously in production.

Error in Vercel logs:
```
NeonDbError: could not determine data type of parameter $2
  severity: 'ERROR'
  code: '42P18'
  routine: 'pg_analyze_and_rewrite_varparams'
  at execute (node_modules/@neondatabase/serverless/index.mjs:1556:55)
  at async api/billing/withdrawals/index.js:36
```

## Root Cause

Read `api/billing/withdrawals/index.js` in full before touching anything.

PostgreSQL's extended query protocol requires type information for all parameters at parse time. In a `LIMIT $N OFFSET $N` clause, PostgreSQL has no type context for those parameters — it cannot infer they should be integers — and rejects the query with error code 42P18 ("indeterminate datatype").

The Neon serverless driver (`@neondatabase/serverless`) uses the extended query protocol. When you write:
```javascript
sql`SELECT ... WHERE user_id = ${user.id} ORDER BY ... LIMIT ${limit} OFFSET ${offset}`
```
The driver sends `limit` and `offset` as untyped parameters ($2 and $3). Postgres sees:
```sql
SELECT ... WHERE user_id = $1 ORDER BY ... LIMIT $2 OFFSET $3
```
Parameters $2 and $3 have no type context → 42P18.

The `user.id` parameter ($1) works fine because `WHERE user_id = $1` lets Postgres infer from the column type.

Note: there is already a comment in the file explaining the 42P18 avoidance pattern for the `status` parameter — the same fix was applied there but was missed for `limit`/`offset`.

## What You Must Fix — Completely

### In `api/billing/withdrawals/index.js`

There are **four SQL template literals** in the GET handler that use `${limit}` and `${offset}`. Find them all and add `::int` casts.

Change every occurrence of:
```javascript
limit ${limit} offset ${offset}
```
To:
```javascript
limit ${limit}::int offset ${offset}::int
```

The `::int` cast is a PostgreSQL-side type annotation that appears as `LIMIT $N::int OFFSET $N::int` in the prepared statement. This gives the query planner the type context it needs and eliminates the 42P18 error.

The four locations are:
1. The withdrawals query in the `status` branch (where `status` is truthy)
2. The withdrawals query in the no-status branch
3. The count query in the `status` branch (check if it uses limit/offset — if not, no change needed)
4. The count query in the no-status branch (same check)

If the count queries don't include LIMIT/OFFSET they don't need the cast. Audit all four and apply the cast wherever `${limit}` or `${offset}` appear in SQL position.

### Verify the fix

After editing, run:
```bash
node -e "
import('./api/billing/withdrawals/index.js').then(() => console.log('module loads OK')).catch(e => console.error(e))
"
```

Then test the endpoint locally with a real authenticated session (or via the Playwright scripts in `scripts/`) and confirm the withdrawals panel loads without error.

Verify the Vercel deployment shows no more 42P18 errors for `/api/billing/withdrawals` after deploy.

## Do Not

- Do not switch to raw string interpolation for the limit/offset values — even though they are already sanitized by `parseInt` + `Math.min`, parameterized queries are the correct pattern.
- Do not change the branching logic for `status` — that fix is already correct and must stay.
- Do not add a try/catch that silently swallows the DB error and returns empty results — the error must be fixed at the SQL level.

## Related Files

- `api/billing/withdrawals/index.js` — the only file to change
- `src/dashboard-next/pages/monetize.js:69` — the frontend caller (no change needed here)

Fix this completely. After the fix, `GET /api/billing/withdrawals?limit=50` must return a valid JSON response with the `withdrawals` array for any authenticated user.
