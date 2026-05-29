# Task: Signature reactive 3D hero tied to live $three data

Build the screenshot-worthy centerpiece: a Three.js hero on the home page whose
visuals **react to live $three market data**. This is the "wow" that gives bored
holders a reason to care again.

## Anchor files
- Home: `pages/home.html` (route `/`), hero module `src/home-v4-hero.js`, 3D `src/home-act2-viewer.js`.
- Live data: `api/three-token/[action].js?action=stats` (price, holders, volume, burns — Birdeye + Pump.fun). Activity feed: `?action=activity`. Burns: `?action=burns`.
- $THREE mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.
- Reuse design tokens from `home.html :root`.

## Concept (pick the strongest interpretation and ship it)
A living 3D object/field that maps real metrics to motion and form:
- **Price momentum** → rotation speed / energy / color temperature.
- **Volume** → particle density or emissive intensity.
- **Recent trades** (poll `activity`) → a pulse/ripple per trade, green for buy / red for sell.
- **Burns** → a visible "burn" effect when a burn event appears.
It should look intentional and premium — not a tech demo. Think a slowly rotating
faceted "$three" crystal/orb in a particle field that breathes with the market.

## Requirements
1. **Real data, polled** — fetch stats on an interval (e.g. 15–30s), diff against last value, drive the visuals from the delta. Handle fetch failure gracefully (freeze last-known state, show a subtle "reconnecting" hint — never crash the canvas).
2. **Fast & lazy** — dynamic-`import()` Three.js; load the scene only when the hero is in view; poster/skeleton until ready; cap DPR on mobile.
3. **A readable data overlay** — small, elegant live readout (price, 24h change, holders) anchored to the hero with designed loading/error states.
4. **Reduced motion** — provide a calm static fallback when `prefers-reduced-motion` is set.
5. **Responsive** — looks great and performs at 320 / 768 / 1440; 60fps target.

## Constraints
- No simulated/fake market data. If the API is down, show the reconnecting state — do not invent numbers.
- No jank: animate on the GPU, throttle the data loop, don't block the main thread on fetches.

## Definition of done
- `npm run dev` → `/`: hero loads lazily, reacts to real $three data, trades pulse, burns show.
- Zero console errors; 60fps; reduced-motion fallback works; responsive.
- `npm run build` clean. Run the **completionist** subagent.
- Report the data→visual mapping and why it reads as premium.

> Run AFTER task 07 (home overhaul) if both are queued — they share `home.html`/hero files.
