# The 3D Asset Pipeline (pay-per-stage over x402)

three.ws runs a full 3D asset pipeline — the same lanes the platform uses to turn
a prompt into a rigged, game-ready character. Every working stage is sold as its
own [x402](x402.md) resource: an AI agent pays a few cents in USDC, hands in a URL,
and gets back a finished asset URL. No API key, no account, no signup.

Nobody else in the x402 ecosystem offers this. The generation stage (text/image →
3D) is [`/api/x402/forge`](x402-endpoints.md); the stages below are what you do to
a mesh *after* it exists.

```
 generate  →  rig  →  remesh / gameready  →  stylize  →  deliver
 (forge)      (skeleton) (topology + budget)  (geometry) (GLB URL)
```

## Two ways to buy

1. **One stage at a time** — `POST /api/x402/pipeline-<stage>`. One payment buys
   one finished asset, returned inline as a durable first-party URL. This is the
   reference below.
2. **The whole chain in one call** — [`POST /api/x402/pipeline`](x402-endpoints.md).
   Submit an ordered chain (`generate → rig → remesh → gameready → stylize`); the
   402 quote is the exact sum of the requested stages, and you poll the job free
   at `GET /api/forge?job=<id>` while it advances. Use this when you want the full
   pipeline without orchestrating each call yourself.

Both run on the same GCP Cloud Run workers (`workers/remesh`, `workers/stylize`,
`workers/rembg`, and the avatar-pipeline rig controller). A stage whose worker
isn't configured on a deployment returns `503 unconfigured` **before** settlement,
so a buyer is never charged for a stage that can't run.

## How a paid stage call works

Every `pipeline-*` route is a synchronous, pay-per-call endpoint:

1. You `POST` a JSON body with the source URL + options.
2. If you send no `X-PAYMENT` header, you get a `402` challenge quoting the price
   in USDC (Solana mainnet; Base when configured).
3. You settle and retry with `X-PAYMENT`. The server validates your input URL
   (SSRF-guarded, magic-byte sniffed), submits the worker job, polls it to
   completion, validates the output bytes, mirrors the result into first-party
   storage, and returns its URL.
4. **Any** failure — bad URL, wrong media type, worker error, timeout, corrupt
   output — throws *before* settlement. You keep your USDC and can retry.

Prices are env-overridable per the [pricing model](x402-endpoints.md#pricing-model)
(`X402_PRICE_<UPPER_SNAKE_SLUG>`).

## Stages

### Rig — `POST /api/x402/pipeline-rig` — $0.05

Infers a humanoid skeleton and binds it to a static mesh with skin weights, so the
model can walk, wave, and emote. **In:** a static GLB. **Out:** a rigged GLB.

```bash
# 1. Discover the price (unpaid request returns the 402 challenge)
curl -s -X POST https://three.ws/api/x402/pipeline-rig \
  -H 'content-type: application/json' \
  -d '{"glb_url":"https://three.ws/avatars/mannequin.glb","rig_type":"biped"}'

# 2. Pay with an x402 client (settles the 402 and retries automatically)
npx @x402/fetch POST https://three.ws/api/x402/pipeline-rig \
  --json '{"glb_url":"https://three.ws/avatars/mannequin.glb","rig_type":"biped"}'
# → { "stage":"rig", "output_url":"https://three.ws/cdn/x402-pipeline/rig/….glb", ... }
```

### Remesh — `POST /api/x402/pipeline-remesh` — $0.03

Retopologizes a mesh: triangle/quad/low-poly remeshing, repair, or decimation to a
target face count, with the texture re-baked onto the new topology. **In:** a GLB +
options. **Out:** a cleaned GLB with predictable topology.

```bash
npx @x402/fetch POST https://three.ws/api/x402/pipeline-remesh \
  --json '{"glb_url":"https://three.ws/avatars/brainstem.glb","remesh_mode":"quad","target_faces":20000}'
# → { "stage":"remesh", "output_url":"…", "face_count":20000, "quad_ratio":0.98, "textured":true }
```

Options: `remesh_mode` (`triangle` | `quad` | `lowpoly`), `operation` (`full` |
`simplify` | `repair` | `convert`, triangle mode only), `target_faces`
(1,000–500,000), `texture_size` (512 | 1024 | 2048).

### Game-Ready — `POST /api/x402/pipeline-gameready` — $0.03

An opinionated engine-ready preset: retopologize to a fixed polygon budget (quad
QuadriFlow or silhouette-preserving low-poly) with PBR re-baked onto the new
topology, so the asset drops into a real-time engine within budget. **In:** a GLB +
`poly_budget`. **Out:** an engine-ready GLB.

```bash
npx @x402/fetch POST https://three.ws/api/x402/pipeline-gameready \
  --json '{"glb_url":"https://three.ws/avatars/fox.glb","topology":"quad","poly_budget":12000}'
# → { "stage":"gameready", "output_url":"…", "poly_budget":12000, "quad_ratio":0.97 }
```

Options: `topology` (`quad` | `tri`), `poly_budget` (1,000–500,000), `texture_size`
(1024 | 2048).

### Stylize — `POST /api/x402/pipeline-stylize` — $0.03

Geometric restyle: voxel, brick, Voronoi-shatter, or faceted low-poly filters that
rebuild the mesh itself (not a shader), so the look survives export to any engine.
**In:** a GLB + `style`. **Out:** a restyled GLB.

```bash
npx @x402/fetch POST https://three.ws/api/x402/pipeline-stylize \
  --json '{"glb_url":"https://three.ws/forge/statue.glb","style":"voxel","resolution":48}'
# → { "stage":"stylize", "output_url":"…", "style":"voxel", "resolution":48 }
```

Options: `style` (`voxel` | `brick` | `voronoi` | `lowpoly`), `resolution`
(clamped per filter).

### Background Removal — `POST /api/x402/pipeline-rembg` — $0.01

Strips the background from an image, returning a transparent PNG — the clean
reference view image→3D reconstruction needs so it never bakes a room into the
mesh. **In:** an image (PNG/JPEG/WEBP/GIF). **Out:** a transparent PNG.

```bash
npx @x402/fetch POST https://three.ws/api/x402/pipeline-rembg \
  --json '{"image_url":"https://three.ws/uploads/photo.jpg","model":"rmbg2"}'
# → { "stage":"rembg", "output_url":"https://three.ws/cdn/x402-pipeline/rembg/….png" }
```

Options: `model` (`rmbg2` | `u2net` | `isnet` | `u2net_human_seg` | `silueta`).

## A full flow

Generate a mesh, then rig and optimize it — three paid calls, each output URL
feeding the next input:

```bash
# 1. Generate ($0.05 draft tier) → poll /api/forge?job=<id> for the GLB
FORGE=$(npx @x402/fetch POST https://three.ws/api/x402/forge \
  --json '{"prompt":"a brass steampunk owl, full body","tier":"draft"}')
GLB=$(echo "$FORGE" | jq -r '.glb_url')

# 2. Rig it ($0.05)
RIGGED=$(npx @x402/fetch POST https://three.ws/api/x402/pipeline-rig \
  --json "{\"glb_url\":\"$GLB\"}" | jq -r '.output_url')

# 3. Make it game-ready ($0.03)
npx @x402/fetch POST https://three.ws/api/x402/pipeline-gameready \
  --json "{\"glb_url\":\"$RIGGED\",\"poly_budget\":15000}"
```

## Operator configuration

Each stage advertises itself only when its worker is configured. Set, in the
platform environment:

| Stage       | Env var                | Worker                              |
| ----------- | ---------------------- | ----------------------------------- |
| rig         | `GCP_RECONSTRUCTION_URL` | avatar-pipeline controller (`/rig`) |
| remesh      | `GCP_REMESH_URL`       | `workers/remesh`                    |
| gameready   | `GCP_REMESH_URL`       | `workers/remesh`                    |
| stylize     | `GCP_STYLIZE_URL`      | `workers/stylize`                   |
| rembg       | `GCP_REMBG_URL`        | `workers/rembg`                     |

All workers share the bearer secret `GCP_RECONSTRUCTION_KEY`. First-party output
persistence uses the R2 config (`S3_*`); when unset, the validated worker URL is
returned as-is. Poll budget is tunable via `X402_PIPELINE_POLL_BUDGET_MS`
(default 45,000).

## Related

- [x402 paid endpoints](x402-endpoints.md) — the full catalog + pricing model
- [x402 buyer client](x402-buyer.md) — how to settle payments as an agent
- [Avatar pipeline](avatar-pipeline.md) — the generation + rig lanes in depth
