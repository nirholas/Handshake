---
name: ambient-section-particles
description: Add a restrained particle atmosphere inside one section with configurable shapes, density, gravity, wind, sway, rotation, recycling or settling, pointer disturbance, visibility pausing, responsive limits, and reduced-motion fallbacks. Use for petals, leaves, snow, sparks, confetti, dots, paper, icons, or brand fragments that support a section's mood without obscuring content.
---

# Ambient Section Particles

Build particles as a bounded atmosphere layer, not as a page-wide screensaver. Keep the content primary and stop work when the effect cannot be seen.

## Choose the renderer

- Use canvas for roughly 40 or more small particles, frequent motion, pointer forces, or simple procedural shapes.
- Use DOM or inline SVG for a small count of branded fragments that need individual styling or semantic labels.
- Use WebGL only for thousands of particles, depth, shaders, or real 3D behavior. Cap device pixel ratio and provide a static fallback.

Start with the least expensive renderer that preserves the desired shape language.

## Define one configuration

```js
const particles = {
  count: 54,
  gravity: 7,
  wind: -3,
  sway: 16,
  speed: [8, 18],
  size: [4, 12],
  opacity: [0.18, 0.62],
  rotation: [-0.8, 0.8],
  mode: "recycle",
  pointerRadius: 110,
  maxDpr: 2
};
```

Scale density by container area, then clamp it for mobile and low-power devices. Do not derive count from viewport width alone.

## Layer the section

1. Give the section a positioning context and clip overflow when particles should remain bounded.
2. Place the particle surface behind content but above the background.
3. Set the layer to `pointer-events: none`; listen for pointer movement on the section.
4. Reserve a quiet content zone or lower density behind long text and controls.
5. Keep controls and links in normal DOM stacking with visible focus.

## Run the simulation

- Seed particles inside or just above the container bounds.
- Update gravity, wind, phase-based sway, rotation, opacity, and position from elapsed time.
- Clamp large time deltas after background tabs or stalled frames.
- Use one `requestAnimationFrame` loop for the whole layer.
- Resize with `ResizeObserver`; cap canvas backing resolution at `min(devicePixelRatio, maxDpr)`.
- For pointer disturbance, apply a small distance-based force and let particles settle back naturally. Never attach a listener per particle.

Support explicit end modes:

- `recycle`: return particles above the section after exit.
- `exit`: remove particles after they leave the bounds.
- `settle`: resolve into a shallow visual pile with a strict height cap.
- `static`: render a deterministic still composition.

## Stop invisible work

Use IntersectionObserver to start only when the section is visible. Cancel animation frames when it exits or `document.hidden` becomes true. Resume from the current simulation state instead of spawning a second loop.

On teardown, disconnect observers, remove resize and pointer listeners, cancel the frame, and release renderer resources.

## Respect the reader

- Under `prefers-reduced-motion: reduce`, render a sparse static arrangement or remove the layer.
- Keep particles decorative and hidden from assistive technology.
- Control opacity and contrast so motion never crosses the legibility threshold.
- Avoid full-screen pointer repulsion, rapid direction changes, flashes, and large objects crossing form controls.
- Pause decorative motion while a modal or critical task in the section is active when it competes for attention.

## Verify

Test entry and exit pausing, background-tab recovery, fast resize, 390/768/1440 widths, device pixel ratio, pointer and touch input, reduced motion, section overflow, content focus, long text, route cleanup, and console errors. Confirm only one animation loop survives repeated mounts.

Use [demo/index.html](demo/index.html) as the working reference and [demo/PROMPT.md](demo/PROMPT.md) to recreate or remix it. Keep [REFERENCES.md](REFERENCES.md) as the links-only implementation source list.
