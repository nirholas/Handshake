# Fix: All x402 endpoints returning 500 — Missing Upstash Redis credentials

## Context

Every `/api/x402/*` endpoint in production is completely non-functional. Each request returns HTTP 500 with exit code 1 before the handler runs. The root cause is a module-level throw in `api/_lib/x402/idempotency-cache.js` that fires at cold-start when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are missing from the Vercel environment.

Affected endpoints (all return 500 on every request):
- `GET /api/x402/model-check`
- `GET /api/x402/dance-tip`
- `GET /api/x402/skill-marketplace`
- `GET /api/x402/symbol-availability`
- `POST /api/x402/mint-to-mesh-batch`

Error seen in Vercel logs:
```
Error: [x402-idempotency] UPSTASH_REDIS_REST_URL/TOKEN required in production.
Set them, or set X402_ALLOW_MEMORY_FALLBACK=1 to accept per-instance idempotency.
  at file:///var/task/api/_lib/x402/idempotency-cache.js:28:8
Node.js process exited with exit status: 1.
```

## Root Cause

Read `api/_lib/x402/idempotency-cache.js`. At line 27-31 there is a top-level `throw` that fires on module import when both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are absent AND `X402_ALLOW_MEMORY_FALLBACK` is not set. This crashes the entire Node.js process. Because this module is imported at the top level by every x402 handler, every cold-start fails.

## What You Must Do — Complete Fix Required

### Step 1: Check for existing Upstash credentials

1. Check `.env` and `.env.local` for `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. Run `vercel env ls` to see if the variables exist in the Vercel project (they may exist but not be pulled locally).
3. If the variables exist in Vercel but not locally, pull them: `vercel env pull`.

### Step 2: If credentials do not exist anywhere

You must provision a real Upstash Redis instance. Do not use `X402_ALLOW_MEMORY_FALLBACK=1` as the permanent solution — it breaks cross-replica idempotency (two Vercel instances can each accept the same payment ID, causing double-processing).

Options:
- Log into Upstash console and create a new Redis database (region: us-east-1 for lowest latency from Vercel iad1).
- Or check if `UPSTASH_REDIS_REST_URL` is referenced in other Vercel env vars under a different name (e.g., `KV_REST_API_URL` from a Vercel KV integration) and wire those.

### Step 3: Set the environment variables in Vercel

```bash
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
```

Also add to `.env` for local dev (using a separate dev Upstash database or using `X402_ALLOW_MEMORY_FALLBACK=1` locally only).

### Step 4: Update `.env.example` or env documentation

If a `.env.example` file exists at the project root, add entries for these two variables with a comment explaining they are required for x402 idempotency in production.

### Step 5: Trigger a redeployment

After setting env vars in Vercel, trigger a redeploy:
```bash
vercel deploy --prod
```
Or push a commit to `main` which will trigger auto-deploy.

### Step 6: Verify

After deploy, hit each affected endpoint and confirm:
- `GET https://three.ws/api/x402/model-check` → should return 402 (payment required) or 200 (not 500)
- `GET https://three.ws/api/x402/dance-tip` → same
- `GET https://three.ws/api/x402/skill-marketplace` → same

If you cannot make live HTTP requests, at minimum verify locally:
```bash
UPSTASH_REDIS_REST_URL=<url> UPSTASH_REDIS_REST_TOKEN=<token> node -e "import('./api/_lib/x402/idempotency-cache.js').then(() => console.log('OK')).catch(e => console.error(e.message))"
```
Must print `OK`.

## Do Not

- Do not set `X402_ALLOW_MEMORY_FALLBACK=1` in production as the permanent fix. The comment in the code says this is explicitly for per-instance fallback only and degrades idempotency guarantees.
- Do not add a try/catch around the module throw to suppress it — that would silently break idempotency without anyone noticing.
- Do not stub out the idempotency cache with a no-op for production.

## Related Files

- `api/_lib/x402/idempotency-cache.js` — the module that throws
- `api/x402/model-check.js` — example endpoint importing the cache
- `api/x402/dance-tip.js`
- `api/x402/skill-marketplace.js`
- `api/x402/symbol-availability.js`
- `api/x402/mint-to-mesh-batch.js`

Fix this completely. Every x402 endpoint must return non-500 responses after this fix is applied.
