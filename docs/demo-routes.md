# Demo routes

The canonical map of every `/demo/*` and `/demos/*` route as of
2026-05-20. Update whenever a route is added, removed, or moved.

The demo namespace splits in two:

- `/demo/<slug>/` — full standalone demos that own their URL space
  (multiple sub-pages, dynamic segments). Each lives in
  `public/demo/<slug>/`.
- `/demos/<slug>` — single-page lab demos. Index hub is
  `/demos/`. Each lives in `public/demos/<slug>.html`.

Production routing is in [vercel.json](../vercel.json); the matching
Vite dev-server middleware is in [vite.config.js](../vite.config.js).
Both must be kept in sync.

## Routes

| Route | Page file | What it does |
|---|---|---|
| `/demo/coin` | `public/demo/coin/index.html` | Lottery + reflection demo on a single Pump.fun coin (real-time holder feed, payout history). |
| `/demo/coin/<mint>` | `public/demo/coin/index.html` | Same page hydrated for a specific base58 mint address (32–44 chars). |
| `/demo/avatar-os/` | `public/demo/avatar-os/index.html` | OSS avatar pipeline hub linking to the four sub-pages below. |
| `/demo/avatar-os/studio.html` | `public/demo/avatar-os/studio.html` | Avatar Studio (rebranded Character Studio fork) embed. |
| `/demo/avatar-os/selfie.html` | `public/demo/avatar-os/selfie.html` | Selfie-to-avatar flow. |
| `/demo/avatar-os/combined.html` | `public/demo/avatar-os/combined.html` | Studio + selfie shown side-by-side. |
| `/demo/avatar-os/live.html` | `public/demo/avatar-os/live.html` | Live capture / streaming variant. |
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
| `/demos/gallery-picker` | `public/demos/gallery-picker.html` | Avatar gallery picker UI. |
| `/demos/gemini-jump` | `public/demos/gemini-jump.html` | Tactile button (Gemini concept). |
| `/demos/halfbody-xr` | `public/demos/halfbody-xr.html` | Half-body avatar in WebXR. |
| `/demos/lipsync-mic` | `public/demos/lipsync-mic.html` | Audio-driven lipsync from microphone. |
| `/demos/lipsync-tts` | `public/demos/lipsync-tts.html` | TTS-driven lipsync. |
| `/demos/livepeer-inference` | `public/demos/livepeer-inference.html` | Decentralized inference via Livepeer. |
| `/demos/memory-seed` | `public/demos/memory-seed.html` | Agent memory seeding flow. |
| `/demos/persona-extract` | `public/demos/persona-extract.html` | Persona extraction from social handles. |
| `/demos/react-sdk` | `public/demos/react-sdk.html` | `@three-ws/avatar/react` SDK walkthrough. |
| `/demos/selfie-fit` | `public/demos/selfie-fit.html` | Selfie-fit avatar pipeline. |
| `/demos/skill-royalty` | `public/demos/skill-royalty.html` | Skill royalty distribution demo. |
| `/demos/usdz-ar` | `public/demos/usdz-ar.html` | USDZ + AR Quick Look (iOS). |
| `/demos/voice-clone` | `public/demos/voice-clone.html` | Voice cloning demo. |

The legacy `/brain`, `/lipsync`, `/lipsync/mic`
shortcuts in `vercel.json` still resolve to the `/demos/*.html` files
above. They predate the `/demos/` namespace and are kept for backward
compatibility — prefer the `/demos/<slug>` form for new links.

## Legacy redirects

| Old | New | Configured in |
|---|---|---|
| `/coin` | `/demo/coin` | `vercel.json` (301), mirrored in `vite.config.js` middleware for dev. |
| `/coin/` | `/demo/coin` | `vercel.json` (301), mirrored in `vite.config.js` middleware for dev. |

`pages/pump-coin-page.html` predates the `/demo/coin` rewrite and is
not wired into the canonical demo nav. It still resolves at
`/pump-coin-page` via the generic `pages/<slug>.html` fallback in the
Vite middleware, but new links should point at `/demo/coin`.

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
