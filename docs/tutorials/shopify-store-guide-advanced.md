# Advanced: Customize Your Shopify 3D Store Guide

The [no-code guide](/tutorials/shopify-store-guide) gets a walking 3D guide onto your store in ten minutes with the [Tour Builder](/tour-builder). This guide is for when you want to hand-tune everything: exact section targeting, **multi-page tours** that cross your whole catalog, **real spoken voices**, your **own avatar**, autostart and deep links, and the **JavaScript API** for wiring the tour into your theme's own buttons and events.

Everything here is still just a script tag and a JSON file — no build step, no Shopify app. It's the same [`@three-ws/tour`](https://www.npmjs.com/package/@three-ws/tour) engine, driven by hand.

**Prerequisites:** you can edit theme code (**Online Store → Themes → ⋯ → Edit code**) and you're comfortable with HTML/CSS selectors. Start from a curriculum exported by the [Tour Builder](/tour-builder) — it's the fastest way to a correct starting file.

---

## The curriculum, in full

The tour is driven by one JSON document. Here's every field that matters:

```json
{
  "title": "Northwind Goods — store tour",
  "tagline": "Handmade homeware, walked and narrated",
  "tracks": [
    { "id": "full", "title": "Full tour" },
    { "id": "quick", "title": "Quick highlights" }
  ],
  "sections": [
    { "id": "home", "title": "Homepage" },
    { "id": "catalog", "title": "Catalog" }
  ],
  "stops": [
    {
      "id": "welcome",
      "path": "/",
      "section": "home",
      "title": "Welcome",
      "sectionIntro": "Welcome to Northwind — let me show you around.",
      "narration": "Everything here is small-batch and made by hand. This button opens the full collection.",
      "highlight": true,
      "targets": ["#Banner a.button", ".hero a.button", "a.button--primary"]
    },
    {
      "id": "bestsellers",
      "path": "/collections/bestsellers",
      "section": "catalog",
      "title": "Bestsellers",
      "sectionIntro": "Now let's look at what everyone's buying.",
      "narration": "These restock every week. The pour-over set is our most-gifted piece.",
      "highlight": true,
      "targets": ["#product-grid", ".collection .grid"]
    }
  ]
}
```

**Top level**
- `title`, `tagline` — shown in the chapter map and share surfaces.
- `tracks` — the selectable views. `full` visits every stop; `quick` visits only stops with `"highlight": true`. Keep both.
- `sections` — logical groups. Each stop names one `section`; the first stop of a section can carry a `sectionIntro` that's spoken as a bridge.

**Each stop**
- `path` — the route the stop lives on. **This is what makes multi-page tours work** (below). `/` and trailing-slash variants are normalized.
- `title` — the short name in the chapter map.
- `narration` — what the guide says. One or two sentences reads best.
- `sectionIntro` — an optional line spoken once before this stop, to bridge into a new chapter. Usually only on a section's first stop.
- `highlight` — include this stop in the Quick track.
- `targets` — **an ordered list** of CSS selectors for the element to walk to and spotlight. The first one that's visible wins. This is the single most important field to get right — see below.

---

## Targeting exact sections

The guide walks to whatever `targets` resolves to. Getting these right is what separates a polished tour from one that spotlights the wrong box.

**Three ways to target, best first:**

### 1. Tag the element in your theme (most robust)

Add `data-tour-target` to any element in your section's Liquid, and leave it out of `targets` (or list it):

```liquid
{% comment %} sections/featured-collection.liquid {% endcomment %}
<div class="collection" data-tour-target>
  ...
</div>
```

Now the stop finds it automatically. This survives theme updates and CSS changes because it doesn't depend on class names.

### 2. Use a stable selector list

Themes change class names between versions, so give the tour **fallbacks** — list the most specific selector first, then broader ones:

```json
"targets": ["#FeaturedCollection", ".featured-collection", ".collection", "main .grid"]
```

The first visible match wins. If a theme update renames `#FeaturedCollection`, the tour falls back to `.collection` instead of breaking. To find a selector: on your live store, right-click the section → **Inspect**, and read the element's `id`/`class` in the dev tools.

### 3. Let it fall back

If none of a stop's `targets` match anything visible, the guide gracefully falls back to the page's main heading or primary button — so a stale selector degrades to "roughly right," never to a crash.

**Common Shopify (Dawn-family) selectors to start from:**

| Section | Typical selectors |
| --- | --- |
| Hero / banner | `.banner`, `#Banner`, `.slideshow` |
| Hero button | `.banner a.button`, `.button--primary` |
| Featured collection | `#FeaturedCollection`, `.featured-collection`, `.collection` |
| Rich text / About | `.rich-text`, `[id^="RichText"]` |
| Product grid | `#product-grid`, `.product-grid`, `.grid--collection` |
| Reviews app | `.spr-reviews`, `.jdgm-widget`, `.testimonials` |
| Footer blocks | `.footer-block`, `.multicolumn` |

Your theme may differ — always confirm with Inspect.

---

## Multi-page tours

Set different `path` values and the guide **navigates your store for you**, picking up the tour on the next page exactly where it left off (state is kept in `sessionStorage`). A tour that starts on `/`, walks the homepage, then continues on `/collections/bestsellers` and `/pages/about` just works:

```json
"stops": [
  { "id": "welcome",  "path": "/",                        "section": "home",    "narration": "…", "targets": ["#Banner"] },
  { "id": "shop",     "path": "/collections/bestsellers", "section": "catalog", "narration": "…", "targets": ["#product-grid"] },
  { "id": "about",    "path": "/pages/about",             "section": "story",   "narration": "…", "targets": [".rich-text"] }
]
```

When the guide reaches the end of the homepage stops, it walks to a link, the page changes, and the tour resumes on the collection page. Make sure each `path` is a real, published route on your store.

---

## Every script-tag option

The one-tag install reads `data-*` attributes:

```html
<script src="https://unpkg.com/@three-ws/tour@0.5.1/dist/tour.global.js"
        data-tour
        data-curriculum="https://cdn.shopify.com/s/files/…/curriculum.json"
        data-avatar="realistic-male"
        data-tts-endpoint="https://your-worker.example.com/speak"
        data-asset-base="https://three.ws"
        data-manifest-url="https://three.ws/animations/manifest.json"
        defer></script>
```

| Attribute | Default | What it does |
| --- | --- | --- |
| `data-curriculum` | — (required) | URL of your curriculum JSON |
| `data-avatar` | `realistic-female` | Which guide walks the store — any avatar id (see below) |
| `data-mode` | `guided` | `guided` (the avatar walks itself), `explore` (the visitor drives it), or `platformer` (explore with gravity + jumping) — see below |
| `data-autostart` | off | `full` or `quick` — start the tour automatically on page load |
| `data-tts-endpoint` | off | A POST endpoint that returns audio for spoken narration. Without it, narration plays as paced on-screen captions |
| `data-asset-base` | `https://three.ws` | Where avatar GLBs load from — point at your own CDN to self-host |
| `data-manifest-url` | `https://three.ws/animations/manifest.json` | The animation manifest — self-host by pointing here |

### Choosing the avatar

`data-avatar` accepts any id from the guide roster: `realistic-female` (Ava), `realistic-male` (Leo), `selfie-girl` (Mira), `michelle`, `guide`, and `robot`. Preview each one live in the [Tour Builder](/tour-builder) — those are the guides verified to stand and walk correctly on a storefront.

### Your own avatar

Bring a custom rigged GLB by self-hosting: upload your `.glb`, set `data-asset-base` to its origin, and reference its id. Any humanoid rig works — the engine retargets the walk/idle animations onto it automatically (that's the [`@three-ws/retarget`](https://www.npmjs.com/package/@three-ws/retarget) engine under the hood), so it never freezes in a T-pose. To build and rig an avatar from scratch, use [three.ws Studio](/start).

### Real spoken narration

By default, narration shows as timed captions — zero setup, no API key. For an actual **voice**, set `data-tts-endpoint` to an HTTPS endpoint that accepts `POST { text, voice }` and returns audio (`audio/mpeg`). Any text-to-speech service works behind a tiny proxy; the seven built-in voice ids are `nova`, `alloy`, `echo`, `fable`, `onyx`, `sage`, `shimmer`. Point the endpoint at your own worker so your keys stay server-side.

---

## Explore mode — let visitors drive the guide

Set `data-mode="explore"` (or pick **🕹 Explore** in the [Tour Builder](/tour-builder)) and the tour becomes an interactive, GTA-style experience: instead of the avatar walking itself, **the visitor drives it** with the arrow keys (or WASD) on desktop and an on-screen joystick on mobile. It's the real three.ws "Stroll" character — it **turns to face its heading and walks or runs in full 3D**, and the page scrolls under it so the whole store is walkable. Each stop becomes a glowing **checkpoint** anchored to its section. Walk the character into the active checkpoint and it stops, spotlights the section, and narrates it — then the next checkpoint lights up. Reach them all to finish.

```html
<script src="https://unpkg.com/@three-ws/tour@0.5.1/dist/tour.global.js"
        data-tour
        data-mode="explore"
        data-curriculum="https://cdn.shopify.com/s/files/…/curriculum.json"
        defer></script>
```

### Platformer mode — gravity, jumping, your DOM as the level

Set `data-mode="platformer"` (or pick **🎮 Platformer** in the [Tour Builder](/tour-builder)) for the same checkpoint experience with platformer physics: your store's real DOM — headings, product cards, buttons, images — becomes **solid ground**, and the visitor runs and **jumps** (Space, or the ⤒ button on mobile) from element to element to reach each checkpoint. It's the same engine as the platformer on the three.ws homepage.

The two interactive modes aren't a fork — they're the same quest. The visitor can flip between strolling and platforming **mid-tour** with the **M** key or the on-screen mode pill, and the checkpoints and progress carry across the switch. `data-mode` only picks which one it starts in.

Everything else works the same — same curriculum, same `targets`, same avatars, same start button. The checkpoint order follows your stop order. Notes:

- **It's single-page.** Explore runs on the stops resolvable on the current page (a checkpoint the visitor can't reach isn't useful). For a whole-catalog walkthrough, use `guided` mode with multi-page `path`s.
- **Reduced motion is respected.** Visitors with "reduce motion" enabled get the same checkpoints and narration, auto-walked in order — no driving, no motion.
- **The HUD** shows progress (`🎯 2 / 5`) and a hint; there's an always-visible ✕ to leave. It never blocks your store — the avatar and markers are pass-through.

Explore and Platformer are the more memorable, playful experiences (great for a launch, a lookbook, or a brand that wants visitors to *play* — Platformer especially rewards a store with strong visual sections to hop across); `guided` is the lower-effort, higher-completion default for pure conversion. Preview all three in the [Tour Builder](/tour-builder) before you choose.

---

## Autostart and shareable deep links

- **Autostart:** add `data-autostart="full"` (or `"quick"`) and the tour begins the moment the page loads — great for a campaign landing page.
- **Deep links:** the tour honors a `?tour=` query param out of the box. Share `yourstore.com/?tour=start` and the tour begins on arrival; `?tour=start&track=quick` starts the short version. Put that link in an email or an ad and visitors land mid-welcome.

---

## The JavaScript API

The one-tag install exposes the controller as `window.__featureTour`, so your theme's own buttons and events can drive it:

```html
<button onclick="window.__featureTour.start('full')">Take the full tour</button>
<button onclick="window.__featureTour.start('quick')">Quick highlights</button>
<a href="#" onclick="window.__featureTour.exit(); return false;">Skip</a>
```

| Method | What it does |
| --- | --- |
| `start('full' \| 'quick')` | Begin a track |
| `resume()` | Pick up an in-progress tour after a navigation |
| `exit()` | Tear the tour down |
| `isActive()` | `true` while a tour is running |
| `bootstrap()` | Re-apply the `?tour=` deep-link + resume logic (called for you on load) |

Any element with `data-tour-start` is also auto-wired as a start button (`data-tour-start="quick"` for the short track) — including elements your theme injects after load. That's usually all you need; reach for the API only when you want custom behavior.

Trigger the tour from a store event — e.g. start it the first time a new visitor lands:

```html
<script>
  addEventListener('DOMContentLoaded', () => {
    if (!localStorage.getItem('seen-tour')) {
      localStorage.setItem('seen-tour', '1');
      window.__featureTour?.start('quick');
    }
  });
</script>
```

---

## Pair it with a page narrator

The tour is the guided pitch. For a docked assistant that reads any page aloud — product descriptions, policies, headings — add [`@three-ws/page-agent`](https://www.npmjs.com/package/@three-ws/page-agent) alongside it:

```html
<script src="https://unpkg.com/@three-ws/page-agent@0.2.0/dist/page-agent.global.js"
        data-page-agent data-avatar="sol" defer></script>
```

It auto-discovers your `h1`/`h2`/`h3` headings and the copy beneath them, scrolls to each, and reads it with the browser's built-in speech — no backend. Control exactly what's read with `data-narrate="Say this instead"` and `data-narrate-order="1"` on your elements. The two coexist: the tour stands the narrator down while it runs.

Give the narrator a storefront persona with `preset="shop-assistant"` — it
resolves a shopping-focused greeting plus four tappable suggested-prompt
chips ("What am I looking at?", "Does this ship to me?", "What's the return
policy?", "Is this the right fit for me?") docked right under the avatar, no
extra config:

```html
<script src="https://unpkg.com/@three-ws/page-agent@0.2.0/dist/page-agent.global.js"
        data-page-agent data-avatar="nova" data-preset="shop-assistant" defer></script>
```

Or as the `<page-agent>` element:

```html
<page-agent avatar="nova" preset="shop-assistant"></page-agent>
```

See [`@three-ws/page-agent`'s Persona presets](https://www.npmjs.com/package/@three-ws/page-agent#persona-presets)
for the other four personas and the full `preset`/`context` reference.

---

## Content-Security-Policy

Stock Shopify themes (Dawn included) need **no changes** — this just works. A small number of themes ship a strict `Content-Security-Policy` that can block added scripts or their runtime styles. If the guide doesn't appear at all, or appears unstyled, add these sources to your theme's CSP:

- `script-src`: `https://unpkg.com` (the tour script) — or self-host it on your own domain
- `connect-src` and `img-src`: `https://three.ws` (avatar models + animation clips) — or your `data-asset-base` origin
- `style-src`: `'unsafe-inline'` (the tour injects its styles at runtime)

Self-hosting everything (the script under `data-asset-base`, the GLBs, and the manifest on your own CDN) removes every third-party origin from the equation if your security policy requires it.

---

## Self-hosting the assets

To serve everything from your own infrastructure — no `unpkg`, no `three.ws` at runtime:

1. Download `tour.global.js` from the [npm package](https://www.npmjs.com/package/@three-ws/tour) and host it on your domain; point the `<script src>` at it.
2. Mirror the avatar GLBs and the `animations/` manifest + clips to your CDN.
3. Set `data-asset-base` and `data-manifest-url` to your origins.

The clip URLs inside the manifest resolve **relative to the manifest**, so a self-hosted manifest pulls self-hosted clips automatically (fixed in `@three-ws/walk` 0.1.1+).

---

## Where to go next

- **[No-code store guide](/tutorials/shopify-store-guide)** — the ten-minute version with the Tour Builder.
- **[Tour Builder](/tour-builder)** — design, preview, and export without writing JSON by hand.
- **[Add a talking assistant](/tutorials/embed-on-website)** — a chat agent trained on your store's FAQ.
- **[`@three-ws/tour` on npm](https://www.npmjs.com/package/@three-ws/tour)** — the full package README and API.
