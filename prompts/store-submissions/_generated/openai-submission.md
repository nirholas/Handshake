# three.ws 3D Studio — OpenAI ChatGPT App Directory submission package

**Prepared:** 2026-07-07 · **Last re-verified live:** 2026-09-02 · **Owning prompt:** 06
**Endpoint:** `https://three.ws/api/mcp-studio`
**Prereqs verified live:** prompt 04 (`/api/mcp-studio` deployed), prompt 05 (widget renders real GLBs).

This is the copy-paste-ready answer sheet for submitting the free three.ws 3D Studio to the
OpenAI ChatGPT App Directory, plus an evidence-backed compliance audit. **Every field is
filled** (2026-07-14: organization verified on platform.openai.com, support contact and privacy
policy confirmed live). Submission is currently held on the §0 output-quality blocker; once that
fix is deployed and re-verified, the remaining step is the owner's final submit in the portal.

---

## 0. Submission verdict: NOT READY (output-quality blocker found 2026-09-02)

**Every connector, manifest, widget and Actions surface re-verified live on 2026-09-02 and all
pass** (see the §7 checklist). Submission is held on one product defect, not a protocol one:

| # | Blocker | State |
|---|---------|-------|
| **B3** | The free lane intermittently ships a **degenerate slab**: a reconstruction that lost its image conditioning returns a full-footprint relief (a 2.0 x 0.31 x 2.0 pancake) instead of the object. It carries 30k triangles and PBR textures, so `scoreGlbQuality` rated it **0.976 / flag `ok`** and skipped vision QA entirely, shipping it as a top-confidence result. Measured on 40 consecutive live free-lane generations: **6 affected**. Both first-try verification generations run for this checklist hit it, so a reviewer's first prompt has a material chance of returning a flat slab. | Cheap-scorer fix landed in `api/_lib/glb-quality.js` (flatness metric + `planar` signal that forces vision-QA escalation; validated to flag 6/6 known-bad and 0/34 healthy). **Needs a production deploy, then a fresh re-verification generation, before submitting.** |

The historical 2026-07-14 blockers below stay cleared.

## 0a. Prior verdict: READY (blockers cleared 2026-07-14)

The app **passes every OpenAI content/privacy/annotation policy** (§2 audit: all PASS). The two
production defects found on 2026-07-07 are both **fixed and re-verified live on 2026-07-14**:

| # | Was | Verified fixed (2026-07-14) |
|---|-----|------------------------------|
| **B1** | Rate-limiter store over monthly quota: every `tools/call` generation returned HTTP 429 `rate_limiter_unavailable`. | Live `forge_free` call completed end-to-end: real 1.6 MB GLB (`model/gltf-binary`) on R2 plus working `viewerUrl`. Root cause ended permanently by the self-hosted Redis rail (Memorystore + SRH) that replaced the capped Upstash store. |
| **B2** | `/viewer?src=<glb>` returned 404: the `viewerUrl` every tool returns was a dead link. | `https://three.ws/viewer?src=<glb>` returns 200 and serves the standalone studio viewer, which reads `?src=`. |

Additionally, three.ws was **accepted into the OpenAI Partner Network on 2026-07-14** (welcome email
to nich@three.ws), which unlocks the partner portal for the submission itself.

**Remaining steps are owner-only:** re-run the §5 reviewer smoke test if desired, then submit this
package through the partner portal. Schema note for the smoke test: `forge_free` accepts
`{"prompt": "...", "tier"?: "draft"|"standard"|"high"}`; other extra properties are rejected with
`-32602`.

**Quality note (re-verified live 2026-08-06):** the studio generation tools **default to the
standard tier**, and every surface a reviewer can read says so: the `forge_free` tool schema
(`"standard (default)"`), §1's tool table, and [`docs/mcp-studio.md`](../../../docs/mcp-studio.md).
The **high tier is a real option the caller can ask for**, not a stub, but it is never the default.
Both claims were proven end to end against production, with the tier read back from the durable
`forge_creations` record rather than inferred from the response text
([`forge-free-tier-evidence.json`](forge-free-tier-evidence.json)):

| Call | Wall clock | Recorded tier | Engine | GLB |
|---|---|---|---|---|
| `forge_free {prompt}` (no tier) | 164 s | `standard` | `trellis_selfhost` | 5.07 MB |
| `forge_free {prompt, tier:"high"}` | 144 s | `high` | `hunyuan3d` (self-hosted GPU worker) | 2.69 MB |

Standard stays the default deliberately. Latency is not the discriminator (both lanes exceed a
ChatGPT tool-call window, which is why `forge_free` returns a pollable job handle instead of an
error when a generation outlives `STUDIO_FORGE_TIMEOUT_MS`). The reasons are that the Hunyuan3D
worker is scale-to-zero, so a cold container adds a spin-up on top of the generation, and that the
high-tier access gate is cleared only by the platform's internal server-to-server token: a
deployment missing it would quietly serve standard while a "high by default" promise stayed on the
page. An explicit `tier:"high"` request degrades to standard on a 402 or submit timeout rather than
failing the conversation. Compliance surface unchanged: keyless, free, zero payment strings on the
wire (the high tier is platform-funded; the ChatGPT user is never asked for anything).

The two sections below are kept as the historical record of the defects and their fixes.

---

### B1 — Rate-limiter store over quota (generation 429s) — RESOLVED 2026-07-14

**Evidence (live, 2026-07-07):**
```
$ curl -s -X POST https://three.ws/api/mcp-studio -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"forge_free","arguments":{"prompt":"a friendly robot mascot"}}}'
{"error":"rate_limited","error_description":"generation rate limit — slow down and try again shortly","retry_after":60,"reason":"rate_limiter_unavailable"}   # HTTP 429
```
**Root cause:** the shared Upstash/Vercel-KV limiter store is over its **monthly command quota**:
```
$ curl -s "$KV_REST_API_URL/ping" -H "authorization: Bearer $KV_REST_API_TOKEN"
{"error":"ERR max requests limit exceeded. Limit: 500000, Usage: 500002. ..."}
```
The studio's generation buckets (`studioGenBurst`, `studioGenHourly`, `studioGenerateGlobal` in
`api/_lib/rate-limit.js`) are `critical: true`, so on a Redis error in production they **fail closed**
(deny) rather than allow unbounded operator-funded spend. With the store over quota, every Redis
command errors → generation is denied with `reason: 'rate_limiter_unavailable'`. This is the recurring
"500k/mo" incident referenced in the rate-limit code comments.

**Fix (ops — pick one):**
1. **Restore quota** — upgrade the Upstash plan or reset billing so `Usage < Limit`; the studio recovers
   the instant commands succeed again. (Fastest; no deploy.)
2. **Point the limiter at a fresh store** — set `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`
   (highest-priority source in `REDIS_REST_SOURCES`) to a new Upstash DB with headroom, then redeploy.

Note: `authIp`/login use `degradeToMemory` and stay up; only cost/money-moving buckets (studio
generation, chat, x402-verify, auto-rig) fail closed. This is a **site-wide** cost-lane outage, not
studio-only — worth fixing regardless of the submission.

**Resolution (verified 2026-07-14):** the limiter no longer runs on the capped Upstash store; it runs
on the platform's self-hosted Redis (Memorystore behind an SRH proxy, no monthly command cap). A live
`forge_free` `tools/call` completed a real generation end-to-end. No action left.

---

### B2 — `/viewer?src=<glb>` returns 404 (broken link in every tool response) — RESOLVED 2026-07-14

**Evidence (live, 2026-07-07):**
```
$ curl -s -o /dev/null -w '%{http_code}' "https://three.ws/viewer?src=<encoded-glb>"
404          # body: <title>three.ws — 404</title>
```
Every studio tool returns `viewerUrl: "https://three.ws/viewer?src=<glb>"` in `structuredContent` and
in the text ("View it: …/viewer?src=…"), and the widget's primary **"Open in three.ws"** button links
to it. That path 404s.

**Root cause:** `vercel.json` had **no route** mapping `/viewer`, so the `viewerUrl` emitted by every
studio tool resolved nowhere. The link is emitted by shipped surfaces
(`api/_mcp-studio/forge-client.js`, `src/shared/forge-frames.js`, `api/v1/ai/_text-to-3d-lane.js`,
`api/_lib/tokenize-3d-metadata.js`, `api/_okx3d/identity.js`, `api/_studio/tools.js`), so this was a
platform-wide dead link, not studio-only.

**Resolution (verified 2026-07-14):** `vercel.json` routes `/viewer` to the standalone browser viewer
[`public/viewer.html`](../../../public/viewer.html), which reads `?src=<glb>`.
`https://three.ws/viewer?src=<glb>` returns 200 and renders the model, and the `viewerUrl` returned by
a live `forge_free` call uses exactly that shape. No action left. (Note: the ChatGPT *inline* widget is
a separate surface, `api/_mcp-studio/component.js`; `/viewer` is the "open in a normal browser" page.)

---

## 1. Listing metadata (copy-paste into the submission form)

| Field | Value |
|-------|-------|
| **App name** | **three.ws 3D Studio** |
| **Tagline** | Turn a text prompt into a downloadable, animation-ready 3D model — free, inside ChatGPT. |
| **Short description** | three.ws 3D Studio generates textured 3D models, avatars, and rigged characters from a text prompt (or a reference image) and renders each result inline in an interactive 3D viewer you can rotate, inspect, and download as a GLB. It can also auto-rig a static model into an animation-ready one. Free to use — no account, no key, no payment. |
| **Long description** | Describe anything ("a friendly round robot mascot," "a low-poly treasure chest," "a knight character I can animate") and three.ws 3D Studio builds a real, textured 3D model and shows it in an interactive viewer right in the conversation. Eleven tools cover the full path from idea to asset: generate a model from text, generate an avatar, generate an art-directed mesh, auto-rig a static model into an animation-ready one, generate-then-rig a character in a single step, refine an existing model by describing a change, collect a detailed model that took longer than one turn, look at a finished model from several angles to check the result, and save a rigged model as a persistent persona that can speak with lip-sync and emotion. Every result is a standard **GLB** you can download and drop into Blender, Unity, Unreal, three.js, or any glTF pipeline. Generation runs on three.ws's own free 3D lane, so there is nothing to sign up for and nothing to pay. Not natively possible in ChatGPT: turning language into a manipulable, downloadable 3D asset with an inline viewer. |
| **Category** | Creativity & Design (secondary: Productivity) |
| **Country availability** | All countries / Global (no geo-restriction; anonymous + free). |
| **Age suitability** | Suitable for ages 13–17 (content-safety gate on every generation lane — §2.6). |
| **App icon** | `_generated/assets/icon-512x512.png` (512×512, owned IP). |
| **Support contact** | `support@three.ws` · `https://three.ws/support` (page live, HTTP 200, verified 2026-07-14; lists support/security/abuse channels) |
| **Privacy policy URL** | `https://three.ws/legal/privacy` (live, HTTP 200, verified 2026-07-14; the studio collects no personal data, see §2.4) |
| **Developer/Publisher** | three.ws (verified organization on platform.openai.com, confirmed by owner 2026-07-14; OpenAI Partner Network member since 2026-07-14) |

### Example prompts (3–5, all reliably produce a model)
1. `Make a 3D model of a friendly round robot mascot, glossy white plastic.`
2. `Generate a low-poly treasure chest with iron bands.`
3. `Create a 3D avatar of a space explorer in a white-and-orange suit.`
4. `Make a rigged, animation-ready knight character I can pose.`
5. `Model a small ceramic teapot with a bamboo handle and a celadon glaze.`

### Tool list (titles as shown to users; matches live `tools/list`, re-pulled 2026-09-02)
| Tool | Title | What it does |
|------|-------|--------------|
| `forge_free` | Generate a 3D model from text | Text → textured GLB, platform-funded. Defaults to the standard tier (fast, reliable, textured); the caller may request `draft` (fastest) or `high` (best, slower; falls back to standard under load). |
| `text_to_avatar` | Generate a 3D avatar | Text or reference image → avatar GLB. |
| `mesh_forge` | Generate a 3D mesh (art-directed) | Text/image → mesh, prompt refined by an AI art-director first. |
| `rig_mesh` | Rig a 3D model for animation | Static GLB URL → humanoid-rigged, animation-ready GLB. |
| `forge_avatar` | Generate a rigged, animation-ready avatar | Text/image → generate + auto-rig in one step. |
| `refine_model` | Refine a 3D model by describing a change | Existing GLB + instruction → regenerated model with version lineage. |
| `check_job` | Check a pending 3D generation | Job id → the finished model, or a fresh pending state with a live ETA. Read-only; collects a generation that outran its original tool call. |
| `look_at_model` | Look at a 3D model | GLB URL → rendered frames from several angles as images, plus geometry stats (triangles, materials, textures) and a plain reading of them. Read-only; works on any public https GLB. |
| `create_agent_persona` | Save a rigged model as a living, persistent agent body | Rigged GLB + name → persona id (continuity across sessions). |
| `get_agent_persona` | Reload a persona by id (continuity across sessions) | Persona id → saved persona (read-only). |
| `persona_say` | Speak a reply through a persona: lip-sync + emotion + gesture | Persona id + text → lip-sync, emotion, and gesture playback in the viewer. |

---

## 2. Compliance audit (item-by-item, each with a PASS verdict + evidence)

Original evidence is from the live production deployment on 2026-07-07; connectivity, annotations,
and the full generation pipeline were re-verified live on 2026-07-14. Raw artifacts are in
`_generated/` (`live-tools-list.json`, `openai-tool-evidence.txt`, `forge-raw-response.json`).

### 2.1 No crypto / token / wallet surface — **PASS**
The studio endpoint, its handlers, the widget, and every reviewer-facing surface contain **zero**
coin/token/wallet/x402/pump/aixbt/$THREE/payment strings.

```
$ grep -rInE 'coin|token|wallet|x402|pump|aixbt|\$THREE|crypto|solana|usdc|mint|payment|checkout|price|fee' \
    api/mcp-studio.js api/_mcp-studio/ | grep -vE ':[0-9]+:\s*(//|\*)'
  (no matches in executable code)

# Reviewer-facing JSON — hit counts:
live-tools-list.json        : 0 crypto/payment hits
studio-widget-resource.json : 0 crypto/payment hits
openai-tool-evidence.txt    : 0 crypto/payment hits
```
The only matches anywhere are in **source comments** that assert the absence (e.g. `// No coin, token,
wallet, or payment surface anywhere.`). The paid, crypto-enabled studio is a **separate** endpoint
(`/api/mcp-3d`) that is not part of this submission.

### 2.1a Review surface vs the platform's general discovery manifest — **PASS**
Per OpenAI's App Directory process, the reviewer scans the app's **MCP endpoint metadata** through the
plugin submission portal, and that discovered snapshot is what review evaluates (sources:
[App submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines),
[Prepare and maintain an app for submission](https://developers.openai.com/apps-sdk/deploy/submission)).
The app's review surface is therefore the keyless MCP connector at
`https://three.ws/api/mcp-studio`, which §2.1 shows is free of any coin/token/wallet/payment string, and
which `tests/mcp-studio.test.js` pins with a regex assertion in CI.

three.ws separately serves a **general-platform** discovery manifest at `/.well-known/ai-plugin.json`
(the legacy ChatGPT-plugins format, generated by `scripts/build-discovery-cards.mjs` and consumed by
third-party agents and crawlers). That manifest describes the broader three.ws platform, not this app,
and is **not** part of the Apps SDK review flow. To keep the app's own discovery story unambiguous, the
3D Studio app additionally ships a dedicated, served OpenAPI at
`https://three.ws/.well-known/3d-studio-openapi.yaml`, scoped to the app's entire free surface and
nothing else: `/api/3d/studio` (POST to generate + GET to poll) and `/api/ar` (GET, the
place-in-your-room launch behind every returned `arUrl`), with `security: []` (no auth) and no payment
fields. Every operation is `x-openai-isConsequential: false`; none of them charges anything. The schema
is verified crypto/payment-free by `tests/api/3d-studio-openapi.test.js`, which also binds it to the
real handler output, and the served copy is the source of truth: the custom-GPT Action file in this kit
is regenerated from it by `npm run sync:studio-openapi` and a drift between them fails
`npm run check:studio-openapi` (wired into `npm run gate`).

The general platform manifest was also cleaned up so it cannot be misread by anyone who does fetch it.
`ai-plugin.json` now leads with the free, keyless lane (`/api/3d/studio`, `/api/mcp-studio`, the viewer,
`/api/ar`, and the read-only market data endpoints, all under a "FREE and keyless, with no account, no
API key and nothing to pay" heading) and presents the pay-per-call catalog second, as separate and
optional. Its `logo_url` is the 512x512 owned-IP brand mark (`https://three.ws/pwa-512x512.png`, the
same asset as the app icon) instead of the favicon, and `legal_info_url` is the canonical
`https://three.ws/legal/tos` instead of the site root. The copy lives in
`scripts/lib/discovery-copy.mjs` (the manifest is regenerated on every prebuild, so a hand-edit would
not survive a deploy) and `tests/wellknown-manifests.test.js` pins the free-before-paid ordering, the
branded logo, the legal URL, and the generator/manifest agreement.

> Owner note: `ai-plugin.json` and the platform `openapi.yaml` under `/.well-known/` still describe the
> paid platform, which is a real product surface and stays. Nothing was removed from it: the change is
> ordering, framing, branding, and the legal URL.

### 2.2 No payments / no embedded checkout — **PASS**
`api/mcp-studio.js` header: *"There is no OAuth, no x402, no wallet, no token, and no PaymentRequired
anywhere in this server — generation runs operator-funded."* No tool returns a price, invoice, or
checkout; the app charges the user nothing. (If monetization is ever added, OpenAI allows only physical
goods via external checkout — out of scope here.)

### 2.3 Tool annotations correct on all eleven tools: **PASS**
Pulled from the live `tools/list` (re-pulled 2026-09-02):

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|------|:---:|:---:|:---:|:---:|
| forge_free | false | false | false | **true** |
| text_to_avatar | false | false | false | **true** |
| mesh_forge | false | false | false | **true** |
| rig_mesh | false | false | false | **true** |
| forge_avatar | false | false | false | **true** |
| refine_model | false | false | false | **true** |
| check_job | **true** | false | **true** | **true** |
| look_at_model | **true** | false | **true** | **true** |
| create_agent_persona | false | false | false | **true** |
| get_agent_persona | **true** | false | **true** | false |
| persona_say | false | false | false | false |

Rationale (matches OpenAI guidance): each generation tool **creates a new hosted asset** → not
read-only; it **never modifies or deletes** existing data → `destructiveHint: false` (generation is
non-destructive; `refine_model` creates a new version, the parent is preserved in the lineage); same
prompt yields a fresh mesh → not idempotent; generation runs against **external model APIs** →
`openWorldHint: true`. `check_job` only reads the state of a job already submitted → `readOnlyHint:
true`, `idempotentHint: true`, and it still polls the external provider → `openWorldHint: true`.
`look_at_model` draws pictures of a model that already exists and creates nothing → `readOnlyHint:
true`, `idempotentHint: true`, and it fetches a caller-supplied GLB from wherever it is hosted →
`openWorldHint: true`.
`get_agent_persona` and `persona_say` operate only on three.ws's own store → `openWorldHint: false`;
`create_agent_persona` fetches the caller-supplied GLB from wherever it is hosted before taking a
durable copy, so it keeps `openWorldHint: true`. `get_agent_persona` is a pure read →
`readOnlyHint: true`, `idempotentHint: true`. Every tool also carries the widget `_meta`
(`openai/outputTemplate`, `openai/widgetAccessible: true`) and human-readable `invoking`/`invoked`
labels.

### 2.4 Data minimization — **PASS** (real request/response captured)
Each tool response returns **only** what a client needs to show/download the model. The studio
**strips every internal identifier** from the raw generation record.

**Raw `/api/forge` response (14 fields, internal):**
```json
{"job_id":null,"creation_id":"7dac20c7-…","status":"done","glb_url":"…","durable":true,
 "mode":"text_to_3d","path":"image","tier":"draft","backend":"nvidia","prompt":"…",
 "preview_image_url":null,"reference_image_urls":[],"eta_seconds":13,"estimated_credits":null}
```
**Authentic studio tool response (5 fields — `openai-tool-evidence.txt`):**
```json
{"kind":"model",
 "glbUrl":"https://pub-…r2.dev/forge/anon/456f0f83-…-1d695f.glb",
 "viewerUrl":"https://three.ws/viewer?src=…",   // route live since 2026-07-14, returns 200
 "format":"glb",
 "prompt":"a small ceramic teapot with a bamboo handle, glossy celadon glaze"}
```
**Stripped:** `creation_id`, `job_id`, `status`, `mode`, `path`, `tier`, `backend`, `durable`,
`eta_seconds`, `estimated_credits`, `preview_image_url`, `reference_image_urls`. **No** session id,
trace id, user id, auth secret, or PII. `prompt` is the user's own input echoed back (labels the model).
The only identifier-shaped token is the generated asset's own **anonymous** content path
(`/forge/anon/<uuid>.glb`) — the public file URL the user needs to download it, not tied to any account
or session.

### 2.5 Inputs minimal — **PASS**
No chat-history or "just in case" fields; `additionalProperties: false` on every schema.

| Tool | Inputs | Required |
|------|--------|----------|
| forge_free | `prompt`, `tier` | `prompt` |
| text_to_avatar | `prompt`, `image_url` | — |
| mesh_forge | `prompt`, `image_url` | — |
| rig_mesh | `glb_url` | `glb_url` |
| forge_avatar | `prompt`, `image_url`, `allow_non_humanoid` | — |
| refine_model | `glb_url`, `instruction`, `parent_prompt`, `reference_image_url`, `parent_lineage`, `parent_index` | `glb_url`, `instruction` |
| check_job | `job_id` | `job_id` |
| look_at_model | `glb_url`, `views`, `size` | `glb_url` |
| create_agent_persona | `glb_url`, `name`, `voice`, `source_prompt` | `glb_url`, `name` |
| get_agent_persona | `persona_id` | `persona_id` |
| persona_say | `persona_id`, `text`, `emotion` | `persona_id`, `text` |

### 2.6 Age-appropriate (13–17) — **PASS** (safety gate present + live-tested)
A synchronous, dependency-free content-safety gate (`api/_mcp-studio/safety.js`) runs **before any
provider work** on every generation lane, refusing sexual/CSAM, graphic-gore, hate/extremism, and
real-weapon/drug prompts. Live-tested through the real handler:
```
forge_free({prompt:"a nude pornographic figure"})  →  refused in 1ms, no provider call:
  "This 3D Studio is rated for ages 13+ and cannot generate sexual or adult content.
   Try describing a character, creature, or object without explicit themes."
```
(Full response in `openai-tool-evidence.txt`.) The safety gate is **not** blocked by B1/B2 — it runs in
the handler, independent of the limiter and the viewer route.

### 2.7 Clear utility not native to ChatGPT — **PASS**
ChatGPT cannot natively turn language into a manipulable, downloadable 3D asset. The studio produces a
real **GLB** plus an inline interactive viewer (rotate / spin / recenter / download) — a capability, not
a chat completion. Value prop: *idea → textured, riggable, downloadable 3D model, free, without leaving
the conversation.*

**Audit result: 7/7 policy items PASS.** Both former infrastructure blockers (§0) are resolved and
re-verified live; nothing stands between this package and a submission.

---

## 3. MCP connectivity details (for the submission form + reviewer)

| Field | Value |
|-------|-------|
| **MCP server URL** | `https://three.ws/api/mcp-studio` |
| **Transport** | Streamable HTTP / JSON-RPC 2.0 over `POST` (synchronous responses; no server-initiated stream). `GET` → `405`. |
| **Protocol version** | `2025-06-18` (echoed on `initialize` and the `mcp-protocol-version` response header). |
| **serverInfo** | `{ "name": "three-ws-3d-studio-free", "version": "1.0.0" }` |
| **Capabilities** | `tools`, `resources`, `logging`. |
| **Auth mode** | **None** (anonymous, unauthenticated). No OAuth, no API key, no test credentials required. |
| **Widget resource** | `ui://widget/three-studio-model.html` (`resources/list` / `resources/read`), MIME `text/html+skybridge`. |
| **Rate limits** | Per-IP transport cap + per-IP generation burst/hourly + a platform-wide generation circuit breaker (operator-cost protection). A reviewer testing normally will not hit these. |

Because the app is anonymous and free, OpenAI's "provide a fully-featured demo account with test
credentials" requirement **does not apply** — there is no login. Note this explicitly in the form's auth
section.

---

## 4. Screenshots (`_generated/openai-screenshots/`)

All three show the interactive viewer widget rendering a **real, freshly generated** model with the
control bar (Download · Spin · Recenter · Open in three.ws).

| File | Dimensions | Content |
|------|-----------|---------|
| `three-ws-3d-studio-1440x1520.png` | 1440×1520 (portrait) | Hero — rigged avatar rendered inline (prompt 05). |
| `three-ws-3d-studio-widget-1600x1000.png` | 1600×1000 (landscape) | Shipped widget rendering a live-generated celadon teapot. |
| `three-ws-3d-studio-widget-1280x800.png` | 1280×800 (landscape) | Same, standard 16:10 landscape. |

The landscape shots must show the **shipped ChatGPT inline widget** (`api/_mcp-studio/component.js`,
resource `ui://widget/three-studio-model.html`) rendering the GLB produced by a real `forge_free` call
— not a standalone page and not a mockup.

**Status 2026-09-02 (task 07).** Two of the three sub-items are now resolved, one is blocked:

- **Resolved: no stale viewer references.** Nothing in the kit points at the retired
  `https://three.ws/apps-sdk/` viewer as "the widget". The only `apps-sdk/` strings left in
  `_generated/` are OpenAI's own developer-docs URLs and a repo source path, neither of which is a
  capture target.
- **Resolved: the capture harness works.** The shipped widget resource was driven end to end in a
  `window.openai`-less Chromium off a real live tool payload and reached its ready state with
  `<model-viewer>.loaded === true`, so a re-capture is a mechanical step, not an open question.
- **Blocked on B3 (§0): no submission-grade model to photograph.** The three generations run for this
  checklist returned, respectively, a flat slab, an untextured blob, and a recognizable cat carrying a
  baked-in ground plane and a floating backdrop panel. A screenshot is the single most scrutinized
  artifact in the listing and must not advertise the defect. **Re-capture once the B3 fix is deployed
  and a generation comes back clean.**

`[HUMAN: confirm the App Directory form's exact required screenshot dimensions and aspect ratio. The
current files are 1440x1520 portrait, 1600x1000 and 1280x800 landscape; only the portal states the
requirement, so this cannot be checked from here. The widget renders any GLB at any viewport, so
re-capturing to whatever the form asks for is trivial once B3 clears.]`

---

## 5. Reviewer testing guide

**No credentials needed** (anonymous, free). Full flow re-verified green against production 2026-07-14.

1. **Discover**: `initialize` → `tools/list` → `resources/list` against
   `https://three.ws/api/mcp-studio`. Expect 11 tools + two resources,
   `ui://widget/three-studio-model.html` (the inline 3D viewer) and
   `ui://widget/three-studio-persona.html` (the living agent body).
2. **Generate** a model that reliably succeeds — say to ChatGPT: *"Make a 3D model of a friendly round
   robot mascot, glossy white plastic."* Expect, in ~15–60s, an inline interactive 3D viewer with the
   model plus **Download / Spin / Recenter / Open in three.ws**.
3. **Expected render behavior:** the widget loads the GLB, frames it, casts a soft ground shadow, and
   auto-rotates until you drag. WebGL is required (the widget shows a graceful "download / open"
   fallback if the host can't render WebGL).
4. **Rig flow:** *"Now make me a rigged knight character I can animate"* → `forge_avatar` returns a
   rigged GLB (idle animation plays in the viewer).
5. **Safety check:** an explicit/adult prompt is refused instantly with an age-13+ message and never
   reaches a generator.

Copy-paste discovery smoke test:
```bash
curl -s -X POST https://three.ws/api/mcp-studio -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

---

## 6. Developer verification + support (all resolved 2026-07-14)

1. ~~Developer identity verification~~ — **DONE**: organization verified on platform.openai.com
   (confirmed by owner 2026-07-14); three.ws accepted into the OpenAI Partner Network 2026-07-14.
2. ~~Support contact~~ — **DONE**: `support@three.ws` + `https://three.ws/support` (live, 200).
3. ~~Privacy policy~~ — **DONE**: `https://three.ws/legal/privacy` live (200, verified 2026-07-14);
   the studio collects no personal data (anonymous, no login, identifier-free responses per §2.4).
4. ~~Post-fix smoke test~~ — **DONE 2026-07-14**: real `forge_free` generation returned a 1.45 MB GLB
   (`model/gltf-binary`, HTTP 200) in ~40s; its `viewerUrl` returned 200 with the exact generated GLB.

`[HUMAN: final submit through the OpenAI partner portal / App Directory flow — the only remaining step.]`

---

## 7. Pre-submit checklist

- [ ] **B3** open: the free lane can ship a degenerate slab as a top-confidence result (§0). Cheap-scorer
      fix is in the tree (`api/_lib/glb-quality.js`); **deploy it, then re-run a `forge_free` generation and
      confirm the returned GLB is a solid object** before submitting.
- [x] **B1** cleared: `tools/call forge_free` returns 200 with a GLB (re-verified live 2026-09-02: HTTP 200
      in 88s, real 2,256,144-byte GLB with `glTF` magic, `model/gltf-binary`; verbatim response saved to
      `_generated/live-call-forge_free.json`, which previously held only a stale rate-limit error).
- [x] **B2** cleared: `/viewer?src=<glb>` returns 200 and renders the model (re-verified live 2026-09-02:
      `<model-viewer>` reports `loaded === true` for the generated GLB, with no page errors).
- [x] Developer identity verified on platform.openai.com (verified organization, 2026-07-14).
- [x] Support contact + privacy policy confirmed live (2026-07-14); both legal URLs return 200 in the
      canonical no-`.html` form (`/legal/privacy`, `/legal/tos`), matching the served OpenAPI (2026-07-18).
- [x] Review surface is the MCP connector metadata, not `/.well-known/ai-plugin.json` (§2.1a, cited);
      live `initialize` + `tools/list` return `three-ws-3d-studio-free` on protocol `2025-06-18` with the
      exact 11-tool surface (re-verified live 2026-09-02).
- [x] App discovery schema served + guarded — `/.well-known/3d-studio-openapi.yaml`, free-only,
      `security: []`, byte-identical to the custom-GPT Action file, crypto/payment-free
      (`tests/api/3d-studio-openapi.test.js`).
- [x] Served discovery schema is live: `https://three.ws/.well-known/3d-studio-openapi.yaml` returns
      200 in production, as do `/.well-known/ai-plugin.json`, `/legal/privacy`, `/legal/tos` and
      `/support` (re-verified 2026-09-02).
- [ ] Screenshots: re-capture against the shipped inline widget (`api/_mcp-studio/component.js`).
      Verified 2026-09-02 that no evidence file still cites the retired `apps-sdk/` viewer, and that the
      widget drives correctly for capture. Held on B3: no generation clean enough to photograph yet (§4).
      Required dimensions still need the portal. `[HUMAN: confirm required dimensions]`
- [x] Inline widget re-verified live 2026-09-02 in a `window.openai`-less Chromium: the skybridge
      resource paints its empty state ("No model yet"), accepts a real tool payload over `postMessage`,
      shows the generating state, and reaches ready with `<model-viewer>.loaded === true` on the real
      generated GLB. Error state reached with an unresolvable GLB ("Couldn't load the model"). No console
      or page errors in any state.
- [x] `/api/ar` re-verified live 2026-09-02 per device class: Android UA gets a 302 to a Google Scene
      Viewer `intent://` URL with a `browser_fallback_url`; iOS and desktop UAs get the 200 launch page
      that carries the real `og:image`/`og:title` and hands off to `/ar/view`; `kind=avatar` adds the
      `irl=` hand-off and `/ar/view` renders its "Bring it to life" control; a bad `src` returns a
      designed 400 page ("Provide a valid https URL to a .glb model.").
- [x] Custom-GPT Actions lane re-verified live 2026-09-02: `POST /api/3d/studio` returned the documented
      pending shape in 15s, `GET ?job=&title=` polled to `done` with a real 2,922,332-byte GLB, and both
      responses validate against the served OpenAPI's own response schemas.
- [x] Compliance audit: 7/7 policy items PASS (§2), with the review-surface separation documented (§2.1a).
- [x] Listing metadata drafted (§1): tool list is the live 11-tool surface (re-pulled 2026-09-02);
      `forge_free` tier note corrected to the honest standard default (2026-07-18).
- [x] MCP connectivity documented (§3).
- [x] Reviewer guide written (§5).
- [ ] **Final submit in the portal.** `[HUMAN]`
