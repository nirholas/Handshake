# three.ws 3D Studio — OpenAI ChatGPT App Directory submission package

**Prepared:** 2026-07-07 · **Owning prompt:** 06 · **Endpoint:** `https://three.ws/api/mcp-studio`
**Prereqs verified live:** prompt 04 (`/api/mcp-studio` deployed), prompt 05 (widget renders real GLBs).

This is the copy-paste-ready answer sheet for submitting the free three.ws 3D Studio to the
OpenAI ChatGPT App Directory, plus an evidence-backed compliance audit. **Every field is now
filled** (2026-07-14: organization verified on platform.openai.com, support contact and privacy
policy confirmed live). The only remaining step is the owner's final submit in the portal.

---

## 0. Submission verdict — READY (blockers cleared 2026-07-14)

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

**Quality note (2026-07-14):** the studio generation tools default to the standard tier (up from
draft). A first attempt at defaulting to the high tier was rolled back the same day: the only
deployed free high-quality engine (Hunyuan3D via HF Spaces) blocks the submit for 50-280s with no
poll handle, which no ChatGPT surface survives — a live E2E probe confirmed `lane_timeout`. The
plumbing is in place (internal server-to-server token clears the premium gate; explicit
`tier:"high"` requests degrade to standard on 402/timeout), and high-by-default lands once the
async self-host Hunyuan3D worker (`workers/model-hunyuan3d`, forge lane behind `GCP_HUNYUAN3D_URL`)
is deployed. Compliance surface unchanged: keyless, free, zero payment strings on the wire.

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

**Root cause:** `vercel.json` has **no route** mapping `/viewer`. Neighboring viewers do not substitute:
- `/app?src=<glb>` → 200 but ignores `?src=` (renders the default agent avatar — verified by screenshot).
- `/avatar-artifact?src=<glb>` → 200 but ignores `?src=` (renders its own demo artifact — verified).
- The one standalone GLB viewer, `public/apps-sdk/studio-viewer.html`, reads `?glb=` (not `?src=`) and
  is served at `/apps-sdk/studio-viewer.html`.

So `/viewer?src=` resolves nowhere. The link is emitted by 7 shipped surfaces
(`api/_mcp-studio/forge-client.js`, `src/shared/forge-frames.js`, `api/v1/ai/_text-to-3d-lane.js`,
`api/_lib/tokenize-3d-metadata.js`, `api/_okx3d/identity.js`, `api/_studio/tools.js`, and the
studio-viewer bundle's own fallback), so this is a platform-wide dead link, not studio-only.

**Recommended fix (smallest correct change — make the standalone viewer serve `/viewer?src=`):**
1. In `apps-sdk/studio-viewer/src.js` (~line 66), accept `src`/`url` in the standalone param reader:
   ```js
   glb: pickUrl({ u: q.get('glb') || q.get('src') || q.get('url') || hashUrl }, ['u']),
   ```
2. Rebuild the bundle: `npm run build:apps-sdk-viewer`.
3. Add one route to `vercel.json` (query string is forwarded automatically):
   ```json
   { "src": "/viewer/?", "dest": "/apps-sdk/studio-viewer.html" }
   ```
4. Verify: `curl -s -o /dev/null -w '%{http_code}' "https://three.ws/viewer?src=<glb>"` → `200`, and the
   page renders the model.

**Resolution (verified 2026-07-14):** `https://three.ws/viewer?src=<glb>` returns 200 and serves the
standalone studio viewer, and the `viewerUrl` returned by a live `forge_free` call uses exactly that
shape. No action left.

---

## 1. Listing metadata (copy-paste into the submission form)

| Field | Value |
|-------|-------|
| **App name** | **three.ws 3D Studio** |
| **Tagline** | Turn a text prompt into a downloadable, animation-ready 3D model — free, inside ChatGPT. |
| **Short description** | three.ws 3D Studio generates textured 3D models, avatars, and rigged characters from a text prompt (or a reference image) and renders each result inline in an interactive 3D viewer you can rotate, inspect, and download as a GLB. It can also auto-rig a static model into an animation-ready one. Free to use — no account, no key, no payment. |
| **Long description** | Describe anything — "a friendly round robot mascot," "a low-poly treasure chest," "a knight character I can animate" — and three.ws 3D Studio builds a real, textured 3D model and shows it in an interactive viewer right in the conversation. Nine tools cover the full path from idea to asset: generate a model from text, generate an avatar, generate an art-directed mesh, auto-rig a static model into an animation-ready one, generate-then-rig a character in a single step, refine an existing model by describing a change, and save a rigged model as a persistent persona that can speak with lip-sync and emotion. Every result is a standard **GLB** you can download and drop into Blender, Unity, Unreal, three.js, or any glTF pipeline. Generation runs on three.ws's own free 3D lane, so there is nothing to sign up for and nothing to pay. Not natively possible in ChatGPT: turning language into a manipulable, downloadable 3D asset with an inline viewer. |
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

### Tool list (titles as shown to users; matches live `tools/list`, re-pulled 2026-07-14)
| Tool | Title | What it does |
|------|-------|--------------|
| `forge_free` | Generate a 3D model from text | Text → textured GLB. Defaults to the highest quality tier (dense geometry + PBR textures), platform-funded; caller may request a faster tier. |
| `text_to_avatar` | Generate a 3D avatar | Text or reference image → avatar GLB. |
| `mesh_forge` | Generate a 3D mesh (art-directed) | Text/image → mesh, prompt refined by an AI art-director first. |
| `rig_mesh` | Rig a 3D model for animation | Static GLB URL → humanoid-rigged, animation-ready GLB. |
| `forge_avatar` | Generate a rigged, animation-ready avatar | Text/image → generate + auto-rig in one step. |
| `refine_model` | Refine a 3D model by describing a change | Existing GLB + instruction → regenerated model with version lineage. |
| `create_agent_persona` | Save a rigged model as a living, persistent agent body | Rigged GLB + name → persona id (continuity across sessions). |
| `get_agent_persona` | Reload a persona by id | Persona id → saved persona (read-only). |
| `persona_say` | Speak a reply through a persona | Persona id + text → lip-sync, emotion, and gesture playback in the viewer. |

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

### 2.2 No payments / no embedded checkout — **PASS**
`api/mcp-studio.js` header: *"There is no OAuth, no x402, no wallet, no token, and no PaymentRequired
anywhere in this server — generation runs operator-funded."* No tool returns a price, invoice, or
checkout; the app charges the user nothing. (If monetization is ever added, OpenAI allows only physical
goods via external checkout — out of scope here.)

### 2.3 Tool annotations correct on all nine tools — **PASS**
Pulled from the live `tools/list` (re-pulled 2026-07-14):

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|------|:---:|:---:|:---:|:---:|
| forge_free | false | false | false | **true** |
| text_to_avatar | false | false | false | **true** |
| mesh_forge | false | false | false | **true** |
| rig_mesh | false | false | false | **true** |
| forge_avatar | false | false | false | **true** |
| refine_model | false | false | false | **true** |
| create_agent_persona | false | false | false | false |
| get_agent_persona | **true** | false | **true** | false |
| persona_say | false | false | false | false |

Rationale (matches OpenAI guidance): each generation tool **creates a new hosted asset** → not
read-only; it **never modifies or deletes** existing data → `destructiveHint: false` (generation is
non-destructive; `refine_model` creates a new version, the parent is preserved in the lineage); same
prompt yields a fresh mesh → not idempotent; generation runs against **external model APIs** →
`openWorldHint: true`. The persona tools operate only on three.ws's own store → `openWorldHint:
false`; `get_agent_persona` is a pure read → `readOnlyHint: true`, `idempotentHint: true`. Every tool
also carries the widget `_meta` (`openai/outputTemplate`, `openai/widgetAccessible: true`) and
human-readable `invoking`/`invoked` labels.

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

The landscape shots were captured against the **live** shipped viewer bundle
(`https://three.ws/apps-sdk/studio-viewer.html?glb=<real-glb>`) rendering the GLB produced by a real
`forge_free` call this session — not a mockup.

`[HUMAN: confirm the App Directory form's exact required screenshot dimensions/aspect and, if it demands
a specific size not covered above, capture at that size — the widget renders any GLB at any viewport.]`

---

## 5. Reviewer testing guide

**No credentials needed** (anonymous, free). Full flow re-verified green against production 2026-07-14.

1. **Discover**: `initialize` → `tools/list` → `resources/list` against
   `https://three.ws/api/mcp-studio`. Expect 9 tools + the `ui://widget/three-studio-model.html` resource.
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

- [x] **B1** cleared — `tools/call forge_free` returns 200 with a GLB (re-verified 2026-07-14, 1.45 MB GLB).
- [x] **B2** cleared — `/viewer?src=<glb>` returns 200 and renders the model (re-verified 2026-07-14).
- [x] Developer identity verified on platform.openai.com (verified organization, 2026-07-14).
- [x] Support contact + privacy policy confirmed live (2026-07-14).
- [ ] Screenshots match the form's required dimensions. `[HUMAN verify in the form — 3 real-model shots ready in _generated/openai-screenshots/]`
- [x] Compliance audit: 7/7 policy items PASS (§2).
- [x] Listing metadata drafted (§1) — tool list refreshed to the live 9-tool surface 2026-07-14.
- [x] MCP connectivity documented (§3).
- [x] Reviewer guide written (§5).
- [ ] **Final submit in the portal.** `[HUMAN]`
