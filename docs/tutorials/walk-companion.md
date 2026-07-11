# Add the Walk Companion to your site

By the end of this tutorial you'll have a **3D avatar walking across your own website** — a corner mascot that idles, follows the cursor, and waves on navigation, plus a full-page playground the visitor can steer with WASD or a touch joystick. You'll add it two ways: a zero-build iframe you can paste onto any page, and the `@three-ws/walk` npm package when you want the real site-wide companion.

Along the way you'll see what the [/walk](/walk) product offers — live demos across six environments, the one-tag embed, the Chrome extension that walks the whole web, and the distance leaderboard — and exactly which attributes and APIs are real.

**Prerequisites:** a website you can edit and a WebGL-capable browser. The iframe path needs no tooling at all; the npm path assumes light JavaScript familiarity and that you already bundle [Three.js](https://threejs.org) (>= 0.150).

---

## What you're building

Two surfaces, one engine:

```
Corner companion          Full-page playground
┌───────────────┐         ┌───────────────────────────┐
│ your page      │  click  │  ▢   walk across the page  │
│               │  ────▶  │      WASD / joystick       │
│        🤖 ◀ idles       │   ▢            ▢            │
│         follows cursor  │        🤖 strolling        │
└───────────────┘         └───────────────────────────┘
```

The companion mounts in a corner and stays out of the way: it idles, turns to follow the cursor, waves when the visitor navigates, and greets each page. Click it and it **detaches into a full-page playground** — the visitor steers across the page from a gentle aerial view, or platforms across your real DOM with gravity and jumps. Walk onto a link and it opens like a doorway into the next page.

This is the same engine that powers the walking companion on three.ws, published as the `@three-ws/walk` package.

---

## The /walk product (two minutes)

Before you embed it, it helps to know what the live [/walk](/walk) page exposes — every piece below is something you can link to or reuse:

| Surface | Route | What it is |
|---|---|---|
| Walk app | [/walk/app](/walk/app) | Drive your avatar with WASD or a touch joystick across six environments |
| Live demos | embedded on [/walk](/walk) | Real (not video) iframes for `beach`, `night`, `grid`, and more |
| One-tag embed | [/walk-embed](/walk-embed) | The chrome-less iframe you drop on any site |
| Chrome extension | [/extension](/extension) | Your avatar walks over every page you visit, reading them aloud |
| Distance leaderboard | [/walk-leaderboard](/walk-leaderboard) | The longest strolls on three.ws — daily, weekly, all-time |

The six built-in environments are fixed and need no HDRI downloads: `studio`, `void`, `beach`, `sunset`, `night`, `grid`. You select one with the `env` query param.

---

## Step 1: The one-tag embed (no build step)

The fastest way to put a walking avatar on a page is the [/walk-embed](/walk-embed) iframe. It's intentionally chrome-less — no nav, no footer — so it drops cleanly into a card or a corner.

```html
<!-- three.ws Walk — drop in anywhere -->
<iframe
  src="https://three.ws/walk-embed?env=void&autoplay=true"
  width="360" height="480"
  style="border:0;background:transparent"
  title="three.ws walking avatar"></iframe>
```

That's the exact snippet the [/walk](/walk) page hands out. The background is transparent, so the avatar floats over whatever your page already has behind it.

### Embed query params

The embed reads its world and controls from the URL. The verified params:

| Param | Values | Effect |
|---|---|---|
| `env` | `studio` `void` `beach` `sunset` `night` `grid` | The environment (default scene if omitted) |
| `autoplay` | `true` | Start animating immediately |
| `controls` | `joystick` `keyboard` `none` | How (or whether) the visitor steers |
| `orbit` | `true` `false` | Allow drag-to-orbit the camera |
| `avatar` | a roster id or your avatar id | Which avatar walks |

A live, drivable demo on a beach:

```html
<iframe
  src="https://three.ws/walk-embed?env=beach&controls=joystick&autoplay=true"
  width="100%" height="520"
  style="border:0;background:transparent"
  title="Walk on the beach"
  allow="accelerometer; gyroscope"></iframe>
```

A passive showpiece (no controls, just walking) for a hero section:

```html
<iframe
  src="https://three.ws/walk-embed?env=void&autoplay=true&controls=none&orbit=false"
  width="360" height="480"
  style="border:0;background:transparent"
  title="three.ws walking avatar"></iframe>
```

The `allow="accelerometer; gyroscope"` attribute lets the joystick respond to device tilt on mobile. Add it whenever `controls=joystick`.

---

## Step 2: Drive the embed from the host page (postMessage)

The embed isn't a black box — it speaks a versioned `postMessage` contract so your page can tell the avatar where to walk, what to say, and which environment to show. The contract is defined in [src/walk-embed-events.js](../../src/walk-embed-events.js) and documented interactively at [/docs/walk-embed-api](/docs/walk-embed-api).

Every message is namespaced to the `three-walk` channel and carries a protocol version, so it never collides with other `message` listeners on your page.

```html
<iframe id="walk" src="https://three.ws/walk-embed?env=studio&autoplay=true"
  width="360" height="480" style="border:0;background:transparent"
  title="three.ws walking avatar"></iframe>

<script>
  const frame = document.getElementById('walk');
  const send = (type, payload = {}) =>
    frame.contentWindow.postMessage({ channel: 'three-walk', v: 1, type, ...payload }, '*');

  // Wait for the avatar to load before commanding it.
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;          // source check = auth
    const msg = e.data;
    if (!msg || msg.channel !== 'three-walk') return;

    if (msg.type === 'walk:ready') {
      send('walk:say', { text: 'Hi — thanks for visiting.' });
      send('walk:goto', { x: 4, z: 0 });                    // walk to a world spot
    }
    if (msg.type === 'walk:position') {
      // { x, z, heading } streams ~10 Hz while the avatar moves
    }
  });
</script>
```

The commands a host can send (inbound) and the events the iframe emits (outbound), straight from the contract:

| Direction | Message | Payload |
|---|---|---|
| host → iframe | `walk:goto` | `{ x, z }` — walk to a world position, then stop |
| host → iframe | `walk:gesture` | `{ gesture }` — one of `idle` `walk` `run` `wave` `jump` |
| host → iframe | `walk:say` | `{ text, voice?, durationMs? }` |
| host → iframe | `walk:env` | `{ env }` — one of the six environments |
| host → iframe | `walk:avatar` | `{ avatarId }` |
| host → iframe | `walk:config` | `{ speed?, bg?, controls? }` |
| iframe → host | `walk:ready` | `{ avatarId, env }` (fires once, when loaded) |
| iframe → host | `walk:position` | `{ x, z, heading }` (~10 Hz while moving) |
| iframe → host | `walk:gesture` | `{ gesture }` |
| iframe → host | `walk:speak` | `{ text, durationMs }` |
| iframe → host | `walk:error` | `{ code, message }` |

Two things the runtime enforces, so plan around them:

- **The source check is the authentication.** The iframe only accepts messages whose source is its parent window; your host listener should likewise gate on `e.source === frame.contentWindow`. The optional origin allow-list is belt-and-suspenders on top of that.
- **Inputs are clamped and bounded.** `walk:goto` coordinates are clamped to the world radius (about ±11.5m), `walk:say` text is capped at 280 characters, and unknown commands come back as a `walk:error` rather than silently failing.

If you mount the iframe *after* it has already loaded and miss the initial `walk:ready`, send `walk:ping` and the iframe re-emits `walk:ready`.

---

## Step 3: The real site-wide companion (npm)

The iframe is great for a fixed card. For the actual corner-mascot-plus-playground experience that follows the visitor across your whole site, install the SDK.

```bash
npm install @three-ws/walk three
```

`three` is a **peer dependency** — the package brings none of its own; you supply >= 0.150 from your app.

```js
import { createWalkCompanion } from '@three-ws/walk';

const walk = createWalkCompanion();
walk.bootstrap();
```

`createWalkCompanion` is **side-effect free on import** — nothing touches the DOM, and no Three.js is fetched, until you call `bootstrap()` or `enable()`. A page that never turns the companion on pays nothing for shipping the import.

`bootstrap()` is the app-style entry: it auto-mounts based on the visitor's saved preference, honors `?walk=` deep links, and resumes the playground after a page "dive." If you'd rather drive it yourself:

```js
const walk = createWalkCompanion({ defaultAvatarId: 'fox' });

walk.enable();                 // mount the corner companion
walk.openPicker();             // let the visitor choose an avatar
walk.setAvatar('michelle');    // persist + hot-swap the live avatar
walk.disable();                // remove it
```

The returned control object surface:

```ts
walk.isEnabled(): boolean
walk.enable(): void
walk.disable(): void
walk.toggle(): void
walk.setAvatar(idOrEntry): void   // persist + hot-swap the live avatar
walk.openPicker(): void
walk.bootstrap(): void            // auto-mount + ?walk= deep links
walk.instance                     // the live companion (or null)
```

### URL controls

Once `bootstrap()` is wired, these query params work on any page:

- `?walk=1` — force the companion on
- `?walk=0` — force it off
- `?walk=play` — deep-link straight into the full-page playground
- `?avatar=<id>` — load a specific avatar (a roster id, or one of your own)

---

## Step 4: Point the SDK at your assets

The companion needs two sets of assets served from your origin (or a CDN you point at). The defaults match the three.ws layout; override them when yours differ.

- The avatar GLBs the roster references (e.g. `/avatars/*.glb`).
- The shared animation manifest + clips (`/animations/manifest.json` + clips), used to retarget motion onto rigs that ship no locomotion.

```js
createWalkCompanion({
  assetBase: 'https://cdn.example.com',   // prepended to static GLB paths
  apiBase: '',                            // prepended to the /api/avatars/<id>/glb proxy
  manifestUrl: '/animations/manifest.json',
  docsUrl: '/avatar-studio',              // "make your own" link in the picker footer
}).bootstrap();
```

Other options worth knowing: `excludedRoutes` (path prefixes where the companion never mounts — full-screen 3D routes by default), `enablePicker` (set `false` to hide the avatar switcher), `greeting` (a `(path) => string | null` to customise the per-page hello), and `storagePrefix` (the localStorage/sessionStorage key namespace, default `walk`).

---

## Step 5: Choose who walks — the roster

Every visitor can pick who walks with them from a built-in roster: a robot mascot, humanoids, a fox, dancers, and showpieces. Each entry declares a rig strategy so it **always moves** — nothing freezes in a bind/T-pose:

| `rig` | Used for | How it animates |
|---|---|---|
| `embedded` | self-animated or non-humanoid GLBs (robot, fox) | plays the clips baked into the GLB; falls back to the first clip so it never freezes |
| `shared` | humanoids with no locomotion (or only a T-pose) | retargets the shared clip library (`idle`/`walk`/`run`/`wave`/`jump`) onto the rig |

The default avatar is `robot`. To extend the roster with your own brand mascot:

```js
import { createWalkCompanion, WALK_AVATARS } from '@three-ws/walk';

createWalkCompanion({
  avatars: [
    ...WALK_AVATARS,
    {
      id: 'mascot',
      name: 'Our Mascot',
      category: 'Brand',
      asset: '/brand/mascot.glb',
      source: 'static',
      rig: 'shared',      // retarget the shared library onto it
      accent: '#ff0066',
    },
  ],
  defaultAvatarId: 'mascot',
}).bootstrap();
```

User-generated avatars served by the GLB proxy (`/api/avatars/<id>/glb`) resolve at runtime via `makeApiAvatarEntry(id)` — you don't have to list them.

---

## Step 6: Walk the whole web — the Chrome extension

The embed and SDK put the avatar on *your* site. The Chrome extension puts it on *every* site the visitor opens. Link to [/extension](/extension) from your page, or just point people there.

What the extension does, per the product page:

- The avatar walks over any page the user visits — articles, docs, social feeds.
- It reads pages aloud as it strolls — a living browsing companion.
- The visitor picks any of their three.ws avatars from the popup and switches in one click.
- Minimal permissions, no tracking. Privacy details are on [/extension/privacy](/extension/privacy).

This is the one path you don't embed — you point your visitors at the install. It's the most ambitious surface of the [/walk](/walk) product, and the strongest reason to give your users a three.ws avatar in the first place.

---

## Step 7: The distance leaderboard

Every stroll logs distance, and the longest ones climb the global board at [/walk-leaderboard](/walk-leaderboard) — ranked daily, weekly, and all-time. The data is real, served from `/api/walk/leaderboard`, so you can surface a "top walkers" teaser on your own page:

```js
async function loadTopWalkers() {
  const res = await fetch(
    'https://three.ws/api/walk/leaderboard?period=all-time&metric=distance',
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // The endpoint may return { leaders } | { walkers } | { entries } | [...]
  const rows = Array.isArray(data)
    ? data
    : data.leaders || data.walkers || data.entries || data.results || data.data || [];
  return rows.slice(0, 3); // each: { name, distance, image_url?, url? }
}
```

Format distances for display the way the live page does — meters under 1km, kilometres above:

```js
function formatDistance(meters) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m <= 0) return '—';
  if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km';
  return Math.round(m) + ' m';
}
```

Always design the empty and error states: a fresh deployment has no walks logged yet, and a transient fetch failure should offer a retry rather than a blank panel.

---

## Troubleshooting

- **Iframe is blank / "loading avatar…" never clears** — the host needs WebGL. Confirm the browser is WebGL-capable and the page isn't blocking the iframe with a restrictive `Content-Security-Policy` `frame-src`. The embed ships `frame-ancestors *`, so it's the host CSP that usually blocks it.
- **postMessage commands do nothing** — you're probably sending before `walk:ready`. Wait for the `walk:ready` event, or send `walk:ping` to re-trigger it. Also confirm your envelope is `{ channel: 'three-walk', v: 1, type, ...payload }` — messages without the channel are ignored unless they use a known legacy `walk:*` type.
- **`walk:goto` lands somewhere unexpected** — coordinates are clamped to the world radius (~±11.5m). A target outside the ground disc is pulled back in.
- **`walk:env` rejected with a `walk:error`** — `env` must be exactly one of `studio` `void` `beach` `sunset` `night` `grid`. Anything else is refused.
- **Avatar shows a frozen T-pose** — that means the rig strategy is wrong for the GLB. A humanoid that ships only a T-pose must use `rig: 'shared'` so the shared clip library is retargeted onto it; `embedded` is only for GLBs that carry their own clips.
- **SDK throws on import about `three`** — `three` is a peer dependency. Install it (`npm install three`) and make sure your bundle resolves a single copy >= 0.150.
- **Companion never appears after `bootstrap()`** — check it's not an excluded route. By default the corner mascot skips full-screen 3D paths (`/walk`, `/walk-embed`, `/play`, `/ar`, and similar). Override `excludedRoutes` if your paths overlap.
- **The companion loaded Three.js on a page that doesn't use it** — it shouldn't: `createWalkCompanion` is side-effect-free on import and fetches nothing until `enable()`/`bootstrap()`. If you see a fetch, something is calling `enable()` unconditionally.

---

## Recap

You added a walking 3D avatar to your site three ways and learned what the [/walk](/walk) product ships:

- **One-tag embed** — paste the [/walk-embed](/walk-embed) iframe, pick the world and controls with query params (`env`, `controls`, `orbit`, `avatar`). No build step.
- **postMessage contract** — drive the embed from the host page with `walk:goto` / `walk:say` / `walk:env` and listen for `walk:ready` / `walk:position`, on the versioned `three-walk` channel. Full reference at [/docs/walk-embed-api](/docs/walk-embed-api).
- **`@three-ws/walk` SDK** — `createWalkCompanion().bootstrap()` mounts the real corner companion plus the full-page playground, side-effect-free until enabled, with a built-in avatar picker and a two-strategy roster that never T-poses.
- **The product surfaces** — the [/extension](/extension) that walks the whole web, and the distance [/walk-leaderboard](/walk-leaderboard) you can read from `/api/walk/leaderboard`.

The leverage is composability: the same engine renders the corner mascot, the full-page playground, the standalone embed, and the extension — so an avatar you build once walks everywhere.

## See also

- [3D store guide for Shopify](/tutorials/shopify-store-guide) — the same engine as a guided tour: the avatar walks a storefront, spotlights sections, and narrates each one
- [Walk docs](/docs/walk) — the full developer + user reference for the walking-avatar system
- [Walk embed API](/docs/walk-embed-api) — interactive playground for the postMessage contract
- [Swap your avatar in Studio](/docs/tutorials/swap-avatar-in-studio) — build the avatar that walks
- [Embed your agent on a website](/docs/tutorials/embed-on-website) — the other side of putting three.ws on your page
