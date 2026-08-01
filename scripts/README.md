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
node scripts/set-r2-cors.mjs --probe    # measure the live policy from outside
node scripts/set-r2-cors.mjs --get      # read the live policy (admin token only)
node scripts/set-r2-cors.mjs --dry-run  # print the policy without pushing
node scripts/set-r2-cors.mjs            # apply (admin token only)
```

Start with `--probe`. It measures what the bucket actually enforces using only
the object-scoped keys every environment already has: one HEAD per origin
against the public host for the read rule, one PUT preflight against the S3
endpoint for the write rule. It prints a row per origin, marks any row where
the measurement disagrees with the policy in the script, and exits `1` on
drift. `--get` and the bare apply both call Get/PutBucketCors, which an
"Object Read & Write" token cannot do; they print the exact token to mint
instead of a stack trace.

Credentials come from `.env` / `.env.local`, or from the Cloud Run service for
production values (`gcloud run services describe three-ws-api --region
us-central1 --project aerial-vehicle-466722-p5 --format=yaml`). Do not use
`vercel env pull`: it returns empty for secret-type vars, and production has
not run on Vercel since 2026-07-07. An admin token belongs in `.env.local` as
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.

Allowed origins are defined inline in the script: edit `ALLOWED_ORIGINS` when
you add a new domain (preview branch, staging host, etc.) and re-run.
Idempotent: re-running with the same policy is a no-op.

Run this any time you see `No 'Access-Control-Allow-Origin' header` errors
on assets served from `*.r2.dev` or your custom R2 domain. As of 2026-08-01
the live policy is an origin allowlist that predates the current script, so
`--probe` reports drift on `www.three.ws`, `*.app.github.dev`,
`localhost:5173`, and every third-party origin. Until an admin token applies
the fix, browser reads of bucket-hosted GLBs from an unlisted origin must go
through [`/api/glb`](../docs/media-api.md#same-origin-glb-proxy).

### `mobile-perf.mjs`: mobile field metrics under CPU + network throttling

```sh
npm run perf:mobile                                    # top-15 preset vs production
npm run perf:mobile -- --pages /,/forge --runs 3
npm run perf:mobile -- --base http://localhost:3000 --net fast4g --cpu 2
npm run perf:mobile -- --json out.json --md out.md --label baseline
```

Drives each page in a real Playwright mobile context (default Pixel 5,
Chromium) with CDP throttling applied: `Emulation.setCPUThrottlingRate` (4x by
default) and `Network.emulateNetworkConditions` (default `slow4g`, the same
1.6 Mbps / 750 Kbps / 150 ms profile Lighthouse uses for its mobile preset).
It reads LCP, CLS, FCP, long-task blocking time, DOMContentLoaded, load, real
over-the-wire transfer bytes (CDP `Network.loadingFinished.encodedDataLength`),
request count, DOM size, and WebGL contexts created / still live / visible.

**These are Playwright-measured field-style metrics, not Lighthouse scores.**
Lighthouse is not a dependency of this repo. `TBT*` in the output is a long-task
blocking-time proxy, `sum(max(0, longtask.duration - 50))`, not Lighthouse's
simulated Total Blocking Time, and there is deliberately no blended
"performance score". Report the individual metrics, never a score.

Reports the median of `--runs` runs per page. Every run gets a fresh browser
context with service workers blocked, so transfer bytes are always cold-cache.

### `mobile-touch-audit.mjs`: touch targets, gesture conflicts, safe areas

```sh
npm run audit:mobile-touch
npm run audit:mobile-touch -- --pages /marketplace --json out.json --md out.md
```

Loads each page in a Pixel 5 context and inspects the live computed DOM for the
four mobile ergonomics defects that matter: interactive elements whose rendered
box is under 44x44 CSS px (inline text links are exempt per WCAG 2.5.8 and
counted separately), visible canvases left at `touch-action: auto` where orbit
gestures fight page scroll, bottom-anchored fixed bars with no CSS rule
mentioning `safe-area-inset` plus whether the viewport meta opts into
`viewport-fit=cover`, and horizontal overflow at the mobile viewport width.

Every finding is a measured bounding box or a resolved computed style, never a
source grep, so the output can be quoted directly as evidence.
