# Text & Image to 3D (Forge)

This atlas entry traces the "Text/Image-to-3D (Forge)" cluster end-to-end from real source. Routes are resolved through `vercel.json` rewrites (not the default `pages/<route>.html` convention in every case).

Routing facts (from `vercel.json`):
- `/forge` → `pages/forge.html` (loads `src/forge.js` + 25 sibling `forge-*` modules).
- `/image-to-3d` → `pages/forge.html` (same app; lands with the photos tab preselected and its own document title; `?mode=image` on any forge URL does the same).
- `/forge-max` → `pages/forge.html` (same app; lands with the High tier pinned and "Forge Max" header copy; `?tier=draft|standard|high` presets the selector on any forge URL).
- `/forge/share/<id>` → `api/forge-share.js` (SSR page that bakes OG/Twitter/Farcaster preview meta for crawlers, then JS-redirects browsers to `/forge?share=<id>`, which opens the creation in the viewer).
- `/features/forge` → `pages/features/forge.html` (static marketing landing, no app module).
- `/create/prompt` → `pages/create-prompt.html` → `src/create-prompt.js` (text → **rigged avatar**, a different backend from Forge).
- `/tutorials/text-to-3d` and `/tutorials/image-to-3d` → `pages/tutorial.html` (one shared template) which `fetch`es `/docs/tutorials/<slug>.md` and renders it with marked.js. Read-only content pages.

---

### Forge (Text / Photos / Sketch → 3D) — `/forge`

- **Source:**
  - `pages/forge.html` (~4200 lines: full composer/stage markup + styles)
  - `src/forge.js` (~3300 lines: main controller, catalog, engine/tier selection, job submit, polling, result, gating; imports `src/forge-timeline.js` for the generation stage timeline and `src/forge-compare.js` for side-by-side compare)
  - `src/forge-prompt-studio.js` (Surprise-me + prompt coach; prompts come from the slot-grammar generator `src/forge-prompt-gen.js`), `src/forge-enhance.js` (AI prompt rewrite → `/api/forge-enhance`), `src/forge-directed-prompt.js` (reveals the server's art-director rewrite from the `directed_prompt` response field)
  - `src/forge-dropzone.js` (paste/drop image handling), `src/forge-reveal.js` (WebGL "materialize" dissolve overlay), `src/forge-wait.js` (rotating craft tips while generating)
  - `src/forge-refine.js` (in-browser geometry refine, no API), `src/forge-stylize.js` (→ `/api/forge-stylize`), `src/forge-optimize.js` (→ `/api/forge-remesh`), `src/forge-gameready.js` (→ `/api/forge-gameready`)
  - `src/forge-rig.js` (auto-rig → `POST /api/forge?action=rig`), `src/forge-materials.js` (PBR material restyle → `POST /api/material-studio?action=restyle`), `src/forge-conversational-refine.js` (free-text shape iteration → `POST /api/forge-iterate`), `src/forge-more-like-this.js` (one-tap material/finish variation chips), `src/forge-segment.js`
  - `src/forge-export.js` (in-browser OBJ/STL/PLY/USDZ export), `src/forge-reel.js` (client-side looping video + hero still + transparent-PNG cutout capture), `src/forge-embed-panel.js`, `src/forge-ar.js`, `src/forge-showcase.js` (community feed with upvotes)
  - `src/forge-pay.js` (pay-per-generation $THREE rail → `src/token-pay.js` → `/api/token/quote|settle`)
- **Entry point:** Direct nav to `/forge`, `/image-to-3d` (photo tab preselected), or `/forge-max` (High tier pinned); CTAs from `/features/forge` ("Open Forge →"), the two tutorial pages, blog `text-to-3d-is-live`, gallery, and the `/forge` empty-state idle viewer. Also reachable as the "make an object/prop" alternative linked from `/create/prompt`.
- **Prerequisites / gates:**
  - **None for the default lane.** Draft/Standard tiers on the free NVIDIA-hosted engine require no auth, no wallet, no payment ("No account required for your first model").
  - **BYOK engines** (Fast, Meshy, Tripo, Rodin, Stability, Replicate) require the user to paste their own provider API key (kept in-browser, sent as `x-forge-provider-key` header).
  - **High quality tier** is gated: it is a `$THREE` holder perk (hold-OR-pay). A holder clears it with a tier pass (`attachTierPass`); a non-holder gets a `402 three_hold_required` and may **pay-per-generation in $THREE** via `forge-pay.js`, or hold $THREE. BYOK High is server-exempt (no pass needed). A server-side comp allowlist (`api/_lib/comp-access.js`, wired into `requireFeatureAccess` and `GET /api/three/access`) clears an allowlisted account through every $THREE gate (`forge.high`, `forge.gameready`, and any gate added later) with no holding, wallet, or payment.
  - Rate limiting applies on the paid lane (server-side, surfaced as a recoverable `429` state).
- **Steps (core text→3D path):**
  1. User lands on `/forge`; `forge.js` fetches the engine/tier catalog (`GET /api/forge?catalog=1`) and live backend health (`GET /api/forge?health=1`), then builds the tier buttons (Draft/Standard/High) and the per-mode engine selector. The empty stage (`#state-empty`) shows an idle community/sample model.
  2. Mode tab defaults to **Describe it** (text). Tabs: *Describe it*, *From photos*, *From a sketch* (the sketch tab stays `hidden` until the catalog reports a live TripoSG sketch engine).
  3. **(text)** User types a prompt in `#prompt` (max 1000 chars). Live: a character counter, a prompt **coach** grading the prompt (tip/warn/strong, from `forge-prompt-studio.js`), and example chips with a "↻ More ideas" swap. The static chip labels in `forge.html` are written at the generator's 64-character cap ("a low-poly red fox sitting upright, matte fur, soft studio light", etc.) and carry no `data-i18n`; on every JS visit `forge-prompt-studio.js` swaps them for generated prompts (`generateForgeChipSet`) whose combined width never exceeds the labels they replace, so the flex-wrapped row cannot gain a line and shift the page.
  4. (optional) User clicks **Surprise me** to fill a random vivid prompt, or **Enhance** (injected by `forge-enhance.js`) to rewrite their text via `POST /api/forge-enhance` into a sharper single-subject FLUX→TRELLIS prompt.
  5. (optional) User picks a **Quality tier** (Draft / Standard / High). Selecting High while locked reveals the in-place lock panel + holder note linking to `/three`; a wallet-aware perk line / "Connect wallet" chip may appear under Generate.
  6. (optional) User picks an **Engine**. Engines are filtered by mode (text/photo/sketch input). BYOK engines show a key glyph; choosing one reveals the `#byok-row` API-key input with a provider-specific hint. Health-degraded engines show an amber dot; down/unconfigured ones show a red dot, are disabled, and carry the reason in the tooltip; a legend under the picker decodes both dots and the FREE/key pills.
  7. (optional) User sets the reference-image **aspect ratio** (1:1 / 4:3 / 3:4 / 16:9) — shown only when relevant to the mode/engine. A live **estimate** line (`#estimate`) shows the catalog's real cost/time for the current tier+engine.
  8. User clicks **Generate** (or ⌘/Ctrl+Enter). `collectComposerCfg()` validates (text ≥ 3 chars). If High is locked and submitted via keyboard, the gate/upsell opens instead of firing.
  9. `startJob()` `POST`s to `/api/forge` with `{ prompt, aspect_ratio, path, tier, backend }` plus headers (client id, BYOK key if any, $THREE tier pass if eligible/needed — minted/awaited before the request when `highTierNeedsPass()`). Stage switches to `#state-generating`.
  10. **Generating state**: a named stage timeline (`#gen-stages`, rendered by `forge-timeline.js`) animates; every row and state change is driven by a real `/api/forge` signal, so the lane decides which stages exist (a no-reference-image engine never shows one). Below it: an honest elapsed-vs-typical progress bar (asymptotic, never fakes 100%, recolors amber past the catalog ETA), a "feel free to leave this page" hint, and a **Cancel** button. When the API reports `cold_start` for a scale-to-zero self-hosted GPU lane, a "Waking up a GPU" warming card appears and is dismissed by the first real running poll, never by a timer (a keep-warm cron, `/api/cron/gpu-keepwarm`, holds allowlisted GPU workers open during peak hours). While waiting, `forge-wait.js` rotates curated craft tips. When the submit response returns a `preview_image_url`, the reference image paints into the preview pane.
  11. If the engine is the synchronous free draft lane, the POST returns the finished `glb_url` directly; otherwise `forge.js` polls `GET /api/forge?job=<id>` every interval until `status:"done"` (with `glb_url`), `failed`, or timeout.
  12. On done: `showResult()` sets the `<model-viewer src>`, plays the WebGL **materialize** reveal (`forge-reveal.js`, skipped under reduced-motion), shows the result bar, wires the **Download GLB** anchor, and (if `creation_id`) shows a "Saved ✓" auto-save chip. Geometry-first/sketch results with no reference image get a captured **poster** frame (`POST /api/forge-poster`).
  13. (optional) User rates the model: **👍 Keep / 👎 Discard** (verdict) → `POST /api/forge-feedback`; or tags a category (Avatar/Creature/Item/Accessory/Scene/Vehicle) → `POST /api/forge-categorize`. (Data flywheel.)
  14. (optional) **Refine → <next tier>** — re-runs the exact same prompt/views one quality tier higher (re-enters step 9). Shown only when a higher tier exists and the job is re-runnable.
  15. (optional) **Refine** panel (`forge-refine.js`) — instant in-browser geometry passes (weld/smooth/relax/decimate/subdivide), non-destructive, no API call, no rate limit. Download the refined GLB.
  16. (optional) **Iterate** (`forge-conversational-refine.js`): a free-text instruction against the model on screen ("make the helmet red", "add a cape") via `POST /api/forge-iterate` (polled). The only post-result action that changes the model's shape from natural language; same core as the MCP `refine_model` tool.
  17. (optional) **Stylize** (`forge-stylize.js`): voxels/bricks/lattice/low-poly geometric filters via `POST /api/forge-stylize` (worker job, polled), with a resolution slider, download, and revert.
  18. (optional) **Restyle materials** (`forge-materials.js`): free-text or preset-chip PBR re-skin (chrome, brushed gold, weathered wood, ...) via synchronous `POST /api/material-studio?action=restyle`; geometry untouched. Same pipeline as the paid `restyle_material` MCP tool.
  19. (optional) **Rig for animation** (`forge-rig.js`): adds a humanoid skeleton + skin weights to the current GLB via `POST /api/forge?action=rig` (the self-hosted GCP model-rig worker, falling back to the configured Replicate rerig model), polled through the same `GET /api/forge?job=` contract.
  20. (optional) **Optimize topology** (`forge-optimize.js`): tri/quad/low-poly remesh via `POST /api/forge-remesh` (polled).
  21. (optional) **Game-Ready** (`forge-gameready.js`): retopologize to a poly budget and export a textured GLB + FBX for Unity/Unreal via `POST /api/forge-gameready` (polled), with budget slider + wireframe preview. Gated on the same $THREE hold-or-pay model as High tier: the panel resolves the viewer's real entitlement first (a signed-in holding or a connected wallet, via `getAccess`/`attachTierPass`), a verified holder exports free, and a non-holder gets a server-quoted pay-per-export price in $THREE.
  22. (optional) **Split into parts** → links to `/segment?mesh=<glb>` (Parts Studio). **Compose** → `/compose?glb=<glb>` (Scene Composer / attach to avatar). **Place IRL** → `/irl?avatar=<glb>` (anchor the model in a real room).
  23. (optional) **Export** (`forge-export.js`): in-browser convert to OBJ / STL / PLY / USDZ (lazy three.js exporters, no upload).
  24. (optional) **Reel** (`forge-reel.js`): fully client-side cinematic capture of the model into a looping video (MP4 or WebM), a hero still, and a transparent-PNG cutout; no upload, no worker.
  25. (optional) **Embed** (`forge-embed-panel.js`): generate an embeddable web-component snippet for the model.
  26. (optional) **View in AR** (`forge-ar.js`) / model-viewer's `ar` (webxr/scene-viewer/quick-look): place the model in the room. The AR panel also links to the multi-model **AR Studio** (`/ar/studio?src=<glb>`).
  27. (optional) **Share** → `forge-share-btn`: when the creation was persisted server-side it shares a real permalink, `/forge/share/<id>`, that unfurls with a preview card; otherwise it falls back to a remix link (`/forge?prompt=`). **Cinema** mode (fullscreen turntable for screen recording, F/Esc). **More like this** (`forge-more-like-this.js`): one-tap chips that re-run the same subject with a different material/finish via the `forge:run-prompt` event (text results only).
  28. User clicks **Download GLB**: the anchor fetches + "stamps" the GLB (`#download[data-stamping]`), reports `downloaded:true` feedback, and saves the file. **OR** clicks **Make another** to reset to the idle composer.
- **Photo / multi-view branch (steps 3-11 differ):** "From photos" tab shows up to 6 view slots (Front/Back/Left/Right/Top/3-4) with a live "N of 6 views" counter + pips. Each photo is uploaded via presign `POST /api/forge-upload` → `PUT` to object storage; the public URL is recorded. Drag-to-reorder, paste (⌘V/Ctrl+V), drop, or click-to-browse (PNG/JPG/WebP, ≤8MB). An optional guidance prompt is allowed. Submit posts `{ image_urls, prompt?, ... }`. A server-side **vision pre-check** can reject an unusable photo (`422 image_not_usable`) → recoverable "Generate anyway" override.
- **Sketch branch:** "From a sketch" tab (only when a live sketch engine exists) takes one drawing + a **required** description; outputs untextured geometry (user is told to Stylize/Retexture after).
- **Decision points / branches:**
  - Mode: text vs photos vs sketch (gates which engines/inputs are valid).
  - Tier: Draft/Standard (free) vs High ($THREE hold-or-pay or BYOK-exempt).
  - Engine: free NVIDIA lane vs BYOK engines (reveals key field; text-only engines disabled when photos are attached).
  - High gate resolution: hold $THREE (tier pass) → pay-per-generation ($THREE via `forge-pay.js`) → drop to Draft/Standard.
  - Sync draft (POST returns done) vs async poll loop.
  - Post-result fork: Refine-tier / Refine-local / Iterate / Stylize / Restyle-materials / Rig / Optimize / Game-Ready / Export / Reel / Embed / AR / Place-IRL / Share / More-like-this / Compose / Segment / Download / Make another.
  - Gallery: side-by-side **Compare** mode (`forge-compare.js`) when the same prompt was forged on 2+ engines; showcase cards are upvotable (auth-free, one vote per browser; the Forge-Off board) with a latest / top-this-week sort.
- **External calls / dependencies:**
  - Catalog/health: `GET /api/forge?catalog=1`, `GET /api/forge?health=1`
  - Submit/poll: `POST /api/forge`, `GET /api/forge?job=<id>`
  - Uploads: `POST /api/forge-upload` (presign) + `PUT` object storage
  - Flywheel: `POST /api/forge-feedback`, `POST /api/forge-categorize`, `POST /api/forge-poster`
  - Galleries: `GET /api/forge-gallery?limit=24` (your creations), `GET /api/forge-gallery?scope=community&limit=24` (showcase, plus `&sort=` for the Forge-Off board), `POST /api/forge-vote` (showcase upvotes), `GET /api/forge-creation?id=` (share open), `DELETE /api/forge-creation?id=` (each "Your creations" card carries a two-tap arm-then-confirm delete, scoped to the owning `x-forge-client`; it erases the stored GLB, preview, and every recorded source photo upload, so an image-to-3D run's reference pictures leave object storage with it)
  - Post-processing jobs: `POST /api/forge-stylize`, `POST /api/forge-remesh`, `POST /api/forge-gameready`, `POST /api/forge-enhance`, `POST /api/forge-iterate` (all polled by `?job=`); `POST /api/forge?action=rig` (auto-rig, polled by `GET /api/forge?job=`); `POST /api/material-studio?action=restyle` (synchronous)
  - Payment: `forge-pay.js` → `src/token-pay.js` → `/api/token/quote` + `/api/token/settle` ($THREE)
  - Access/tier pass: `/api/three/access` (read) + tier-pass mint (referenced via `attachTierPass`/`getTierPass`)
  - Generation engines: FLUX (image) → TRELLIS (mesh) free lane; BYOK Meshy / Tripo / Rodin / Stability / Replicate; Hunyuan3D / TripoSG (sketch). Hosted on NVIDIA NIM / providers; same pipeline exposed to agents over MCP at `/api/mcp-3d`.
  - **Photoreal reference-image path (the realism lever):** the final mesh reads as real only if the reference image the reconstructor sees is a photoreal, single-subject, plain-seamless-background, evenly-lit photograph. Two pieces drive that:
    - `POST /api/forge-enhance` (director): rewrites the raw prompt into one centered real-world subject with material + surface micro-detail + neutral studio-lighting cues. It classifies the subject (person / animal / vehicle / food / object) and returns a `subject`-aware `negative_prompt` targeting that class's failure modes (hands/faces for people, wheel-count/panel symmetry for vehicles, plastic-replica sheen for food). It prefers a Vertex Gemini rewrite (GCP credits) and falls through to the free-first LLM chain automatically, so it never hard-depends on Vertex. Response schema is unchanged apart from the additive `subject` field.
    - `api/_lib/forge-reference-image.js` → `generateReferenceImage(directedPrompt, { aspectRatio, negativePrompt?, seed, skipNim })`: generates the reconstruction reference image on the Vertex Gemini 2.5 Flash Image lane (`imageConfig.imageSize:"2K"`), tuned as a plain-background studio photo, with the director's negatives folded in as natural-language avoidance. Automatic fallthrough to the existing provider chain (`textToImage`: NIM FLUX free → Vertex Imagen → Replicate), returning `{ imageUrl, model, lane }` (generated base64 output is persisted through the shared `image-persist` lib). The same directed prompt + aspect + negatives within 24h reuses its cached reference set instead of re-spending a Vertex generation. When `negativePrompt` is omitted it derives subject-aware negatives from the prompt itself, so a caller gets them for free. `api/forge.js` imports it on the text→3D path (dynamic import with `textToImage` as the fallback). The whole reference step (the Vertex lane, its QA score and corrective retry, and the fallthrough ladder) runs under one shared budget, `TEXT_TO_IMAGE_BUDGET_MS` (default 60 s), so a stalled image provider can no longer hold a submit open for minutes before a job exists. Separately from the client-side Enhance button, `api/forge.js` runs its own art-director rewrite on every text prompt by default (send `director: false` to skip it; it fails soft to the raw prompt).
  - 3rd-party viewer: model-viewer 4.0.0 (googleapis CDN).
- **Success state:** A textured **GLB** standing in the in-page `<model-viewer>` (orbit/AR), auto-saved to "Your creations", with a downloadable file and all post-processing/export/embed/share actions enabled. Optional converted formats (OBJ/STL/PLY/USDZ/FBX) and a community showcase entry.
- **Empty / error states:**
  - **Empty/idle** (`#state-empty`): isometric wireframe art + "Enter a prompt to generate", with a live sample/community model in the viewer.
  - **Unconfigured** (`#state-unconfigured`): only for the `unconfigured` error (no 3D engine reachable: none of `NVIDIA_API_KEY`, `HF_TOKEN`, or `REPLICATE_API_TOKEN` set); it names the env vars to set and offers no retry.
  - **Generation failed** (`#state-error`): generic failure with "Try again", plus contextual recovery buttons: "Refine current model instead" (rate-limited fallback), "Generate anyway" (vision override).
  - BYOK errors: `needs_key` / `invalid_key` reveal + focus the key field; `insufficient_credits` explains provider is out of credits.
  - `429`/limiter-unavailable, and any other `503` (`generation_unavailable`: a worker still warming or a free lane that shed the request): the recoverable countdown state carrying the server's own message and `retry_after` (20 s when absent) + local-refine escape hatch.
  - High gate `402 three_hold_required`: designed upsell (held vs required, Get $THREE, Pay-per-use).
  - Payment errors: `payment_invalid` / `payment_expired` re-offer Pay; `payment_already_used` clears the stale proof; a settle call that cannot be reached after the $THREE transfer already confirmed surfaces `settle_unreachable` with the transaction signature, so the payment is reconciled rather than sent twice.
  - Upload errors: per-slot states (503 uploads unavailable, 429 rate-limited, too-large/empty/wrong-type, network).
  - Viewer load failure: `#viewer-load-error` overlay → "use the download button to save the file directly".
- **Step count:** ~12 required (text path, entry → download) + ~16 optional (surprise/enhance, tier/engine/aspect choices, refine-tier, refine-local, iterate, stylize, restyle-materials, rig, optimize, game-ready, export, reel, embed, AR, share/cinema/compare/compose/segment/verdict/category).

---

### Forge marketing landing — `/features/forge`

- **Source:** `pages/features/forge.html` (static; no app JS module — only nav/footer + an inline FAQ accordion script and model-viewer for the hero sample). Stylesheets: `features-landing.css`.
- **Entry point:** `/features` index, SEO/search, social cards.
- **Prerequisites / gates:** None — read-only marketing page.
- **Steps (3):**
  1. User reads the hero ("Type a description. Get a 3D model." — Flux + TRELLIS) and orbits the sample GLB (`/animations/robotexpressive.glb`) in the hero model-viewer.
  2. User reads the "Three steps from prompt to model" how-it-works, the highlight cards (AR inspection, agent avatar, shareable link, data flywheel), and expands FAQ items (inline `aria-expanded` toggle script).
  3. User clicks **Open Forge →** (to `/forge`) or **Try Scan instead** (`/features/scan`).
- **Decision points / branches:** Open Forge vs Try Scan vs All features; FAQ expand/collapse.
- **External calls / dependencies:** model-viewer CDN only. No API calls. (FAQ schema mentions Flux + TRELLIS; advertises GLB output and commercial-use rights.)
- **Success state:** User navigates into `/forge`.
- **Empty / error states:** None (static content). FAQ items collapsed by default.
- **Step count:** 3 required (read + click through) + 0 optional (FAQ expansion is incidental).

---

### Describe it to 3D (prompt → rigged avatar) — `/create/prompt`

- **Source:** `pages/create-prompt.html` + `src/create-prompt.js`. The page has a real light theme (`:root[data-theme='light']`) with AA-contrast secondary copy in both themes. **Overlap note:** this is the **onboarding/avatar-creation** cluster, not Forge. It shares the same conceptual "type a prompt → 3D" pattern but uses an entirely **different backend**: the selfie/avatar reconstruction + auto-rig pipeline, not the Forge engine catalog. It explicitly cross-links to `/forge` for "making an object, prop, or scene piece instead of a character." Entry points include `/create`, `/create-agent`, dashboard avatars/agents pages, and the gallery.
- **Entry point:** From `/create` (and `create.js`), the create-agent flow, dashboard, and gallery "make one" CTAs.
- **Prerequisites / gates:** **Sign-in required** ("Sign-in required" chip). A `401` on submit or poll redirects to `/login?next=/create/prompt?prompt=<typed prompt>`, so the words already typed come back with the user. No wallet / no $THREE gate. Avatars default to `private` visibility.
- **Steps (3 stages):**
  1. **Compose:** User types a single-subject character description in `#prompt` (max 600; counter; Generate disabled under 3 chars). Optional example chips fill the box. A `?prompt=` query param pre-fills the composer (remix/copy-prompt deep links; nothing auto-submits). Hint: "Single subject, full body works best." Cross-link offered to `/forge` for objects.
  2. User clicks **Generate avatar** (or ⌘/Ctrl+Enter). `start()` POSTs `/api/avatars/reconstruct` `{ name (derived from prompt), prompt, visibility:'private' }`. UI switches to the **Building** stage (spinning orb).
  3. **Building:** Live phased progress — *Rendering a reference image…* (Flux) → *Reconstructing it into 3D…* → *Adding a skeleton so it can move…* — with an elapsed clock. Polls `GET /api/avatars/regenerate-status?jobId=` every 3s (up to 8 min).
  4. **Done:** On `status:"done"` + `resultAvatarId`, fetches `GET /api/avatars/<id>`, previews the rigged GLB in the done model-viewer, shows tags (Animation-ready / Static mesh — riggable / Private to you). CTAs: **Open in editor** (`/avatars/<id>/edit`) and **Make another**. If no model URL yet, it redirects straight to the editor.
- **Decision points / branches:** Signed-in vs not (login redirect); rigged vs static-mesh tag; open editor vs make another; (offered) divert to `/forge` for non-characters.
- **External calls / dependencies:** `POST /api/avatars/reconstruct`, `GET /api/avatars/regenerate-status?jobId=`, `GET /api/avatars/<id>`. Flux text→image + reconstruct + auto-rig backend (shared with the selfie pipeline). model-viewer CDN. Dispatches `tws:feature-done` for the site discovery layer.
- **Success state:** A **rigged GLB avatar** saved to the user's account, previewed, ready to open in the avatar editor.
- **Empty / error states:** Compose inline error ("Add a few words…"). Build error box with friendly mappings: rate-limited (`txt2img_rate_limited`/429), unconfigured (`regen_unconfigured`/`txt2img_unconfigured` → suggests `/create/selfie`), provider billing, unreachable, render error, no-face-detected, NSFW-blocked, timeout, OOM; plus a "Back" recovery button. Each failure carries a `retryable` flag that decides which recovery buttons render: a full avatar library (`402`/`plan_limit`, also detected when a job loses the race mid-build) drops "Try again" and links to `/dashboard` (delete one) and `/pricing` (upgrade); an unconfigured engine drops it too; a `429` quotes the server's `Retry-After` and holds the retry button for exactly that long. On failure the orb, progress bar and phase line freeze and Cancel goes away; the error box (`role="alert"`) is the only live control. Cancel stays live for the whole building step, and every run holds a monotonic token so a cancelled build can never paint its late result over a newer one. Poll timeout message points the user to their dashboard.
- **Step count:** 3 required (compose → generate → done) + 1 optional (pick an example chip) — excludes downstream editor actions.

---

### Tutorial · Text Prompt to 3D Model — `/tutorials/text-to-3d`

- **Source:** `pages/tutorial.html` (shared template, renders any `/tutorials/<slug>`) + content `docs/tutorials/text-to-3d.md`. Slug resolved client-side, markdown fetched from `/docs/tutorials/text-to-3d.md`, rendered with marked.js + highlight.js. Metadata/preview model come from `/tutorials-manifest.js` (`window.TUTORIALS`). The template also loads `/live-steps.js` (runnable ```` ```live ```` blocks: real API calls rendered inline) and `/tutorial-figures.js` (resolves `figure:` directives in the markdown into captured media, live 3D viewers, and a keyboard-navigable lightbox). Relative links in the markdown resolve against `docs/tutorials/<slug>.md`: sibling tutorials go to `/tutorials/<slug>`, other docs to `/docs/<name>` (with `#section` preserved), and repo-only docs (`docs/internal`, `docs/ops`, `docs/security`) or cited source files open on GitHub.
- **Entry point:** `/tutorials` index, `/docs`, in-Forge "/docs" hint, blog, search, and cross-links from the image-to-3d and prompts-for-3d tutorials.
- **Prerequisites / gates:** None — read-only content page. (The tutorial itself states: "no account, no wallet, no code.")
- **Steps (read-only content page):**
  1. Read intro + hero; orbit the interactive preview model (`<model-viewer>` injected from the manifest's `previewModel`).
  2. Read the 6 tutorial steps: **Step 1** Open the Forge → **Step 2** Describe the object → **Step 3** Pick a quality tier → **Step 4** Generate → **Step 5** Inspect your model → **Step 6** Download or share it; plus "Didn't get what you wanted?" troubleshooting and "What's next".
  3. (optional) Use the auto-generated heading anchors / table of contents; follow inline links to `/forge`, `/tutorials/image-to-3d`, `/tutorials/prompts-for-3d`.
  4. (optional) Use the prev/next pager (built from `window.TUTORIALS`) to move between tutorials.
- **Decision points / branches:** Navigate to `/forge` to actually do it, or to adjacent tutorials via inline links / pager.
- **External calls / dependencies:** `GET /docs/tutorials/text-to-3d.md`; marked.js + highlight.js CDNs; model-viewer CDN; `/tutorials-manifest.js`; `/api/page-og` (OG image only).
- **Success state:** User understands the text→3D flow (content consumed); typically clicks through to `/forge`.
- **Empty / error states:** Template handles a missing/invalid slug (no entry → redirect/empty handling in `tutorial.html`); a failed markdown fetch leaves the article empty. No interactive failure modes.
- **Step count:** 2 required (read content + follow the embedded steps) + 2 optional (TOC anchors, prev/next pager / cross-links). Content covers 6 in-doc instructional steps.

---

### Tutorial · Photos to 3D Model — `/tutorials/image-to-3d`

- **Source:** `pages/tutorial.html` (same shared template) + content `docs/tutorials/image-to-3d.md`, fetched from `/docs/tutorials/image-to-3d.md`.
- **Entry point:** `/tutorials` index, the text-to-3d tutorial's "What's next", Forge photo-mode help, search.
- **Prerequisites / gates:** None — read-only content page ("A phone camera is plenty.").
- **Steps (read-only content page):**
  1. Read intro + orbit the manifest preview model.
  2. Read the 5 tutorial steps: **Step 1** Take good photos (1 object, plain bg, even light, fill frame, 4 angles) → **Step 2** Open the Forge in photo mode → **Step 3** Add guidance (optional) → **Step 4** Pick a tier and generate → **Step 5** Inspect, download, share; plus Troubleshooting and "What's next".
  3. (optional) Follow inline links to `/forge` and adjacent tutorials; use the pager.
- **Decision points / branches:** Go to `/forge` (From photos tab) to execute; navigate to adjacent tutorials.
- **External calls / dependencies:** `GET /docs/tutorials/image-to-3d.md`; marked.js + highlight.js + model-viewer CDNs; `/tutorials-manifest.js`; `/api/page-og`.
- **Success state:** User understands the photo/multi-view→3D flow; clicks through to `/forge` photo mode.
- **Empty / error states:** Same template-level handling as the text-to-3d tutorial (missing slug, failed md fetch). No interactive failure modes.
- **Step count:** 2 required (read + follow embedded steps) + 2 optional (anchors, pager / cross-links). Content covers 5 in-doc instructional steps.

---

## Notes

- All five routes' sources were located and traced from real code. No missing sources.
- `/create/prompt` is included here because it overlaps the "type a prompt → 3D" pattern, but it belongs to the **onboarding/avatar** cluster and uses the **avatar reconstruct + auto-rig** backend (`/api/avatars/*`), distinct from Forge's `/api/forge` engine catalog. It is the one route in this cluster that is auth-gated.
- `/features/forge` is pure marketing (no app module); the two tutorials are read-only markdown rendered by one shared `tutorial.html` template.
