# Demo routes

The canonical map of every `/demo/*` and `/demos/*` route as of
2026-08-14. Update whenever a route is added, removed, or moved.

The demo namespace splits in two:

- `/demo` and `/demo/<slug>/` — full standalone demos that own their URL
  space (multiple sub-pages, dynamic segments). `/demo` (no slug) is the
  agent-economy demo (`pages/demo-economy.html`); the rest live in
  `public/demo/<slug>/`.
- `/demos/<slug>` — single-page lab demos. Index hub is `/demos/`; the
  agent-interaction sub-lab is `/demos/agents/`. Each lives in
  `public/demos/<slug>.html`.

Production routing is in [vercel.json](../vercel.json); the matching
Vite dev-server middleware is in [vite.config.js](../vite.config.js).
Both must be kept in sync.

Every row below was verified against production (`https://three.ws`)
with `curl -sIL`, not read from config alone. Rows added after that
sweep are marked in the [Verification notes](#verification-notes-2026-08-05)
at the end, which also records what each later pass actually checked.

## Routes

| Route | Page file | What it does |
|---|---|---|
| `/demo` | `pages/demo-economy.html` | Agent Economy demo — two AI agents pay each other on-chain. |
| `/demo/coin` | `public/demo/coin/index.html` | Lottery + reflection demo on a single Pump.fun coin (real-time holder feed, payout history). |
| `/demo/coin/<mint>` | `public/demo/coin/index.html` | Same page hydrated for a specific base58 mint address (32–44 chars). |
| `/demo/avatar-os/` | `public/demo/avatar-os/index.html` | OSS avatar pipeline hub linking to the three sub-pages below. |
| `/demo/avatar-os/studio.html` | `public/demo/avatar-os/studio.html` | Avatar Studio (rebranded Character Studio fork) embed. |
| `/demo/avatar-os/selfie.html` | `public/demo/avatar-os/selfie.html` | Selfie-to-avatar flow. |
| `/demo/avatar-os/combined.html` | `public/demo/avatar-os/combined.html` | Studio + selfie shown side-by-side. |
| `/demos/` | `public/demos/index.html` | Index of all lab demos. |
| `/demos/3d-home` | `public/demos/3d-home.html` | "Give your AI a body" homepage demo. |
| `/demos/404.html` | `public/demos/404.html` | Lost-avatar 404 page: she falls in from off-screen, lands on the `0` with a dust splash, and runs offscreen before the redirect fires. Carries its own card in the `/demos/` index and doubles as the lab's not-found page; `noindex`. |
| `/demos/audio2face` | `public/demos/audio2face.html` | NVIDIA Audio2Face-3D lipsync: type text, hear it in NVIDIA Magpie's voice, watch the avatar's face animate via ARKit blendshapes. |
| `/demos/avatar-sdk` | `public/demos/avatar-sdk.html` | `@three-ws/avatar` SDK walkthrough. |
| `/demos/bonding-curve` | `public/demos/bonding-curve.html` | Bonding curve simulator. |
| `/demos/brain` | `public/demos/brain.html` | Multi-LLM brain router. |
| `/demos/button` | `public/demos/button.html` | Tactile button experiment. |
| `/demos/button-jump` | `public/demos/button-jump.html` | Tactile button + jump animation variant. |
| `/demos/create-v2` | `public/demos/create-v2.html` | Create-avatar v2 flow. |
| `/demos/eas-reputation` | `public/demos/eas-reputation.html` | Reputation attestations on Base via EAS. |
| `/demos/erc8004` | `public/demos/erc8004.html` | ERC-8004 registry browser. |
| `/demos/checkout` | `public/demos/checkout.html` | Subscription checkout flow. |
| `/demos/gallery-picker` | `public/demos/gallery-picker.html` | Avatar gallery picker UI. |
| `/demos/halfbody-xr` | `public/demos/halfbody-xr.html` | Half-body avatar in WebXR. |
| `/demos/login` | `public/demos/login.html` | Auth / sign-in flow demo. |
| `/demos/login-2` | `public/demos/login-2.html` | Alternate sign-in UI variant. |
| `/demos/lipsync-mic` | `public/demos/lipsync-mic.html` | Audio-driven lipsync from microphone. |
| `/demos/lipsync-tts` | `public/demos/lipsync-tts.html` | TTS-driven lipsync. |
| `/demos/livepeer-inference` | `public/demos/livepeer-inference.html` | Decentralized inference via Livepeer. |
| `/demos/memory-seed` | `public/demos/memory-seed.html` | Agent memory seeding flow. |
| `/demos/persona-extract` | `public/demos/persona-extract.html` | Persona extraction from social handles. |
| `/demos/pricing` | `public/demos/pricing.html` | Plan pricing page demo. |
| `/demos/react-sdk` | `public/demos/react-sdk.html` | `@three-ws/avatar/react` SDK walkthrough. |
| `/demos/selfie-fit` | `public/demos/selfie-fit.html` | Selfie-fit avatar pipeline. |
| `/demos/skill-royalty` | `public/demos/skill-royalty.html` | Skill royalty distribution demo. |
| `/demos/usdz-ar` | `public/demos/usdz-ar.html` | USDZ + AR Quick Look (iOS). |
| `/demos/voice-clone` | `public/demos/voice-clone.html` | Voice cloning demo. |
| `/demos/walk-embed-sdk` | `public/demos/walk-embed-sdk.html` | Walk animation embed via SDK. |

`public/demos/404.html` does double duty: it is the lab's designed
not-found page (the `/demos/` index embeds it as a hidden empty-state)
and a demo in its own right, carrying its own card in the index grid.
That card is why it is listed in the table above. The extensionless
`/demos/404` resolves to the same file through the generic rewrite, but
nothing links it that way and the page is `noindex`, so prefer the
explicit `.html` form the index card uses.

The legacy `/lipsync`, `/lipsync/mic`, and `/audio2face` shortcuts in
`vercel.json` still resolve to the `/demos/lipsync-*.html` and
`/demos/audio2face.html` files above. They predate the
`/demos/` namespace and are kept for backward compatibility (prefer the
`/demos/<slug>` form for new links).

### Agent interaction lab — `/demos/agents/*`

Single-purpose demos of an avatar reacting to the page. Index hub is
`/demos/agents/` (`public/demos/agents/index.html`), linked from the main
`/demos/` index. Each page lives at `public/demos/agents/<slug>.html` and
is served straight from the filesystem at that `.html` path; the
extensionless `/demos/agents/<slug>` form is a dev-only convenience
(`vite.config.js` middleware). The only `/demos/agents` rule in
`vercel.json` is the hub rewrite (`/demos/agents` and `/demos/agents/`
both serve `public/demos/agents/index.html`), so in production the
`.html` form is the only one that resolves for a sub-demo, which is the
form the hub links. Extensionless agent slugs 404. The routes below use
that canonical `.html` form.

| Route | Page file | What it does |
|---|---|---|
| `/demos/agents` | `public/demos/agents/index.html` | Hub for the lab below, linked from the `/demos/` index. `/demos/agents/` reaches it too: `vercel.json` carries an explicit rewrite for both forms. |
| `/demos/agents/auto-rig.html` | `public/demos/agents/auto-rig.html` | Auto-rigging an imported mesh. |
| `/demos/agents/builds-button.html` | `public/demos/agents/builds-button.html` | Agent assembles a CTA button. |
| `/demos/agents/climb-title.html` | `public/demos/agents/climb-title.html` | Agent climbs the page title. |
| `/demos/agents/cursor-follower.html` | `public/demos/agents/cursor-follower.html` | Agent tracks the cursor. |
| `/demos/agents/face-mocap.html` | `public/demos/agents/face-mocap.html` | Webcam face mocap drives the avatar. |
| `/demos/agents/fall-from-top.html` | `public/demos/agents/fall-from-top.html` | Agent drops in from the top of the viewport. |
| `/demos/agents/falls-asleep.html` | `public/demos/agents/falls-asleep.html` | Idle agent falls asleep. |
| `/demos/agents/gemini-live.html` | `public/demos/agents/gemini-live.html` | Live conversation via Gemini. |
| `/demos/agents/high-five.html` | `public/demos/agents/high-five.html` | Agent high-fives on click. |
| `/demos/agents/holds-cta.html` | `public/demos/agents/holds-cta.html` | Agent holds up the call-to-action. |
| `/demos/agents/pickup-drop.html` | `public/demos/agents/pickup-drop.html` | Pick up and drop the agent. |
| `/demos/agents/scroll-inertia.html` | `public/demos/agents/scroll-inertia.html` | Agent reacts to scroll inertia. |
| `/demos/agents/sit-in-body.html` | `public/demos/agents/sit-in-body.html` | Agent sits inside body copy. |
| `/demos/agents/skateboard.html` | `public/demos/agents/skateboard.html` | Agent skateboards across the page. |
| `/demos/agents/trampoline.html` | `public/demos/agents/trampoline.html` | Agent bounces on a trampoline. |
| `/demos/agents/walks-gutter.html` | `public/demos/agents/walks-gutter.html` | Agent walks the page gutter. |
| `/demos/agents/wrecking-ball.html` | `public/demos/agents/wrecking-ball.html` | Wrecking-ball physics demo. |

## Related demo pages (outside `/demo` and `/demos`)

Page files that carry a `demo-`/`coin` name or alias into the lab but
live at their own top-level URLs:

| Route | Page file | What it does |
|---|---|---|
| `/coin3d` | `pages/coin3d.html` | Token-in-3D visualizer. |
| `/embed-demo` | `pages/embed-demo.html` | Avatar embed demo. |
| `/hero-demo` | `pages/hero-demo.html` | Cinematic 3D hero stage: a lit avatar over glowing rings and a starfield, with pointer parallax. |
| `/lipsync` | `public/demos/lipsync-tts.html` | Alias into the lab: TTS-driven lipsync. |
| `/lipsync/mic` | `public/demos/lipsync-mic.html` | Alias into the lab: mic/audio-driven lipsync. |
| `/audio2face` | `public/demos/audio2face.html` | Alias into the lab: NVIDIA Audio2Face-3D lipsync. |

## Legacy redirects

| Old | New | Configured in |
|---|---|---|
| `/coin` | `/demo/coin` | `vercel.json` (301), mirrored in `vite.config.js` middleware for dev. |
| `/coin/` | `/demo/coin` | `vercel.json` (301), mirrored in `vite.config.js` middleware for dev. |

Both redirects land on a `200` (`/demo/coin`) after following the
30x. The legacy `pages/pump-coin-page.html` has been removed —
`/pump-coin-page` now `404`s and `/demo/coin` is the only coin demo URL.

## Adding a new demo

1. Create the page under `public/demos/<slug>.html` (single-page lab
   demo) or `public/demo/<slug>/index.html` (multi-page demo with its
   own URL space).
2. If the demo has inline `<script type="module">` blocks that import
   from `/src/*` or pull in heavy SDKs, register it under
   `build.rollupOptions.input` in `vite.config.js` so the bundler
   processes its scripts. (Most `/demos/<slug>` pages do not need this
   — they're served as plain HTML.)
3. For multi-page demos (`/demo/<slug>/`), add entries to both
   `fileMap` and the `dirRoutes` set in `vite.config.js` so the dev
   server serves the directory index and adds the trailing-slash
   redirect that lets relative imports resolve.
4. Add the production route to `vercel.json` if the URL does not match
   the file path directly:
   - For `/demos/<slug>` the regex
     `"/demos/([^/.]+)" → "/demos/$1.html"` already covers it.
   - For `/demo/<slug>/*` add explicit `dest` rewrites following the
     `/demo/avatar-os/*` pattern.
5. Add a row to the table above.
6. Curl-verify locally:

   ```bash
   npm run dev
   curl -sIL -o /dev/null -w "%{http_code} %{url_effective}\n" \
     http://localhost:3000/<route>
   ```

   The route must return `200` (or `301` → 200 for a documented
   legacy redirect).

## Verification notes (2026-08-05)

Re-verified against production (`https://three.ws`) with `curl -sIL`:

- Every route in the tables above returns **200**. `/coin` and `/coin/`
  return **301 → `/demo/coin` → 200**.
- All 27 `/demos/<slug>` pages return 200 in the extensionless form (the
  `vercel.json` rewrite) and the `.html` form; in-page links use `.html`.
- All 17 `/demos/agents/<slug>.html` pages return 200. The extensionless
  form 404s in production (dev-only, see the agents section above).
- **The `/demos/agents` hub 404 recorded here is fixed** (2026-08-14).
  It was a real production gap for as long as the hub existed: the
  generic `/demos/([^/.]+)` rewrite mapped `/demos/agents` to the
  nonexistent `/demos/agents.html`, and the trailing-slash form is
  301-normalized to the slashless one before any directory index can
  resolve, so the `/demos/` index linked a URL that could not be served.
  It stayed invisible because the dev server has explicit `fileMap`
  entries for both forms in `vite.config.js`. `vercel.json` now carries
  a `/demos/agents` rewrite to `/demos/agents/index.html` (and one for
  `/demos/agents/`), placed above the generic slug rule so it wins.
- Directory URLs with a trailing slash (`/demos/`, `/demo/`,
  `/demo/avatar-os/`) return **301** to the slashless form, which serves
  the index with 200.
- `/demo/avatar-os/studio` (no `.html`) 404s and is **not** a
  supported URL: the avatar-os hub links its sub-pages with the `.html`
  extension, which is the canonical form. Same for the other avatar-os
  sub-pages.
- `/app-demo` and `/avatar-studio-demo` have been removed (pages and
  routes are gone; both 404) and no longer appear in the tables above.

## Later pass (2026-08-14)

Not a production sweep. Every route in the tables was resolved through
the same route table the server runs (`scripts/lib/page-routing.mjs`
loads `vercel.json` and `server/index.mjs` serves from it), against the
files on disk. That catches a route pointing at nothing, which is what
the agents-hub gap was; it does not catch CDN or revision problems, so
the 200s above still come from the 2026-08-05 curl sweep.

- All 62 rows resolve to a built file, with two deliberate exceptions:
  the `/coin` and `/coin/` rows resolve to a 301, and their second
  column names the redirect target rather than a file.
- Every `.html` file under `public/demos/` and `public/demo/` now has a
  row. Two had none: `public/demos/agents/index.html`, covered in prose
  but absent from the agents table, and `public/demos/404.html`, which
  was deliberately excluded as "not a content demo" despite carrying its
  own card in the `/demos/` index grid.
- The `/demos/<slug>` count is unchanged at 27. The two rows added here
  are the agents hub and the 404 page, neither of which is a lab slug.
