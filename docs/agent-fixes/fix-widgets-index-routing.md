# Fix: GET /api/widgets/index — 404/405 (verify vercel.json route is present)

## Context

`GET /api/widgets/index` returns 404 on 3 requests. The widgets listing endpoint lives at `/api/widgets` (not `/api/widgets/index`), but some callers are requesting the `/index` path.

## Current State — Verify Before Changing Anything

Read `vercel.json` and check whether the alias route already exists:

```bash
grep -n "widgets/index" vercel.json
```

As of the last audit, `vercel.json` already contains:
```json
{ "src": "/api/widgets/index", "dest": "/api/widgets" }
```

**If this route is already in vercel.json, this issue may be already fixed.**

## If the Route Is Missing

Add the route alias to `vercel.json`:
```json
{
    "src": "/api/widgets/index",
    "dest": "/api/widgets"
}
```

Place it before the wildcard `"/api/widgets/([A-Za-z0-9_-]+)"` route to ensure it takes priority.

## Additionally: Fix the frontend caller

Find the frontend code that calls `/api/widgets/index` and update it to call `/api/widgets` directly. The canonical path is `/api/widgets` — the `/index` alias is a workaround, not a permanent solution.

Search for the caller:
```bash
grep -rn "widgets/index" src/
```

Update any hit to use the correct path `/api/widgets`.

## Verify the fix

1. Check `vercel.json` for the `/api/widgets/index` → `/api/widgets` route
2. Search `src/` for any frontend code calling `/api/widgets/index` and update it
3. After deploy, request `GET https://three.ws/api/widgets/index` — must return 200 (same as `/api/widgets`)

## Related Files

- `vercel.json` — route table
- `api/widgets.js` or `api/widgets/index.js` — the handler (whichever exists)
- `src/` — frontend callers using the `/index` path
