# H6 — High: Session cookie forwarded to PostHog via the analytics proxy

**Severity:** High · **Area:** Server proxy · **Commit-gate:** no

## The defect
[server/index.mjs:120-131](../../server/index.mjs) — `proxyExternal` forwards all
request headers except a hop-by-hop set (`PROXY_SKIP_REQ`). That set does **not**
include `cookie` or `authorization`. The `/ingest/*` routes
([vercel.json](../../vercel.json) ~4200) proxy to `us.i.posthog.com`. Because the
session cookie is `__Host-sid` with `Path=/` and same-origin, the browser attaches
it to every `/ingest` analytics call — so the **full, unexpired session token is
transmitted to PostHog on every event.** Any logging or compromise at PostHog yields
hijackable sessions.

## The fix
Strip the app's own credentials before proxying. Two parts:

```js
const PROXY_SKIP_REQ = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  'accept-encoding',
  'authorization',           // <-- add
]);
```

And inside `proxyExternal`, rather than forwarding the whole `cookie` header, keep
only PostHog's own cookies (drop the session/CSRF cookies):

```js
// Forward only ph_* cookies to the analytics upstream; never our session/CSRF.
const rawCookie = req.headers.cookie || '';
const safeCookie = rawCookie
  .split(';').map((c) => c.trim())
  .filter((c) => c.startsWith('ph_') || /^__ph/i.test(c))
  .join('; ');
if (safeCookie) headers.cookie = safeCookie; else delete headers.cookie;
```

Keep this scoped to the external-proxy path (PostHog); don't alter same-origin API
dispatch, which legitimately needs the session cookie.

## Verification
1. Trigger an analytics event; inspect the outbound request to PostHog (log the
   forwarded headers in dev) → no `__Host-sid`, no `authorization`.
2. Confirm PostHog ingestion still works (its own `ph_*` cookies pass through).
3. Confirm normal authenticated API calls are unaffected.

## Done checklist
- [ ] `authorization` added to `PROXY_SKIP_REQ`.
- [ ] Session/CSRF cookies stripped from the proxied `cookie` header.
- [ ] PostHog ingestion still functions; app auth unaffected.
- [ ] `data/changelog.json` security entry added.
