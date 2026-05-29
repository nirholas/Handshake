# Task 5 — Make saved/public animations play across three.ws

> Read `prompts/animation-studio/00-README.md` first (clip format, `AnimationManager`, viewer).
> Follow `CLAUDE.md`. No mocks, real APIs, wire 100%, design every state, verify in a real browser.
>
> **Depends on Task 3** (`/api/animations` CRUD; clip JSON resolvable by id/slug). Benefits from
> Task 4 (clips actually exist to test with). Read their handoff notes first.

The animations a user creates must not be trapped in the editor. This task makes any
saved/public animation **playable anywhere three.ws renders an avatar**, using the existing
`AnimationManager` playback engine — and adds a public gallery to discover community animations.

## What to build

### 1. Load user animations into the playback engine
- The playback engine is [src/animation-manager.js](../../src/animation-manager.js)
  (`setAnimationDefs`, `attach`, `ensureLoaded`, `play`, `crossfadeTo`, `update`). Built-in clips
  come from [public/animations/manifest.json](../../public/animations/manifest.json). Read how
  [src/viewer.js](../../src/viewer.js) wires the manager to a loaded avatar (~lines 1545–1612).
- Add a path for the manager to load a **user/public animation by id or slug** from the API
  (`GET /api/animations/clips/:id` / list), parsing the stored `AnimationClip.toJSON()` with
  `AnimationClip.parse()` and registering it as an animation def (give it a name/label/icon/loop
  consistent with manifest entries). Reuse the manager's existing caching/lazy-load — extend it,
  don't fork it.
- Filter tracks to bones present on the target model (the manager/viewer already has a clip-filter
  helper — reuse it) so a clip authored on one rig degrades gracefully on another.

### 2. Play a specific animation in the viewer / on avatar pages
- Support a URL param on the viewer/avatar page (e.g. `?anim=<id|slug>`) that, after the avatar
  loads, fetches and plays that animation via the manager. Mirror how the viewer already
  `ensureLoaded('idle')` / `play()`s built-ins.
- Where avatars are shown with an animation control panel, list the user's saved animations (when
  signed in) and public ones alongside the built-in clips so they're selectable. Real fetch, real
  playback — design loading/empty/error states for that list.
- Ensure embeds keep working: if there's a gesture/postMessage API in the viewer
  (`onGesture`), allow triggering a user animation by id through the same channel.

### 3. Public animation gallery
- Add a gallery view (a page or a clearly-linked section) listing **public** animations
  (`GET /api/animations/clips?include_public=true` filtered to public, or a public list endpoint
  consistent with Task 3). Each card: thumbnail, name, author, duration, tags, a live preview
  (play on hover/click on a small viewer), and links to **open in the studio** (`/pose?...`) and to
  the seller flow when priced (Task 6).
- Reuse existing gallery/card patterns and the viewer/preview components already in the repo rather
  than inventing new ones. Match design tokens. Design loading (skeletons), empty, and error states.
- Cross-link: from an avatar page, "Animate this avatar" → opens `/pose?avatar=<id>`; from a public
  animation, "Use on my avatar" → opens the studio with that animation loaded.

### 4. Correctness
- `play_count` increments on real plays where Task 3 exposed that (don't double-count scrubbing).
- A private animation is never playable/listable by non-owners. A public one is.
- Clips authored on the primitive mannequin (canonical bone names) must still apply to standard
  rigged avatars — verify a mannequin-authored clip plays on a real avatar.

## Definition of done
- A saved animation plays on a rigged avatar in the viewer via `?anim=<id>` — verified in browser,
  no console errors, real network calls.
- The animation control panel lists and plays user/public animations next to built-ins.
- The public gallery lists real public animations with working previews and correct empty/loading/
  error states; cross-links to the studio and back work.
- Visibility is enforced (private clips invisible/unplayable to others).
- `npm test` green. Run `completionist`; fix all findings.
- Handoff note: how a clip is addressed for playback (id/slug + any param), for Task 6's
  post-purchase "play/download" UX.

Do not build payments here (Task 6). Do not push unless the user explicitly approves (then both
remotes per CLAUDE.md).
