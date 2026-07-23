# Scripts

This directory contains various scripts for the 3D-Agent application.

## Usage

...

## Operational

### `gcp-logs.mjs`: read/tail Cloud Run production logs (`vercel logs` equivalent)

```sh
npm run logs                       # three-ws-api, last hour
npm run logs:tail                  # live tail
npm run logs -- -s model-rig --errors --since 2d
npm run logs -- --all --grep "forge" --warnings
```

Renders app logs (`textPayload`/`jsonPayload`) and request logs chronologically,
severity-colored, for any service in the fleet. Full guide:
[docs/ops/gcp-logs.md](../docs/ops/gcp-logs.md).

### `gcp-triage.mjs`: automated production monitor

```sh
npm run triage:gcp                 # human report
npm run triage:gcp -- --json      # what agents consume (exit 1 = actionable findings)
```

Merges `/api/healthz` with a fleet-wide WARNING+ log sweep, fingerprints
repeated signatures, classifies each against the runbook
([docs/ops/production-log-triage.md](../docs/ops/production-log-triage.md)) into
owner / env-action / investigate / self-healing, and prints the concrete action
per finding. Agents drive the fix loop via the `/gcp-triage` skill.

### `inspect-pbr-channels.mjs` — PBR channel matrix for any GLB

```sh
node scripts/inspect-pbr-channels.mjs public/avatars/fox.glb
node scripts/inspect-pbr-channels.mjs --json https://storage.googleapis.com/three-ws-avatar-reconstructions/mesh.glb
```

Loads a local file or public https GLB with `@gltf-transform/core` and reports,
per material, whether baseColor/normal/metallicRoughness/occlusion/emissive
are a real texture, a flat factor, or missing, plus which `KHR_materials_*`
extensions (clearcoat, transmission, sheen, ior, anisotropy, volume) are
present. This is the ground truth for auditing whether a forge lane emits a
full PBR set or just albedo, without opening the GLB in a 3D editor by hand.

### `set-r2-cors.mjs` — apply the bucket CORS policy

Runs the canonical CORS policy against the R2 bucket holding all media
(avatars, thumbnails, posters). Required for browser reads (`<model-viewer>`,
`<img>`, `fetch`) and presigned uploads to work cross-origin.

```sh
vercel env pull .env
node scripts/set-r2-cors.mjs            # apply
node scripts/set-r2-cors.mjs --get      # show what's currently live
node scripts/set-r2-cors.mjs --dry-run  # print the policy without pushing
```

Allowed origins are defined inline in the script — edit `ALLOWED_ORIGINS`
when you add a new domain (preview branch, staging host, etc.) and re-run.
Idempotent: re-running with the same policy is a no-op.

Run this any time you see `No 'Access-Control-Allow-Origin' header` errors
on assets served from `*.r2.dev` or your custom R2 domain.
