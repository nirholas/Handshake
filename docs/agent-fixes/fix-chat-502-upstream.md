# Fix: POST /api/chat — 18 × 502 errors from upstream AI provider failures

## Context

`POST /api/chat` returns 502 (bad gateway) on 18 requests. The 502 comes from upstream AI providers (Anthropic or the worker proxy) returning 5xx responses that the handler propagates directly to the client.

## Root Cause

Read `api/chat.js` lines 280–370 in full before touching anything.

The handler already has multi-provider fallback logic at line 314:
```javascript
if ((upstream.status === 429 || upstream.status >= 500) && routeIdx + 1 < fallbackRoutes.length) {
    // fall over to next route
}
```

The 502 errors occur when **all fallback routes are exhausted** — every configured provider returned 5xx. When that happens, the handler returns 502 with the upstream error message.

Two distinct failure modes:
1. **All providers simultaneously returning 5xx** — rare but possible during an Anthropic or OpenAI incident.
2. **Fallback routes not configured** — if `fallbackRoutes` has only one entry, the first failure immediately returns 502 with no retry.

Additionally, the handler logs the error at `console.error` level (line 333) but the upstream error **message** may be truncated at 400 characters, making it hard to diagnose which provider failed and why.

## What You Must Fix — Completely

### Step 1: Audit the fallback route configuration

Read `api/chat.js` to find where `fallbackRoutes` is built. Identify:
- How many routes are configured in production (check env vars like `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CHAT_WORKER_URL`)
- Whether any route is missing its API key (which would cause it to skip or fail immediately)

If only one provider is configured, the fallback logic is irrelevant and any provider 5xx becomes a user-facing 502.

Verify all required env vars are set in Vercel production:
```bash
vercel env ls | grep -E "ANTHROPIC_API_KEY|OPENAI_API_KEY|CHAT_WORKER_URL"
```

### Step 2: Add single-provider retry before failover

For the case where the primary provider returns a transient 5xx (e.g., 503 Service Unavailable), add one retry before falling to the next provider:

In `api/chat.js`, in the route loop, before the `if (routeIdx + 1 < fallbackRoutes.length)` check, retry once on 5xx:

```javascript
// First try
upstream = await fetch(route.url, { ... });

// One retry on transient 5xx (503/504 are most common transient errors)
if ([503, 504].includes(upstream.status)) {
    await new Promise(r => setTimeout(r, 500));
    upstream = await fetch(route.url, { ... });
}
```

Only retry 503 and 504 (gateway-level transient errors). Do NOT retry 400, 401, 422 (client errors) or 500 (provider bugs) — those won't recover on retry.

### Step 3: Improve error logging for provider failures

At line 333, the current log is:
```javascript
console.error(`[chat:${route.name}]`, upstream.status, text.slice(0, 400));
```

Enhance it to log the route name and whether it was a final failure:
```javascript
const isFinal = routeIdx + 1 >= fallbackRoutes.length;
console.error(
    `[chat:${route.name}]`,
    upstream.status,
    isFinal ? '(final — no more fallbacks)' : '(failing over)',
    text.slice(0, 400)
);
```

This lets you distinguish "all providers failed" from "primary failed, fell back" in the logs.

### Step 4: Add a user-friendly error body on final 502

When all providers fail, the current response is:
```javascript
return error(res, 502, 'upstream_error', `${route.name} returned ${upstream.status}...`);
```

Add a generic message so the frontend can show a human-readable error:
```javascript
return error(res, 502, 'upstream_error', 'AI chat provider is temporarily unavailable. Please try again in a moment.');
```

The frontend chat UI should display this message to the user rather than a raw error object.

### Verify the fix

1. Start the dev server (`npm run dev`)
2. Send a POST to `/api/chat` with a valid session and message body — must return a streaming SSE response without 502
3. Verify the response streams correctly and completes without error

For provider failure simulation:
- Temporarily set `ANTHROPIC_API_KEY` to an invalid value in `.env` local dev
- Send a chat request — should fall over to the next provider (OpenAI or worker proxy) and succeed

## Do Not

- Do not add retry for non-transient errors (400, 401, 422, 500).
- Do not remove the existing fallback route logic — it's the primary resilience mechanism.
- Do not add infinite retry loops — maximum one retry per provider, then fall over.
- Do not mock the AI responses or hardcode fallback text.

## Related Files

- `api/chat.js:280–370` — primary route loop and fallback logic
- `api/chat.js:427–440` — fallback routes configuration
