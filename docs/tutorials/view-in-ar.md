# Place your 3D model in AR

This tutorial walks you through every step of seeing a three.ws model in augmented reality — from generating the model to walking around it in your kitchen. No app to install. Runs in the browser on iPhone and Android.

**What you'll do:**
- Generate or pick a 3D model from Forge
- View it in the AR tab on your phone
- Understand what happens under the hood (iOS Quick Look vs. Android WebXR)
- Add AR to your own embedded agent with two lines of HTML
- Troubleshoot the three most common failures

**Prerequisites:** A smartphone (iPhone or Android). For the embedding section, a basic HTML file you can edit.

---

## Step 1 — Get a 3D model

You need a model before you can place it in AR. The fastest way is to generate one in Forge.

1. Go to [three.ws/forge](https://three.ws/forge)
2. Type a description — something concrete works best: **a ceramic coffee mug with a handle** or **a low-poly red fox sitting down**
3. Hit **Forge** and wait 30–90 seconds for the model to generate

You can also use any existing avatar from [three.ws/gallery](https://three.ws/gallery) — the AR tab exists on every avatar and Forge model page.

---

## Step 2 — Open the model on your phone

**If you're already on your phone:**
The Forge result screen has a **View in AR** button in the toolbar. Tap it.

**If you're on desktop:**
After the model generates, switch to the **AR** tab in the model viewer. A QR code appears. Scan it with your phone's camera. On iPhone it opens Safari; on Android it opens Chrome. The AR experience opens automatically — no extra taps required.

---

## Step 3 — Place it in your space

Once the AR page opens on your phone:

1. **Allow camera access** if prompted (this only happens once)
2. **Point the camera at a flat surface** — floor, desk, table. The camera scans for a plane.
3. A **reticle** (small circle or crosshair) appears on the detected surface. This is where the model will land.
4. Tap **Place in your space**. The model appears at that location, at real-world scale.
5. Walk around it. Pinch to resize. Tap and drag to reposition.

The model stays anchored as you move — if you step back, it doesn't follow you.

---

## Step 4 — Understand what just happened

Three different AR systems power this feature, selected automatically:

### iPhone (Safari) → iOS Quick Look
Safari intercepts a click on a special `<a rel="ar">` link and opens Apple's native AR viewer. The model renders at true scale using ARKit. No app required because Quick Look is built into iOS. Rigged avatars arrive with their idle animation baked in, so they breathe and sway instead of standing frozen. The tradeoff: only that one clip plays, and there's no conversation with the agent.

To make this work, three.ws either:
- Serves a pre-generated **USDZ file** (Apple's AR format) if one exists
- Bakes an **animated USDZ in-browser** (the avatar's idle clip sampled into
  Quick Look's native time-sampled format) if not — this takes a few seconds,
  and falls back to a static-pose conversion if the model has no usable rig

### Android (Chrome) → Scene Viewer
Chrome launches Google's **Scene Viewer** via an ARCore intent URL. Scene Viewer is a Google app that comes pre-installed on most Android phones with Google Play. It supports GLB files directly and plays animations. No conversion step needed.

### Any WebXR browser → WebXR AR
If the above methods aren't available, three.ws starts a **WebXR immersive-ar session** — the most powerful method. The page itself becomes the AR view: the camera passthrough shows through the canvas, and the agent's full runtime stays live. Animations play. Conversation works. The agent can track your head position.

---

## Step 5 — Add AR to your own embed

If you've embedded a three.ws agent on your website, enabling AR takes one attribute:

```html
<script type="module"
  src="https://three.ws/agent-3d/latest/agent-3d.js"
></script>

<agent-3d
  id="your-agent-id"
  ar
></agent-3d>
```

The `ar` attribute is all you need. The AR button appears automatically on mobile devices that support it. On desktop, it's hidden — no desktop browser supports `immersive-ar`.

### Iframe embed + AR

If you're using the iframe embed, add `xr-spatial-tracking` to the `allow` attribute:

```html
<iframe
  src="https://three.ws/embed/avatar/YOUR_AVATAR_ID"
  allow="microphone; camera; xr-spatial-tracking; fullscreen"
  width="400"
  height="500"
></iframe>
```

Without `xr-spatial-tracking`, the browser blocks `navigator.xr` inside the frame and the AR button won't appear.

---

## Step 6 — Test on a real device

AR requires HTTPS — `navigator.xr` is undefined on `http://` origins and Quick Look refuses non-HTTPS model URLs.

**During development**, you have two options:

**Option A — ngrok tunnel (fastest)**
```bash
# Start your dev server (default port 3000 for this repo)
npm run dev

# In a second terminal
ngrok http 3000

# Open the ngrok HTTPS URL on your phone
# e.g. https://abc123.ngrok.io/your-page
```

**Option B — deploy a preview**
Deploy the page to any static host that serves HTTPS (a preview environment, your own Vercel/Netlify project, or a staging URL) and open it on your phone. This is the cleanest path because it tests a real production build over TLS rather than a tunnel.

---

## Troubleshooting

### The AR button doesn't appear

**On iPhone:** Are you using Safari? Chrome, Firefox, and every other browser on iOS uses WebKit but lacks the Quick Look integration. AR only works in Safari on iPhone.

**On Android:** Is Chrome installed and up to date? AR uses ARCore, which Chrome manages. Other Android browsers (Samsung Internet, Firefox, Brave) may not support it.

**In an iframe:** Add `allow="xr-spatial-tracking"` to the `<iframe>` tag.

**On your dev server:** Switch to an HTTPS URL — ngrok tunnel or a deployed preview.

---

### I tap the button but nothing happens

**iOS:** The model URL is HTTP. Quick Look silently refuses. Use ngrok or deploy.

**Android:** ARCore isn't installed. Chrome shows a "Get ARCore" prompt. If the user dismisses it, nothing opens. Direct them to install ARCore from the Play Store.

---

### Quick Look opens but immediately closes

This almost always means the model is too large (> 15 MB) or the USDZ conversion produced an invalid file. Check the browser console before Quick Look opens for conversion errors. Also verify the model URL returns `Access-Control-Allow-Origin: *` — Quick Look fetches it separately and fails silently on CORS errors.

---

### The model floats or doesn't stick to surfaces

AR surface detection needs a moment to work. Move the phone slowly over the target surface — a table or floor with texture (not a plain white table) detects faster. Bright, uniform surfaces confuse ARCore and ARKit.

---

## What's next

- [AR & WebXR reference](/docs/ar) — full programmatic API, USDZ pipeline, model optimization limits
- [Embedding guide](/docs/embedding) — iframe setup and permission attributes
- [Web component reference](/docs/web-component) — all `<agent-3d>` attributes
- [AR feature page](https://three.ws/features/ar) — platform comparison and live demo
- [Blog: How AR works on three.ws](https://three.ws/blog/see-your-3d-in-ar)
