---
name: scroll-progress-timeline
description: Turn any ordered process into a data-driven vertical or horizontal scroll story with a base line, progress fill, active step states, responsive collapse, semantic fallback, and reduced-motion behavior. Use for onboarding, checkout, roadmaps, recipes, case studies, service processes, histories, or narratives where progress through the sequence should become visible while scrolling.
---

# Scroll Progress Timeline

Use one progress line to connect ordered information. The sequence must remain complete, readable, and navigable before animation is added.

## Model the steps

Keep the content data-driven:

```js
const steps = [
  { id: "brief", number: "01", title: "Set the direction", body: "..." },
  { id: "build", number: "02", title: "Make the system", body: "..." },
  { id: "ship", number: "03", title: "Release and learn", body: "..." }
];
```

Render it as an ordered list with real headings. The line, dots, media, and active state enhance that structure; they do not replace it.

## Build the line

1. Render a quiet base line behind every point.
2. Place one progress line on top with `transform-origin: top` for vertical or `left` for horizontal.
3. Measure the first and last point centers, not arbitrary section edges.
4. Normalize scroll position between those centers.
5. Apply `scaleY(progress)` or `scaleX(progress)` so updates stay on the compositor.
6. Mark a step active when the progress head crosses its center.

```js
const progress = Math.min(1, Math.max(0,
  (viewportAnchor - lineStart) / (lineEnd - lineStart)
));
line.style.transform = `scaleY(${progress})`;
```

Schedule DOM writes in one animation frame. Recalculate geometry after font and image loading, resize, orientation changes, and content mutation.

## Choose the layout

- Use a centered alternating timeline only when both sides have enough width and similar content weight.
- Use a left rail for long copy, compact steps, or mixed card heights.
- Use a horizontal line for short sequences with concise labels and explicit keyboard-safe overflow.
- Use pinned full-screen chapters only when each step carries a distinct visual state. Keep the pin finite and release before the next section.
- Collapse to a simple left rail on small screens. Do not preserve alternation at the expense of reading order.

## Animate step state

Use small opacity, translate, scale, blur, color, or media transitions. Keep every step readable while inactive. Expose active index with `aria-current="step"` only when that state is meaningful and current; do not announce every scroll update with a live region.

Use IntersectionObserver for simple active-state entry. Use a normalized scroll measurement or GSAP ScrollTrigger when the line must fill continuously or coordinate pinned media.

## Handle navigation

- Make step links real anchors when users can jump within the process.
- Add `scroll-margin` for sticky headers.
- Preserve focus and do not move it during passive scrolling.
- Keep URLs and browser history stable unless the user explicitly selects a step.
- If steps are interactive, use buttons or links with visible focus; never make a decorative dot the only control.

## Reduce motion

Under `prefers-reduced-motion: reduce`, show the complete line or discrete reached states without scrubbed interpolation, blur, pinning, or large transforms. Keep ordinary document flow and all step content.

## Verify

Test variable step counts, uneven card heights, missing media, long translations, 390/768/1024/1440 widths, 200% zoom, fast forward and reverse scrolling, direct anchor navigation, keyboard order, reduced motion, late font/image layout, route cleanup, and console errors. The active step and line head must agree at every boundary.

Use [demo/index.html](demo/index.html) as the working reference and [demo/PROMPT.md](demo/PROMPT.md) to recreate or remix it. Keep [REFERENCES.md](REFERENCES.md) as the links-only implementation source list.
