# `deploy/world` — world.three.ws (Hyperfy on Cloud Run)

Build and deploy config for the multiplayer 3D world at **https://world.three.ws**.

The world is a [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) server pinned to an exact
upstream commit and rebuilt with three local patches. It runs as its own Cloud Run service
(`hyperfy-world`, `us-central1`), separate from the main `three-ws-api` container. World state —
the SQLite database and every uploaded asset — lives in the GCS bucket `world-three-ws-data`,
mounted at `/app/world`, so the container itself is stateless and can be rebuilt without losing
the world.

## Why the admin code matters

Hyperfy computes a player's effective rank as:

```js
get effectiveRank() {
  return this.hasAdminCode ? this.rank : Ranks.ADMIN   // src/core/systems/Settings.js
}
```

With no `ADMIN_CODE` set, `hasAdminCode` is `false` and **every visitor is `Ranks.ADMIN`** — the
server itself (`ServerNetwork.js`) then accepts entity add/modify/remove packets from anyone. That
fail-open default is not a UI oversight; it is real, server-side build access for every anonymous
visitor. It is how the world broke on 2026-06-12: the `$scene` script asset was deleted, the ground
unloaded, and every player who joined fell into a black void.

With `ADMIN_CODE` set, `effectiveRank` falls back to the world's own `settings.rank` (`0` =
`VISITOR`), so visitors can walk, chat, and explore but cannot mutate the world. A builder claims
rights in-world with the chat command:

```
/admin <code>
```

Running it again drops back to `VISITOR`.

## Deploying

From the repo root, with `gcloud` credentials that have Cloud Run, Secret Manager, and Cloud Build
access on `aerial-vehicle-466722-p5`:

```bash
bash deploy/world/apply-hardening.sh
```

The script is idempotent and safe to re-run. It:

1. Creates the Secret Manager secret `hyperfy-admin-code` **only if it does not already exist** —
   an existing code is reused, never rotated, so previously issued codes keep working. A freshly
   created code is printed exactly once.
2. Grants `roles/secretmanager.secretAccessor` on that secret to the runtime service account
   `hyperfy-world-sa@aerial-vehicle-466722-p5.iam.gserviceaccount.com`.
3. Rebuilds and pushes the image via `cloudbuild.yaml`, as the `three-ws-build@` service account
   (this project has no legacy default Cloud Build SA, so an unqualified submit fails).
4. Applies `cloudrun.yaml`, wiring `ADMIN_CODE` from the secret and `PUBLIC_MAX_UPLOAD_SIZE=16`.
5. Polls `https://world.three.ws/status` until it reports `"protected":true`, and exits non-zero if
   it never does.

Step 5 is the part that proves the deploy worked. Do not hand-edit the Cloud Run env var instead of
running the script — without the verification loop you can "succeed" against a revision that never
actually flipped `protected:true`.

## Retrieving the admin code

The code lives in Secret Manager and nowhere else. It is never committed, never printed to logs,
and never stored in this repo:

```bash
gcloud secrets versions access latest \
  --secret=hyperfy-admin-code \
  --project=aerial-vehicle-466722-p5
```

To rotate it deliberately, add a new secret version and redeploy so the new revision picks it up:

```bash
printf '%s' "$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)" \
  | gcloud secrets versions add hyperfy-admin-code --data-file=- --project=aerial-vehicle-466722-p5
gcloud run services replace deploy/world/cloudrun.yaml --region=us-central1
```

Rotation invalidates every previously issued code.

## Patches

Applied in order to the pinned upstream ref by the `Dockerfile`. Re-verify them whenever you bump
`HYPERFY_REF`; `git apply` fails the build loudly if a hunk no longer lands.

| Patch | What it does |
| --- | --- |
| `0001-upload-limit-from-env.patch` | Enforces `PUBLIC_MAX_UPLOAD_SIZE` on `/api/upload` server-side. Upstream hard-codes a 200 MB multipart cap on an unauthenticated route. |
| `0002-status-blueprint-assets.patch` | Makes `/status` enumerate every content-hashed asset each blueprint references, with absolute URLs, so `api/cron/world-health.js` can `HEAD` them and catch a missing asset before it crashes the scene for every joiner. |
| `0003-fail-closed-without-admin-code.patch` | In production, refuse to boot without `ADMIN_CODE` (exit 1) instead of warning and serving an unprotected world. A secret-less revision then fails its Cloud Run startup probe, and traffic stays on the last protected revision. |

Patch `0003` exits explicitly rather than throwing: `import 'ses'` installs an uncaught-exception
handler that reports a top-level throw but still lets the process exit `0`, which reads as a clean
shutdown in Cloud Run logs.

## Build gotchas

- Hyperfy's `npm run build` emits everything to **`build/`** — the server bundle (`build/index.js`,
  per `package.json` `"start"`), the client bundle and its assets (`build/public/`), and the PhysX
  wasm. There is no `dist/` and no top-level `public/`. Naming them is what silently broke every
  build of this image before 2026-07-09.
- Do not wrap the build in `|| true`. A swallowed failure resurfaces much later as a confusing
  `COPY failed: stat app/dist: file does not exist`.
- The container runs as **root**, deliberately. Cloud Run mounts the gcsfuse volume at `/app/world`
  root-owned, and the server writes SQLite plus uploaded assets there every `SAVE_INTERVAL`. A
  non-root `USER` boots cleanly but silently loses every world save — a quieter version of the data
  loss this hardening exists to prevent. Dropping privileges needs gcsfuse uid/gid mount options,
  not just a `USER` line.

## Monitoring

`api/cron/world-health.js` probes `/status` every 15 minutes and alerts on two conditions:

- **UNPROTECTED** — `protected` is not `true`; every visitor has build rights.
- **MISSING ASSET** — a blueprint references an asset URL that `404`s, the failure that unloaded
  the ground on 2026-06-12.

It parks its verdict in the cache for `/api/healthz` to read (`subsystems` → `world`). Run it by
hand with `curl -H "X-Cron-Secret: $CRON_SECRET" https://three.ws/api/cron/world-health`.
