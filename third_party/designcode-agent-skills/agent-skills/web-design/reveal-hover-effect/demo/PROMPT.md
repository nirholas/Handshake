# Reveal Hover Effect Demo Prompts

## Minimal prompt

Use $reveal-hover-effect to build a cursor-following spotlight that reveals a second perfectly aligned image.

## Recreate the demo

Use $reveal-hover-effect to create a responsive, full-screen editorial hero called Materia.

Generate two images at 1586 x 992 with exactly the same composition, crop, camera, lighting, and sculptural shell form:

1. Default image: quiet mineral plaster in warm beige and ivory.
2. Reveal image: the identical object transformed into opal glass, iridescent color, and polished chrome.

### Art direction

- Museum-catalog editorial composition.
- Warm beige background with a subtle 48px technical grid.
- Large serif headline: Matter remembers color.
- Small uppercase metadata, thin rules, and restrained navigation.
- Keep typography and interface above both image layers.

### Interaction

- Keep the plaster image permanently visible.
- Stack the opal image exactly above it.
- Reveal the opal image through a 260px cursor-following radial CSS mask.
- Keep the center fully opaque through 40% of the radius.
- Feather through 60%, 75%, and 88%, reaching transparency at 100%.
- Ease pointer position by 0.1 and radius by 0.14.
- Begin the reveal directly under the pointer.
- Handle the first pointer movement when the page loads under a stationary cursor.
- Collapse on pointer exit, pointer cancel, and window blur.
- Stop requestAnimationFrame when the animation settles.
- Recalculate local coordinates after scrolling or resizing.

### Accessibility

- Keep the native cursor.
- Show the static plaster image on coarse pointers.
- Add a Reveal material button that toggles the complete opal image.
- Remove trailing movement under reduced-motion preferences.

### Deliverable

- Put all HTML, CSS, and JavaScript in demo/index.html.
- Put both optimized images in demo/assets/.
- Do not use React, a build system, external fonts, or package dependencies.
- Use relative asset paths.

### Acceptance checks

- Both images remain pixel-aligned at every breakpoint.
- There is no visible mask ring.
- The reveal never sweeps in from the center.
- The animation loop stops when idle.
- The demo works at desktop and mobile sizes.

## Remix prompt

Use $reveal-hover-effect to keep this exact interaction and delivery contract, but replace the shell with another subject and generate a new aligned default/reveal pair. Change the editorial copy and palette while preserving the mask stops, accessibility fallbacks, cleanup, and idle-loop behavior.
