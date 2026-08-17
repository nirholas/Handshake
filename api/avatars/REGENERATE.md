# Avatar Regeneration API

Pluggable endpoint for avatar re-mesh, re-texture, re-rig, and restyle operations. Designed to support multiple ML backends with a consistent interface.

## Endpoints

### `POST /api/avatars/regenerate`

Initiate an avatar regeneration job.

**Authentication:** Session cookie or `avatars:write` bearer token required.

**Request body:**

```json
{
	"sourceAvatarId": "avatar-uuid",
	"mode": "remesh|retex|rerig|restyle",
	"params": {
		"custom": "values"
	}
}
```

**Mode definitions:**

- `remesh` — regenerate mesh topology from source material or reference
- `retex` — regenerate textures and materials
- `rerig` — regenerate skeleton/rig bindings
- `restyle` — regenerate styling/appearance from description

**Success response (202):**

```json
{
	"ok": true,
	"jobId": "string",
	"status": "queued",
	"eta": null
}
```

**Error responses:**

- **404 not_found** — source avatar not found or not owned
- **501 regen_unconfigured** — `AVATAR_REGEN_PROVIDER` env var not set
    ```json
    {
    	"error": "regen_unconfigured",
    	"error_description": "Avatar regeneration is not yet wired to an ML backend. Set AVATAR_REGEN_PROVIDER env var."
    }
    ```
- **429 rate_limited** — user has exceeded upload quota

`POST /api/avatars/reconstruct` (the selfie and text→avatar lane) additionally
pre-flights the caller's plan quota before it spends any GPU time, and answers a
full library with:

- **402 plan_limit**, the avatar count or storage ceiling for the plan is
  already reached, so the job would have nowhere to land
    ```json
    {
    	"error": "plan_limit",
    	"error_description": "Your avatar library is full on this plan. Delete an avatar or upgrade to build another."
    }
    ```

### `GET /api/avatars/regenerate-status?jobId=<id>`

Poll the status of a regeneration job.

**Authentication:** Session cookie or `avatars:read` bearer token required.

**Query parameters:**

- `jobId` (required) — job ID from regenerate endpoint

**Success response (200):**

```json
{
	"ok": true,
	"jobId": "string",
	"status": "queued|running|rigging|done|failed",
	"resultAvatarId": "avatar-uuid",
	"resultGlbUrl": "https://…/model.glb",
	"error": "optional error message",
	"errorKind": "input"
}
```

**Status values:**

- `queued` — job waiting for processing
- `running` — actively processing
- `rigging`, the mesh landed bare and a child auto-rig job is running
- `done` — completed successfully
- `failed` — failed (check `error` field)

**`error` and `errorKind`:**

`error` is never the raw provider or job string: that can name a vendor, a task
id, or an upstream status, so it is collapsed into neutral copy before it leaves
the API. Two cases are relayed verbatim instead, and both are marked
`errorKind: "input"`:

- a worker rejection the worker itself classified as caller-facing ("no face
  detected in any of the provided photos");
- a plan-quota refusal at materialization, telling the caller to delete an avatar
  or upgrade.

`errorKind` is absent on every other error. Clients should print an
`errorKind: "input"` message as-is and only apply their own friendlier wording
when it is absent, the `/create/selfie` poll loop does exactly this
([`src/selfie-pipeline.js`](../../src/selfie-pipeline.js)), because rewriting an
exact reason with a keyword guess sends the user off to retake a photo that was
never the problem.

## Provider Plug Shape

Providers are swapped via the `AVATAR_REGEN_PROVIDER` env var (e.g., `meshy`, `csm`, `rodin`, `tripor`, `stub`).

### Provider function signature

```typescript
// Each provider exports an async factory function
export async function createRegenProvider(config) {
	return {
		// Accept regeneration request, return job handle
		submit: async (request) => {
			// request shape:
			// {
			//   userId: string,
			//   sourceAvatarId: string,
			//   mode: 'remesh' | 'retex' | 'rerig' | 'restyle',
			//   params: Record<string, unknown>,
			//   sourceStorageKey: string,  // R2 path to source GLB
			// }

			// return shape:
			// { jobId: string, eta?: number }
			return { jobId: 'ext-' + Date.now(), eta: 30 };
		},

		// Poll job status
		status: async (jobId) => {
			// return shape:
			// {
			//   status: 'queued' | 'running' | 'done' | 'failed',
			//   resultGlbUrl?: string,   // temporary signed URL or CDN URL
			//   textureUrls?: string[],  // optional pre-resolved texture URLs
			//   error?: string,
			// }
			return { status: 'done', resultGlbUrl: 'https://...' };
		},
	};
}
```

### Output requirements

When `status` returns `done`:

- **resultGlbUrl** (required) — HTTP(S) URL to the regenerated GLB file. If temporary signed URL, provider must guarantee it stays valid for at least 24 hours.
- **textureUrls** (optional) — Array of HTTP(S) URLs to texture files if they differ from those embedded in the GLB.

Provider is responsible for:

1. Storing intermediate results (probably temporary S3 / R2 bucket)
2. Persisting temporary URLs long enough for the client to register the avatar
3. Handling cleanup of stale jobs after X days

The client will:

1. Fetch the GLB from `resultGlbUrl` and store it in `avatars` R2 bucket
2. Register the new avatar via `POST /api/avatars` with `parent_avatar_id = sourceAvatarId`
3. Delete or archive the old avatar (user decision)

## Candidate providers

Research-stage notes (costs and integration effort unknown):

| Provider    | Specialization         | Notes                                                                            |
| ----------- | ---------------------- | -------------------------------------------------------------------------------- |
| **Meshy**   | 3D generation          | Text/image → mesh. API available; evaluate cost/time.                            |
| **CSM**     | Custom avatar builder  | Photo → avatar. Avalready integrated for `POST /api/onboarding/avaturn-session`. |
| **Rodin**   | Avatar generation      | Competitors of Meshy; check pricing.                                             |
| **TripoSR** | Text-to-3D models      | Open-source model; would need self-hosted inference.                             |
| **Kaedim**  | Automated mesh cleanup | Specifically optimized remeshing for game assets.                                |

Picking a provider is a separate decision and out of scope for this contract. When chosen, create `api/_providers/<name>.js` implementing the shape above, then set `AVATAR_REGEN_PROVIDER=<name>` in Vercel env.

## Environment

Add to `.env.local` or Vercel settings. The provider is **auto-detected from
present credentials** (priority: paid → free). Set `AVATAR_REGEN_PROVIDER`
explicitly to override.

```
# Explicit override (optional). Auto-detected order is replicate → gcp → huggingface.
AVATAR_REGEN_PROVIDER=replicate

# --- Replicate (paid, $0.035/run TRELLIS default) ---
REPLICATE_API_TOKEN=r8_...
# Optional — defaults to firtoz/trellis (MIT TRELLIS). Pin a version with owner/name:hash
REPLICATE_RECONSTRUCT_MODEL=firtoz/trellis
# Optional — if APP_ORIGIN is set this is derived. Replicate POSTs done predictions here.
REPLICATE_WEBHOOK_URL=https://three.ws/api/webhooks/replicate
# REQUIRED if you create the webhook in Replicate dashboard (gives you whsec_…)
REPLICATE_WEBHOOK_SIGNING_KEY=whsec_…

# --- GCP Cloud Run (self-hosted InstantMesh, see workers/avatar-reconstruction/) ---
GCP_RECONSTRUCTION_URL=https://avatar-reconstruction-…run.app
GCP_RECONSTRUCTION_KEY=…

# --- HuggingFace (free, Space queue, variable wait) ---
HF_TOKEN=hf_…
# Comma-separated failover chain. Format: "owner/name[:api_name]". First success wins.
# Default chain (when unset): tencent/Hunyuan3D-2.1, tencent/Hunyuan3D-2,
# JeffreyXiang/TRELLIS, stabilityai/TripoSR.
HF_RECONSTRUCT_SPACES=tencent/Hunyuan3D-2.1,JeffreyXiang/TRELLIS:image_to_3d
```

## Webhooks (Replicate only — optional but recommended)

When `REPLICATE_WEBHOOK_URL` is configured, every prediction submission asks
Replicate to POST `/api/webhooks/replicate` when the prediction completes.
That handler verifies the `webhook-signature` (Standard Webhooks spec), updates
the `avatar_regen_jobs` row, and — for `reconstruct` jobs — materializes the
avatar inline. The client's status poll then sees `done` + `resultAvatarId`
on its very next hit without any Replicate API call.

The poll path still works as a fallback: if a webhook is dropped/blocked,
the next `regenerate-status` call triggers a manual provider.status() poll
that reconciles the row.

To create the webhook + grab the signing secret:

1. Set `REPLICATE_WEBHOOK_URL=https://three.ws/api/webhooks/replicate` in Vercel.
2. Replicate dashboard → Webhooks → Add → URL = same → Save.
3. Copy the `whsec_…` secret → set as `REPLICATE_WEBHOOK_SIGNING_KEY` in Vercel.
4. Redeploy.

## Database schema (future migration)

The stub provider and status endpoint assume a `avatar_regen_jobs` table:

```sql
create table avatar_regen_jobs (
  job_id text primary key,
  user_id uuid not null,
  source_avatar_id uuid not null,
  mode text not null,  -- remesh | retex | rerig | restyle
  params jsonb,
  status text not null,  -- queued | running | done | failed
  result_avatar_id uuid,
  error text,
  created_at timestamp default now(),
  updated_at timestamp default now(),
  foreign key (user_id) references users(id),
  foreign key (source_avatar_id) references avatars(id),
  foreign key (result_avatar_id) references avatars(id)
);

create index on avatar_regen_jobs(user_id);
create index on avatar_regen_jobs(job_id, user_id);
```

This table is not required if using an external provider (e.g., Meshy) for job tracking.
