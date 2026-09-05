---
name: scroll-scrubbed-visual-sequence
description: Build reversible scroll-controlled visual transformations with a pinned or sticky stage, normalized progress, and video, image-sequence, canvas, SVG, or DOM renderers. Use for hero transformations, product assembly, interface state walkthroughs, object rotation, diagrams, or photo sequences that must move forward and backward with native scrolling.
---

# Scroll-Scrubbed Visual Sequence

Turn one visual transformation into a responsive scroll instrument. Keep the page usable without motion and keep the renderer replaceable.

## Define the sequence

Write the visual states before coding:

```js
const sequence = {
  scrollVh: 280,
  frameCount: 96,
  fit: "contain",
  posterFrame: 0,
  reducedMotionFrame: 95,
  copyStops: [0, 0.42, 0.78]
};
```

Use one normalized value for every renderer:

```js
const progress = Math.min(1, Math.max(0,
  (viewportTop - sectionTop) / (sectionHeight - viewportHeight)
));
```

Never make wheel delta, elapsed time, or autoplay the source of truth. Native scroll position must determine the exact visual state in both directions.

## Choose the renderer

- Use video when the sequence is continuous, photographic, or expensive to render live. Encode frequent keyframes, preload metadata, reserve the aspect ratio, and coalesce `currentTime` writes in `requestAnimationFrame`.
- Use an image sequence when exact art-directed frames matter. Preload the current frame first, then nearby frames; never block first paint on the whole set.
- Use canvas for procedural drawing or compositing. Cap device pixel ratio at 2 and redraw only when progress changes.
- Use SVG or DOM for diagrams, product cards, interface states, and accessible text. Drive transforms, opacity, clip paths, and CSS variables instead of layout-heavy properties.
- Use WebGL only when depth, lighting, or a real 3D camera materially strengthens the idea. Provide a static poster and dispose resources.

## Build the scroll stage

1. Keep the section in normal document flow and set its height from `scrollVh`.
2. Put the visual in a `position: sticky` stage sized to the viewport.
3. Keep copy and controls in a separate layer. Do not bake essential text into frames.
4. Map progress to the renderer with no implicit easing. Add optional smoothing after correctness is proven.
5. Refresh measurements after fonts and intrinsic media sizes settle.
6. Release the sticky stage cleanly before the next section and keep the footer reachable.

Use GSAP ScrollTrigger when the project already uses GSAP or needs exact pin, refresh, and timeline coordination:

```js
ScrollTrigger.create({
  trigger: section,
  start: "top top",
  end: () => `+=${innerHeight * 2.8}`,
  pin: stage,
  scrub: true,
  invalidateOnRefresh: true,
  onUpdate: ({ progress }) => render(progress)
});
```

For a dependency-free implementation, measure the section on scroll and resize, then schedule one render per animation frame.

## Handle media safely

- Keep a poster visible until the first real frame paints.
- Clamp frame indexes to `0...frameCount - 1`.
- Cancel stale image requests and never queue every seek during fast scrolling.
- Use `object-fit` and an explicit focal point so the subject survives mobile crops.
- Pause decoding, rendering, and observation while the section is offscreen or the document is hidden.
- Clean up ScrollTriggers, observers, listeners, animation frames, Blob URLs, and renderer resources on route change or unmount.

## Preserve access and control

- Keep headings, copy, captions, and the CTA in semantic HTML.
- Do not trap scrolling, block keyboard navigation, or require precise pointer input.
- Under `prefers-reduced-motion: reduce`, remove pinning and scrubbing, render the selected static frame, and restore ordinary document flow.
- If the sequence communicates ordered information, expose the same states as text or a list.

## Tune deliberately

Expose scroll distance, renderer, frame count, poster frame, media fit, focal point, copy stops, overlay strength, smoothing, and reduced-motion state as configuration. Avoid magic numbers distributed across event handlers.

## Verify

Check forward and reverse scrolling, fast flicks, resize while active, 390/768/1024/1440 widths, unloaded frames, blocked video, reduced motion, keyboard order, route cleanup, and console errors. The same scroll position must always reproduce the same state.

Use [demo/index.html](demo/index.html) as the working reference and [demo/PROMPT.md](demo/PROMPT.md) to recreate or remix it. Keep [REFERENCES.md](REFERENCES.md) as the links-only implementation source list.
