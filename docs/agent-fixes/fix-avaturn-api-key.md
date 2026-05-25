# Fix: POST /api/onboarding/avaturn-session — 10 × 501 (AVATURN_API_KEY not set)

## Context

The avaturn-session endpoint returns 501 on every request when `AVATURN_API_KEY` is not set. This breaks the avatar editor onboarding flow for all new users.

Error:
```javascript
// api/onboarding/[action].js:37
if (!env.AVATURN_API_KEY) return error(res, 501, 'not_configured', 'Avatar editor is not available right now. Please try again later.');
```

## Root Cause

`AVATURN_API_KEY` is missing from the Vercel production environment. The endpoint is correctly guarded with a 501, but the frontend onboarding flow does not handle the 501 gracefully — it likely shows an error or hangs.

## What You Must Fix — Completely

### Step 1: Obtain an Avaturn API key

1. Log in to Avaturn at https://avaturn.me
2. Navigate to Account → API Keys (or Developer settings)
3. Create a new API key for production use

### Step 2: Set AVATURN_API_KEY in Vercel

```bash
vercel env add AVATURN_API_KEY production
# Paste the key when prompted
```

Also add to `.env` for local dev (you can use a test/sandbox key if Avaturn provides one):
```
AVATURN_API_KEY=<your-avaturn-api-key>
```

### Step 3: Verify the endpoint end-to-end

Read `api/onboarding/[action].js` lines 37–60 to understand the full avaturn-session flow:
1. The handler POSTs to Avaturn's API to create a session
2. Returns the `session_url` for the frontend iframe

After setting the key:
1. Start the dev server (`npm run dev`)
2. POST to `/api/onboarding/avaturn-session` with a valid auth session — must return 200 with `{ session_url: "https://..." }`
3. Navigate to the onboarding avatar editor page — the iframe must load successfully

### Step 4: Handle 501 gracefully in the frontend

Read the onboarding page component that calls `avaturn-session`. If `AVATURN_API_KEY` is ever absent (staging environments, etc.), the frontend must show a graceful fallback rather than a broken state.

Find the fetch call (search for `avaturn-session` in `src/`), and add a 501 handler:
```javascript
if (response.status === 501) {
    // Show: "Avatar customization is temporarily unavailable. You can set one up later."
    // Skip the avaturn iframe step, proceed with onboarding
}
```

The user should be able to complete onboarding without the avatar editor if it's unavailable.

### Verify the fix

After setting the env var in Vercel and deploying:
- `POST /api/onboarding/avaturn-session` must return 200 with a valid `session_url`
- The onboarding avatar editor page must load and show the Avaturn iframe
- No 501 responses in Vercel logs for this endpoint

## Do Not

- Do not remove the `!env.AVATURN_API_KEY` guard — it's correct; fix is to set the env var
- Do not use a stub or fake session URL — the iframe must load from a real Avaturn session
- Do not leave the frontend in a broken/hanging state when the key is missing

## Related Files

- `api/onboarding/[action].js:37–60` — avaturn-session handler
- `src/dashboard-next/` — find the onboarding page that calls this endpoint
