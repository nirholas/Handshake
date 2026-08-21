# Liquid glass: the visual target for three.ws grids and panels

The look we are building toward is the one on
[infinite-liquid-glass.shader.se](https://infinite-liquid-glass.shader.se/?v=2), a WebGPU
experiment by [Shader](https://shader.se) (Simon Hedlund and Filip Kantedal, Sweden). This
document is the design brief for that direction: what the reference actually is, which parts
of it we adopt, the material and type recipe that produces it, the open source we build on,
and the budget it has to stay inside.

It sits under [Design tokens](./DESIGN-TOKENS.md), which stays the source of truth for colour,
type, radius, blur, and motion values. Nothing here introduces a value the token file does not
have. Interaction primitives come from [ui-juice](./ui-juice.md).

## What the reference is

An infinite, drag-and-scroll plane of rounded-square tiles. Each tile is a live media card
(video or image) sitting *behind* a thick slab of refractive glass, so the content bends at the
tile edge, picks up a bright specular rim along the top-left, and smears into a slight rainbow
fringe where the curvature is steepest. Over that: a large display-weight title
("Infinite City", "Glass House", "Common Sky"), a one-line subtitle at low opacity, and a
monospaced eyebrow across the top edge (`ILG-05  SPATIAL IDENTITY   SELECTED WORK 2026`). The
background is near-black. Nothing is flat, and nothing is loud.

Four things carry the whole effect, in order of importance:

1. **Real refraction, not blur.** The content behind a tile is displaced, not just frosted.
   A `backdrop-filter: blur()` panel is the thing this look is not.
2. **The edge does the work.** The interior of a tile is almost clear. The last 8 to 12 percent
   of the width is where the bend, the rim light, and the colour fringe live.
3. **Squircle geometry.** Continuous rounded corners, radius roughly 12 percent of the tile's
   short side, never a small 8px radius and never a full pill.
4. **Type sits on top, unrefracted.** Titles stay crisp and legible over the moving glass. They
   are not part of the material.

## Is there a repo for it?

**Not for that demo.** It ships as a Turbopack/Next.js build on Vercel with no repository link,
no license, and no credits beyond the studio logo and a booking link. The bundle is minified
first-party code. What the bundle does tell us is the stack: `@react-three/fiber` plus drei,
three.js `WebGPURenderer`, and `MeshPhysicalNodeMaterial` driven by `transmission`, `thickness`,
`ior`, `dispersion`, `iridescence`, `anisotropy`, and `roughness`. Shader's own site pipeline is
written up in detail on Codrops
([80s Business Tech and Seamless Scene Transitions](https://tympanus.net/codrops/2026/05/19/80s-business-tech-seamless-scene-transitions-inside-shader-ses-scroll-driven-webgpu-pipeline/)),
and that article says an open source example is planned. It had not been published as of
2026-08-21.

So we rebuild the look from open source. These are the repositories worth reading, checked on
2026-08-21:

| Repo | Stars | License | What it gives us |
|------|-------|---------|------------------|
| [iyinchao/liquid-glass-studio](https://github.com/iyinchao/liquid-glass-studio) | 607 | MIT | The closest single-panel implementation, WebGL2 and WebGPU, with every knob (refraction strength, edge falloff, chromatic aberration, specular) exposed live. Read this first for the edge math. |
| [Yousuf-developer/liquid-glass-carousel](https://github.com/Yousuf-developer/liquid-glass-carousel) | 130 | MIT | Structurally the nearest match: an infinite scroll-driven grid of media tiles under a glass lens, three.js plus GSAP. This is the layout half of the reference. |
| [shuding/liquid-glass](https://github.com/shuding/liquid-glass) | 1.1k | MIT | DOM-only, SVG `feDisplacementMap`. No WebGL context, so it is the cheap lane for UI chrome on pages that have no canvas. |
| [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react) | 6.0k | MIT | The same DOM technique packaged for React. Reference only; we do not ship React on these surfaces. |
| [mrdoob/three.js](https://github.com/mrdoob/three.js) transmission examples | | MIT | `webgpu_materials_transmission` and the `MeshPhysicalMaterial` transmission examples are the canonical parameter set, and they match the three.js version we already bundle. |

[ybouane/liquidglass](https://github.com/ybouane/liquidglass) (401 stars) is a good WebGL
implementation with **no declared license**. Read it for ideas, never vendor it.

## What we adopt, in two lanes

The reference is one technique. On three.ws it splits in two, because most of our surfaces have
no 3D canvas and must not gain one for decoration.

### Lane A: DOM glass, for chrome

Panels, docks, modals, cards, nav. Pure CSS, no WebGL, already tokenised in
[`public/tokens.css`](../public/tokens.css):

```css
.glass-panel {
	background: var(--surface-glass);
	backdrop-filter: blur(var(--blur-md)) saturate(1.25);
	border: 1px solid var(--surface-3);
	border-radius: var(--radius-lg);
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), var(--shadow-2);
}
```

That `inset 0 1px 0` highlight is the cheapest 80 percent of the look: it is the rim light the
reference gets from real refraction. A DOM panel without it reads as frosted plastic. Blur tier
by role: `--blur-sm` for inline chips, `--blur-md` for panels and docks, `--blur-lg` for
full-screen scrims. Never invent a fourth value.

For a DOM surface that genuinely needs displacement rather than blur (a hero tile, a featured
card), the SVG `feDisplacementMap` technique from `shuding/liquid-glass` is the approved
escalation. It costs no GPU context and degrades to the blur above when filters are
unsupported.

### Lane B: canvas glass, for tiles

Surfaces that already run three.js (`/gallery`, the entity studio stage, Restyle Studio, Scene
Composer) get the real thing. We are on three.js r184, so every parameter the reference uses is
available on `MeshPhysicalMaterial` under WebGL2. **WebGPU is not a prerequisite.** Do not port
a renderer to chase this look.

<!-- live:off -->
```js
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Image-based lighting is not optional: transmissive glass with nothing to
// reflect renders as grey soup. Restyle Studio lights its stage the same way.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const glass = new THREE.MeshPhysicalMaterial({
	transmission: 1,          // fully refractive, not alpha-blended
	thickness: 0.35,          // slab depth in world units; drives how far light bends
	ior: 1.47,                // window glass sits at 1.5; slightly under reads softer
	roughness: 0.08,          // above ~0.15 the content behind turns to mush
	dispersion: 3.5,          // rainbow fringe at the edges; useful range is 0 to 10
	iridescence: 0.12,        // faint oil-slick sheen on the rim
	iridescenceIOR: 1.3,
	clearcoat: 1,             // the hard specular streak along the top-left edge
	clearcoatRoughness: 0.04,
	specularIntensity: 1,
	color: 0xffffff,
	attenuationColor: new THREE.Color(0xdfe7ff),
	attenuationDistance: 2.5, // very slight cool tint through the body
});

// One material instance, reused by every tile. Each unique transmissive
// material costs its own render pass.
const tile = new THREE.Mesh(squircleGeometry(1, 1, 0.12), glass);
```

Rules for this lane:

- **One shared material for the whole grid.** Transmission renders the scene into an offscreen
  target; per-tile materials multiply that cost linearly.
- **Scale the transmission buffer, do not cap the canvas.** `renderer.transmissionResolutionScale
  = 0.5` halves the most expensive pass and is invisible at tile scale. Drop to `0.35` on the
  mobile tier.
- **Media goes behind the glass, never inside it.** The video or image plane is a separate mesh
  sitting a few centimetres behind the slab. That gap is what produces parallax as the grid moves.
- **Type is DOM or an unlit overlay plane**, positioned over the tile. Refracted text is
  illegible, and the reference does not refract it either.

### The squircle

Corner radius is 12 percent of the tile's short side in both lanes, which keeps a DOM card and a
3D tile reading as the same object. In CSS that is `border-radius: clamp(14px, 12%, 34px)`. In
three.js, build the profile with `THREE.Shape` and `absarc` corners, then `ExtrudeGeometry` with
`bevelEnabled: true`, `bevelSize` about 4 percent of the short side. The bevel is not cosmetic:
it is the surface that catches the rim light.

## Type and layout over glass

| Element | Token | Notes |
|---------|-------|-------|
| Tile title | `--font-display`, `--text-2xl`, `--weight-bold`, `--leading-tight` | Pure white, tight negative tracking, sits low-left in the tile. Large enough that the glass beneath reads as texture, not noise. |
| Subtitle | `--font-body`, `--text-md` | One line, opacity 0.62, never wraps to three lines. |
| Eyebrow | `--font-mono`, `--text-2xs`, uppercase, letter-spacing 0.18em | Top edge, split left and right (`ILG-05  SPATIAL IDENTITY` / `SELECTED WORK 2026`). This is the detail that makes the grid read as a catalogue rather than a moodboard. |
| Background | `--bg-0` | Near-black. Glass needs darkness to have anything to bend. |

Contrast is checked against the *brightest* frame of the media behind the tile, not the average.
Where a title cannot clear 4.5:1 across the whole clip, add a bottom-anchored scrim
(`linear-gradient(transparent, rgba(0,0,0,0.55))`) inside the tile rather than dimming the media.

## Motion

The reference moves constantly and never bounces. Pointer drag and wheel both feed one velocity
value that is damped toward zero, tiles wrap modulo the grid extent, and nothing snaps. Use the
motion ladder from the token file (`--duration-*`, `--ease-*`) for anything with a fixed
duration, and a frame-rate-independent damp for the continuous scroll:

```js
// Frame-rate independent damping. lambda ~6 feels like the reference.
const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));
```

Under `prefers-reduced-motion: reduce` the plane stops drifting entirely and becomes a static
paginated grid. The glass stays; only the motion goes. Token durations already zero themselves
in that media query, so anything built on `--duration-*` handles this for free.

## Budget

This look is expensive and it is not allowed to cost us the product.

- **Frame budget:** 16.6ms on a 2021 laptop with the grid at full viewport. If the transmission
  pass cannot fit, cut `transmissionResolutionScale` before cutting tile count.
- **Mobile and low-power:** below the mobile tier, or when
  `navigator.hardwareConcurrency <= 4`, the canvas lane falls back to Lane A: the same layout,
  the same type, DOM glass over a still poster frame. Designed fallback, not a blank grid.
- **No WebGL context on a page that did not already have one.** A marketing section does not get
  a renderer for decoration.
- **Media pauses off-screen.** Videos behind tiles outside the viewport are paused, exactly as the
  scroll-driven pipeline in the Codrops write-up skips render passes for off-screen sections.

## Where this lands first

1. `/gallery` (avatar grid) is the closest structural match to the reference and the first target.
2. [`/marketplace`](https://three.ws/marketplace) and [`/discover`](https://three.ws/discover)
   cards adopt Lane A now, since neither runs a canvas grid today.
3. The entity studio stage panels adopt the Lane A rim-light rule immediately; it is a one-line
   change per panel and it is most of the perceived quality.

## Verify before calling a glass surface done

- The interior of a tile is nearly clear and the *edge* carries the effect. If the whole tile is
  frosted, it is blur, not glass, and it is wrong.
- Every panel has the `inset 0 1px 0` rim highlight.
- Radius is 12 percent of the short side, in both lanes, on every tile.
- Title clears 4.5:1 against the brightest frame behind it.
- `prefers-reduced-motion: reduce` leaves a static grid with no drift.
- The transmission pass is measured, not assumed: profile it in DevTools with the grid full-screen.
- No raw hex, rgba, or px font size that a token in [`public/tokens.css`](../public/tokens.css)
  already provides.

## Related

- [Design tokens](./DESIGN-TOKENS.md), the values every rule above resolves to.
- [ui-juice](./ui-juice.md), the shared interaction primitives (damping, reduced-motion contract).
- [Restyle Studio](./restyle.md), which already ships a `realGlass` transmissive preset and the
  `RoomEnvironment` lighting setup this document depends on.
