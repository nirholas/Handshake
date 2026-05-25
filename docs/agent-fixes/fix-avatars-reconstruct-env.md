# Fix: POST /api/avatars/{id}/reconstruct — 14 × 501 (REPLICATE_RECONSTRUCT_MODEL not set)

## Context

The avatar reconstruction endpoint (`POST /api/avatars/{id}/reconstruct` or equivalent reconstruct action) returns 501 Not Implemented on every request. The frontend's avatar regeneration UI shows a spinner that never completes.

Error:
```
{ code: 'regen_unconfigured', status: 501 }
```

## Root Cause

Read `api/avatars/_actions.js` lines 691–740 and `api/avatars/REGENERATE.md` before touching anything.

The reconstruct handler checks for a configured Replicate model:
```javascript
if (!env.REPLICATE_RECONSTRUCT_MODEL) {
    return error(res, 501, 'regen_unconfigured', 'Reconstruction is not configured');
}
```

`REPLICATE_RECONSTRUCT_MODEL` is not set in the Vercel production environment. Without it, no avatar reconstruction jobs can be submitted, and every attempt returns 501.

The second dependency is `REPLICATE_API_TOKEN` — without this, even if the model is configured, Replicate API calls will fail.

## What You Must Fix — Completely

### Step 1: Set REPLICATE_RECONSTRUCT_MODEL in Vercel

Per `api/avatars/REGENERATE.md`, the default model is `firtoz/trellis`:

```bash
vercel env add REPLICATE_RECONSTRUCT_MODEL production
# When prompted, enter: firtoz/trellis
```

If you want to pin a specific version for reproducibility:
```
firtoz/trellis:a1e62aa99e3d40aed1de4cd4c5c4b1f5ec25c32f8b38f6dec71b80d6083b0f4f
```

Check Replicate's model page for the latest stable version tag.

### Step 2: Set REPLICATE_API_TOKEN if not already set

```bash
vercel env ls | grep REPLICATE_API_TOKEN
```

If not present:
```bash
vercel env add REPLICATE_API_TOKEN production
# Enter your Replicate API token from https://replicate.com/account/api-tokens
```

Also add both to `.env` for local dev:
```
REPLICATE_RECONSTRUCT_MODEL=firtoz/trellis
REPLICATE_API_TOKEN=r8_<your-token>
```

### Step 3: Verify the reconstruction flow end-to-end

Read `api/avatars/_actions.js` lines 390–450 (the reconstruct job completion handler) to understand what happens after Replicate finishes:
1. Replicate webhook delivers the result to the job status endpoint
2. The job result is materialized as a new avatar row
3. The frontend polls `avatar_regen_jobs` for completion

Verify the webhook URL is configured in Replicate's callback — the `reconstruct` submission must include a `webhook` field pointing to the production jobs endpoint. Check whether `VERCEL_URL` or a hardcoded production URL is used for the webhook.

### Step 4: Update the frontend to surface "unavailable" gracefully

In `src/dashboard-next/` (find the page that calls the reconstruct endpoint), if `REPLICATE_RECONSTRUCT_MODEL` is intentionally unset, the UI must show "Avatar reconstruction is not available" rather than an infinite spinner.

Look for where the `reconstruct` action is dispatched and add a handler for the 501 response:
```javascript
if (response.status === 501) {
    // show a clear "feature not available" message, not a spinner
}
```

### Verify the fix

1. Set env vars locally in `.env`
2. Start dev server (`npm run dev`)
3. Navigate to the avatar reconstruction UI
4. Trigger a reconstruction — must submit to Replicate and return a job ID (200 response)
5. The UI must poll for completion and display the result when done

After Vercel deploy:
- `POST /api/avatars/{id}/reconstruct` must return 200/202 (job submitted) not 501

## Do Not

- Do not set `REPLICATE_RECONSTRUCT_MODEL` to a non-existent or invalid model name — verify it exists at https://replicate.com/firtoz/trellis
- Do not stub the Replicate call — reconstruction must go through the real Replicate API
- Do not remove the 501 guard — it's correct behavior when the env var is missing; the fix is to set the env var

## Related Files

- `api/avatars/_actions.js:691–740` — reconstruct handler
- `api/avatars/_actions.js:390–450` — job completion and avatar materialization
- `api/avatars/REGENERATE.md` — full env var documentation for this feature
