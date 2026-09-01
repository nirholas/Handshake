# Docs World: the documentation as a place

The three.ws docs come in two surfaces with one content source:

- **Classic docs** at [/docs](/docs): the sidebar-and-article reader you are probably using now.
- **Docs World** at [/docs/world](/docs/world): the same documentation as an explorable 3D world. Every section of the sidebar is a glowing pavilion on a ring; you walk an avatar between them and read the real pages inside the scene.

Both render the same files. The world fetches the same `/docs/nav.json` manifest that builds the classic sidebar and the same `/docs/<page>.md` markdown the classic reader shows, so the two surfaces can never drift apart.

## Entering

- From the classic docs, use the **3D world** button in the header. It carries the page you are reading, so you land in front of the right pavilion with the doc already open.
- Or go straight to [three.ws/docs/world](https://three.ws/docs/world).
- Deep links work like the classic docs: `/docs/world#forge` opens the Forge doc in-world, at the Creation studios pavilion.

## Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Walk | WASD or arrow keys | Virtual joystick (lower-left) |
| Run | Hold Shift | Push the joystick to its edge |
| Look / orbit | Drag | Drag anywhere outside the joystick |
| Zoom | Scroll wheel | Camera button |
| Open a section | Walk close and press E, or click its pavilion | Tap the pavilion or the prompt |
| Camera modes | C cycles follow, cinematic, first person, top down | Camera chip (top right) |
| Close a panel | Esc | The ✕ button |

The **Index** chip (top left) lists every section; picking one teleports you to its pavilion and opens its page list. That list is fully keyboard-reachable, so nothing in the world requires mouse-precision walking.

The **Search docs** chip (or `/`, or `Ctrl`+`K`) opens a palette over every page. `Enter` on a result opens the page at once; `Shift`+`Enter` hands you to the wayfinder, which walks your avatar to the right pavilion with a live route readout, a **Read now** shortcut that skips the walk, and a cancel button. The **?** chip holds the controls table and a **Replay the welcome tour** button.

## Your avatar

By default you walk as the platform's default rigged body, the same one [/walk](/walk) uses, animated by the shared canonical clip library. Pass any rigged GLB with `?avatar=`:

```text
https://three.ws/docs/world?avatar=https://three.ws/avatars/michelle.glb
```

Any humanoid rig works; bone names are mapped automatically, exactly as described in [Animations](/docs/animations).

## Devices and accessibility

- **No WebGL?** The page detects it and offers the classic docs instead; nothing is lost, because the content is identical. A failure a reload can fix (a dropped `/docs/nav.json` fetch, an exhausted WebGL context budget, an unexpected boot error) shows the same fallback with a **Try again** button, focused once it is visible; a device with no GPU never gets that button, because reloading cannot help it.
- **`prefers-reduced-motion`** stills the ambient animation (floating labels, portal shimmer, drifting stars).
- The reader panel is real DOM, not a texture: text is selectable, zoomable, and visible to screen readers.
- Frame rate is governed like every three.ws 3D surface: 60fps focused, 30fps in the background or with the shared Power-saver preference on.

## For contributors

The section list lives in [`docs/nav.json`](https://github.com/nirholas/three.ws/blob/main/docs/nav.json). Add a page there and it appears in both the classic sidebar and the world's pavilions; no world-side change is ever needed. The world itself lives in `src/docs-world/` (scene, player, controls, overlays) with the page shell at `pages/docs-world.html`.

### The manifest format

One object with a `sections` array. Each section becomes a sidebar group in the classic docs and one pavilion in the world, in this order:

```json
{
  "sections": [
    {
      "title": "Start here",
      "links": [
        { "label": "What is three.ws?", "path": "start-here" },
        { "label": "Widget reference", "href": "/docs/widgets", "external": true }
      ]
    }
  ]
}
```

Every link carries a `label` plus exactly one of:

- **`path`**: a docs page, relative to `docs/` and without the `.md` extension. `"forge"` resolves to `docs/forge.md` and reads at `/docs/forge`. Nested paths work (`"agent-abilities/chapters/01-the-body"`).
- **`href`**: any other destination. Set `"external": true` so both surfaces render it as a link out rather than an in-world page.

Three rules the test suite enforces in [`tests/docs-world.test.js`](https://github.com/nirholas/three.ws/blob/main/tests/docs-world.test.js), so a bad entry fails CI rather than shipping a dead link:

1. Every `path` must resolve to a markdown file that actually exists, in `docs/` (copied into the build) or `public/docs/` (served verbatim); either one reaches `/docs/<slug>.md`.
2. A link is a `path` **or** an `href`, never both and never neither.
3. No `path` may point into `docs/internal/`, `docs/ops/`, or `docs/security/`. Those directories are written for operators and are deliberately excluded from the published site, so a nav entry into one would 404 in production.

Adding a section is the same edit: append to `sections` and a new pavilion appears on the ring, coloured and positioned automatically. Nothing in `src/docs-world/` hardcodes a section name or count.
