# From the Character Library to a Live Embed in Ten Minutes

By the end of this tutorial there will be a rigged, animated 3D character standing on your own web page, waving when a visitor clicks a button. You will not model anything, rig anything, install a 3D toolchain, or pay anything. The character comes from a free library of 107 professionally rigged humanoids, and the embed is one script tag and one custom element.

Ten minutes is not marketing. The list is: two minutes reading the library manifest, two minutes picking and previewing a character, one minute proving the rig animates, three minutes writing the embed, two minutes wiring a button. The only thing that can make it longer is skipping Step 4, which is where you find out whether the character you picked does what you want.

**What you'll build:**

- A shortlist of characters pulled live from `GET /api/avatars/library`, filtered by file size and license
- A browser preview of your pick, and a server-rendered proof that its skeleton drives the animation clip library
- A working `<agent-3d>` embed on a plain HTML page, sized, silent, and looping an idle animation
- A CORS fix that most people hit on their first production deploy, before they hit it
- A gesture triggered from your own page JavaScript, on a real button, wired to the `agent:ready` lifecycle event
- Clarity on `src` versus `avatar-id`, which is the single most common way this embed gets misconfigured

**Prerequisites:**

- A text editor and a way to serve a local HTML file. `npx serve .` or `python3 -m http.server` both work. A `file://` page will not, because the GLB load is a cross-origin `fetch`.
- `curl` and `jq` for the API steps.
- No account, no API key, no payment. The library is free and public, and so is the embed runtime.
- Background reading, if you want it: [Character Library](/docs/character-library.md) for the gallery and manifest, [Embedding Guide](/docs/embedding.md) for the full `<agent-3d>` contract.

---

## Step 1 - Read the library

The library is a manifest of rigged humanoid GLBs staged on a CDN. One public, keyless, CORS-open endpoint serves it.

```bash
curl -s 'https://three.ws/api/avatars/library?limit=3&offset=0' | jq
```

```json
{
  "avatars": [
    {
      "name": "abe",
      "label": "Abe",
      "url": "https://<cdn>/avatars/mixamo/glb/abe.glb",
      "thumb": "https://<cdn>/avatars/mixamo/thumbs/abe.png",
      "bytes": 35947032,
      "skins": 1,
      "animations": 1,
      "source": "mixamo",
      "license": "Mixamo"
    }
  ],
  "total": 107,
  "offset": 0,
  "next_offset": 3,
  "generated_at": "2026-07-21T13:39:15.447Z"
}
```

Omit `limit` entirely and you get all 107 entries in one response, which is small enough that the gallery page does exactly that and filters client-side. With `limit` (1 to 1000) and `offset`, you additionally get `offset` and `next_offset`, where `next_offset` is `null` on the last page and `total` is always the full library size rather than the page size.

The fields that matter when you are choosing:

| Field | Why you care |
|---|---|
| `url` | Absolute CDN URL of the GLB. This is what goes in the embed. Read it from here; never hardcode a CDN hostname. |
| `bytes` | Your visitor downloads all of this. The single biggest lever on how the embed feels. |
| `skins` | Skinned mesh count. Anything `>= 1` means there is a real skeleton driving deformable geometry. |
| `animations` | Clips baked into the GLB **file**. Almost always `1`. This is *not* how many animations the character can play. See Step 4. |
| `license` | Read this per character. Do not assume one license for the whole library. |
| `thumb` | Pre-rendered PNG. Free poster image for your embed. Present when a thumbnail has been rendered. |

One behaviour worth coding for: before the manifest is staged, the endpoint returns `{ "avatars": [], "total": 0 }` rather than an error. Feature-detect by emptiness, not by catching exceptions. Responses are edge-cached for 5 minutes.

---

## Step 2 - Pick a character on the numbers

Sort by size and the shortlist writes itself. Weight is the whole game for an embed: a 36 MB character and a 2 MB character look about equally good in a 480px box, and one of them costs your visitor eighteen times as much bandwidth.

```bash
curl -s https://three.ws/api/avatars/library \
  | jq -r '.avatars
      | sort_by(.bytes)
      | .[0:8]
      | .[]
      | "\(.name)\t\((.bytes/1048576)|floor)MB\tskins=\(.skins)\t\(.license)"' \
  | column -t
```

```
x-bot                2MB  skins=2   Mixamo
quaternius-base      2MB  skins=1   CC0
y-bot                2MB  skins=2   Mixamo
the-boss             2MB  skins=11  Mixamo
peasant-man          2MB  skins=1   Mixamo
lola-b-styperek      3MB  skins=1   Mixamo
big-vegas            3MB  skins=4   Mixamo
medea-by-m-arrebola  3MB  skins=1   Mixamo
```

Of the 107 characters, 36 are under 10 MB. That subset is where a production embed should live. Grab the URL of your pick into a shell variable so the rest of the tutorial is copy-pasteable:

```bash
GLB=$(curl -s https://three.ws/api/avatars/library \
  | jq -r '.avatars[] | select(.name == "y-bot") | .url')
echo "$GLB"
```

```
https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/avatars/mixamo/glb/y-bot.glb
```

Y Bot is a good default: 2.5 MB, clean neutral topology, two skinned meshes, and no visual style that fights your page design.

### Read the license, per character

Every entry carries its own `license` field:

- **`"CC0"`** is public domain. Any use including commercial, no attribution required.
- **`"Mixamo"`** means the character is an Adobe Mixamo character used under Adobe's Mixamo terms. The manifest records the tag; it does not restate the terms. Consult Adobe's Mixamo licensing FAQ before redistributing that GLB outside three.ws.

Using any library character **inside three.ws** (previewing, animating, publishing a widget or embed) is free. If you are embedding on your own commercial site and want to skip the licensing question entirely, filter for `CC0`:

```bash
curl -s https://three.ws/api/avatars/library \
  | jq -r '.avatars[] | select(.license == "CC0") | "\(.name)\t\(.source)\t\(.url)"'
```

The CC0 set is currently small (the manifest is mostly Mixamo characters, with additional CC0 sets merged in over time), so run that filter rather than assuming a count. If it returns fewer characters than you need, the other free route is to generate your own: text-to-3D on the free lane produces a character you own outright, and [Generate 3D models from code](/docs/tutorials/generate-3d-api.md) covers it.

---

## Step 3 - Preview it before you commit

Two ways, and both take under a minute.

**The gallery.** [/character-library](/character-library) renders every character live in an auto-rotating viewer with its pre-rendered thumbnail as the poster. Press `/` anywhere on the page to focus search, type a name, and sort by size or name. Each card offers three one-click routes:

| Button | Goes to | For |
|---|---|---|
| **Preview** | `/app#model=<glb-url>` | The full three.js viewer: orbit, zoom, inspect |
| **Use** | `/studio?model=<glb-url>` | [Widget Studio](/docs/widget-studio.md), to configure and publish an embeddable widget |
| **Animate** | `/pose?src=<glb-url>` | [Animation Studio](/docs/animation-studio.md), to pose, keyframe, and export motion |

**Or straight from your shell**, which is handy when you already have the URL in a variable:

```bash
echo "https://three.ws/app#model=$GLB"
```

Open that. Orbit around it. Check the silhouette at the size your page will actually use, not full screen. A character that reads well at 900px can turn to mush at 320px.

---

## Step 4 - Prove the rig drives the clip library

This is the step people skip, and it is the one that makes the whole thing work.

The manifest said `"animations": 1`. That number counts clips baked into the GLB file, and it is nearly always 1 for every character in the library. It says nothing about what the character can play, because **the animations do not come from the file.** three.ws holds a canonical clip library (112 clips: idle, walk, run, wave, dance, cheer, and the rest) and retargets them onto any humanoid skeleton at runtime. There is no per-character allowlist. Any character in the library plays any clip.

You can prove that in one request, without a browser, by asking the server to pose the character:

```bash
curl -s -D headers.txt -X POST https://three.ws/api/render/avatar-clip \
  -H 'content-type: application/json' \
  -d "{\"glbUrl\":\"$GLB\",\"posePresetId\":\"wave\",\"background\":\"transparent\",\"width\":512,\"height\":512}" \
  -o proof.png

grep -i '^x-render-pose' headers.txt
file proof.png
```

```
x-render-pose: wave
x-render-pose-label: Wave hello
proof.png: PNG image data, 512 x 512, 8-bit/color RGBA, non-interlaced
```

Open `proof.png`. The character is waving. Its skeleton accepted a pose it never shipped with, which is exactly the mechanism the runtime uses for full animation clips. If that render comes back correctly, the embed in Step 5 will animate.

That endpoint takes any GLB under 10 MB, so it works on the 36 small characters directly. It also gives you a free poster image for the embed, and 28 poses to choose from (`GET https://three.ws/api/render/avatar-clip` returns the catalog). Full details in [Put a 3D avatar in an `<img>` tag](/docs/tutorials/render-avatar-images.md).

To see the actual motion clips rather than a static pose, open the [Animation Studio](/docs/animation-studio.md):

```bash
echo "https://three.ws/pose?src=$GLB"
```

Play `idle`, `walk`, `wave`, `dance`. Whatever plays there will play in your embed, because it is the same runtime. Browse the whole set at [/animations](/animations), or read it as JSON:

```bash
curl -s https://three.ws/animations/manifest.json | jq -r '.[] | "\(.name)\t\(.label)\tloop=\(.loop)"' | head -12
```

---

## Step 5 - Embed it

One script tag, one element. Create `index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My 3D character</title>

  <script
    type="module"
    src="https://three.ws/agent-3d/1.5.2/agent-3d.js"
    integrity="sha384-qCG5gH4q2+k2Gsf98zs9RFXyN8iezoklCWt63pA2Xk2YF7Onae4rfUwu+oZSqRzN"
    crossorigin="anonymous"
  ></script>

  <style>
    body { margin: 0; background: #0b0b0f; color: #f4f4f5; font-family: system-ui, sans-serif; }
    main { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
    agent-3d { display: block; width: 100%; height: 520px; }
  </style>
</head>
<body>
  <main>
    <h1>Meet the guide</h1>

    <agent-3d
      id="guide"
      src="https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/avatars/mixamo/glb/y-bot.glb"
      clip="idle"
      kiosk
    >
      <img
        src="https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/avatars/mixamo/thumbs/y-bot.png"
        alt="Y Bot, a rigged 3D character (requires JavaScript)"
        style="max-width: 100%"
      />
    </agent-3d>
  </main>
</body>
</html>
```

Serve it and open it:

```bash
npx serve .
```

The character loads and starts breathing on an idle loop. Four decisions in that markup, each doing real work:

- **`src` with a `.glb` URL.** The element recognizes a plain `.glb` or `.gltf` URL and treats it as a bare body rather than trying to parse it as an agent manifest. You do not have to know the distinction; you just have to point at the file.
- **No `brain` attribute.** Without it, no LLM client ever loads and the embed is a pure silent display. Add `brain="free"` and the same character gains a real conversation, host-paid, with no API key. That is a different tutorial ([Add a 3D avatar assistant to your site](/docs/tutorials/add-a-3d-assistant.md)); leave it off while you are getting the geometry right.
- **`clip="idle"`** sets the looping animation it settles into. Any clip name from the manifest in Step 4 works. Omit the attribute and it defaults to `idle` anyway.
- **`kiosk`** hides all chrome (chat input, controls, overlays) for a faster first render. For a decorative character this is what you want.

Two sizing rules that account for most "my embed is invisible" reports:

1. **The element has no intrinsic size.** It fills its CSS `width` and `height`, and with neither set it collapses to zero. Always set both.
2. **It is lazy by default.** An IntersectionObserver defers boot until the element scrolls into view, and the render loop pauses when it is fully off-screen. Add `eager` only if it genuinely must be ready before it is visible.

The `<img>` child is not decoration. Any children of `<agent-3d>` render when JavaScript is unavailable, so that one line gives you a progressive-enhancement fallback and a real `alt` for screen readers, using the free thumbnail from the manifest.

For production, pin the exact version as above. The current Subresource Integrity hash for any release lives at `https://three.ws/agent-3d/<version>/integrity.json`. The moving channels (`/agent-3d/1.5/`, `/agent-3d/1/`, `/agent-3d/latest/`) exist for demos and prototypes, and carry a 5 minute cache; do not ship them.

---

## Step 6 - Fix the CORS failure before it happens on production

This is the one that bites on deploy day, and it is worth thirty seconds of prevention.

Loading a GLB in a browser is a cross-origin `fetch`, which means CORS. The CDN answers cross-origin GLB reads only for origins it recognizes: `three.ws` itself and the standard local dev ports. Check for yourself:

```bash
for O in https://three.ws http://localhost:3000 https://your-site.com; do
  printf '%-26s ' "$O"
  curl -sD - -o /dev/null -H "Origin: $O" "$GLB" \
    | grep -i 'access-control-allow-origin' || echo '(none)'
done
```

```
https://three.ws           Access-Control-Allow-Origin: https://three.ws
http://localhost:3000      Access-Control-Allow-Origin: http://localhost:3000
https://your-site.com      (none)
```

So the embed works perfectly on `localhost:3000` and then shows an empty box the moment you deploy. That is not a bug in your code and it is not worth debugging twice.

The fix is one attribute change: route the GLB through `GET /api/glb?src=<url>`, which streams any public GLB back with `access-control-allow-origin: *`.

```bash
# Build the proxied URL from the manifest URL.
PROXIED="https://three.ws/api/glb?src=$(jq -rn --arg u "$GLB" '$u|@uri')"
echo "$PROXIED"

# Verify it from an arbitrary origin.
curl -sD - -o /dev/null -H 'Origin: https://your-site.com' "$PROXIED" \
  | grep -iE 'access-control-allow-origin|content-type|cache-control'
```

```
access-control-allow-origin: *
content-type: model/gltf-binary
cache-control: public, max-age=86400, s-maxage=604800, immutable
```

Then use that URL in the element:

```html
<agent-3d
  id="guide"
  src="https://three.ws/api/glb?src=https%3A%2F%2Fpub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev%2Favatars%2Fmixamo%2Fglb%2Fy-bot.glb"
  clip="idle"
  kiosk
></agent-3d>
```

Safe by construction: the upstream objects are already public and keyless, and the proxy fetch runs through an SSRF-hardened client (scheme allowlist, DNS pinning, private-address blocklist, redirect re-validation, 30 MB cap, 20 second timeout). It is a CORS shim, not an open proxy. The response is cached immutably, so the proxy costs one hop on a cold cache and nothing after.

One exception worth knowing, so you do not reach for the proxy reflexively: this applies to the `pub-*.r2.dev` bucket host, which is where every manifest GLB lives. Files served from `three.ws` itself (`https://three.ws/avatars/cesium-man.glb` and the rest of the built-in set) already answer every origin with `access-control-allow-origin: *`, re-measured 2026-09-04. So does `https://three.ws/cdn/<key>`, which serves the very same bucket objects first-party. Those load directly, no proxy. Check the host in the URL, not the symptom.

Use the proxied URL from the start and you never have a localhost-only success to unlearn. The same shim is what makes these GLBs loadable in a Jupyter or Colab notebook and on a dev server running on a non-standard port.

---

## Step 7 - Trigger a gesture from your page

Now make it respond to your visitor. The element exposes a JavaScript API, and the correct time to touch it is after the `agent:ready` event, which fires once the manifest and model are both settled.

Add to `index.html`, inside `<main>`:

```html
<div class="controls">
  <button type="button" data-clip="wave">Wave</button>
  <button type="button" data-clip="celebrate">Celebrate</button>
  <button type="button" data-clip="dance">Dance</button>
  <button type="button" data-clip="idle">Back to idle</button>
</div>

<style>
  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
  .controls button {
    padding: 10px 16px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
  }
  .controls button:hover   { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.32); }
  .controls button:active  { transform: translateY(1px); }
  .controls button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
  .controls button[disabled] { opacity: 0.45; cursor: progress; }
</style>

<script type="module">
  const guide = document.getElementById('guide');
  const buttons = [...document.querySelectorAll('.controls button')];

  // Disabled until the model is actually loaded. A button that silently does
  // nothing for the first two seconds is worse than a button that says "wait".
  buttons.forEach((b) => { b.disabled = true; });

  guide.addEventListener('agent:ready', () => {
    buttons.forEach((b) => { b.disabled = false; });
  });

  guide.addEventListener('agent:error', (e) => {
    console.error('[agent-3d] failed to load', e.detail);
    buttons.forEach((b) => { b.disabled = true; });
  });

  for (const button of buttons) {
    button.addEventListener('click', () => {
      // userInitiated: true plays the motion even under prefers-reduced-motion.
      // An explicit click is allowed to animate; ambient autoplay is not.
      guide.playClip(button.dataset.clip, { userInitiated: true });
    });
  }
</script>
```

Reload and click. The character waves, celebrates, dances, and settles back into idle. Every one of those clips is retargeted onto its skeleton at runtime; none of them shipped inside the GLB.

The methods worth knowing for a decorative embed:

| Call | Does |
|---|---|
| `el.playClip(name, { userInitiated })` | The polished entry point. Reads the clip's `loop` flag from the manifest automatically, so looping clips loop and one-shots play once and crossfade back into idle instead of hard-snapping at the boundary. Honours `prefers-reduced-motion` unless `userInitiated: true`. **Use this one.** |
| `el.wave()` | Convenience shorthand for a wave, resolved by hint rather than exact clip name. |
| `el.play(name, opts)` | Lower level. Plays exactly what you name, with no loop inference and no reduced-motion handling. |
| `el.pause()` / `el.resume()` | Stop and restart the render loop. Useful when your own code knows the element is hidden. |
| `el.lookAt('user')` | Point the head at the camera. |

`playClip` is the one to reach for. The reason it exists is that `loop` is a property of the clip, not of your intent, and a host page should not have to keep a table of which of the 112 clips loop.

Because events are dispatched with `composed: true`, they cross the shadow DOM boundary and bubble, so you can also listen on a container instead of the element:

```js
document.querySelector('main').addEventListener('agent:ready', (e) => {
  console.log('character ready:', e.detail.manifest.name);
});
```

The full event list (`agent:ready`, `agent:load-progress`, `agent:error`, and the brain, voice, and skill events for conversational embeds) is in the [Embedding Guide](/docs/embedding.md).

---

## Step 8 - `src` versus `avatar-id`: pick one, deliberately

The element accepts several source attributes, and mixing them is the most common misconfiguration. The rule:

| Attribute | Value | Use when |
|---|---|---|
| `src` | A `.glb` / `.gltf` URL, or an `agent://` URI | **This tutorial.** A library character is a raw GLB URL, so `src` is correct. |
| `avatar-id` | A three.ws avatar UUID | The character has been saved as an avatar on your account and you want a stable ID instead of a URL. |
| `agent-id` | An agent identifier, on-chain or backend | You want a full agent with a brain, persona, memory, and skills. |
| `manifest` | A manifest URL | You are hosting your own agent manifest. |
| `body` | A `.glb` URL | Equivalent to a bare-GLB `src`. Either is fine. |

Two precedence facts that are easy to get wrong:

1. **When `src` is set, it wins** over `agent-id` and `manifest`. The overall order is `src` > `agent-id` > `manifest` > `body`.
2. **`avatar-id` is only consulted when none of `src`, `manifest`, `body`, or `agent-id` is present.** Setting both `src` and `avatar-id` does not merge them and does not warn; the `avatar-id` is simply ignored.

So: set exactly one. Never both.

The attribute is spelled **`avatar-id`**, hyphenated, like every other HTML attribute. It resolves the UUID through `GET /api/avatars/<id>` and builds a bare-body manifest from the result, which is why it works for public and unlisted avatars and returns nothing for private ones (the correct boundary for a cross-origin embed).

### When you actually want `avatar-id`

A raw `src` URL is perfect for a fixed decorative character. Switch to `avatar-id` when you want the *page to stop being the source of truth*: save the character into your own avatar library once, and from then on you can restyle it, swap its GLB, or replace it entirely in the three.ws studios, and every embed pointing at that UUID updates without a deploy.

Save it with `POST /api/avatars/from-forge`, which copies a GLB into your library server-side. This is the one authenticated call in this tutorial (a signed-in session cookie, or a bearer token with the `avatars:write` scope):

```bash
curl -s -X POST https://three.ws/api/avatars/from-forge \
  -H 'authorization: Bearer sk_live_replace_me' \
  -H 'content-type: application/json' \
  -d "{
    \"glb_url\": \"$GLB\",
    \"name\": \"Site Guide\",
    \"visibility\": \"unlisted\",
    \"tags\": [\"embed\", \"guide\"]
  }" | jq '{id: .avatar.id, view_url}'
```

```json
{ "id": "<your new avatar uuid>", "view_url": "https://three.ws/discover/avatar/<id>" }
```

Then swap the attribute:

```html
<agent-3d avatar-id="<your new avatar uuid>" clip="idle" kiosk></agent-3d>
```

No `src`. That is the point.

Doing the copy server-side also sidesteps cross-origin reads and browser upload caps, and it routes through the normal avatar-creation path, so the result is a first-class avatar with its own agent and its own render URL. It becomes eligible for `/api/avatar/render` too, which means a free `<img>` poster and social card for the same character ([Put a 3D avatar in an `<img>` tag](/docs/tutorials/render-avatar-images.md)).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nothing renders, no console error | The element has zero height | It has no intrinsic size. Set both `width` and `height` in CSS. |
| Empty box, CORS error in the console | Loading the CDN GLB directly from an origin the CDN does not echo | Route it through `/api/glb?src=...` (Step 6). Works on localhost, fails on production, every time. |
| Works locally, blank after deploy | The same CORS issue, discovered late | Same fix. Use the proxied URL from the start. |
| `{ "avatars": [], "total": 0 }` from the library API | Manifest not staged in this environment | Expected pre-launch state, not an error. Feature-detect by emptiness. |
| Character loads but never moves | A `clip` name that is not in the manifest, or `prefers-reduced-motion` is on | Check the name against `curl -s https://three.ws/animations/manifest.json`. Reduced motion holds a clean static idle on purpose; pass `{ userInitiated: true }` for click-driven motion. |
| `playClip` throws "not a function" | Called before the runtime upgraded the element, or the script tag failed | Wait for `agent:ready`. Confirm the script tag loaded and the SRI hash matches the version in the URL. |
| Embed takes many seconds on mobile | The character is large | Check `bytes` in the manifest. 36 of 107 are under 10 MB; start there. Or shrink one through `/api/avatar/optimize` (see [the render tutorial](/docs/tutorials/render-avatar-images.md)). |
| Character appears in a T-pose and stays there | The GLB has no skinned mesh the runtime can drive | Check `skins` in the manifest is `>= 1`. Every library character satisfies this; a custom upload might not. |
| `avatar-id` is ignored | `src`, `body`, `manifest`, or `agent-id` is also set | `avatar-id` only resolves when none of the others is present. Set exactly one source attribute. |
| Chat UI appears when you wanted a silent character | An `agent-id` or `manifest` source, which implies a brain | Add `kiosk`, or the explicit `chat="off"`. A bare-GLB `src` with no `brain` is silent already. |
| Multiple embeds on one page, some are black | WebGL context limit (browsers cap at roughly 8 to 16) | One `<agent-3d>` per page is the safe default. For several characters, use iframes or `<agent-stage>` to share a context. See [Embedding Guide](/docs/embedding.md). |

---

## What you learned

- How to read the character library from its API, and which manifest fields decide a good pick
- That `animations: 1` counts clips in the file, and that the real motion library is retargeted at runtime onto any humanoid skeleton
- A one-request, no-browser proof that a character's rig accepts poses before you build anything around it
- The minimal `<agent-3d>` embed, and why `kiosk`, `clip`, no-`brain`, and a fallback child are each the right default for a decorative character
- The CORS failure that only shows up in production, and the one-attribute fix
- `playClip` versus `play`, and why loop inference and reduced-motion handling belong in the runtime rather than your page
- The exact precedence rules for `src`, `avatar-id`, `agent-id`, `manifest`, and `body`, and when graduating from a URL to a UUID pays off
- How to read a per-character license instead of assuming one for the library

## Next steps

- Give the character a voice and a real conversation, host-paid and keyless: [Add a 3D avatar assistant to your site](/docs/tutorials/add-a-3d-assistant.md).
- Make it react to clicks, scrolls, form submits, and route changes instead of just buttons: [Trigger the agent from page events](/docs/tutorials/trigger-from-page-events.md).
- Author your own motion on the character you picked: [Animate your avatar](/docs/tutorials/animate-your-avatar.md).
- Render the same character as a static image for social cards and email: [Put a 3D avatar in an `<img>` tag](/docs/tutorials/render-avatar-images.md).
- Skip the hand-written HTML and publish a configured widget instead: [Widget Studio](/docs/widget-studio.md) and the [Embedding Guide](/docs/embedding.md).
- Reference pages for everything used here: [Character Library](/docs/character-library.md), [Animations](/docs/animations.md), [Media & Render API](/docs/media-api.md).
