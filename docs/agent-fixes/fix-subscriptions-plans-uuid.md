# Fix: GET /api/subscriptions/plans crashes on invalid creator_id — two bugs in a chain

## Context

`GET /api/subscriptions/plans?creator_id=<invalid>` returns 500 and crashes with a Postgres type error. Two distinct invalid values are reaching the server:

1. `creator_id=undefined` — JavaScript `undefined` serialized to the string `"undefined"` in the query string
2. `creator_id=u_demo` — a placeholder/demo value sent by uptime probes or Playwright smoke tests

Vercel error log:
```
NeonDbError: invalid input syntax for type uuid: "u_demo"      code: '22P02'
NeonDbError: invalid input syntax for type uuid: "undefined"   code: '22P02'
  at async handleList (api/subscriptions/plans.js:73:10)
```

## Root Cause Chain — Two Bugs, Both Must Be Fixed

### Bug 1 (API): No UUID validation before querying Postgres

In `api/subscriptions/plans.js`, the `handleList` function at line 54-79:

```javascript
const creatorId = params.get('creator_id');
// ...
rows = await sql`
    SELECT ...
    FROM subscription_plans
    WHERE creator_id = ${creatorId} AND active = true
`;
```

`creatorId` is passed directly to the SQL query with no format validation. When it's `"undefined"` or `"u_demo"`, Postgres throws 22P02 because the column type is `uuid`. The fix is to validate at the API boundary before touching the database.

### Bug 2 (Frontend): `creator_id=undefined` sent before user session resolves

In `src/dashboard-next/pages/monetize.js`:
```javascript
const creatorParam = encodeURIComponent(me.id);  // line 62
// ...
safe(() => get(`/api/subscriptions/plans?creator_id=${creatorParam}`))  // line 72
```

`me` comes from `await requireUser()`. If `me.id` is somehow `undefined` (e.g., the user object returned from the API has an unexpected shape, or a Playwright script calls this before a session is established), then `encodeURIComponent(undefined)` produces the string `"undefined"`, which gets sent to the server.

This must be guarded on the frontend so the API call is never made with an invalid ID.

## What You Must Fix — Both Bugs, Completely

### Fix 1: API validation in `api/subscriptions/plans.js`

In the `handleList` function, after extracting `creatorId` and `agentId`, add UUID format validation:

```javascript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (creatorId && !UUID_RE.test(creatorId)) {
    return error(res, 400, 'validation_error', 'creator_id must be a valid UUID');
}
if (agentId && !UUID_RE.test(agentId)) {
    return error(res, 400, 'validation_error', 'agent_id must be a valid UUID');
}
```

Place this validation after the existing check that requires at least one of `creatorId`/`agentId`. Both parameters need validation since both are passed to SQL as UUIDs.

This is the minimum change required to stop the 500 crashes. A 400 is the correct HTTP status — the input is invalid, not a server fault.

### Fix 2: Frontend guard in `src/dashboard-next/pages/monetize.js`

Before making the subscriptions plans API call, verify `me.id` is a non-empty string that looks like a UUID:

```javascript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const creatorParam = me.id && UUID_RE.test(me.id) ? encodeURIComponent(me.id) : null;

// Only fetch if we have a valid creator ID
if (creatorParam) {
    safe(() => get(`/api/subscriptions/plans?creator_id=${creatorParam}`))
}
```

Read the full `monetize.js` file to understand the loading pattern before making this change — the `safe()` call is part of a parallel fetch block and the result is used to render subscription plan UI. If `creatorParam` is null, the plans section should render empty/default state rather than crash.

Look at how other conditional fetches in this file handle missing data and follow the same pattern. Do not leave the plans UI in an indefinite loading state if the fetch is skipped.

### Verify both fixes

1. Start the dev server: `npm run dev`
2. Navigate to the monetize/billing page as an authenticated user — subscriptions plans panel must render without errors.
3. Manually curl the API with invalid values and confirm 400 responses:
   ```bash
   curl "https://three.ws/api/subscriptions/plans?creator_id=undefined"
   # → {"error":"validation_error","message":"creator_id must be a valid UUID"}  HTTP 400

   curl "https://three.ws/api/subscriptions/plans?creator_id=u_demo"
   # → {"error":"validation_error","message":"creator_id must be a valid UUID"}  HTTP 400
   ```
4. Confirm `GET /api/subscriptions/plans?creator_id=<valid-uuid>` still returns plans correctly.

## Do Not

- Do not silently swallow invalid `creator_id` values by returning empty plans. Return 400 explicitly so callers know the input was wrong.
- Do not only fix the frontend without fixing the API — the API is the authoritative boundary and must validate inputs regardless of what the frontend does.
- Do not only fix the API without fixing the frontend — the frontend bug causes unnecessary error-level log noise and may degrade user experience if the 400 isn't handled gracefully.
- Do not use a try/catch around the SQL query to convert the 22P02 into a 200 empty response. Fix the root cause.

## Related Files

- `api/subscriptions/plans.js:54-79` (handleList — server fix)
- `src/dashboard-next/pages/monetize.js:62-72` (frontend guard)

Both files must be changed. This is a two-part bug. Fix the complete chain.
