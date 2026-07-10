# Demo routes

The canonical map of every `/demo/*` and `/demos/*` route as of
2026-06-08. Update whenever a route is added, removed, or moved.

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

Every row below was verified against the live Vite dev server
(`npm run dev`, port 3000) with `curl -sIL`, not read from config alone.
See [Verification notes](#verification-notes-2026-06-08) at the end.

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

`public/demos/404.html` (`/demos/404`) is the lab's designed not-found
page, not a content demo — the `/demos/` index also embeds it as a
hidden empty-state. It is intentionally omitted from the table above.

The legacy `/lipsync`, `/lipsync/mic` shortcuts in `vercel.json` still
resolve to the `/demos/lipsync-*.html` files above. They predate the
`/demos/` namespace and are kept for backward compatibility — prefer the
`/demos/<slug>` form for new links.

### Agent interaction lab — `/demos/agents/*`

Single-purpose demos of an avatar reacting to the page. Index hub is
`/demos/agents/` (`public/demos/agents/index.html`), linked from the main
`/demos/` index. Each page lives at `public/demos/agents/<slug>.html` and
is served by the `/demos/agents/<slug>` rewrite.

| Route | Page file | What it does |
|---|---|---|
| `/demos/agents/auto-rig` | `public/demos/agents/auto-rig.html` | Auto-rigging an imported mesh. |
| `/demos/agents/builds-button` | `public/demos/agents/builds-button.html` | Agent assembles a CTA button. |
| `/demos/agents/climb-title` | `public/demos/agents/climb-title.html` | Agent climbs the page title. |
| `/demos/agents/cursor-follower` | `public/demos/agents/cursor-follower.html` | Agent tracks the cursor. |
| `/demos/agents/face-mocap` | `public/demos/agents/face-mocap.html` | Webcam face mocap drives the avatar. |
| `/demos/agents/fall-from-top` | `public/demos/agents/fall-from-top.html` | Agent drops in from the top of the viewport. |
| `/demos/agents/falls-asleep` | `public/demos/agents/falls-asleep.html` | Idle agent falls asleep. |
| `/demos/agents/gemini-live` | `public/demos/agents/gemini-live.html` | Live conversation via Gemini. |
| `/demos/agents/high-five` | `public/demos/agents/high-five.html` | Agent high-fives on click. |
| `/demos/agents/holds-cta` | `public/demos/agents/holds-cta.html` | Agent holds up the call-to-action. |
| `/demos/agents/pickup-drop` | `public/demos/agents/pickup-drop.html` | Pick up and drop the agent. |
| `/demos/agents/scroll-inertia` | `public/demos/agents/scroll-inertia.html` | Agent reacts to scroll inertia. |
| `/demos/agents/sit-in-body` | `public/demos/agents/sit-in-body.html` | Agent sits inside body copy. |
| `/demos/agents/skateboard` | `public/demos/agents/skateboard.html` | Agent skateboards across the page. |
| `/demos/agents/trampoline` | `public/demos/agents/trampoline.html` | Agent bounces on a trampoline. |
| `/demos/agents/walks-gutter` | `public/demos/agents/walks-gutter.html` | Agent walks the page gutter. |
| `/demos/agents/wrecking-ball` | `public/demos/agents/wrecking-ball.html` | Wrecking-ball physics demo. |

## Related demo pages (outside `/demo` and `/demos`)

Page files that carry a `demo-`/`coin` name or alias into the lab but
live at their own top-level URLs:

| Route | Page file | What it does |
|---|---|---|
| `/coin3d` | `pages/coin3d.html` | Token-in-3D visualizer. |
| `/app-demo` | `pages/app-demo.html` | Viewer with the studio skin (studio-skin demo). |
| `/embed-demo` | `pages/embed-demo.html` | Avatar embed demo. |
| `/avatar-studio-demo` | `pages/avatar-studio-demo.html` | Avatar Studio demo. |
| `/lipsync` | `public/demos/lipsync-tts.html` | Alias into the lab — TTS-driven lipsync. |
| `/lipsync/mic` | `public/demos/lipsync-mic.html` | Alias into the lab — mic/audio-driven lipsync. |

## Legacy redirects

| Old | New | Configured in |
|---|---|---|
| `/coin` | `/demo/coin` | `vercel.json` (301), mirrored in `vite.config.js` middleware for dev. |
| `/coin/` | `/demo/coin` | `vercel.json` (301), mirrored in `vite.config.js` middleware for dev. |

Both redirects land on a `200` (`/demo/coin/`) after following the
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

## Verification notes (2026-06-08)

Verified on the live Vite dev server (`npm run dev`, port 3000):

- Every route in the tables above returns **200**. `/coin` and `/coin/`
  return **301 → `/demo/coin/` → 200**.
- All 27 `/demos/<slug>` pages and all 17 `/demos/agents/<slug>` pages
  return 200 (extensionless and `.html` forms both resolve; in-page links
  use `.html`).
- Each page renders a real, non-placeholder `<title>` and loads its JS
  modules with **200** responses.
- `/_vercel/insights/script.js` 404s on the dev server on every page — it
  is a leftover Vercel Web Analytics path from the Vercel era. Production
  moved to Google Cloud Run (2026-07-07), which does not serve or inject it
  either, so the 404 is expected in both environments and is not a route
  regression.
- `/demo/avatar-os/studio` (no `.html`) 404s in dev and is **not** a
  supported URL — the avatar-os hub links its sub-pages with the `.html`
  extension, which is the canonical form. Same for the other avatar-os
  sub-pages.
- No `vercel.json` or `vite.config.js` changes were needed; all routes
  were already wired correctly.
