# Fix: GET /api/mocap/clips — 6 × 500 errors, SQL positional parameter mismatch

## Context

`GET /api/mocap/clips` and `POST /api/mocap/clips` each return 500 on some requests. The `handleList` function uses a raw SQL string with positional parameters (`$1`, `$2`, etc.) built up dynamically via `params.push()`. The parameter indices must exactly match the push order, including conditional branches.

## Root Cause

Read `api/mocap/clips.js` in full before touching anything, paying close attention to `handleList` and the conditional `kindFilter` branch (line 87).

The function builds an SQL string and a `params` array conditionally. The `$N` placeholder indices in the SQL string must match the index at which each value was pushed into `params`. When `kindFilter` is provided, it adds an extra parameter — if the SQL template uses a hardcoded `$4` but the `kindFilter` push changes the expected index, the query will either fail with a parameter count mismatch or bind the wrong value.

Specifically examine:
1. The order of `params.push()` calls
2. Whether the `$N` placeholders in the SQL string increment correctly for each conditional branch
3. The cursor (`decoded.createdAt`) push and whether it's always at the same `$N` position regardless of the `kindFilter` branch

## What You Must Fix — Completely

### Fix 1: Audit and correct the parameter binding

Read the full `handleList` function and trace every `params.push()` call:

```
params[0] = auth.userId or null
params[1] = auth.userId or null (second occurrence)
params[2] = kindFilter (conditional)
params[3] = cursor value (conditional, position shifts when kindFilter added)
params[4] = limit + 1
```

If `kindFilter` is truthy, every `$N` after the kindFilter push must be incremented by 1. Verify the SQL string does this correctly. If not, fix the SQL string to use the correct `$N` indices.

A safer pattern is to build the WHERE clauses conditionally:

```javascript
const whereClauses = ['deleted_at IS NULL'];
const params = [];

if (auth.userId) {
    params.push(auth.userId);
    whereClauses.push(`user_id = $${params.length}`);
}
if (kindFilter && /^[a-z]+$/.test(kindFilter)) {
    params.push(kindFilter);
    whereClauses.push(`kind = $${params.length}`);
}
// cursor
if (decoded?.createdAt) {
    params.push(decoded.createdAt);
    whereClauses.push(`created_at < $${params.length}`);
}
// limit is always last
params.push(limit + 1);
const limitPlaceholder = `$${params.length}::int`;

const sqlStr = `
    SELECT ...
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ${limitPlaceholder}
`;
```

This pattern uses `$${params.length}` to self-document the index, making it impossible to have a mismatch.

### Fix 2: Verify the LIMIT/OFFSET parameter has `::int` cast

The Neon serverless driver has the same 42P18 problem for LIMIT/OFFSET as described in `fix-billing-withdrawals-42p18.md`. If the raw SQL uses `$N` in LIMIT position without a type cast, add `::int`:

```sql
-- Change:
LIMIT $4
-- To:
LIMIT $4::int
```

### Fix 3: Improve error logging

The current catch at line 113 does:
```javascript
console.error('[mocap/clips/list]', err?.message || err);
```

Add the error code so future diagnosis is instant:
```javascript
console.error('[mocap/clips/list]', err?.code, err?.message || err);
```

### Fix 4: Verify POST 405 is not from vercel.json

The 405 on `POST /api/mocap/clips` suggests the route may be restricted to GET. Check `vercel.json` for any route entry that limits this path to GET methods. If found, remove the method restriction — the handler correctly accepts both GET and POST.

### Verify the fix

1. Start the dev server (`npm run dev`)
2. Request `GET /api/mocap/clips` as an authenticated user — must return 200 with a `clips` array
3. Request `GET /api/mocap/clips?kind=bvh` — must return filtered results without error
4. Request `GET /api/mocap/clips?kind=bvh&cursor=<timestamp>` — must return paginated results

No 500 errors should appear after these tests.

## Do Not

- Do not switch from raw SQL to tagged templates for this query — the code comment explains why (`"syntax error at or near $1"` is a known Neon limitation for this pattern).
- Do not add a try/catch that returns empty arrays on failure — fix the root cause.

## Related Files

- `api/mocap/clips.js:62–115` — `handleList` function (primary fix target)
