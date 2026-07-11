# Troubleshooting & FAQ

Organized by symptom. Find your problem, check the likely causes, follow the fix steps.

---

## 1. Model Loading Issues

### The 3D model doesn't appear (blank canvas)

**Symptom:** The `<agent-3d>` element renders but the canvas is empty or stays on the loading poster.

**Likely causes:**
- Network error fetching the GLB
- CORS headers missing on the GLB host
- File too large for the browser to parse in time
- Wrong file format

**Fix steps:**

1. Open DevTools → Console (F12). Look for red errors — a failed fetch or a Three.js parse error will be logged there.
2. Open DevTools → Network. Find the GLB request. Check the HTTP status code:
   - `404` — the URL is wrong. Verify `src` attribute.
   - `403` / `401` — access is blocked. Make the file publicly readable.
   - `200` with a CORS error in Console — see the CORS section below.
3. Paste the GLB URL directly into a new browser tab. If it downloads or previews, the URL is valid.
4. Check file size. Models over ~100 MB can cause timeouts on slow connections. Compress with Draco (5–10× mesh size reduction). See "Model loads slowly" under Performance.
5. Verify the format. Only **glTF 2.0** (`.glb` or `.gltf`) is supported. glTF 1.0, OBJ, FBX, and USDZ are not. If you're exporting from Blender, use File → Export → glTF 2.0 with "Format: GLB".

---

### "CORS error" in the console

**Symptom:** Console shows `Access to fetch at '...' has been blocked by CORS policy`.

**Likely causes:**
- The server hosting the GLB doesn't send CORS response headers.

**Fix steps:**

1. Add `Access-Control-Allow-Origin: *` to the response headers on the server that hosts your GLB. How to do this depends on your host:
   - **Nginx:** `add_header Access-Control-Allow-Origin *;` in the `location` block.
   - **Apache:** `Header set Access-Control-Allow-Origin "*"` in `.htaccess`.
   - **AWS S3 / CloudFront:** Set a CORS policy on the bucket (allow all origins, GET method).
   - **Vercel / Netlify:** Add a `headers` rule in the config file.
2. If you can't modify the server, re-host the file somewhere that sends CORS headers: the platform's hosted storage (uploads via the Studio are CORS-configured automatically), or any CDN/bucket with a permissive CORS rule (Cloudflare R2, S3 + CORS policy). Note that the `key-proxy` attribute is **not** a fetch proxy — it points the element at your LLM API-key proxy endpoint (so the key never reaches the client) and has no effect on GLB loading.

---

### Model loads but textures are missing

**Symptom:** The model's geometry appears but surfaces are grey or untextured.

**Likely causes:**
- For `.gltf` (JSON format): texture files aren't being served alongside the JSON file
- Texture URLs inside the glTF JSON are broken

**Fix steps:**

1. Open the file in a glTF viewer (e.g. [gltf.report](https://gltf.report)) to isolate the problem from the viewer itself.
2. If using `.gltf` (not `.glb`): texture PNG/JPG files must be served from the same origin as the JSON and referenced by relative path. The simplest fix is to re-export as `.glb` — this embeds all textures in one file.
3. If using `.glb`: textures are embedded by default. If they're missing, the export settings may have excluded them. In Blender: tick "Include → Textures" when exporting.

---

### Model loads but looks wrong (black material, wrong colors)

**Symptom:** Model appears but with black surfaces, missing reflections, or washed-out colors.

**Likely causes:**
- No environment map — metallic materials need a reflection source
- Metalness = 1.0 with no environment (renders black)
- Inverted normal map

**Fix steps:**

1. Change the environment preset in the viewer panel. Metallic materials need an HDR environment to reflect.
2. If the model is all-black: open it in Blender and check the material's Metallic value. A fully metallic material with no environment will be pitch black. Set Metallic to 0 or load an HDRI in the viewer.
3. If lighting looks inverted: the normal map's G channel may be flipped (a common difference between DirectX and OpenGL conventions). Flip it in your 3D editor before re-exporting.

---

### Draco-compressed model fails to load

**Symptom:** Model exported with Draco compression either shows an error or silently fails to load.

**Likely causes:**
- Content Security Policy blocking the Draco decoder WASM (loaded from CDN)

**Fix steps:**

1. Check the Console for CSP violations mentioning `draco_decoder.wasm` or the CDN hostname.
2. If CSP is blocking it, either add the CDN to your `script-src` and `connect-src` directives, or host the decoder yourself and set `dracoDecoderPath` on the viewer options.

---

## 2. Agent / LLM Issues

### Agent doesn't respond to messages

**Symptom:** Chat input works but no reply appears. The agent is silent.

**Likely causes:**
- `brain` attribute not set on `<agent-3d>` — without it, the element uses `NullProvider` (a no-op)
- Missing or invalid `ANTHROPIC_API_KEY`
- Rate limit reached

**Fix steps:**

1. Check the `brain` attribute. The agent only activates LLM mode when `brain` is set to a model name:
   ```html
   <agent-3d brain="claude-opus-4-7" ...></agent-3d>
   ```
   Without this attribute, `brain.provider` defaults to `none` and the agent uses `NullProvider`, which returns empty responses silently.
2. Open DevTools → Network. Filter for `/api/chat` or `/api/llm`. Look at the response:
   - `401` — the API key is missing or invalid.
   - `429` — rate limited. Wait a minute and retry.
   - `500` — server error. Check the server logs.
3. Verify `ANTHROPIC_API_KEY` is set in your server environment. On the production Cloud Run service:
   ```bash
   gcloud run services update three-ws-api --region us-central1 \
     --update-env-vars ANTHROPIC_API_KEY=sk-ant-...
   ```
   Updating an env var rolls a new revision automatically. On a self-hosted fork, set it wherever your host reads environment variables and restart/redeploy.
4. If you're calling the Anthropic API directly from the browser (not via a proxy), also set the `api-key` attribute on the element and note that this exposes your key to users.

---

### Agent responds but says something off-topic

**Symptom:** The agent replies but ignores its role or answers questions it shouldn't.

**Fix steps:**

1. Tighten the system prompt. A vague `instructions` field produces vague behavior. Be explicit: "You are a guide for [product]. You only discuss [topic]. If asked about anything else, say you can't help with that."
2. Add a boundary statement to the instructions: "Never break character. Never discuss topics outside [domain]."
3. If you're loading instructions from a `.md` file via `brain.instructions`, verify the file is being fetched correctly — check the Network panel for the `.md` request.

---

### Agent emotions not showing (no facial expression)

**Symptom:** Agent responds and speaks but the avatar's face doesn't change expression.

**Likely causes:**
- Model missing required morph targets
- Missing `Head` or `Neck` bone for head movement

**Fix steps:**

1. Check the Console. The avatar module logs a warning if expected morph targets aren't found on load.
2. Verify your GLB has morph targets named exactly as expected (case-sensitive). The emotion system maps to: `mouthSmile`, `mouthFrown`, `mouthOpen`, `cheekPuff`, `browInnerUp`, `browOuterUp`, `noseSneer`, `eyeSquint`, `eyesClosed`. These are the standard VRM / humanoid avatar names.
3. For head tilt and lean, the skeleton needs a `Head` or `Neck` bone. Open the model in Blender and check the armature.
4. Confirm the avatar module is initialized: open DevTools Console and run `window.VIEWER?.agent_avatar`. If `undefined`, the avatar layer didn't boot — check for earlier errors in the console.

---

### Agent speaks but mouth doesn't move

**Symptom:** TTS audio plays but lips stay still.

**Likely cause:** The `mouthOpen` morph target is missing or misspelled.

**Fix steps:**

1. Open the GLB in Blender → Object Data Properties → Shape Keys. Look for `mouthOpen` (exact spelling, camelCase).
2. If the shape key exists but has a different name (e.g. `Mouth_Open`, `mouth_open`), rename it to `mouthOpen` and re-export.

---

### TTS not working (agent doesn't speak aloud)

**Symptom:** Agent sends text responses but no audio.

**Likely causes:**
- Browser blocking audio autoplay
- Browser doesn't support `SpeechSynthesis`

**Fix steps:**

1. Click somewhere on the page first. Browsers block audio autoplay until there's been a user interaction. After clicking, retry the message.
2. Check browser support: run `'speechSynthesis' in window` in the Console. If `false`, the browser doesn't support the Web Speech API. Try Chrome or Edge.
3. Check system volume and browser tab mute state.

---

### ElevenLabs TTS not working

**Symptom:** ElevenLabs voice is configured but no audio plays, or audio falls back to browser TTS.

**Fix steps:**

1. Open DevTools → Network. Filter for `/api/tts` or `elevenlabs.io`. Check the response:
   - `401` — `ELEVENLABS_API_KEY` is missing or wrong.
   - `429` — rate limited. The free tier allows 10,000 characters/month.
   - `422` — voice ID is invalid. Verify the `voiceId` in your manifest or config.
2. Confirm `ELEVENLABS_API_KEY` is set in your server environment variables.

---

## 3. Embedding Issues

### Embedded agent doesn't appear

**Symptom:** The page loads but the `<agent-3d>` element is invisible.

**Likely causes:**
- Script tag not loaded before the element
- CSP blocking the CDN
- SSR rendering the web component on the server (which has no `window`)

**Fix steps:**

1. Verify the `<script>` tag loads before the `<agent-3d>` element in the DOM, or that it uses `defer`/`async` correctly.
2. Check the Console for CSP violations. The CDN origin (`cdn.three.ws`) must appear in your `script-src` policy.
3. For **Next.js**: web components use browser APIs (`window`, `document`, `SpeechSynthesis`) that don't exist server-side. Mark the component file with `'use client'` and disable SSR for the wrapper:
   ```js
   import dynamic from 'next/dynamic';
   const Agent3D = dynamic(() => import('./Agent3DWrapper'), { ssr: false });
   ```

---

### Iframe embed shows "Refused to connect" or blocked by X-Frame-Options

**Symptom:** An iframe pointing at the agent URL shows an error instead of the agent.

**Fix steps:**

1. Verify the `src` URL is correct — use the full HTTPS URL.
2. Do not use a URL that ends in `/edit` or `/dashboard` — those pages block framing for security. Use the agent's public embed URL.
3. Note: the `frame-ancestors` CSP for the embed is currently set via a `<meta>` HTTP-equiv tag, which browsers ignore for `frame-ancestors` (it must be an HTTP header). This means any origin can embed — if you're seeing a block, it's coming from something else, likely the host page's own CSP or an extension.

---

### postMessage not working

**Symptom:** Messages sent to the agent iframe via `postMessage` don't produce a reaction.

**Fix steps:**

1. Target the correct origin: `'https://three.ws/'` (or your self-hosted origin).
2. Listen for `message` events on `window`, not on the iframe element itself:
   ```js
   window.addEventListener('message', (e) => {
     if (e.origin !== 'https://three.ws/') return;
     console.log(e.data);
   });
   ```
3. Use the correct envelope shape. There are two related protocols, and neither uses a type prefix like `3dagent:`:
   - The **element bridge** (`src/embed-host-bridge.js`) wraps every message in `{ v: 1, source: 'agent-host' | 'agent-3d', id, kind, op, payload }` — e.g. a speak request is `{ v: 1, source: 'agent-host', id: '<uuid>', kind: 'request', op: 'speak', payload: { text: '...' } }`.
   - The **host protocol** ([specs/EMBED_HOST_PROTOCOL.md](../specs/EMBED_HOST_PROTOCOL.md)) uses `{ v: 1, type: 'host.*' | 'embed.*', id, payload }` — e.g. `{ v: 1, type: 'host.chat.message', payload: { ... } }`.

   Messages that don't match the expected envelope (missing `v: 1`, wrong `source`/`type`) are silently ignored.
4. Use the `EmbedHostBridge` class (`src/embed-host-bridge.js`) rather than raw `postMessage` — it handles the handshake, queues requests until the iframe is ready, and correlates responses by `id`.

---

### Floating agent hidden behind other elements

**Symptom:** `mode="floating"` agent is clipped or hidden behind page content.

**Fix steps:**

1. The element sets `z-index: 2147483000` internally via `:host([mode="floating"])`. If another element has a higher z-index, it will cover the agent.
2. Check parent elements for `overflow: hidden` — this can clip absolutely-positioned children even with a high z-index.
3. If the agent is inside a stacking context (e.g. a `position: relative` container with `z-index`), the z-index is relative to that context. Move `<agent-3d>` to a direct child of `<body>` if possible.

---

### Agent looks tiny or invisible on mobile

**Symptom:** The agent element exists in the DOM but renders as a 0×0 or very small box.

**Likely cause:** No explicit dimensions set. The web component has no intrinsic size.

**Fix steps:**

1. Set explicit dimensions. A good mobile starting point:
   ```html
   <agent-3d style="width: 100%; height: 50vh;" ...></agent-3d>
   ```
2. Avoid `display: inline` on the container — use `block` or `flex`.
3. For inline mode with automatic aspect ratio, add the `responsive` attribute:
   ```html
   <agent-3d responsive style="width: 100%;" ...></agent-3d>
   ```
   This sets `aspect-ratio: 3/4` and lets height follow width.

---

## 4. Authentication Issues

### Can't connect wallet

**Symptom:** "Connect Wallet" button does nothing or shows an error.

**Fix steps:**

1. MetaMask: confirm the extension is installed, unlocked, and the correct account is selected.
2. WalletConnect: QR codes expire after ~60 seconds. Refresh the page and try again.
3. Confirm you're on the correct network. Some operations require switching to Base (chain ID 8453) or Base Sepolia (chain ID 84532 for testnet).
4. Incognito / private mode: MetaMask may not inject `window.ethereum` in private windows. Try a normal window.

---

### "invalid_domain" error during wallet sign-in

**Symptom:** After signing the SIWE message, the server returns a 400 `invalid_domain` error.

**Likely cause:** The `PUBLIC_APP_ORIGIN` environment variable doesn't match the domain in the browser URL bar.

**Fix steps:**

1. Set `PUBLIC_APP_ORIGIN` to exactly the origin users are hitting (e.g. `https://www.yourdomain.com`). `www.yourdomain.com` and `yourdomain.com` are treated as different domains. In production this lives on the Cloud Run service (`gcloud run services update three-ws-api --region us-central1 --update-env-vars PUBLIC_APP_ORIGIN=...`).
2. For local development, any `localhost` domain is accepted automatically — you don't need to set `PUBLIC_APP_ORIGIN` for local dev.
3. For forks deployed on Vercel, the deployment host injected as `VERCEL_URL` is automatically trusted alongside `PUBLIC_APP_ORIGIN`.

---

### Session expires unexpectedly

**Symptom:** Users are logged out before the 30-day session window.

**Likely cause:** `JWT_SECRET` changed between deploys, which invalidates all existing sessions.

**Fix steps:**

1. Set `JWT_SECRET` once and don't rotate it unless needed. In production it lives on the Cloud Run service env (`gcloud run services describe three-ws-api --region us-central1` to inspect) — it must be the same value across all revisions.
2. Session duration is 30 days. A session used when fewer than 7 days remain is rotated to a fresh 30-day token (a rolling refresh window), so actively returning users stay signed in indefinitely.

---

### API key authentication fails

**Symptom:** Requests using an API key return 401 or 403.

**Fix steps:**

1. The key must be sent as `Authorization: Bearer <key>` — include the `Bearer ` prefix with a space.
2. Check if the key has been revoked in the dashboard (Settings → API Keys).
3. Verify the key's scope includes the endpoint you're calling. For example, reading avatar data requires `avatars:read`; creating or updating requires `avatars:write`.

---

## 5. Blockchain / ERC-8004 Issues

### Transaction reverts during registration

**Symptom:** The on-chain registration transaction fails with a revert error.

**Fix steps:**

1. Increase the gas limit by 20% — registration involves IPFS CID storage and can exceed estimates.
2. Check your ETH balance on Base. Bridge more if needed.
3. Verify the manifest CID resolves on IPFS before calling the contract. A CID that doesn't resolve yet may cause the contract to reject it depending on the registry version.
4. Confirm MetaMask is on Base mainnet (chain ID 8453), not Ethereum mainnet. The registry is not deployed on mainnet.

---

### "IPFS pinning failed" during registration

**Symptom:** The upload step fails with a pinning error before the transaction is even sent.

**Fix steps:**

1. Retry — IPFS providers go down occasionally. Wait a minute and try again.
2. Check `PINATA_JWT` (or your configured IPFS provider key) in your environment variables.
3. The default backend uses R2 storage (via `/api/erc8004/pin`). If you're supplying a Pinata JWT directly to the client, verify the token is valid and not expired in the Pinata dashboard.

---

### Agent doesn't appear on the discover/explore page after registration

**Symptom:** Transaction confirmed but the agent isn't visible on the on-chain listing.

**Fix steps:**

1. Wait 1–2 minutes. The indexer polls the chain periodically.
2. Access the agent directly by URL: `https://three.ws/a/<chainId>/<agentId>` — this bypasses the index.
3. Confirm the transaction was actually confirmed (not just submitted) on the block explorer for Base.

---

### ENS resolution not working

**Symptom:** Navigating to `/agent/ens/yourname.eth` shows "not found".

**Fix steps:**

1. Verify the `3dagent` text record is set on the ENS name. In the ENS manager, add a text record with key `3dagent` and value set to your agent's on-chain ID.
2. ENS records can take 30+ minutes to propagate after being set.
3. Test direct resolution: `https://three.ws/agent/ens/yourname.eth`

---

## 6. Memory Issues

### Agent forgets everything on reload

**Symptom:** The agent starts fresh with no memory of previous conversations.

**Likely causes:**
- Memory mode is `"none"` — conversations are never persisted
- localStorage was cleared

**Fix steps:**

1. Check the `memory` attribute or manifest setting. The default mode is `"local"` (persisted to `localStorage`). If your manifest or element sets `memory="none"`, memory is intentionally disabled.
2. Verify `localStorage` isn't being cleared. Open DevTools → Application → Local Storage and look for keys of the form `agent:<agentId>:memory`. If they're missing after a conversation, check if your browser settings clear storage on close.
3. Private/incognito mode: `localStorage` is cleared when the window closes. This is browser behavior, not a bug.

---

### IPFS memory not loading on another device

**Symptom:** A user's memory is stored but doesn't appear when they sign in on a different device.

**Cause:** The IPFS CID pointer is stored in `localStorage`, which doesn't sync between devices.

**Fix:** Cross-device memory sync is not implemented in the current release. It requires a server-side memory backend. Stay tuned for an upcoming release that adds this. For now, each device maintains its own local memory.

---

## 7. Performance Issues

### Model loads slowly

**Symptom:** The model takes many seconds to appear, or shows a long loading spinner.

**Fix steps:**

1. Check file size. Over 10 MB is noticeable on mobile; over 50 MB is slow on most connections.
2. Enable Draco compression on export. In Blender's glTF exporter: Geometry → Compression → enable. This typically reduces mesh data by 5–10×.
3. Scale down textures. 4096×4096 textures are rarely necessary — 1024×1024 is fine for most avatars. Use KTX2 format for GPU-compressed textures that decompress on the GPU rather than in JavaScript.
4. Merge meshes in Blender before exporting. Fewer objects = fewer draw calls = faster load.

---

### Low FPS / choppy animation

**Symptom:** Frame rate is visibly low or the animation stutters.

**Fix steps:**

1. Open the stats panel (visible in the dat.gui panel on the right side of the viewer). Check which metric is the bottleneck — GPU time or JavaScript time.
2. Reduce polygon count. Under 100k triangles renders at 60fps on most desktop GPUs; under 50k for mobile.
3. Disable environment maps on mobile — IBL (image-based lighting) is GPU-expensive. Set `preset="none"` or use a simple directional light preset.
4. Limit the number of `<agent-3d>` elements on a single page. Each one creates a WebGL context. Most browsers cap WebGL contexts at 8–16; 4–6 is a safe limit, fewer on mobile.

---

### Page freezes when loading a large model

**Symptom:** The browser UI freezes for several seconds while the model loads.

**Cause:** GLB parsing runs on the main thread. Models over ~50 MB can cause noticeable jank.

**Fix steps:**

1. Compress with Draco — the WASM decoder is more efficient and has less UI thread impact than uncompressed mesh parsing.
2. Split the model into multiple smaller files if possible, and load non-essential parts after the main avatar appears.
3. Moving model loading to a Web Worker is technically possible but requires custom viewer configuration — advanced use case.

---

## 8. Self-Hosting Issues

### "Cannot connect to database" on startup

**Symptom:** Server throws on startup or API routes return 500 with a database connection error.

**Fix steps:**

1. Verify `DATABASE_URL` is set. The format for Neon is: `postgres://user:password@host/dbname?sslmode=require`.
2. If using Neon: check that your server's IP is in the Neon project's IP allowlist (or set it to allow all IPs during development).
3. Run the full schema bootstrap to ensure every table exists:
   ```bash
   npm run db:bootstrap
   ```

---

### `relation "…" does not exist` errors in production logs

**Symptom:** API routes and crons throw `NeonDbError: relation "agent_custody_events" does not exist` (or `forge_creations`, `x_triggers`, `club_tips`, `unstoppable_activity`, …). Often hundreds or thousands of identical errors.

**Cause:** The database was provisioned with only part of the schema — typically `apply-schema.mjs` was run but the incremental migrations under `api/_lib/migrations/` were not. The base schema does **not** create migration-defined tables.

**Fix:** Point `DATABASE_URL` at the affected database and run the complete bootstrap. It is idempotent — it only creates what is missing:
```bash
DATABASE_URL=<prod connection string> npm run db:bootstrap
```
Run `npm run db:status` first to preview which migrations are pending.

---

### API routes return 500

**Symptom:** Requests to `/api/*` return HTTP 500 with no useful body.

**Fix steps:**

1. Check the server logs. Production runs on Google Cloud Run (service `three-ws-api`, region `us-central1`); read recent errors with:
   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" severity>=ERROR' \
     --freshness=1h --limit 20 --format="value(textPayload)"
   ```
   Deploys ship via `npm run deploy:gcp` (run `npm run build` first for frontend changes) — the full runbook lives in the repo at `docs/ops/gcp-production.md`. On a self-hosted fork, check whatever your host surfaces as function/process logs.
2. The most common cause is a missing environment variable. All required vars must be set: `DATABASE_URL`, `JWT_SECRET`, `PUBLIC_APP_ORIGIN`. The `env.js` module throws on startup if required vars are absent. In production, inspect and set them on the Cloud Run service: `gcloud run services describe three-ws-api --region us-central1` / `gcloud run services update three-ws-api --region us-central1 --update-env-vars KEY=value`.

---

### PWA / service worker serves stale assets after deploy

**Symptom:** After deploying a new version, some users still see the old UI.

**Fix steps:**

1. Hard-refresh: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac).
2. Clear the service worker manually: DevTools → Application → Service Workers → "Unregister", then DevTools → Application → Clear Storage → "Clear site data".
3. Service workers cache aggressively and can serve stale content for up to 24 hours. This is expected behavior — users will update automatically when the SW checks for a new version.

---

## Augmented Reality (AR)

### The AR button doesn't appear on mobile

**Symptom:** The `<agent-3d ar>` element renders correctly, but no AR button is visible on an iPhone or Android phone.

**Check 1 — `ar` attribute is present:**
```html
<agent-3d id="..." ar></agent-3d>
```
Without `ar`, the button is never rendered, even on supported devices.

**Check 2 — correct browser:**
- iPhone: must be **Safari**. Chrome, Firefox, and all other iOS browsers use WebKit but lack the Quick Look integration that triggers AR. The button is hidden for non-Safari iOS browsers.
- Android: must be **Chrome** (or a Chromium-based browser with ARCore). Firefox on Android does not support Scene Viewer or WebXR AR.

**Check 3 — inside an iframe:**
Add `allow="xr-spatial-tracking"` to the `<iframe>` element. Without it, the browser blocks `navigator.xr` inside the frame.

```html
<iframe
  src="https://three.ws/embed/avatar/YOUR_ID"
  allow="microphone; camera; xr-spatial-tracking; fullscreen"
></iframe>
```

**Check 4 — model not yet loaded:**
The AR button is only shown after the GLB finishes loading. If the model is large or on a slow connection, the button appears late. Check the console for load errors.

**Check 5 — HTTP origin:**
`navigator.xr` is `undefined` on `http://` origins. All AR methods require HTTPS for the page or the model URL. Use an ngrok tunnel or a deployed HTTPS environment during development.

---

### AR button appears but tapping it does nothing

**iOS:** The model URL is `http://`. Quick Look silently refuses non-HTTPS model URLs — it opens briefly then closes immediately, or never opens. Use an HTTPS URL for both the page and the GLB.

**Android:** ARCore is not installed. Chrome shows a "Get ARCore" prompt on first use; if dismissed, nothing happens. Direct the user to install ARCore from the Play Store, then try again.

**WebXR fallback:** The page origin is `http://`. `navigator.xr.isSessionSupported` throws on insecure origins.

---

### Quick Look opens but immediately closes

Almost always a model problem:

1. **File too large.** Quick Look on older devices struggles above ~15 MB. Compress textures and simplify geometry — see [model optimization](/docs/ar#model-size-and-compatibility).
2. **Draco-compressed GLB.** Quick Look doesn't include a Draco decoder — the file may load partially then fail. Decompress it: `npx @gltf-transform/cli optimize model.glb out.glb --no-draco`.
3. **CORS missing on the model URL.** Quick Look fetches the file separately from the browser, and CORS failures are silent. Verify `Access-Control-Allow-Origin: *` is present on the response headers for the GLB URL.
4. **USDZ conversion failed.** Check the browser console for errors *before* Quick Look opens — the in-browser USDZExporter logs any failures. A corrupt or oversize USDZ causes immediate dismissal.

---

### The model is invisible or floating in WebXR

**Background not cleared:** Verify the scene background is `null` when the XR session starts. If it's opaque, it occludes the camera passthrough — the agent is there but hidden behind the background color.

**Agent placed off-screen:** If `activateAR()` is called before the agent is positioned in the viewport, the model may be anchored outside the camera frustum. Ensure the agent is visible in the standard 3D view before activating AR.

**Hit-test not resolving:** WebXR hit-test requires a real flat surface with texture. Blank white desks, uniform floors, and glass surfaces confuse ARCore. Try a surface with visible pattern or grain.

---

### USDZ conversion is slow or fails

The in-browser GLB → USDZ conversion runs in the main thread and can take 5–15 seconds for complex models. If it fails:

- Check the browser console for errors from `USDZExporter`.
- Try the model in the [glTF Validator](/validation) first — invalid GLBs often cause export failures.
- Skinned/rigged meshes export as static poses in USDZ (animations are lost — this is expected).
- Models over ~30 MB may time out or exhaust memory during conversion on mobile. Reduce the model size before attempting Quick Look.

Pre-generate USDZ files on the server and set `ios-src` to skip in-browser conversion entirely.

---

### Testing AR locally (HTTPS required)

All three AR methods require HTTPS. `navigator.xr` is undefined on insecure origins; Quick Look and Scene Viewer require the model URL to be HTTPS regardless of the page origin.

**Option 1 — ngrok:**
```bash
npm run dev          # starts dev server on port 3000
ngrok http 3000      # creates an HTTPS tunnel
# Open the ngrok URL on your phone
```

**Option 2 — a deployed HTTPS environment:**
Deploy your change and test against the live HTTPS URL. There are no per-branch preview deployments in the production flow — three.ws production deploys with `npm run deploy:gcp` to Cloud Run. A fork hosted on Vercel or Netlify does get an HTTPS URL per deploy, which works the same way for AR testing.

**Chrome WebXR emulator (desktop testing):**
Chrome 127+ includes a WebXR device simulator under DevTools → More Tools → WebXR. It won't show camera passthrough but lets you test the session lifecycle and model placement logic without a physical device.

See the [AR & WebXR guide](/docs/ar) for the full platform compatibility matrix and programmatic API reference.

---

## FAQ

**Is three.ws free?**

The core platform is free. API usage costs (Anthropic for LLM, ElevenLabs for TTS) are charged at cost — you supply your own API keys. IPFS pinning for on-chain registration requires a Pinata JWT or uses the default R2 backend.

**Can I use any 3D model, or does it have to be a humanoid?**

Any glTF 2.0 / GLB model works. Humanoid models with the correct skeleton and morph targets unlock the full emotion system (facial expressions, head movement). Non-humanoid models display and animate fine — they just won't show emotions.

**Does the agent work without an Anthropic API key?**

The 3D viewer, animations, and widget system all work without a key. The LLM conversation feature requires setting the `brain` attribute on the element and a valid API key. If no key is configured, the element uses `NullProvider` (no-op) — it won't respond to chat messages.

**Can I self-host without Vercel?**

Yes — production itself doesn't run on Vercel. Since 2026-07-07, three.ws production is a single container on Google Cloud Run: `server/index.mjs` serves the static frontend and every `api/**` handler, and reads `vercel.json`'s route table at runtime as its routing config. That server is the reference implementation for self-hosting on any Node.js host. If you'd rather use your own routing layer (Express routes, Nginx `proxy_pass`, etc.), replicate the `vercel.json` rewrite rules there — the API routes are standard Node.js async functions. Deploying a fork to Vercel also still works.

**Is the agent data private?**

In local memory mode, all conversation memory stays in the browser's `localStorage`. Conversation messages are sent to the Anthropic API (subject to [Anthropic's privacy policy](https://www.anthropic.com/privacy)). Model files are never uploaded unless you explicitly save to your account. If you're building a sensitive application, review what data flows through each API.

**The `IdleAnimation` (blink / head-drift) doesn't seem to work.**

This is a known open issue. The `IdleAnimation` class is implemented in `src/idle-animation.js` but is not yet wired into the avatar system — it's imported but the integration with `agent-avatar.js` is incomplete. Idle blink and head-drift are not active in the current release. This is tracked as a defect.
