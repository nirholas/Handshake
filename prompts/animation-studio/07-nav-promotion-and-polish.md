# Task 7 — Promote the studio in nav, add page chrome, cross-link, final QA

> Read `prompts/animation-studio/00-README.md` first (nav injection, page-chrome pattern). Follow
> `CLAUDE.md`. No mocks, wire 100%, design every state, verify in a real browser.
>
> **Depends on Tasks 1–6.** This is the integration + polish pass that makes the Animation Studio a
> first-class, discoverable platform feature. Read each prior task's handoff note.

The studio is now functional but the page is still a bare canvas buried in the **Labs** submenu
with no shared header/nav/footer. This task gives it real platform chrome, promotes it, wires every
cross-link, and runs a final quality audit.

## What to build

### 1. Page chrome on `/pose`
- Add the shared **nav** to [pages/pose.html](../../pages/pose.html): include
  `<div id="nav-container"></div>` + `<script src="/nav.js"></script>` and the site header wrapper,
  matching how an existing full page does it (e.g. study `pages/avatar-page.html` — its header,
  nav-container, footer, and the CSS it links: `/nav.css` is already present; add `/footer.css`).
- Add the shared **footer** (copy the structure used by other pages; include the newsletter script
  if other pages do). Ensure the 3D canvas + studio panels still lay out correctly **with** the
  header/footer present (the studio currently assumes full-viewport; adjust so it sits in the page
  shell without clipping or scroll-jank, responsive at 320 / 768 / 1440).

### 2. Rename + promote
- The page is currently "Pose Studio" in `nav.html` (~line 270, under Labs). Rename to
  **"Animation Studio"** (keep `/pose` as the route; it's already public-facing and SEO-indexed —
  do not break the URL). Update the page `<title>`, OG/Twitter meta, and `<meta name="description">`
  in `pages/pose.html` to describe the animation authoring + marketplace capabilities.
- **Promote it out of Labs** into a prominent menu: add a top-level or **Build**-menu entry in
  [public/nav.html](../../public/nav.html) (study the existing nav-item / submenu markup and copy
  it exactly — title + subtitle spans, `role="menuitem"`). Decide whether to keep a Labs entry too;
  if you remove it from Labs, make sure there are no orphaned references. Verify the nav still
  renders and is keyboard-navigable after the edit.

### 3. Cross-linking (make it feel like one product)
Wire every natural connection (no dead links):
- **Avatar pages / gallery / dashboard:** an "Animate" / "Create animation" action that opens
  `/pose?avatar=<id>` for that avatar.
- **Public animation gallery (Task 5):** links into the studio and to buy/play.
- **Marketplace (Task 6):** animation listings link to their detail/preview and Buy.
- **Studio → account:** the "My animations" library and (if signed in) a link to the user's
  dashboard/marketplace seller view.
- **Docs/features:** add the Animation Studio to the features list / docs where other features are
  catalogued (search for `public/features.json` and the features page) with accurate copy.

### 4. Final QA — run the self-review + completionist protocol over the whole feature
Exercise the full flow in a real browser and confirm:
- Open `/pose` cold (no params) → mannequin loads, nav + footer present, no console errors.
- `?avatar=<id>` and the picker load real rigged avatars; FK/IK posing works.
- Build a multi-keyframe animation, scrub + play it looping.
- Export GLB (plays its animation on re-open) and clip JSON.
- Sign in → Save → appears in "My animations"; reopen → keyframes restored; PATCH + delete work.
- Saved/public animation plays in the viewer via `?anim=<id>`; public gallery works.
- Price + publish an animation; it lists in marketplace + bazaar; the paid download endpoint serves
  a real 402 and post-payment download (per Task 6's verification note).
- Every interactive element has hover/active/focus; every list has loading/empty/error states;
  responsive at 320/768/1440; keyboard shortcuts documented in-UI; ARIA on controls.
- `npm test` green. Run the `completionist` subagent across **all** files touched by Tasks 1–7 and
  fix everything it flags.

### 5. Documentation
- Update any READMEs/docs that enumerate routes or features to include the Animation Studio. Per the
  project's docs-mirror note, if you edit `docs/`, sync the corresponding `public/docs/` mirror.

## Definition of done
- `/pose` is a fully-chromed, discoverable, prominently-linked **Animation Studio** with working
  nav/header/footer, responsive at all three breakpoints, zero console errors.
- Every cross-link in section 3 exists and works; no dead paths anywhere in the feature.
- The end-to-end flow (load avatar → animate → save → play across platform → sell → buy) works in a
  real browser; you've exercised it and can describe what you verified.
- `npm test` green; `completionist` clean.
- Summarize the shipped feature and call out anything intentionally deferred.

This is the last task. When the user approves, push to **both** remotes (`git push threeD main`
then `git push threews main`) per CLAUDE.md. Never pull/fetch from `threeD`.
