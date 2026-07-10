# GCP Credits & Vertex AI Runbook

The operational source of truth for three.ws's Google Cloud footprint: the
project, the credit grant, what's enabled, service accounts, env vars, quota,
and how to smoke-test Claude on Vertex. Prompts 02–08 append to this file as
they build on the foundation.

_Historical record — this is a date-stamped runbook from the GCP-credits program
(most sections written 2026-07-07); its per-prompt subsections are point-in-time
work logs, not current setup steps. Production has since moved to Google Cloud Run
(service `three-ws-api`), so every "set in Vercel" / `vercel env add` / `vercel --prod`
instruction below is superseded — the GCP env vars now live on the Cloud Run
service. See the **"Audit + fixes — 2026-07-08"** section at the end of this file for
what was actually wired onto Cloud Run, and the [GCP production runbook](gcp-production.md)
for the live deploy/env procedure._

> **Status: foundation live; one owner console action remains for Claude.**
> `gcloud` is authenticated (`nich@sperax.io`) against `aerial-vehicle-466722-p5`,
> all APIs are enabled, the `vercel-inference` SA is created with
> `roles/aiplatform.user`, and — as of 2026-07-07 — the four GCP env vars
> (`GCP_SERVICE_ACCOUNT_JSON`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`,
> `GOOGLE_CLOUD_LOCATION_CLAUDE`) are set in Vercel across Production, Preview,
> and Development. The smoke test proves the SA key works: **Gemini on Vertex
> returns 200** with it. **Claude on Vertex returns 404** ("Publisher model …
> not found or your project does not have access") — the sole remaining gate is
> the owner accepting the Anthropic partner-model terms in Model Garden (see
> **Enable Claude in Model Garden** and **Pending human actions**). Credit
> balance/expiry and partner-model coverage are console-only reads still owed.

---

## Project

| Field | Value |
|---|---|
| **Project ID** | `aerial-vehicle-466722-p5` |
| Source of truth | Active `gcloud config` default in the dev container; the project the existing worker deploy flow and `api/_mcp3d/vertex-imagen.js` target. |
| Active gcloud account | The project owner's Google account (see team vault; not published here). |
| Known GCS buckets | `three-ws-model-weights`, `three-ws-avatar-reconstructions` |
| Default region | `us-central1` (Cloud Run + Imagen). Claude partner models use `global`. |

> Confirm the buckets live in this project once auth is restored:
> `gcloud storage buckets describe gs://three-ws-model-weights --format='value(name)'`
> If they resolve, the project ID above is correct. If not, run
> `gcloud projects list` and pick the project that owns them.

---

## Credits & partner-model coverage — GO/NO-GO (billing confirmed; balance console-only)

**Billing account confirmed live 2026-07-07** (see table below). The remaining
unknowns — credit **balance, expiry, and partner-model coverage** — are not
exposed by the `gcloud billing` CLI and must be read from the console. Commands
used to confirm the account object:

```bash
# Billing account linked to the project
gcloud billing projects describe aerial-vehicle-466722-p5
#   → billingAccountName: billingAccounts/01B467-A61905-9A97D2, billingEnabled: true

# The billing account object (open/closed, master)
gcloud billing accounts describe billingAccounts/01B467-A61905-9A97D2
#   → displayName: Sperax, open: true, USD, parent org 530103279143
```

Credit **balance and expiry** are not exposed by the `gcloud billing` CLI. Read
them from the console:

- **Credits:** https://console.cloud.google.com/billing → select the account →
  **Credits**. Record remaining balance + expiry date (target: ~$100k expiring
  ~Sept 2026 — confirm the exact date).

**Critical coverage check (gates prompt 02's chain inversion):** determine
whether the credit grant covers **Vertex AI *partner* models** (Anthropic).
Google-for-Startups credits do; some promotional grants exclude third-party
publisher models.

- Console path: **Billing → Credits → click the credit** → read
  **"Eligible products / scope."** If it lists "Vertex AI" broadly it covers
  partner models; if it enumerates only Google-first-party services, partner
  spend (Claude) falls outside and would bill real money.
- **Owner question if ambiguous:** *"Does our GCP credit grant
  (account `<ACCT>`) cover Vertex AI Anthropic partner models, or Google-first-party
  services only?"* — answer determines whether prompt 02 can route production
  Claude traffic through Vertex credits.

Record here once confirmed:

| Field | Value |
|---|---|
| Billing account | `billingAccounts/01B467-A61905-9A97D2` — displayName **Sperax**, `open: true`, USD, org `530103279143` (verified 2026-07-07) |
| Credits applied | _pending — console Credits page (CLI cannot read it)_ |
| Remaining balance | _pending — console_ |
| Expiry date | _pending — console_ |
| Covers Anthropic partner models? | _pending — console check above_ |

---

## APIs to enable (✅ all enabled 2026-07-07)

Idempotent — kept for DR/re-provision:

```bash
gcloud services enable \
  aiplatform.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  compute.googleapis.com \
  bigquery.googleapis.com \
  cloudbilling.googleapis.com \
  monitoring.googleapis.com \
  --project aerial-vehicle-466722-p5

# Verify
gcloud services list --enabled --project aerial-vehicle-466722-p5 \
  --format='value(config.name)' | sort
```

| API | Enabled? |
|---|---|
| aiplatform.googleapis.com | ✅ 2026-07-07 |
| run.googleapis.com | ✅ 2026-07-07 |
| cloudbuild.googleapis.com | ✅ 2026-07-07 |
| storage.googleapis.com | ✅ 2026-07-07 |
| compute.googleapis.com | ✅ 2026-07-07 |
| bigquery.googleapis.com | ✅ 2026-07-07 |
| cloudbilling.googleapis.com | ✅ 2026-07-07 |
| monitoring.googleapis.com | ✅ 2026-07-07 |

Also enabled 2026-07-07: `billingbudgets.googleapis.com`, `pubsub.googleapis.com` (prompt 07 budgets/alerts).

---

## Service accounts

### Inventory

| SA | Purpose | Roles | Status |
|---|---|---|---|
| `avatar-reconstruction-sa@aerial-vehicle-466722-p5.iam.gserviceaccount.com` | Cloud Run workers (mesh/rig pipeline), used by `workers/deploy/*.sh` + cloudbuild | run/build identity | ✅ Confirmed valid 2026-07-07 |
| `vercel-inference@aerial-vehicle-466722-p5.iam.gserviceaccount.com` | Vercel functions → Vertex Claude + Imagen | `roles/aiplatform.user` | ✅ Created + role bound; key minted and **pushed to Vercel (all 3 envs) 2026-07-07**. Key proven working (Gemini 200). Rotate with `gcloud iam service-accounts keys create` → re-push if the local key is ever exposed. |

### Create the Vercel inference SA (done — commands kept for rotation/DR)

Check-first, then create only if absent:

```bash
PROJECT=aerial-vehicle-466722-p5
SA=vercel-inference@${PROJECT}.iam.gserviceaccount.com

# Create only if it doesn't exist
gcloud iam service-accounts describe "$SA" --project "$PROJECT" 2>/dev/null \
  || gcloud iam service-accounts create vercel-inference \
       --project "$PROJECT" \
       --display-name "Vercel inference (Vertex Claude + Imagen)"

# Grant Vertex user
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" \
  --role roles/aiplatform.user

# Mint a JSON key to a path OUTSIDE the repo (never commit it)
gcloud iam service-accounts keys create /tmp/vercel-inference-key.json \
  --iam-account "$SA" --project "$PROJECT"
```

### Push credentials to Vercel (✅ done 2026-07-07 — commands kept for rotation)

All four vars are set for **all** environments (production, preview, development)
and verified with `vercel env ls`. To rotate the key or re-provision from scratch
(`npx vercel` is used since the CLI is not globally installed):

```bash
# Mint a fresh key to a path OUTSIDE the repo (scratchpad / /tmp, never commit it)
gcloud iam service-accounts keys create /tmp/vercel-inference-key.json \
  --iam-account vercel-inference@aerial-vehicle-466722-p5.iam.gserviceaccount.com

# Value = the raw key file contents. The api/ token parser tolerates the paste.
for E in production preview development; do
  cat /tmp/vercel-inference-key.json     | npx vercel env add GCP_SERVICE_ACCOUNT_JSON    "$E"
  printf 'aerial-vehicle-466722-p5'      | npx vercel env add GOOGLE_CLOUD_PROJECT        "$E"
  printf 'us-central1'                   | npx vercel env add GOOGLE_CLOUD_LOCATION        "$E"
  printf 'global'                        | npx vercel env add GOOGLE_CLOUD_LOCATION_CLAUDE "$E"
done

# Then delete the local key file
shred -u /tmp/vercel-inference-key.json 2>/dev/null || rm -f /tmp/vercel-inference-key.json

# Verify
npx vercel env ls | grep -iE 'GCP_SERVICE_ACCOUNT_JSON|GOOGLE_CLOUD'
```

> **Fixes a live production gap:** before this push, `api/_mcp3d/vertex-imagen.js`
> had no `GCP_SERVICE_ACCOUNT_JSON` in the deployed environment, so the Vertex
> image lane could only run locally. It now has real credentials in production.

### Env vars (names only — never values here)

| Name | Value shape | Scope |
|---|---|---|
| `GCP_SERVICE_ACCOUNT_JSON` | Vercel inference SA key JSON | all envs ✅ set 2026-07-07 |
| `GOOGLE_CLOUD_PROJECT` | `aerial-vehicle-466722-p5` | all envs ✅ set 2026-07-07 |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | all envs ✅ set 2026-07-07 |
| `GOOGLE_CLOUD_LOCATION_CLAUDE` | `global` | all envs ✅ set 2026-07-07 |

---

## Enable Claude in Model Garden (owner console action)

Partner-model enablement is a **one-time console terms acceptance** — it cannot
be done from gcloud. Owner opens Model Garden for publisher `anthropic` and
clicks **Enable** on each model:

- Base console: https://console.cloud.google.com/vertex-ai/model-garden?project=aerial-vehicle-466722-p5
  (filter by publisher **Anthropic**), then enable:
  - `claude-haiku-4-5`
  - `claude-sonnet-4-6`
  - `claude-opus-4-8`
  - `claude-sonnet-5`
  - `claude-fable-5` (if listed in the region)

Accept the Anthropic terms once; enablement applies project-wide.

**Model ID mapping (repo default → Vertex):** the repo's default model string
`claude-haiku-4-5-20251001` maps to the Vertex snapshot form
`claude-haiku-4-5@20251001` (dated snapshots use `@`; current-gen bare IDs like
`claude-opus-4-8` work without a date).

---

## Quota (open — file after Model Garden enablement)

Partner-model quota can only be inspected/filed once Anthropic is enabled in
Model Garden (the models don't exist for the project until then — see the 404
above). Run this the moment enablement lands, then file increases sized for
production chat:

```bash
# Inspect current online-prediction / partner-model quotas
gcloud alpha services quota list \
  --service=aiplatform.googleapis.com \
  --consumer=projects/aerial-vehicle-466722-p5 2>/dev/null | less
```

Console (most reliable for partner-model QPM/TPM): **IAM & Admin → Quotas &
System Limits**, filter service `Vertex AI API`, search the Anthropic model
tiers.

**Requested targets** (start; scale after go-live):

| Model tier | Region | QPM | TPM |
|---|---|---|---|
| Haiku 4.5 | `global` | 300 | 2,000,000 |
| Haiku 4.5 | `us-central1` | 300 | 2,000,000 |
| Sonnet (4.6 / 5) | `global` | 300 | 2,000,000 |
| Sonnet (4.6 / 5) | `us-central1` | 300 | 2,000,000 |

| Field | Value |
|---|---|
| Current values | _pending_ |
| Requested | per table above |
| Request IDs / status | _pending_ |

---

## Smoke test — is Claude on Vertex live?

`scripts/gcp/vertex-smoke.mjs` sends a real streaming request to a Claude
partner model and prints the reply. It reads `GCP_SERVICE_ACCOUNT_JSON` from the
environment (same var Vercel uses) and needs no SDK. Run it the moment Model
Garden enablement + the SA key are in place:

```bash
export GOOGLE_CLOUD_PROJECT=aerial-vehicle-466722-p5
export GCP_SERVICE_ACCOUNT_JSON="$(cat /path/to/vercel-inference-key.json)"
node scripts/gcp/vertex-smoke.mjs
```

- **PASS** = `HTTP 200 — model replied: "…"`. Enablement, quota, billing all live.
- **403 / 404** = Claude not enabled in Model Garden yet, or the SA lacks
  `roles/aiplatform.user`. The script prints the exact Model Garden URL.
- **429** = quota exceeded — file the increase above.

Optional overrides: `GOOGLE_CLOUD_LOCATION_CLAUDE` (default `global`),
`VERTEX_SMOKE_MODEL` (default `claude-haiku-4-5@20251001`), `VERTEX_SMOKE_PROMPT`.

**Last run — 2026-07-07:** `404 NOT_FOUND` — *"Publisher model
`…/publishers/anthropic/models/claude-haiku-4-5@20251001` was not found or your
project does not have access to it."* The **same SA key returns HTTP 200 against
Gemini** (`publishers/google/models/gemini-2.5-flash:generateContent`), proving
auth, billing, and `roles/aiplatform.user` are all good. The 404 is therefore
purely the Anthropic Model Garden enablement gate — re-run this script the
instant the owner accepts the terms; no code change is needed and a PASS is
expected within seconds.

---

## Claude Code dev sessions → GCP credits

`scripts/gcp/claude-code-vertex.sh` routes a Claude Code dev session through
Vertex so development spend draws down the credit pool. **Opt in by sourcing**
it — it is deliberately NOT set globally in the devcontainer, so each session
picks its billing lane.

```bash
# One-time per machine (interactive):
gcloud auth application-default login

# Per shell you want on Vertex credits:
source scripts/gcp/claude-code-vertex.sh
claude          # this session now bills to GCP credits
```

It exports `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`,
`CLOUD_ML_REGION=global`, and warns if ADC is missing. Open a fresh shell to opt
back out.

---

## Vertex Claude LLM lane (chat & completions) — prompt 02

Routes the platform's Claude/Anthropic LLM traffic through Vertex AI so it bills
the GCP credit pool instead of a paid Anthropic key. Wired across **every** text
inference surface, behind two flags, with automatic fallthrough to the existing
free-first chain on any Vertex failure. Flags off ⇒ behavior is byte-identical to
before (proven by `tests/vertex-claude.test.js`).

### Flags

| Env var | Effect |
|---|---|
| `VERTEX_CLAUDE_ENABLED=1` | Vertex becomes an available Anthropic transport. In `llm.js`/`api/chat.js` it sits in the paid tier **ahead of** first-party Anthropic (GCP credits before a paid key); in `api/llm/anthropic.js` any `provider: anthropic` model streams from Vertex with first-party as the fallback; `/api/brain/chat` gains selectable "· Vertex" Claude rows. |
| `VERTEX_CLAUDE_PRIMARY=1` | Chain inversion: Vertex Claude is tried **first**, before the free lanes — the platform's default brain becomes real Claude on Vertex. Requires `VERTEX_CLAUDE_ENABLED`. A caller BYOK key still leads (their own billing choice). |

Both require `GOOGLE_CLOUD_PROJECT` (config check). Location: `GOOGLE_CLOUD_LOCATION_CLAUDE`
(default `global`). Both unset ⇒ zero code-path change.

### Wire format & model mapping

Vertex speaks the Anthropic Messages API with four differences, all handled in
`api/_lib/vertex-claude.js` (the one shared module — never scatter this):

- Model id in the **URL path**, not the body: `…/publishers/anthropic/models/<id>:streamRawPredict` (stream) / `:rawPredict` (non-stream). Regional endpoints prefix the host (`us-east5-aiplatform.googleapis.com`); `global` uses the bare host.
- Body gains `"anthropic_version": "vertex-2023-10-16"` and drops `model` (+ `stream`).
- Auth: `Authorization: Bearer <oauth>` (via `api/_lib/gcp-auth.js` — shared with Imagen) — no `x-api-key`, no `anthropic-version` header.
- Model id: bare aliases pass through (`claude-sonnet-4-6`); a dated first-party id converts to the `@` form (`claude-haiku-4-5-20251001` → `claude-haiku-4-5@20251001`) via `toVertexModelId()`.

SSE event shapes are identical to first-party, so every existing stream parser works unchanged.

### Surfaces wired

| Surface | Entry point | How Vertex is chosen |
|---|---|---|
| Server one-shot completions (agent talk/delegation, personas, x402, crons, vision) | `api/_lib/llm.js` `providerChain()` | `vertexAnthropicProvider()` inserted per flags |
| Embedded avatar/agent chat widgets (streaming) | `api/llm/anthropic.js` | `provider: anthropic` models routed to Vertex `streamRawPredict`; `x-llm-transport` response header records the transport |
| Main viewer/agent chat (streaming) | `api/chat.js` `providerOrder()` | synthetic `vertex` provider injected into the ladder |
| `/brain` comparison page | `api/brain/chat.js` | "Claude … · Vertex" specs via `streamVertex()` |

### Telemetry marker

Vertex traffic is recorded as provider **`vertex-anthropic`** distinctly from
first-party `anthropic` (in `recordEvent` for `llm.js`/`api/llm/anthropic.js`, and
`meta.provider` for `api/chat.js` via `route.via`), so prompt 07's spend reporting
attributes it. The embed proxy also returns an `x-llm-transport: vertex-anthropic`
response header.

### Smoke test (needs a running dev server + creds)

`scripts/gcp/vertex-llm-smoke.mjs` hits three live surfaces and asserts Vertex served
each. (Distinct from prompt 01's `vertex-smoke.mjs`, which is a single raw Claude call.)

```bash
GOOGLE_CLOUD_PROJECT=aerial-vehicle-466722-p5 \
GCP_SERVICE_ACCOUNT_JSON="$(cat /path/to/vercel-inference-key.json)" \
VERTEX_CLAUDE_ENABLED=1 VERTEX_CLAUDE_PRIMARY=1 npm run dev   # terminal 1

node scripts/gcp/vertex-llm-smoke.mjs                          # terminal 2
#   (a) POST /api/forge-enhance → asserts provider=vertex-anthropic
#   (b) POST /api/llm/anthropic  → asserts x-llm-transport=vertex-anthropic  (set SMOKE_AGENT_ID)
#   (c) POST /api/chat           → asserts done.provider=vertex              (set SMOKE_BEARER)
```

Browser verification (definition of done): with the flags on, open an embedded agent
widget page and the main chat, send messages, confirm streamed replies + no console
errors + `vertex-anthropic` in server logs; then unset the flags and confirm today's
behavior is intact.

### Deploy & rollback

- **Preview first:** set `VERTEX_CLAUDE_ENABLED=1` (and optionally `VERTEX_CLAUDE_PRIMARY=1`) in Vercel **preview** only. Production flags stay unset — flipping production changes the billing lane and is the owner's call.
- **Production flip (owner):** `printf '1' | vercel env add VERTEX_CLAUDE_ENABLED production` (+ `VERTEX_CLAUDE_PRIMARY` for chain inversion), then redeploy.
- **Rollback (instant, no code deploy):** unset `VERTEX_CLAUDE_ENABLED` / `VERTEX_CLAUDE_PRIMARY`. Every lane falls through to Groq → OpenRouter → NVIDIA → paid backstop exactly as before.

---

## Vertex image lane (text→3D reference images) — prompt 03

The forge text→3D chain synthesizes a reference image, then reconstructs a GLB
from it (TRELLIS / Hunyuan3D). That image step can bill to GCP credits instead of
NVIDIA NIM FLUX / Replicate. Client: `api/_mcp3d/vertex-imagen.js`; selector:
`api/_mcp3d/text-to-image.js`.

### Model landscape — Imagen `:predict` is being retired (verified 2026-07)

The dormant client defaulted to `imagen-3.0-generate-001`. That endpoint is **dead**:
Google is shutting down the entire Imagen `:predict` family.

| Model | API shape | Status (2026-07) |
|---|---|---|
| `imagen-3.0-generate-001` / `-002` | `:predict` | Shut down ~**2026-06-30** (404s now) |
| `imagen-3.0-capability-001` (edit) | `:predict` | Retired ~**2026-06-30**, no mask-edit successor |
| `imagen-4.0-generate-001` / `-fast` / `-ultra` | `:predict` | Deprecated; discontinued **2026-06-30…2026-08-17** |
| **`gemini-2.5-flash-image`** ("Nano Banana") | `:generateContent` | **GA, recommended** — bills to the same GCP credits |

So the client now **defaults to `gemini-2.5-flash-image`** and routes on the model id:
`gemini*` → `:generateContent`; `imagen*` → legacy `:predict` (for an explicit
override while any Imagen endpoint is still callable). It also handles the `global`
location (un-prefixed host).

### Flag & models

| Env var | Default | Meaning |
|---|---|---|
| `VERTEX_IMAGEN_ENABLED` | unset ⇒ **on when `GOOGLE_CLOUD_PROJECT` set** | Explicit lane switch, decoupled from the shared project var (which Vertex Claude + workers also need). Set `0`/`false`/`no`/`off` to force the image lane off without unsetting the project. |
| `VERTEX_IMAGEN_MODEL` | `gemini-2.5-flash-image` | Generation model. An `imagen-*` value uses the legacy `:predict` path. |
| `VERTEX_IMAGEN_EDIT_MODEL` | `gemini-2.5-flash-image` | Edit model (`editImage()`); `imagen-*` routes to `:predict` inpainting. |

Ladder is unchanged and fully preserved: **NIM FLUX → Vertex → Replicate**, with
any Vertex error degrading cleanly to FLUX. Which provider served each image is
logged (`[text-to-image] served by <model>`) and persisted on the forge job as
`text_to_image_model`.

### Verification status

Static verification is **done**: model IDs checked against live Vertex docs; both
request/response shapes and the gate + fallback are covered by unit tests
(`tests/api/vertex-imagen.test.js`, `tests/api/text-to-image.test.js` — green).

**Live E2E passed 2026-07-07**: `generateImage()` against the real project
(`vercel-inference` SA key, `us-central1`) returned a 901 KB on-prompt PNG —
`served by vertex-ai/gemini-2.5-flash-image`, isolated subject on a plain white
background, visually verified. The 3–4-prompt quality gate is now **also done**
(results below). The Vercel env push is **also done** —
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and `GCP_SERVICE_ACCOUNT_JSON`
are set in production (commit 28220d673). `VERTEX_IMAGEN_ENABLED` is unset, so the
lane auto-activates as the fallback the moment a deployment carrying those vars
goes live — no separate flag flip needed. Until the next prod deploy propagates
them, `/api/v1/ai/image?health=1` still shows the running deployment as `nim`-only.
The E2E command used:

```bash
export GOOGLE_CLOUD_PROJECT=aerial-vehicle-466722-p5
export GOOGLE_CLOUD_LOCATION=us-central1          # or "global" if the model requires it
export GCP_SERVICE_ACCOUNT_JSON="$(cat /path/to/vercel-inference-key.json)"
export VERTEX_IMAGEN_ENABLED=1
node -e '
  import("./api/_mcp3d/vertex-imagen.js").then(async ({ generateImage }) => {
    const { imageUrl, model } = await generateImage("a stylized red robot, isolated subject, plain white background", { aspectRatio: "1:1" });
    const b64 = imageUrl.split(",")[1];
    require("fs").writeFileSync("/tmp/vertex-sample.png", Buffer.from(b64, "base64"));
    console.log("served by", model, "→ /tmp/vertex-sample.png");
  });
'
```

### Quality gate — results (2026-07-07)

Ran the same 4 prompts through the real `gemini-2.5-flash-image` client (`robot`,
`knight`, `fox`, `chest`), driving `generateImage()` with the `vercel-inference`
SA key. Verdict: **Gemini is a high-quality, on-prompt reference-image lane, fully
fit for the paid text→3D chain — not a regression.** All four came back ~0.9–1.4 MB
PNGs in ~6 s, and 3 of 4 (`robot`, `knight`, `chest`) were textbook 3D references:
a single centered subject, even studio lighting, pure white background, clean
readable geometry.

The one outlier (`fox`) surfaced a **real bug in the shared prompt heuristic, not a
Gemini weakness.** `enhanceFluxPrompt()` gated the isolation suffix on art-style
words — `"cartoon"` in `"a cartoon fox…"` suppressed
`", isolated subject, … plain white background"`, so Gemini rendered a full
illustrated forest scene (mushrooms, trees, path) that the 3D backend cannot
reconstruct. Re-running the same prompt **with** the suffix produced a perfectly
isolated cartoon fox on white. Fix shipped: `COMPOSITION_CUE_WORDS` now lists only
background/lighting/composition cues (no `cartoon`/`stylized`/`colorful`/`vibrant`)
and matches whole words, so a stylized subject — and substrings like `light` in
`lightsaber` — still get isolated. The suffix is only ever *added* relative to the
old behavior, so this improves **both** lanes (FLUX included) and cannot regress
either. Covered by `tests/api/text-to-image.test.js` (`enhanceFluxPrompt` block).

Live FLUX side-by-side samples were not captured: the prod `/api/v1/ai/image` POST
returned `FUNCTION_INVOCATION_TIMEOUT` during the run and there is no NVIDIA key in
the local env, so FLUX could not be driven locally. The verdict rests on the
inspected Gemini outputs plus the known FLUX.1-schnell characteristics; it does not
depend on ranking the two lanes, because Gemini stays the **fallback** (NIM FLUX
still leads the ladder) and its quality clears the bar for that role.

**Recommendation:** quality is not a blocker. Keep **NIM FLUX primary** (free, fast,
already carries prod) and Gemini as the credit-funded fallback that activates
whenever NIM is absent/down. No quality carve-out (draft-lane-only) is needed. The
GCP envs are already in Vercel prod, so the lane goes live on the next deployment;
instant rollback stays available via `VERTEX_IMAGEN_ENABLED=0`.

### Deploy & rollback

- **Preview first:** `printf '1' | vercel env add VERTEX_IMAGEN_ENABLED preview`.
  Exercise `/api/forge` (text mode) and confirm the log shows
  `served by vertex-ai/gemini-2.5-flash-image`.
- **Production** only after the quality gate passes cleanly:
  `printf '1' | vercel env add VERTEX_IMAGEN_ENABLED production`.
- **Rollback (instant, no deploy):** set `VERTEX_IMAGEN_ENABLED=0` in the affected
  environment — the lane drops to NIM FLUX → Replicate immediately. Removing
  `GOOGLE_CLOUD_PROJECT` also disables it but would break Vertex Claude/workers, so
  prefer the flag. To pin a specific model instead, set `VERTEX_IMAGEN_MODEL`.

---

## Pending human actions (do these, in order)

**✅ Done 2026-07-07 (no owner action needed — recorded for history):**

- ~~Restore gcloud auth~~ — authenticated `nich@sperax.io` on
  `aerial-vehicle-466722-p5`.
- ~~Enable all APIs~~ — 8 required + `billingbudgets` + `pubsub` (tables above).
- ~~Create `vercel-inference` SA + bind `roles/aiplatform.user`~~.
- ~~Push GCP env vars to Vercel~~ — `GCP_SERVICE_ACCOUNT_JSON`,
  `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_LOCATION_CLAUDE`
  set across Production/Preview/Development; verified with `npx vercel env ls`.
- ~~Prove the SA key works~~ — Gemini on Vertex returns 200 with it.

**⏳ Still owed — owner console actions, in order:**

1. **Enable Claude in Model Garden** — the ONE gate for all Vertex Claude
   traffic (prompt 02). Console → accept Anthropic partner-model terms → enable
   `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-sonnet-5`,
   and `claude-fable-5` (if listed). **Confirmed still missing 2026-07-07:** the
   smoke test returns `404 NOT_FOUND` on `publishers/anthropic/models/*` while
   the same SA serves Gemini fine — terms acceptance is the only blocker. The
   moment it lands, run `node scripts/gcp/vertex-smoke.mjs` for a green PASS
   (closes prompt 01's smoke criterion) and then file partner-model quota.
2. **Confirm credits + partner-model coverage** — console Credits page; read the
   balance + expiry and confirm the grant covers Vertex AI *partner* (Anthropic)
   models. GO/NO-GO for prompt 02's chain inversion. `gcloud billing` cannot
   expose balance/expiry — this is console-only.
3. **`gcloud auth application-default login` (ADC)** — only needed for Claude
   Code dev sessions on Vertex (`scripts/gcp/claude-code-vertex.sh`) and any
   ADC-only script. Production `api/` uses the SA key, not ADC, so this does not
   block anything shipped.
4. **Enable the BigQuery billing export** (prompt 07) — console-only:
   Billing → Billing export → BigQuery. Confirmed 2026-07-07 no dataset exists
   (`bq ls` empty; `burn-report.mjs` → "export not configured").

Update the cells in this file as each step completes.


---
---

# Premium vanity inventory (prompt 06)

Grind long, brandable Solana vanity addresses **ahead of time** on cheap spot CPU
and sell them from stock via a new x402 tier — the durable, near-zero-marginal-cost
"asset factory" use of the credits. The live grinder (`/api/x402/vanity`, the
`vanity_grinder` MCP tool) still handles fresh ≤3-char grinds; this is the 4–5+
char **sell-from-stock** lane.

## Shape

```
targets → workers/vanity-grinder (spot CPU) → seal in-process → vanity_inventory (ciphertext)
                                                                        │
        browse: /vanity/premium ── /api/x402/vanity-premium (list) ─────┤
        buy:    /api/x402/vanity-premium?address=… (x402) → reserve → settle → reveal ONCE → destroy
```

- **Grinder:** `workers/vanity-grinder/` (Node + the same Rust/WASM ed25519 engine
  as the serverless tier, one worker/vCPU). Seals every key with
  `api/_lib/vanity-vault.js` **before any write**; writes only ciphertext.
  Resumable (checkpoint) and SIGTERM-clean for spot preemption.
- **Store:** `vanity_inventory` (migration `20260706120000_vanity_premium_inventory.sql`),
  atomic single-use reveal in `api/_lib/vanity-inventory-store.js`.
- **Sell:** `api/x402/vanity-premium.js` (list + buy + one-time delivery),
  browsable at `/vanity/premium`, plus the free `vanity_premium` MCP browse tool.
- **Encryption:** secret-box AES-256-GCM (`WALLET_ENCRYPTION_KEY`) by default —
  the platform's custodial-key pattern — with an **optional GCP-KMS envelope**
  (`VANITY_KMS_KEY`) that gates decrypt to the delivery identity via IAM.

## Run it (owner) — executed 2026-07-07, see "Measured throughput" below

```bash
export PROJECT_ID=aerial-vehicle-466722-p5

# 1) (recommended) KMS envelope — key-level decrypt granted to the delivery SA,
#    encrypt-only to the grinder SA (project owners still inherit decrypt — see
#    the threat model's "Insider access" row):
./scripts/gcp/vanity-kms-setup.sh                 # prints VANITY_KMS_KEY

# 2) Put the vault secrets in Secret Manager (grinder + delivery both need them):
#    WALLET_ENCRYPTION_KEY, JWT_SECRET, DATABASE_URL   (and VANITY_KMS_KEY as env)

# 3) Build + run the grinder on spot CPU, writing straight to the DB:
VANITY_KMS_KEY=<from step 1> WRITE_DB=1 TASKS=8 CPU=8 \
  ./scripts/gcp/vanity-grind-deploy.sh --run        # Cloud Run Job (spot)
#   …or a GCE spot MIG for very large runs:
#   ./scripts/gcp/vanity-grind-deploy.sh --mig --instances 20

# 4) (file path) load an encrypted JSONL a run produced into the DB:
node scripts/vanity-inventory-load.mjs --file workers/vanity-grinder/out/inventory.jsonl
node scripts/vanity-inventory-load.mjs --stats
```

Migration first: `npm run db:migrate` (applies `20260706120000_vanity_premium_inventory.sql`).

## Measured throughput & $/address

**Real production run — 2026-07-07, Cloud Run Job, 4 tasks × 4 vCPU (16 vCPU),
`IGNORE_CASE=1 INCLUDE_5=1`, KMS-envelope sealing.** The full 115-target list
(brandable 3/4/5-char prefixes + suffixes) was ground; every found key was sealed
in-process with the `gcp-kms+aes-256-gcm` scheme and written straight to
`vanity_inventory` — no plaintext ever hit disk, a log, or the DB.

| metric | value |
|---|---|
| Runner | Cloud Run Job (spot-labelled), gen2, 4×4 vCPU |
| Sealing | KMS envelope (`gcp-kms+aes-256-gcm`) — 100% of records |
| Throughput / WASM thread | **~18,000–20,000 keys/sec sustained** on the long grinds (measured: KELP… 34.5M attempts in 1,744s ≈ 19.8k/s; LUNA… 41M in 2,230s ≈ 18.4k/s), single ed25519 WASM worker |
| Inventory loaded | **107 addresses ground** (106 available + 1 consumed by the E2E test): 2 uncommon · 43 rare · 46 epic · 14 legendary · 2 mythic, rarity-priced **$1–$50** |
| Round-trip proof | every delivered key decrypts and its ed25519 pubkey == the stored address |

Cost at c2d **spot** ≈ $0.015 / vCPU-hour. Price is value-based ($1–$50 by rarity),
so the margin is enormous — the entire point of grinding on free credits:

| pattern | expected attempts | vCPU-seconds | **$/address (spot)** | list price |
|---|---:|---:|---:|---:|
| 3-char, case-insensitive | ~36k | 1.4 | $0.000006 | $1 |
| 4-char, case-insensitive | ~1.2M | 47 | $0.0002 | $2–$5 |
| 4-char, case-sensitive | ~11.3M | 452 | $0.0019 | $6–$13 |
| 5-char, case-sensitive | ~656M | 26,244 | $0.11 | $30–$50 |

**Finding — Base58 leading-char bias:** a 32-byte value's *leading* Base58 char is
**not** uniformly distributed, so a case-**sensitive** prefix can be far harder than
the naive 58ⁿ estimate (some leading chars are near-impossible). The grinder caps
per-target attempts (`MAX_ATTEMPTS_PER_TARGET`, default 200M) and gives up on such
targets instead of hanging a worker. **Case-insensitive prefixes and suffixes
(uniform tail) are dramatically cheaper per useful address** — weight target lists
toward them. Revenue math: even 200 addresses cost cents of credits to grind and
list at $1–$50 each — a four-figure sellable asset for a near-zero credit outlay.

**Fix landed this run — worker stop signal.** `grindToCompletion` is a *synchronous*
loop, so a worker mid-target never drains its message queue; the old
`postMessage({type:'stop'})` sat unread until the (possibly hard) target finished,
hanging the process on `MAX_FOUND` and on SIGTERM. The stop signal is now a
`SharedArrayBuffer` atomic the sync loop polls at each 25k-key batch boundary, so
every worker aborts within a fraction of a second — proven by
`tests/vanity-wasm-grinder.test.js` ("grindToCompletion stop signal"). Two Cloud
Build/Run gaps were also fixed: the Dockerfile now copies `src/shared` (the WASM
glue imports `src/shared/log.js` — without it every worker crashed at load and the
job wrote zero rows), and the deploy script builds via a cloudbuild config as the
`three-ws-build` SA (this project has no legacy Cloud Build SA) instead of the
mutually-exclusive `--tag`+`--config`.

**Note — "spot" runner.** The Cloud Run Job path bills cheap per-vCPU-second and is
labelled `billing=spot`, but Cloud Run Jobs are not literally GCE Spot VMs. For true
Spot preemptible pricing on very large runs, use `--mig` (a GCE Spot MIG); the
grinder is preemption-safe either way (SIGTERM → checkpoint → resume skips finished
targets).

## E2E verification (2026-07-07)

The full production delivery pipeline was exercised against the **real Neon DB and
real Cloud KMS**, authenticated as the **actual delivery identity**
(`vercel-inference` SA), on a real inventory row (`navPJe3…GW1`, a `$2` rare):

- **KMS decrypt** as the delivery SA succeeded (`scheme=gcp-kms+aes-256-gcm`); the
  decrypted key's ed25519 pubkey **equals the stored address** (delivered key is valid).
- **Single-use:** first `reserveAndReveal` returned `destroyed=true`, status
  `destroyed`; a second call was refused (`already_revealed`); the ciphertext is no
  longer retrievable at rest (delete-after-reveal, retention 0).
- **Insider isolation (partial):** the **grinder SA has no decrypt binding** (key IAM
  verified) so it can never read back what it seals; a project **owner can** decrypt
  (see the threat model's honest caveat).

The one leg not driven here is the on-chain **USDC settlement** (`verifyPayment` /
`settlePayment`) — that is the shared x402 rail already live across every paid
three.ws endpoint; a real settlement needs a funded buyer wallet. Everything the
premium tier adds on top of that rail (KMS-sealed inventory, atomic single delivery,
destruction, custody disclosure) is verified above.

## Security review (threat model)

The store holds **real private keys**; the design defends each realistic threat:

| threat | mitigation |
|---|---|
| **DB dump** | Keys are AES-256-GCM (or KMS-envelope) ciphertext with a random per-record salt. A dump yields no spendable key without `WALLET_ENCRYPTION_KEY` (and, under KMS, a live IAM-gated decrypt call). |
| **Log leakage** | No secret is ever logged. The grinder's only "found" line is the public address + attempt count; the endpoint strips secret fields from the idempotency cache; the store's public reads select an explicit column list that omits `secret_ciphertext`. Verified by grep (`git grep -nE 'console.*(secretKey|privateKey|ciphertext)'` over the new files → none). |
| **Delivery replay / double-spend** | Single-use is a server-side atomic CTE (`reserveAndReveal`): the reveal flips status and nulls the ciphertext in one statement guarded by `status IN ('reserved','sold') AND secret_ciphertext IS NOT NULL`. A second call captures zero rows → `already_revealed`. The x402 idempotency cache stores a secret-free copy. |
| **Charge-without-delivery** | The endpoint decrypts (non-destructive peek) **before** settling; a KMS/decrypt outage fails the purchase *before* charging. Settle → reveal(destroy) only after decrypt is proven. |
| **Insider access** | With `VANITY_KMS_KEY` set, the KMS key's own IAM policy grants `cryptoKeyDecrypter` **only** to the delivery SA (`vercel-inference`) and `cryptoKeyEncrypter` **only** to the grinder SA — so **the grinder can seal keys but can never read them back**, and every decrypt is Cloud-Audit-Logged (verified 2026-07-07: `gcloud kms keys get-iam-policy` shows exactly those two key-level bindings). **Honest caveat:** a GCP project **Owner/Editor** inherits `cloudkms.*.decrypt` and *can* decrypt (an owner can always self-grant — verified: `nich@sperax.io` with `roles/owner` decrypted a real wrapped DEK). So KMS raises the floor — a DB dump is useless, a `WALLET_ENCRYPTION_KEY` leak no longer decrypts KMS-scheme records, and no *service* identity except delivery can read keys — but it does **not** wall off a compromised project owner. That tier is covered by owner-account MFA, org-policy, and the Cloud Audit Log, not by the key IAM. |
| **Custody dishonesty** | Every listing + delivery carries the required disclosure: platform-generated keys → use as a token mint or sweep to self-generated custody, not a treasury. Delete-after-reveal (retention 0) is the default. |

## Revert / wind-down

One-shot asset — nothing to revert. The inventory persists in the app DB and sells
down at **zero ongoing GCP cost** after the grind. Tear down the grinder MIG/Job
when a batch finishes (the deploy script prints the command). See the keep/kill
table below.

---
---

# Expiry revert & keep/kill runbook (prompt 08)

The credits expire (~$100k, target ~Sept 2026 — confirm the exact date on the
console Credits page). This section makes that a non-event: a proven, env-only
path back to the pre-program providers, plus a data-driven keep/kill call per lane.

**Core fact:** every credit-funded reroute is gated by an env var, and each lane
already falls through to the provider it displaced. So the revert is a config
change, never a code migration. Proven at the code level by
`tests/api/gcp-revert.test.js` (7 assertions, green).

## The lanes and how each reverts

| Lane | Gate (present ⇒ GCP lane live) | Reverts to | Code |
|---|---|---|---|
| **Vertex Claude** (chat/LLM) | `VERTEX_CLAUDE_ENABLED` (+`_PRIMARY`), needs `GOOGLE_CLOUD_PROJECT` | Groq → OpenRouter → NVIDIA → paid backstop | `api/_lib/vertex-claude.js`, `api/chat.js` `providerOrder()` |
| **Vertex Imagen** (text→image) | `GOOGLE_CLOUD_PROJECT` (+`GCP_SERVICE_ACCOUNT_JSON`) | free NIM FLUX → Replicate | `api/_mcp3d/vertex-imagen.js`, `text-to-image.js` |
| **Forge TRELLIS self-host** | `MODEL_TRELLIS_URL` + `GCP_RECONSTRUCTION_KEY` | free NIM/HF → Replicate | `api/_lib/forge-tiers.js` |
| **Forge Hunyuan3D self-host** | `GCP_HUNYUAN3D_URL` + `GCP_RECONSTRUCTION_KEY` | free HF Spaces → Replicate | `forge-tiers.js` |
| **Forge TripoSG sketch** | `GCP_TRIPOSG_URL` + `GCP_RECONSTRUCTION_KEY` | none — option hides | `forge-tiers.js` |
| **Game-Ready remesh** | `GCP_REMESH_URL` + `GCP_RECONSTRUCTION_KEY` | none — export hides | `forge-tiers.js` (`OUTPUTS`) |
| **Avatar reconstruct/rerig** | `GCP_RECONSTRUCTION_URL` + `_KEY` | Replicate → HF Spaces | `api/_lib/regen-provider.js` |
| **Editing** (rembg/texture/segment) | `GCP_REMBG_URL` / `GCP_TEXTURE_URL` / `GCP_SEGMENT_URL` | in-lane fallback / off | `workers/deploy/deploy-editing.sh` |
| **Vanity inventory** | — (one-shot; already ground) | n/a — sells down | `api/_lib/vanity-inventory-store.js` |

## Revert runbook (a tired human at 2am can follow this)

Tooling: `scripts/gcp/revert-to-free.sh` (this is the planned revert; the panic
sibling for a runaway bill is `scripts/gcp/emergency-stop.sh`).

**Step 0 — confirm the fallbacks exist before pulling any gate.** The only way
this breaks a feature is removing a GCP gate while its fallback is also unset.
Confirm in Vercel prod: `NVIDIA_API_KEY` (free NIM), `HF_TOKEN` (free HF),
`REPLICATE_API_TOKEN` (paid backstop). The script's pre-flight checks this and
warns per lane:
```bash
scripts/gcp/revert-to-free.sh          # dry-run: full plan + per-lane pre-flight, changes nothing
```

**Step 1 — remove the env gates from Vercel** (the script prints the exact
`vercel env rm … production/preview` for every var). Removing the gate *is* the
revert. Groups: the `VERTEX_CLAUDE_*` flags; the Imagen vars; the forge
`GCP_*_URL`/`MODEL_TRELLIS_URL`/`GCP_RECONSTRUCTION_*`; the editing URLs. Then:
```bash
vercel --prod
```

**Step 2 — drop Cloud Run workers to min-instances=0.** The deploy scripts never
set `--min-instances`, so workers are already scale-to-zero; this is an idempotent
confirm:
```bash
scripts/gcp/revert-to-free.sh --apply      # min-instances=0 on every worker
```

**Step 3 — verify (2 min):**
- `curl "$SITE/api/forge?catalog=1"` → GCP backends show `"configured": false`; free NIM/HF show `true`.
- text→3D routes to free NIM, photo→3D to free HF, avatar reconstruct to Replicate/HF — all succeed.
- a text→image returns from `nvidia` (not `vertex-ai/*`); a chat completion's `route.via` is a free provider (not `vertex-anthropic`).

## Proving the revert

- **Automated (CI):** `npx vitest run tests/api/gcp-revert.test.js` — flips each
  gate and asserts the fallthrough (forge self-host→HF→Replicate; avatar
  gcp→replicate→hf→none; Imagen `isConfigured` off; Vertex Claude
  `vertexClaudeEnabled`/`vertexClaudePrimary` off). This locks the mechanism.
- **Live preview (owner, needs Vercel+GCP creds):** in a preview, set the gates →
  confirm lanes serve from GCP; run the Step-1 removals → confirm every feature
  still works on the free/original providers. The `?catalog=1` check makes this a
  2-minute confirmation, not an investigation.
- **Live verification run (2026-07-07, gcloud + Vercel authed):**
  - `revert-to-free.sh` dry-run executed against the live project — pre-flight,
    the full `vercel env rm` block, and the min-instances loop all render
    correctly; idempotent (re-run produces the identical plan).
  - `teardown.sh` dry-run enumerated **real** resource state: `model-triposr`
    deployed (would delete), `gs://three-ws-model-weights`, the
    `avatar-reconstruction-key` secret and its SA present; all other workers and
    the Artifact Registry repo not created yet — the script skips them cleanly.
  - **Production already runs the revert-target state for chat and forge:**
    `https://three.ws/api/forge?catalog=1` shows every GCP self-host lane
    (`trellis_selfhost`, `hunyuan3d`, `triposg`) `configured:false` and the free
    NIM/HF lanes `configured:true` and leading; `VERTEX_CLAUDE_ENABLED`/`_PRIMARY`
    are not set in Vercel, so chat runs the free ladder. The four
    `GOOGLE_CLOUD_*`/`GCP_SERVICE_ACCOUNT_JSON` vars landed in prod+preview
    2026-07-07 (arming Imagen as backstop behind free NIM FLUX) — the Step-1
    removal block is the exact revert for them.
  - Net: the free/original-provider state is not hypothetical — it is what
    production serves today, and the flip-on side is what remains gated on the
    owner (Model Garden terms for Claude; worker deploys for forge).

## Keep / kill — post-expiry economics

Pull **real per-lane spend and volume** from the burn report (prompt 07):
```bash
node scripts/gcp/burn-report.mjs            # human-readable: spend by lane (vertex-claude|imagen|forge-gpu|vanity)
node scripts/gcp/burn-report.mjs --json     # machine-readable, for the decision below
```
The decision *math* below is fixed; plug the lane's actual spend/volume into it.

**Cloud Run L4 unit cost** (verify the current L4 rate; worked example at
≈ $0.71/GPU-hr = $0.000197/GPU-sec):

| Lane | Active/asset | Warm | Cold |
|---|---|---|---|
| TRELLIS self-host (standard) | ~60 s | ~$0.012 | ~$0.024 |
| Hunyuan3D self-host (high) | ~120 s | ~$0.024 | ~$0.039 |
| TripoSG sketch | ~45 s | ~$0.009 | ~$0.018 |
| Remesh (Game-Ready) | ~35 s | ~$0.007 | ~$0.010 |

Retail prices (`api/_lib/forge-tiers.js`, source of truth): **draft $0.05,
standard $0.15, high $0.50; Game-Ready $0.10.** (The prompt's "$0.25/$0.45" are stale.)

| Lane | Recommendation | Why (math) |
|---|---|---|
| **Vertex Claude** | **Keep only if Vertex ≤ first-party Anthropic per token AND quality holds; else revert to free lanes** | Chat's free tier (Groq/OpenRouter/NVIDIA) costs $0 and already carries prod. Vertex Claude earns its keep only where quality needs a frontier model AND the Vertex partner-model token price beats calling Anthropic first-party. Compare `burn-report.mjs` vertex-claude spend ÷ tokens vs Anthropic list price. If Vertex ≈ Anthropic, revert to first-party (one less dependency); if free lanes suffice for the traffic, revert to free. |
| **Forge self-host — FREE-tier gens** | **Kill (revert to NIM/HF)** | Self-host serves free-first, so most gens earn **$0**. On credits: ~100% margin. Post-expiry: **$0.012–0.039 GPU for $0 revenue = pure loss.** Free NIM/HF cost $0 and cover these. |
| **Forge self-host — PAID x402 gens** | **Keep iff paid volume clears the floor** | Paid standard: **$0.15 − ~$0.012–0.024 ≈ 6–12× margin.** High: **$0.50 − ~$0.024–0.039 ≈ 13–20×.** Great per-call, but scale-to-zero means cold starts and near-idle GPU at low volume. Keep only if `burn-report.mjs` forge-gpu paid-gen volume beats Replicate (~$0.03–0.05/run, zero idle); else revert paid tiers to Replicate too. |
| **Vertex Imagen** | **Kill (revert)** | Free **NIM FLUX already leads** the chain; Imagen only serves when NIM is absent/down. On credits it was a free quality bump (~$0.02–0.04/img); post-expiry it's real money for a rarely-leading lane. NIM (free) + Replicate ($0.003) cover it. |
| **Avatar reconstruct/rerig** | **Revert to Replicate** | `resolveProviderName()` already prefers Replicate; its pinned reliability at per-run cost beats idle GPU unless reconstruct volume is high (check the report). |
| **Editing workers** | **Revert / delete at teardown** | Auxiliary, low value; degrade to in-lane fallback or hide. No standing cost once min-instances=0. |
| **Vanity inventory** | **Done — keep the assets** | One-shot batch already ground; inventory persists in the app store and sells down at **zero ongoing GCP cost.** |

**Bottom line:** revert everything to free/original providers at expiry. The only
lanes worth keeping on paid GCP are (a) forge **paid-tier** generation if the burn
report shows enough paid volume to beat Replicate, and (b) Vertex Claude only where
its token price beats first-party Anthropic — both numbers to pull on the day.

## Durable-asset audit — nothing user-facing dies with the credits

No committed data or served page references a `gs://` or `*.run.app` URL (grepped
`data/`, `public/`). Every durable output is on R2, independent of GCP:

| Asset | Lives on | Dies with credits? |
|---|---|---|
| Generated GLBs (forge/avatar) | R2 | No — GCS `OUTPUT_BUCKET` is only the pipeline's internal handoff |
| Seeded avatar catalog / animation library | R2 + repo data | No |
| Vanity inventory | app store / R2 | No |
| Model weights | GCS `WEIGHTS_BUCKET` | Yes, **but re-downloadable** (HuggingFace) — safe to delete, re-stage via `workers/deploy/stage-weights.sh` |

**One dependency to watch:** avatar reconstruct routes to `gcp` when *only*
`GCP_RECONSTRUCTION_URL` is set. If a deployment has no `REPLICATE_API_TOKEN` and
no `HF_TOKEN`, reverting turns reconstruction off. Step-0 pre-flight catches this —
ensure a non-GCP reconstruct provider key is in Vercel prod before the revert. No
blocking fixes filed; the fallback chains already exist in code.

## Teardown plan — stop all post-credit billing

Run **after** the revert is verified and traffic has drained.
`scripts/gcp/teardown.sh` is **dry-run by default** — do NOT run it now.
```bash
scripts/gcp/teardown.sh                       # dry-run: list what it would delete
scripts/gcp/teardown.sh --apply               # Cloud Run + Artifact Registry + weights bucket + secret + SA
scripts/gcp/teardown.sh --apply --include-output   # ALSO the OUTPUT bucket (confirm R2 copy first)
```
Deletes the GPU/controller Cloud Run services, the docker Artifact Registry repo,
the (re-downloadable) `WEIGHTS_BUCKET`, the worker secret, and the runtime SA.
Keeps the `OUTPUT_BUCKET` unless `--include-output`. Never auto-deletes: the
Firestore `(default)` DB or the GCP project (prints the commands for both).

## Owner one-pager

- **Permanent (survives the credits):** the forge quality/lane system (free-first,
  GCP + paid vendors behind env gates), Vertex Imagen path, avatar reconstruct with
  a 3-provider chain, the Vertex Claude chat lane (flag-gated), the vanity inventory
  (one-shot, sold down), and all generated assets on R2. **None depend on the credits
  to keep working** — the GCP lanes were preferred routes, not load-bearing.
- **Total credits used:** `node scripts/gcp/burn-report.mjs` (needs the BigQuery
  billing export configured; see its header). Program budget targets: Claude-on-Vertex
  $40–60k, GPU fleet $15–25k, Imagen $3–5k, misc ~$5k.
- **Day-of revert:** `scripts/gcp/revert-to-free.sh` (dry-run → read pre-flight →
  paste the `vercel env rm` block → `vercel --prod` → `--apply` for min-instances=0 →
  verify with `?catalog=1`). ~10 min, zero user-visible breakage.
- **Keep/kill in one line:** revert everything to free/original providers; keep paid
  GCP only for (a) forge paid-tier gens if the burn report shows the volume, and
  (b) Vertex Claude where its token price beats first-party Anthropic.
- **Then:** `scripts/gcp/teardown.sh --apply` to delete the idle resources and zero the bill.

_Revert section last verified against source: 2026-07-06; scripts dry-run against
live GCP and prod revert-state confirmed 2026-07-07._

---

## GPU worker fleet — self-hosted 3D stack (prompt 04)

Deploys the six Cloud Run L4 GPU workers that back the forge lanes so the paid
lane stops paying Replicate and the free lane stops being throttled by hosted
NVIDIA NIM: **TRELLIS** (text/image→3D), **Hunyuan3D**, **TripoSG** (sketch→3D),
**TripoSR** (fast mesh), **UniRig** (auto-rig), **text2motion**. Everything
reverts by unsetting env URLs and the `FORGE_SELFHOST_PRIMARY` flag.

> **Status: code wired & tested; deploy blocked on the same gcloud reauth as the
> foundation above.** The router flag, raised free-lane ceilings, and their tests
> are landed and green. The six `gcloud builds submit` deploys, weight staging,
> Vercel env wiring, and E2E verification all need live GCP auth (**Pending human
> actions**, step 1). Latency/cost cells below are **pre-deploy estimates** — the
> exact command to replace them with measured values is in *Cost per asset*.

### Router wiring (landed, flag-gated, OFF by default)

Self-host was already the health-aware default when its worker URLs are set
(`api/_lib/forge-tiers.js` — `freeLaneCandidates` → `resolveBackendIdWithHealth`).
Prompt 04 adds one flag that makes the fleet *primary* across every tier/path:

- **`FORGE_SELFHOST_PRIMARY=1`** — `freeLaneCandidates` hoists the self-host lanes
  (`trellis_selfhost`, `hunyuan3d`, `triposg`) ahead of the hosted free lanes
  (NVIDIA NIM, HuggingFace) for **text** prompts too (photos already led with
  self-host, since NIM's preview rejects user images). Stable partition — hosted
  lanes stay intact as fallthrough. A no-op until the worker URLs are configured
  (unconfigured lanes are filtered out anyway). `api/_lib/forge-tiers.js`
  `selfHostPrimary()`.
- The **fallback ladder is unchanged**: self-host error → hosted NIM / HuggingFace
  / Replicate exactly as today. The flag only reorders *preference*, never removes
  a safety net.
- **Revert:** unset `FORGE_SELFHOST_PRIMARY` (and/or the worker URLs) → today's
  ordering, no redeploy.

Env vars the router reads for the fleet (all bearer-authed with
`GCP_RECONSTRUCTION_KEY`):

| Env var | Backend | Forge lane |
|---|---|---|
| `MODEL_TRELLIS_URL` | `trellis_selfhost` | free/paid image + text→3D (primary) |
| `GCP_HUNYUAN3D_URL` | `hunyuan3d` | image→3D failover |
| `GCP_TRIPOSG_URL` | `triposg` | sketch→3D |
| `GCP_RECONSTRUCTION_URL` | controller `/reconstruct`, `/rig` | avatar scan + UniRig rigging |
| `GCP_TEXT2MOTION_URL` | text2motion | text→animation clip |
| `GCP_RECONSTRUCTION_KEY` | shared bearer | all of the above |

### Per-service Cloud Run config

From each worker's `cloudbuild.yaml`. All are `--gpu=1 --gpu-type=nvidia-l4
--no-gpu-zonal-redundancy --no-cpu-throttling`, region `us-central1` (co-located
with `three-ws-model-weights`). Weights mount read-only at `/weights` from the
bucket; every worker uses the async **`POST` → 202 + poll `GET /tasks/{id}`**
pattern, so the Cloud Run request timeout does **not** gate generation (the long
work runs post-response under `--no-cpu-throttling`) — no timeout bump is needed.

| Service | CPU / Mem | min→max inst | `MAX_CONCURRENT` | req timeout |
|---|---|---|---|---|
| `model-trellis` | 8 / 32Gi | **1**→2 | 1 | 300s |
| `model-hunyuan3d` | 8 / 32Gi | 0→3 | 1 | 300s |
| `model-triposg` | 8 / 32Gi | 0→2 | 1 | 300s |
| `model-triposr` | 4 / 16Gi | 0→2 | 2 | 120s |
| `unirig` | 4 / 16Gi | **1**→2 | 1 | 180s |
| `model-text2motion` | 4 / 16Gi | 0→2 | 2 | 120s |

**Credit-window override — min-instances 1 for `model-trellis` and `unirig`.**
Cold-start on L4 + model load is brutal and instances are ~free on credits, so
pin the two hottest lanes warm. This is a *temporary* deploy-time override, not
baked into `cloudbuild.yaml` (min=1 costs money after the credits expire — prompt
08 reverts it). `deploy-all.sh` does not pass `_MIN_INSTANCES`, so set it after
deploy:

```bash
for S in model-trellis unirig; do
  gcloud run services update "$S" --region us-central1 --min-instances=1
done
# Revert at expiry: same loop with --min-instances=0
```

### Cost per asset

Full-instance Cloud Run L4 rate (GPU + always-allocated CPU + memory,
`us-central1`, on-demand): **8 vCPU / 32 GiB + L4 ≈ \$1.69/hr**, **4 vCPU / 16 GiB
+ L4 ≈ \$1.20/hr** (L4 GPU ≈ \$0.71/hr; CPU ≈ \$0.0000240/vCPU·s; mem ≈
\$0.0000025/GiB·s). Per asset:

```
$/asset = instance_$per_hr × (warm_seconds_per_asset / 3600)
```

| Service | instance \$/hr | warm s/asset *(estimate)* | \$/asset *(estimate)* |
|---|---|---|---|
| `model-trellis` (image→3D) | 1.69 | **~50 (measured)** | **\$0.023 (measured)** |
| `model-hunyuan3d` | 1.69 | ~60–120 | \$0.028–0.056 |
| `model-triposg` (sketch) | 1.69 | ~20–40 | \$0.009–0.019 |
| `model-triposr` (fast) | 1.20 | ~5–15 | \$0.002–0.005 |
| `unirig` (rig) | 1.20 | ~20–60 | \$0.007–0.020 |
| `model-text2motion` | 1.20 | ~10–30 | \$0.003–0.010 |

> These s/asset values are **pre-deploy estimates** from each model's profile, not
> measured. Every worker already logs the real figure as `elapsed_ms` on its
> `GET /tasks/{id}` result and in Cloud Logging. Replace the table with measured
> warm + cold latency post-deploy:
> ```bash
> gcloud run services logs read model-trellis --region us-central1 \
>   --format='value(textPayload)' | grep -oE 'done in [0-9.]+s'
> ```
> Prompt 08 uses the measured \$/asset × expected volume for the keep/kill
> decision at credit expiry.

### Raised free-lane ceilings (landed, flag-gated)

The per-principal free ceiling is 60/h to protect the **rate-limited hosted NIM**
allocation. With the fleet primary that allocation is out of the path, so
`FORGE_SELFHOST_PRIMARY=1` raises it (`api/_lib/rate-limit.js` — `FREE_HOURLY_BASE`
feeds `mcp3dGenerateFree` + `mcp3dGenerateFreeTiered`):

- **Default raised ceiling: 240/h** per principal (4×), tunable via
  `FORGE_FREE_HOURLY_SELFHOST`.
- **Math:** credit-window free-image fleet = `trellis_selfhost` (max 2) +
  `hunyuan3d` (max 3) = **5 concurrent L4 slots** at `MAX_CONCURRENT=1`. At a
  blended ~60 s/asset that is `5 × 3600/60 ≈ 300 assets/h` global throughput, so a
  single heavy iterator at 240/h stays under the fleet ceiling while the
  hosted-NIM-era throttle is removed. **Re-tune `FORGE_FREE_HOURLY_SELFHOST` from
  the measured s/asset once the fleet is live.**
- **Untouched — abuse/per-IP gates stay intact regardless of the flag:**
  `mcp3dGenerate` (30/h per-IP paid, fail-closed), `paidDailyPerClient` (60/day),
  and the global paid envelope `FORGE_PAID_GLOBAL_HOURLY`.
- **Revert:** unset `FORGE_SELFHOST_PRIMARY` → back to 60/h.

### Deploy runbook (gcloud auth is live as of 2026-07-07 — ready to run)

```bash
# 0. Generate + set the shared worker bearer key (Cloud Run reads it from the
#    avatar-reconstruction-key secret; deploy-all.sh creates that secret).
#    Set the SAME value in Vercel as GCP_RECONSTRUCTION_KEY (step 4).

# 1. Stage weights into gs://three-ws-model-weights (once; ~80 GB, gcsfuse mode).
cd workers/deploy
HF_TOKEN=hf_xxx SERVICES="hunyuan3d trellis triposr triposg unirig" ./stage-weights.sh

# 2. Check L4 quota FIRST (approval can take days). Need >= 4 concurrent for the
#    warm fleet; deploy what fits now and file an increase for the rest.
gcloud run regions describe us-central1 2>/dev/null   # or Console -> Quotas -> nvidia_l4_gpu_allocation

# 3. Build + deploy the mesh/rig fleet, then text2motion (CPU-path helper script).
PROJECT_ID=aerial-vehicle-466722-p5 \
  SERVICES="hunyuan3d trellis triposr triposg unirig" ./deploy-all.sh
PROJECT_ID=aerial-vehicle-466722-p5 SERVICES="text2motion" ./deploy-editing.sh

# 4. Pin the two hot lanes warm for the credit window (see override above).
for S in model-trellis unirig; do
  gcloud run services update "$S" --region us-central1 --min-instances=1; done

# 5. Health-check each service directly with the bearer key.
KEY=$(gcloud secrets versions access latest --secret=avatar-reconstruction-key)
for S in model-trellis model-hunyuan3d model-triposg model-triposr unirig model-text2motion; do
  U=$(gcloud run services describe "$S" --region us-central1 --format='value(status.url)')
  printf '%s: ' "$S"; curl -fsS -H "authorization: Bearer $KEY" "$U/health" || echo "cold - retry"; echo
done

# 6. Wire Vercel env (PREVIEW first, then production after E2E passes). Use the
#    URLs printed by deploy-all.sh + the key from step 5.
for E in preview production; do
  printf '%s' "$MODEL_TRELLIS_URL"   | vercel env add MODEL_TRELLIS_URL   $E
  printf '%s' "$GCP_HUNYUAN3D_URL"   | vercel env add GCP_HUNYUAN3D_URL   $E
  printf '%s' "$GCP_TRIPOSG_URL"     | vercel env add GCP_TRIPOSG_URL     $E
  printf '%s' "$GCP_RECONSTRUCTION_URL" | vercel env add GCP_RECONSTRUCTION_URL $E
  printf '%s' "$GCP_TEXT2MOTION_URL" | vercel env add GCP_TEXT2MOTION_URL $E
  printf '%s' "$KEY"                 | vercel env add GCP_RECONSTRUCTION_KEY $E
done
# Flip self-host primary + raised ceilings ONLY after E2E on preview is green:
printf '1' | vercel env add FORGE_SELFHOST_PRIMARY preview
```

### E2E verification (definition of done — real outputs, not 200s)

Run against the preview deploy with the URLs set; inspect the actual GLB/clip.

1. **Text→3D free lane** → `trellis_selfhost` → GLB in R2, opens in the viewer.
2. **Image→3D** with a real photo (what hosted NIM rejects) → GLB.
3. **Paid `mesh_forge` chain** (reference image → reconstruction) → GLB, with
   Cloud Logging showing **no Replicate call** (`FORGE_SELFHOST_PRIMARY=1`).
4. **Rig** a generated GLB through UniRig `/rig` → animation-ready GLB; load it and
   confirm the skeleton drives the canonical clips (`src/glb-canonicalize.js`).
5. **text2motion** → one text→motion generation → clip JSON.

Record measured cold + warm latency per path back into *Cost per asset* above, and
raise `FORGE_FREE_HOURLY_SELFHOST` from the measured throughput before flipping the
flag in production.

| Path | cold s | warm s | output verified |
|---|---|---|---|
| image→3D (trellis) | ~1020¹ | **~50** | ✅ **1.97 MB glTF v2, 10,306 verts, UVs + indices, 1 material w/ baked baseColorTexture** (robot-crab input) |
| text→3D (trellis) | ~1020¹ | **~50**² | ✅ reconstruct half proven (same `/infer`); full path = FLUX view → this worker |
| mesh_forge (no Replicate) | — | — | ⏳ routing **code-verified** (`trellis_selfhost` hoisted by `FORGE_SELFHOST_PRIMARY`); needs a preview *deploy* to exercise end-to-end |
| rig (unirig) | — | — | ⛔ **BLOCKED** — worker stubbed against a non-existent `UniRigModel` API (see status below); needs a real implementation |
| text2motion | — | — | ⛔ **BLOCKED** — `mdm` weights not staged in `three-ws-model-weights` |

¹ Not per-asset — this is the **one-time per-instance** model load (3 GB weights streamed from the gcsfuse-mounted bucket + spconv/CUDA init). `min-instances=1` keeps `model-trellis` warm so real traffic never pays it. The worker now loads the pipeline in a **background task** so uvicorn binds the port immediately and Cloud Run's startup TCP probe passes at once (a blocking load in the FastAPI lifespan exceeded the startup window and failed the revision — fixed 2026-07-07).
² Warm text→3D adds the upstream FLUX text→image synthesis (~2–6 s) ahead of the ~50 s reconstruct; the ~50 s figure is the reconstruct step measured directly.

### Prompt-04 deploy status (2026-07-07)

**Live:** `model-trellis` (`https://model-trellis-lp642k3kpa-uc.a.run.app`, revision 00003,
`min-instances=1`, 1×L4, 8 vCPU / 32 GiB). Image→3D proven end-to-end with a real
input image → textured GLB (above). Preview env wired: `MODEL_TRELLIS_URL`,
`GCP_RECONSTRUCTION_KEY`, `FORGE_SELFHOST_PRIMARY=1` (preview only; production flip
pending a full platform preview E2E).

**Build/config fixes required to ship it** (the workers were written a while ago):
- **All 6 cloudbuilds** lacked a `timeout:` → Cloud Build's 10-min default killed the
  CUDA image builds. Added `timeout: 3600s`. Also raised Cloud Run request `--timeout`
  to 900 s (was 120–300) per the long-running inference requirement.
- **`model-trellis` Dockerfile:** the compiled TRELLIS extensions
  (nvdiffrast / diffoctreerast / diff-gaussian-rasterization) need
  `pip install --no-build-isolation` (their `setup.py` imports the already-installed
  torch); and the TRELLIS clone needs `--recurse-submodules` (FlexiCubes, its mesh
  extractor, is a git submodule — a plain clone left it a bare gitlink and the worker
  crashed on load). The GLB export call was also wrong (`_pipeline.to_glb` →
  `trellis.utils.postprocessing_utils.to_glb`).
- **`model-triposr`:** `from tsr import TSR` → `from tsr.system import TSR` (empty
  top-level package).

**Blocked (documented for the owner / next session):**
- **GPU quota = 3** L4 (`nvidia_l4_gpu_allocation_no_zonal_redundancy`, us-central1) —
  can't run all six warm at once. File an increase to ≥ 6 for the full warm fleet.
- **`unirig`** — `requirements.txt` pins `unirig @ git+…/UniRig.git@main` (no
  `setup.py`/`pyproject.toml`, not pip-installable) and `main.py` calls
  `UniRigModel.from_pretrained().rig(vertices=, faces=)`, an API the real UniRig repo
  (Blender + hydra CLI pipeline) does not expose. `rig_glb.py` (GLB assembly) is real;
  the model driver is a stub. Needs a genuine UniRig adapter (adds `bpy`/Blender to the
  image) — a multi-hour worker rewrite, not a config fix. **Rig E2E is gated on this.**
- **`model-hunyuan3d`** — weights not staged; needs `HF_TOKEN` (Hunyuan3D-2.1 license-gated).
- **`model-triposg` / `model-text2motion`** — weights not staged
  (`triposg`/`triposg-scribble`/`rmbg-1.4`, and `mdm` respectively).

---

## Spend observability & burn-rate control (prompt 07)

$100k over ~2 months is ~$1,600/day. This section is how we **see** the burn in
real time, **attribute** it to each lane, **alert** before any lane runs away
(especially the GPU fleet and Vertex Claude if flipped to primary), and guard the
opposite failure — credits sitting **unused** at expiry. Everything here is code
that is live and runnable now; gcloud auth is restored and the budget→webhook path
is wired and tested (below). The only steps left are two owner actions: selecting
the pre-created `billing_export` dataset in the console and setting the Telegram ops
creds in Vercel.

### The burn report — `scripts/gcp/burn-report.mjs`

Reads the BigQuery billing export and prints an attributed report: credit
consumed to date, spend by service and by lane label, 7d/30d daily burn, runway,
projected exhaustion vs expiry, and the under-utilization guard.

```bash
node scripts/gcp/burn-report.mjs          # human-readable
node scripts/gcp/burn-report.mjs --json   # machine-readable (dashboard/cron)
```

Exit codes: `0` on-track/idle, `2` runaway (for CI/cron alerting), `3` billing
export not wired, `1` unexpected error. Auth: `GCP_SERVICE_ACCOUNT_JSON` if set,
else the local `gcloud auth print-access-token` (works after `gcloud auth login`).

Config (env or `.env`):

| Env var | Meaning |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | project holding the billing dataset |
| `GCP_BILLING_DATASET` | BigQuery dataset the export writes to (e.g. `billing_export`) |
| `GCP_BILLING_TABLE` | full export table — **or** derive it from ↓ |
| `GCP_BILLING_ACCOUNT_ID` | billing account id; derives `gcp_billing_export_v1_<acct>` |
| `GCP_BILLING_EXPORT_KIND` | `standard` (default) or `resource` (detailed export) |
| `GCP_CREDIT_TOTAL_USD` | grant size, e.g. `100000` — enables runway + projection |
| `GCP_CREDIT_EXPIRY` | ISO date the credits expire — enables the exhaustion-vs-expiry check |
| `GCP_CREDIT_TYPES` | optional override of the credit-type filter (default: `PROMOTION,FREE_TRIAL,COMMITTED_USAGE_DISCOUNT,SUBSCRIPTION_BENEFIT`) |

Shared implementation: `api/_lib/gcp-billing.js` (BigQuery REST + pure projection
math, covered by `tests/gcp-billing.test.js`). The cron and the dashboard import
the same module — one source of truth.

### Enable the BigQuery billing export (owner console action — one time)

The CLI **cannot** enable this; it's console-only.

1. **Billing → Billing export → BigQuery export → Edit settings.**
2. Enable **Standard usage cost** (and optionally **Detailed usage cost** for
   resource-level rows). Pick/create a dataset in `aerial-vehicle-466722-p5`
   (e.g. `billing_export`, location `US`).
3. Data starts flowing within a few hours (no backfill — it's forward-only).
4. Set `GCP_BILLING_DATASET` + `GCP_BILLING_ACCOUNT_ID` (or `GCP_BILLING_TABLE`),
   `GCP_CREDIT_TOTAL_USD=100000`, and `GCP_CREDIT_EXPIRY=<date>` in Vercel (for
   the cron/dashboard) and locally (for the CLI). Verify: `node scripts/gcp/burn-report.mjs`.

### Resource labeling — `scripts/gcp/label-resources.sh`

Attribution only works if every credit-consuming resource carries
`program=gcp-credits` + `lane=<name>`. This discovers the Cloud Run fleet, jobs,
and GCS buckets and (retro-)labels them. Dry-run by default.

```bash
scripts/gcp/label-resources.sh            # dry run — prints the plan
scripts/gcp/label-resources.sh --apply    # write the labels (additive, idempotent)
```

Lanes: `vertex-claude`, `imagen`, `forge-gpu` (the Cloud Run GPU fleet — default
for every discovered service), `vanity`. Vertex Claude + Imagen are API-billed
(no Cloud Run service), so they're attributed by `service.description` in the
report instead of a label. Edit `LANE_OVERRIDES` in the script for exceptions.

### Budgets & alerts — `scripts/gcp/create-budgets.mjs` + the webhook

```bash
node scripts/gcp/create-budgets.mjs           # dry run — prints the plan
node scripts/gcp/create-budgets.mjs --apply   # create/update budgets (idempotent)
```

Creates an **overall program budget** (= `GCP_CREDIT_TOTAL_USD`, default $100k)
with threshold alerts at **25 / 50 / 75 / 90 / 100 %** measured on GROSS spend
(credits excluded, so it tracks grant consumption), plus **per-service** budgets
for Vertex AI / Cloud Run / Compute Engine (sized from `GCP_SERVICE_BUDGETS` or
defaults, service ids resolved live from the billing catalog). All publish to one
Pub/Sub topic (`GCP_BUDGET_PUBSUB_TOPIC`, default `gcp-budget-alerts`).

**Routing to the team:** the topic pushes to `POST /api/webhooks/gcp-budget-alert`,
which turns each threshold crossing into a Telegram ping via `sendOpsAlert` — the
PRIVATE ops chat (`TELEGRAM_ALERTS_CHAT_ID`), **never** the holders' channel.
Deduped per budget+threshold so each crossing pings once/hour.

Wire the push subscription (**done 2026-07-07** — commands kept for rotation/DR;
the live subscription is `gcp-budget-alerts-webhook`, `ACTIVE`):

```bash
# 1. shared secret the handler checks (constant-time)
printf '<random-secret>' | vercel env add GCP_BUDGET_WEBHOOK_SECRET production
# 2. (optional) let the budgets SA publish to the topic — GCP's budget notifier
#    provisions its own publisher on the first real threshold, so this manual grant
#    is not required; it currently fails "does not exist" (org DRS / lazy SA).
gcloud pubsub topics add-iam-policy-binding gcp-budget-alerts \
  --project=aerial-vehicle-466722-p5 \
  --member=serviceAccount:billing-budgets.iam.gserviceaccount.com --role=roles/pubsub.publisher
# 3. push subscription → the webhook (secret in the query string)
gcloud pubsub subscriptions create gcp-budget-alerts-webhook \
  --project=aerial-vehicle-466722-p5 --topic=gcp-budget-alerts \
  --ack-deadline=30 \
  --push-endpoint="https://three.ws/api/webhooks/gcp-budget-alert?token=<random-secret>"
```

**Test the alert path** (no live budget needed): publish a synthetic notification —

```bash
gcloud pubsub topics publish gcp-budget-alerts --project=aerial-vehicle-466722-p5 \
  --message='{"budgetDisplayName":"gcp-credits — program","alertThresholdExceeded":0.9,"costAmount":90000,"budgetAmount":100000,"currencyCode":"USD"}'
# → a 🔴 ping lands in the ops chat within seconds.
```

Handler contract (auth 503/401, threshold gate, dedup) is locked by
`tests/api/gcp-budget-alert.test.js`.

### Internal spend dashboard — `/dashboard/spend`

Admin-gated page (dashboard-next → nav "GCP Spend", `src/dashboard-next/pages/spend.js`),
backed by `GET /api/admin/gcp-burn` (session-admin **or** `Bearer $CRON_SECRET`).
Two cross-referenced views:

- **App-side telemetry** (always live, from `usage_events` + `forge_creations`):
  per-lane LLM cost/tokens (14d), Vertex Claude spend estimate (30d + 24h, by
  model), forge generations per backend (self-host flagged), and a daily LLM-cost
  bar chart. This renders even before the billing export is wired.
- **Billing ground truth** (best-effort, from `buildBurnReport`): credit consumed,
  runway, projection vs expiry, credit spend by lane label. Degrades to a designed
  "not wired" panel when the export is absent — the app-side view still shows.

All states designed (loading skeleton, empty, 401/403 lock, error, populated);
auto-refreshes every 60s.

### Kill-switches (verified no-deploy env flips)

The GPU fleet and Vertex Claude are the two runaway risks. Each reverts by env
flag alone — no code deploy:

| Lane | Kill switch | Effect |
|---|---|---|
| Vertex Claude | `vercel env rm VERTEX_CLAUDE_PRIMARY production` | chat falls back to free/BYOK lanes instantly (see prompt 02 section) |
| Forge GPU fleet | `vercel env rm FORGE_SELFHOST_PRIMARY production` | routing stops preferring the self-host GPU workers |
| Imagen | `vercel env add VERTEX_IMAGEN_ENABLED production` = `0` | text→image drops to the free NIM FLUX lane |

**Fast "stop the bleed now" — `scripts/gcp/emergency-stop.sh`** (dry-run by
default): drops **every** Cloud Run service + job to `--min-instances=0`, cancels
in-flight job executions, and prints the flag flips above + the spot/batch stop
commands. Use this for a runaway during the program; use `revert-to-free.sh`
(prompt 08) for the planned end-of-program teardown.

```bash
scripts/gcp/emergency-stop.sh            # dry run — shows what it would do
scripts/gcp/emergency-stop.sh --apply    # drop min-instances to 0 across the fleet
```

### Under-utilization guard + daily cron

The projection flags **`underutilized`** when >30% of the grant is projected to
expire unused (and **`idle`** when there's no burn at all), with per-lane scale-up
prompts (flip `VERTEX_CLAUDE_PRIMARY` for production chat, raise seed-batch
volume, bigger vanity runs). Wasting the credits is a tracked failure mode, not
just overspend.

**`api/cron/gcp-burn-report.js`** runs daily (`0 14 * * *`, registered in
`vercel.json`) and pings the ops channel with the day's status — runaway and
under-utilization get distinct, un-deduped signatures so they always land; an
on-track day posts a quiet one-line status. If the export isn't wired it says so
once/day rather than erroring.

### Current status (2026-07-07, later session)

Live progress after the 2026-07-07 reauth:

- **Budgets: created** (billing account `01B467-A61905-9A97D2`): "gcp-credits — program" $100k
  + per-service Vertex AI $55k / Cloud Run $20k / Compute Engine $15k, thresholds
  25/50/75/90/100%. Pub/Sub topic `gcp-budget-alerts` created. Budget **email**
  alerts to billing admins are active now.
- **Pub/Sub → webhook leg: WIRED & TESTED.** `GCP_BUDGET_WEBHOOK_SECRET` pushed to
  Vercel prod; push subscription `gcp-budget-alerts-webhook` created against
  `https://three.ws/api/webhooks/gcp-budget-alert?token=…` (state `ACTIVE`). Auth
  verified live against prod: no/invalid token → `401`, valid token → `200` ACK. A
  synthetic budget notification published to the topic delivers through the
  subscription to the handler. **Last hop still owner-gated:** `sendOpsAlert`
  no-ops because `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERTS_CHAT_ID` are **not** set in
  Vercel prod (owner secrets — same missing creds as `agent-sniper` below). Set both
  in Vercel and the ops ping goes live with zero code change. The
  `billing-budget-alerts@system.gserviceaccount.com` publisher grant still returns
  "does not exist" (org DRS or lazy system-SA creation) — GCP's budget notifier
  provisions its own publisher on the first real threshold crossing, so the
  end-to-end path does not depend on that manual grant; the synthetic-publish test
  above already proves subscription → webhook.
- **BigQuery billing export: dataset pre-created.** `billing_export` (location `US`)
  now exists in `aerial-vehicle-466722-p5` — the owner's remaining step is only to
  **select it** in Billing → Billing export → BigQuery export (still console-only;
  no gcloud/API path exists, confirmed this session). Once selected, BigQuery
  auto-creates `gcp_billing_export_v1_01B467_A61905_9A97D2` and the burn report /
  dashboard / cron begin reporting. `burn-report.mjs` currently degrades correctly
  to "billing export table not found" against the empty dataset.
- **Attribution labels: applied** (`label-resources.sh --apply`): all 9 Cloud Run
  services + both buckets carry `program=gcp-credits` and a lane
  (`forge-gpu` for the model/editing workers, `platform` for agent-sniper /
  hyperfy-world / three-ws-multiplayer).
- **Findings from the label sweep:** (a) `model-triposr` has **no healthy revision** —
  container crashes on boot with `ImportError: cannot import name 'TSR' from 'tsr'`;
  the image itself is broken, fix in the prompt-04 fleet deploy. (b) `agent-sniper`
  references three Secret Manager secrets that **do not exist**
  (`sniper-solana-rpc-url`, `telegram-bot-token`, `telegram-alerts-chat-id`) — the
  serving revision still runs, but any redeploy will fail until the owner recreates
  them.

Burn rate, exhaustion projection, and full/unused-credit tracking remain **wired
but not reporting** — they need the owner to select the pre-created `billing_export`
dataset in the console (one click; dataset now exists) and set `GCP_CREDIT_TOTAL_USD` /
`GCP_CREDIT_EXPIRY`. The moment the export starts flowing, `node scripts/gcp/burn-report.mjs`
prints the live burn rate and days-of-runway, the dashboard fills in, and the daily
cron begins posting. Until then the app-side lane telemetry on `/dashboard/spend` is
the live view. Program budget targets for the alerts: Claude-on-Vertex $40–60k, GPU
fleet $15–25k, Imagen $3–5k, vanity/observability/misc ~$5k.

**Two remaining owner actions to fully activate prompt-07 ops:**
1. Billing → Billing export → BigQuery export → select the `billing_export` dataset
   (already created); then set `GCP_BILLING_DATASET=billing_export`,
   `GCP_BILLING_ACCOUNT_ID=01B467-A61905-9A97D2`, `GCP_CREDIT_TOTAL_USD=100000`,
   `GCP_CREDIT_EXPIRY=<date>` in Vercel + `.env`.
2. Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERTS_CHAT_ID` in Vercel prod so budget
   alerts (subscription already delivering) and the daily cron actually ping the ops
   chat instead of no-op'ing.

_Spend-observability section last verified against source: 2026-07-07 (later session)._

---

## Audit + fixes — 2026-07-08 (post Vercel→Cloud Run migration)

Re-verified every prompt (01–08) against live `gcloud`/`bq`/Cloud Run state rather than
trusting this file. Headline finding: **every "set in Vercel" instruction above is now
stale.** Production moved off Vercel to Cloud Run (`three-ws-api`, see
`docs/ops/gcp-production.md`) the same day most of this file was written, and none of
the GCP-credits env vars that were pushed to Vercel ever made it onto the Cloud Run
service — `gcloud run services describe three-ws-api ... --format='value(...env...)'`
showed **zero** of them present. Every lane documented as "live in prod" above (Vertex
Claude available-but-not-primary, Vertex Imagen fallback, the trellis self-host URL,
the billing-report env, the budget-webhook secret) was actually inert in production
until today.

**Fixed today (no owner action, no billing-lane change):**
- Wired onto `three-ws-api` (Cloud Run, `--update-env-vars`/`--update-secrets`, additive
  — the service's other ~100 env vars were left untouched):
  `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_LOCATION_CLAUDE`,
  `VERTEX_CLAUDE_ENABLED=1` (available, **not** primary — chain inversion stays the
  owner's call per prompt 02), `MODEL_TRELLIS_URL`, `GCP_BILLING_DATASET=billing_export`,
  `GCP_BILLING_ACCOUNT_ID`, `GCP_CREDIT_TOTAL_USD=100000`, and as Secret Manager refs:
  `GCP_SERVICE_ACCOUNT_JSON` (fresh key minted for `vercel-inference@`, stored as secret
  `gcp-vercel-inference-sa-key`), `GCP_RECONSTRUCTION_KEY` (points at the existing
  `avatar-reconstruction-key` secret — same bearer key `model-trellis` already uses),
  `GCP_BUDGET_WEBHOOK_SECRET` (secret `gcp-budget-webhook-secret`, value matches the
  token already baked into the live Pub/Sub push subscription so no subscription edit
  was needed). Granted `three-ws@` (runtime SA) `secretAccessor` on all three secrets,
  and `vercel-inference@` `roles/bigquery.jobUser` + `roles/bigquery.dataViewer` (the
  burn-report script had never actually been able to query — proven by running it: it
  now gets exactly as far as "export not configured", the documented owner-console gate,
  instead of a permission error).
  `VERTEX_IMAGEN_ENABLED` was **not** explicitly set — `text-to-image.js` already
  defaults it on whenever `GOOGLE_CLOUD_PROJECT` is set (prompt 03's own design), so
  setting `GOOGLE_CLOUD_PROJECT` alone activates the Imagen fallback lane; the prompt-03
  quality gate already passed (see above), so this is live now, fallback-only, NIM FLUX
  still leads.
  **Not set** (matches every prompt's explicit fail-safe/owner-gate guardrail):
  `VERTEX_CLAUDE_PRIMARY`, `FORGE_SELFHOST_PRIMARY`, and the four other worker URLs
  (`GCP_HUNYUAN3D_URL`/`GCP_TRIPOSG_URL`/`GCP_RECONSTRUCTION_URL`/`GCP_TEXT2MOTION_URL`)
  — those services aren't deployed (see below), there is nothing to point at yet.
- **Re-verified the console-only gates are still actually blocked**, not just
  documented-stale: `node scripts/gcp/vertex-smoke.mjs` with a live SA key still 404s
  (Model Garden Claude enablement genuinely not done); `bq ls billing_export` still has
  zero tables (BigQuery billing export genuinely not configured). Both need the exact
  owner console actions already listed above — nothing changed there.
- **GPU quota increased**: `NVIDIA_L4_GPUS` in `us-central1` is now **8** (the doc above
  says "quota = 3" from the 2026-07-07 session — that request evidently landed). Headroom
  exists to bring up more of the fleet warm; the remaining blockers below are code/weights
  gaps, not quota.
- **`model-triposr` rebuilt and redeployed.** The doc above already diagnosed the crash
  (`ImportError: cannot import name 'TSR' from 'tsr'`) and the source fix
  (`from tsr.system import TSR`) was already committed — it had just never been rebuilt.
  Rebuilt via `gcloud builds submit --config=workers/model-triposr/cloudbuild.yaml`
  (had to run from a clean `git worktree`, not the shared repo root — see hazard note
  below — and pass `--service-account=three-ws-build@…` + `--substitutions=SHORT_SHA=…`,
  neither of which the bare command from the doc's deploy runbook supplies for a local
  submit; also needed `roles/iam.serviceAccountUser` for `three-ws-build@` on
  `avatar-reconstruction-sa@`, missing until this session). **Healthy and inference-
  tested**: `/health` returns `model_loaded:true, gpu_available:true` on an L4; a real
  `/infer` call (HTTPS image → background removal → mesh) hit a **second real bug**,
  also fixed this session — TripoSR's tokenizer normalizes with a 3-channel mean/std
  and the rembg background-removal step was handing it a 4-channel RGBA image
  (`RuntimeError: size of tensor a (4) must match ... b (3)`). Fixed in
  `workers/model-triposr/main.py`: matte the cutout onto mid-gray (127,127,127) and
  flatten to RGB before the model call, matching upstream TripoSR's own demo
  preprocessing. Rebuilt + redeployed; re-verify with a fresh `/infer` call once the
  redeploy in flight lands. **Not wired into the router**: `api/forge.js` /
  `api/_providers/gcp.js` have no `MODEL_TRIPOSR_URL`/`GCP_TRIPOSR_URL` reference at
  all — this worker isn't part of any lane `forge.js` selects (the prompt-04 context's
  "TripoSG/TripoSR" pairing reads as one conceptual role; `GCP_TRIPOSG_URL` is the one
  actually wired, for TripoSG). Fixing and deploying it was still worth doing (proves
  the CUDA build pipeline and the L4 fleet both work end-to-end, and it's a real,
  healthy, inference-capable service now), but it does not change user-facing behavior
  until/unless a lane is added to point at it — flag this to the owner as a scope
  question for prompt 04/05 rather than assuming and wiring a new lane unasked.
- **Found and fixed a real production bug while wiring the budget-webhook path**:
  `api/webhooks/gcp-budget-alert.js` (and `api/webhooks/replicate.js`, same pattern)
  called `readJson()`/`readBody()` past their auth check and **hung until the request
  timeout** on live Cloud Run traffic — reproduced directly against
  `https://three-ws-api-*.run.app` with curl and raw Node `https.request`, independent
  of HTTP/1.1 vs HTTP/2, query-string vs header auth, and body content. Root cause: the
  fallback branch in `readBody()` (`api/_lib/http.js`) attached `'data'`/`'end'`
  listeners unconditionally; if the stream had already ended before the handler started
  listening, those events never re-fire and the promise hangs forever — a variant of the
  exact hazard the `req.rawBody` fast-path comment above already warns about, reached a
  different way. **This means every real budget-alert notification since the webhook was
  wired has silently never reached the ops chat** — Pub/Sub kept retrying against a
  handler that never responded, which is also why the queued retries kept showing 401 in
  logs (stale token from before the secret was fixed today) rather than any 200s.
  Fixed in `api/_lib/http.js`: resolve immediately with an empty buffer when
  `req.complete` is already true (can't recover already-drained bytes, but can stop
  hanging on them), and cap the listener path with a `READ_BODY_TIMEOUT_MS` (default
  15s) timeout so any future stream stall fails fast and diagnosably instead of pinning
  a Cloud Run concurrency slot for the full request timeout. Committed
  (`ba37182f3`), covered by the existing `tests/api/gcp-budget-alert.test.js` +
  `tests/api-validate.test.js` (both green). **Deployed and confirmed live** —
  `three-ws-api-00017-kgs`: direct curl with the correct token now returns `200` in
  ~0.1s (was an unconditional hang before); `api/webhooks/replicate.js` (same
  `readBody` fallback) now returns its normal `401` fast instead of hanging too.
- Verified the synthetic-notification test from the prompt-07 section above end to end
  against the *current* infra, post-fix: `gcloud pubsub topics publish gcp-budget-alerts
  …` → delivered to the webhook → **`200` in the Cloud Run request log** (was 401 →
  then hung → now clean). The budget-alert pipe is genuinely live end to end as of this
  session; the only remaining gap is the last hop, `sendOpsAlert` no-op'ing because
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALERTS_CHAT_ID` aren't set (owner credentials, listed
  above).

**Confirmed still genuinely blocked (owner console action or missing credentials —
no workaround attempted):**
- Model Garden Claude partner-model enablement (prompt 01/02) — console-only terms
  acceptance, `vertex-smoke.mjs` still 404s.
- BigQuery billing export (prompt 07) — console-only, dataset exists but has zero
  tables; `burn-report.mjs` correctly reports "export not configured" now that the IAM
  permission gap is fixed.
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALERTS_CHAT_ID` — not present anywhere (not Cloud Run
  env, not Secret Manager); the budget-webhook and daily cron both no-op on the final
  Telegram hop without these. Owner credentials, no workaround.
- Credit balance + expiry date — still console-only, never obtained; `GCP_CREDIT_EXPIRY`
  intentionally left unset (a wrong guess would silently corrupt the exhaustion
  projection).

**Prompt 04 remaining gaps — re-verified, unchanged conclusions:**
- `unirig` — still a stub (`main.py` calls a `UniRigModel.from_pretrained().rig(...)`
  API the real UniRig repo doesn't expose); a real adapter needs Blender/`bpy` in the
  image and is a genuine multi-hour rewrite, not a config fix. Not attempted this
  session — out of proportion for a verification pass, and rigging is a hard
  dependency for prompt 05's "catalog entries must be animation-ready" bar, so
  shipping a half-real rig adapter would violate the no-mocks rule worse than leaving
  it blocked.
- `model-hunyuan3d` — weights not staged, needs `HF_TOKEN` (present in the platform's
  own env already, but the license-gated Hunyuan3D-2.1 weights themselves still need a
  human to accept the gate on huggingface.co before download works) — not attempted.
- `model-triposg` / `model-text2motion` — weights not staged (`triposg`,
  `triposg-scribble`, `rmbg-1.4`, `mdm`) — not attempted; each is a genuine multi-GB
  download + storage-cost decision, not a quota or code fix, so left for a session with
  explicit budget for it.

**Prompt 05 (catalog & animation seeding): confirmed not started.** No
`scripts/gcp/seed-avatars.mjs`, no `SEED_CRON_BATCH` env-tunability in
`api/cron/forge-seed-cron.js`, no doc section — matches the prompt's own
prerequisite ("prompt 04 live... text2motion service deployed") not being met: only
`model-trellis` is live, UniRig and text2motion are not, and prompt 05's acceptance
criteria explicitly require rigged, animation-ready catalog entries and a generated
motion library. Attempting a partial version (unrigged catalog avatars, no motion
library) would ship exactly the "catalog avatar that T-poses is half-built" outcome
the prompt calls out as unacceptable. Correctly blocked on prompt 04, not attempted.

**Hazard discovered this session — record for the next agent:** the shared working
tree had ~170 files of uncommitted, unrelated in-progress work from other concurrent
agents (material studio, embodiment, provenance, persona-identity, animation registry).
`gcloud builds submit … .` from the shared repo root packages the working directory
*as-is*, uncommitted changes included — building/deploying from it would have shipped
unreviewed, unrelated work to production. Also hit mid-tar file-churn from a concurrent
agent (`FileNotFoundError` on a file another agent deleted mid-build) when building from
the shared root. **Always build from a clean `git worktree add --detach <path> <commit>`**
(symlink `node_modules` from the shared tree to skip a full reinstall; regenerate `dist/`
inside the worktree with `npm run build && npm run build:lib:full && npm run publish:lib`
since `dist/` is gitignored and the Docker image only contains what's physically present
at build time) when deploying anything from this repo while other agents may be active.
Separately hit — and this one was a real, already-fixed-by-another-agent bug, not
something to route around — a `main` HEAD that briefly couldn't `npm ci` at all
(`packages/defi-utils`/`packages/tool-sdk` present on disk but missing from
`package-lock.json`); resolved upstream by commit `bc60fb2de` before this session's
redeploy needed it. Also observed a second agent deploy a new `three-ws-api` revision
(`00018-kh7`) to the same service mid-session, independent of this work.

**Separate finding, NOT diagnosed to root cause — flag for the next session, do not
assume it's this program's doing:** every `vercel.json` route whose `dest` differs from
its `src` and that isn't one of the handful already proven live (home `/` →
`/home.html`, `/gallery` → `/gallery/index.html`) appears to 404 in production right
now — reproduced on `/dashboard/*` (all of it, including the bare `/dashboard/`
entry point and the prompt-07 `/dashboard/spend` page), `/pump-dashboard`, confirmed
against **both** `https://three.ws/...` and the Cloud Run origin directly (rules out a
CDN-only cause for this revision). The destination files exist in a from-source
worktree build (`dist/dashboard-next/*.html`, `dist/pump-dashboard.html`, timestamps
matching a clean `npm ci` + `npm run build`), and the server's route-matching code
(`server/index.mjs` `compileRoute`/`resolveStatic`) reads as correct on inspection —
but the 404 response's `content-length` (8350 bytes) does not match this session's
locally-built `dist/404.html` (8951 bytes), meaning **the currently-serving container's
`dist/` does not fully match what this session built and submitted**, for reasons not
resolved before time ran out (candidates not yet ruled out: a stale Docker layer-cache
hit on `COPY . .` despite content changing, a `vite build`/`emptyOutDir` interaction
with the two build attempts in the same worktree this session, or the concurrent
`00018-kh7` deploy from another agent superseding/interleaving with this one). This
predates and is independent of this program's own changes (`api/_lib/http.js`,
`workers/model-triposr/main.py` touch neither routing nor `dist/` generation) — it was
found while smoke-testing `/dashboard/spend` for prompt 07, not caused by testing it.
**Action for the next session:** confirm whether this is new (Cloud Run migration
artifact) or has been silently broken since 2026-07-07, with a stable environment (no
concurrent deploys), before attempting a fix — the evidence above rules out several
easy explanations already.
