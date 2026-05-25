# Fix: GET /api/agent-strategy — 404 (verify vercel.json route is present and working)

## Context

`GET /api/agent-strategy` returns 404 on 2 requests in logs. The file `api/agent-strategy.js` exists and is complete.

## Current State — Verify Before Changing Anything

Read `vercel.json` and check whether the route already exists:

```bash
grep -n "agent-strategy" vercel.json
```

As of the last audit, `vercel.json` already contains:
```json
{ "src": "/api/agent-strategy", "dest": "/api/agent-strategy" }
```

**If this route is already in vercel.json, this issue may be already fixed.** The 2 logged 404s may be from before the route was added, or from a brief period when the rule wasn't deployed.

## If the Route Is Missing

Add the route to `vercel.json` in the `routes` or `rewrites` array, in the correct position (before any wildcard catch-all):

```json
{
    "src": "/api/agent-strategy",
    "dest": "/api/agent-strategy"
}
```

## Verify the fix

1. Check `vercel.json` for the route entry
2. If missing, add it and redeploy
3. After deploy, request `GET https://three.ws/api/agent-strategy` — must return 200 or 401/403 (not 404)
4. Check that the `api/agent-strategy.js` handler runs correctly end-to-end

## Do Not

- Do not create a duplicate route entry if one already exists
- Do not remove any existing route rules when adding this one

## Related Files

- `vercel.json` — route table
- `api/agent-strategy.js` — the handler file (must exist and be complete)
