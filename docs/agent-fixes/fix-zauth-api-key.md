# Fix: ZAUTH_API_KEY not set — log noise on 30+ endpoints, zauth middleware disabled

## Context

Every authenticated endpoint emits `[zauth] disabled: ZAUTH_API_KEY not set` in logs. This appears on `api/agents`, `api/auth/wallets`, `api/avatars`, `api/keys`, `api/marketplace/agents/mine`, `api/mcp`, `api/users/me/purchased-skills`, `api/widgets`, `api/x402-pay`, and many more — essentially every endpoint that uses the zauth middleware.

This pollutes error logs so severely that real errors are buried.

## Root Cause

Read `api/_lib/zauth.js` in full before touching anything.

Line 28: `console.log('[zauth] disabled: ZAUTH_API_KEY not set')` — this fires on every request to any zauth-instrumented endpoint when `ZAUTH_API_KEY` is absent from the environment. The log level is `console.log` (which Vercel captures as INFO), but the sheer volume makes it appear as noise in filtered log views.

The `zauthProvider` middleware from `@zauthx402/sdk` provides request analytics and ZK-auth capabilities. When disabled, it's a no-op that falls back to the regular session/bearer auth — so the auth itself still works correctly.

## What You Must Fix — Completely

### Option A: Set ZAUTH_API_KEY in Vercel (recommended — enables the feature)

1. Obtain a `ZAUTH_API_KEY` from the zauthx402 dashboard (https://zauthx402.com or the API provider for this key).
2. Set it in Vercel production:
   ```bash
   vercel env add ZAUTH_API_KEY production
   ```
3. Add to `.env` for local dev:
   ```
   ZAUTH_API_KEY=<your-key>
   ```
4. Redeploy. The log line will stop appearing once the key is set.

### Option B: Suppress the log in production (if zauth is intentionally disabled)

If `ZAUTH_API_KEY` is intentionally not set (zauth is not being used), change the log in `api/_lib/zauth.js` line 28 from:

```javascript
console.log('[zauth] disabled: ZAUTH_API_KEY not set');
```

To:

```javascript
if (process.env.NODE_ENV !== 'production') {
    console.log('[zauth] disabled: ZAUTH_API_KEY not set');
}
```

This suppresses the log in production without removing the useful development-mode warning.

**Only choose Option B if you have explicitly decided not to use the zauth middleware.** If the feature is being built out or was accidentally left unconfigured, Option A is correct.

### Verify the fix

After implementing:
1. Deploy to Vercel
2. Make a request to any authenticated endpoint (e.g., `GET /api/agents`)
3. Check Vercel logs — `[zauth] disabled` must NOT appear

## Do Not

- Do not remove the `instrument()` function or the zauth import — the middleware is wired for a reason.
- Do not change `console.log` to `console.error` for this line — if you can't suppress it, log it at DEBUG level not ERROR level.

## Related Files

- `api/_lib/zauth.js:25–30` — the disabled-check log line
