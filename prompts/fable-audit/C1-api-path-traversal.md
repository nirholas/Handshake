# C1 — Critical: Unauthenticated path traversal in the API dispatcher

**Severity:** Critical · **Area:** Server routing · **Commit-gate:** no

## Context
`server/index.mjs` is the single Cloud Run entrypoint. `dispatchApi()` maps an
incoming `/api/...` URL to a handler file under `API_ROOT` and invokes its default
export as `(req, res)`. Files whose name starts with `_` (e.g. `api/_lib/*`) are
meant to be non-routable helpers.

## The defect
[server/index.mjs](../../server/index.mjs) — in `dispatchApi` (~line 245) the path
is split **before** it is percent-decoded:

```js
segments = apiPath.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
```

A single URL segment containing `%2f` and `%2e` decodes to a compound path *after*
the split, so one array element becomes e.g. `x/../../vite.config`. The only guard —

```js
if (segments.length === 0 || segments.some((s) => !isRoutable(s) || s === '..')) return false;
```

— never rejects an **embedded** `/` or `..`. `resolveApi()` then calls
`path.join(dir, head + '.js')`, which collapses the `..` and escapes `API_ROOT`.

**Verified live:** `GET /api/x%2f..%2f..%2fvite.config` resolves to
`/workspaces/three.ws/vite.config.js`, gets `import()`ed, and its default export is
invoked as an unauthenticated handler.

## Why it matters
- Escapes `API_ROOT` to `import()` arbitrary server-side `.js` (import-time side
  effects run; any default-exported function runs unauthenticated).
- Bypasses the `_`-prefix guard, so `api/_lib/*` handlers meant to be internal
  become directly reachable — defeating any auth wrapper the public route applies.
- On a money platform this is an auth/route-gating bypass with a trivial fix.

## The fix
In `dispatchApi`, reject embedded separators in the guard, and add a
defense-in-depth containment check after `resolveApi` returns:

```js
if (
  segments.length === 0 ||
  segments.some(
    (s) => !isRoutable(s) || s === '..' || s.includes('/') || s.includes('\\'),
  )
) return false;

// ...after `route = resolveApi(...)` (before caching/using it):
if (route && !route.file.startsWith(API_ROOT + path.sep)) route = null;
```

Because `decodeURIComponent` runs per-segment, a legit segment can never contain a
raw `/` — so this rejects only traversal attempts, not real routes.

## Verification
1. Add a unit/integration test (mirror `tests/server-rewrite-query.test.js`) that
   asserts `GET /api/x%2f..%2f..%2fvite.config` → 404 (route not found), and that a
   normal route like `/api/health` still resolves.
2. Manually: boot `server/index.mjs`, `curl -i 'http://localhost:8080/api/x%2f..%2f..%2fvite.config'`
   → must be 404, not 200/500.
3. Confirm existing API routes and `[param].js` / `[...rest].js` dynamic routes
   still resolve.

## Done checklist
- [ ] Guard + containment check added.
- [ ] Regression test added and passing.
- [ ] Traversal probe returns 404; normal routes unaffected.
- [ ] `data/changelog.json` security entry added.
