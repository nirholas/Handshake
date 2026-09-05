# Scroll-Scrubbed Visual Sequence Demo Prompts

## Minimal prompt

Use $scroll-scrubbed-visual-sequence to create a polished, responsive visual transformation whose exact state moves forward and backward with native scroll.

## Recreate the demo

Use $scroll-scrubbed-visual-sequence to recreate **Aperture 04 — Matter to Memory** as a complete standalone HTML document. Treat `demo/index.html` as the visual, interaction, responsive, accessibility, and performance reference.

### Experience

- Create one full-viewport sticky chapter inside a longer native-scroll section.
- Compose an original abstract optical object from inline SVG rings, shards, a core, labels, and a measurement grid.
- Map one normalized section progress value to object assembly, rotation, scale, opacity, copy state, and the progress indicator.
- Make the first state feel exploded, the middle state calibrated, and the final state resolved.
- Keep essential copy in semantic HTML and keep the SVG decorative.

### Implementation contract

- Deliver `demo/index.html` with all CSS and JavaScript inline and no required external assets.
- Use native sticky positioning and a requestAnimationFrame-coalesced scroll measurement; a project implementation may substitute GSAP ScrollTrigger.
- Expose scroll length, state stops, scale, rotation, and overlay values as configuration or CSS custom properties.
- Preserve deterministic reverse scrolling, responsive layout from 390px through 1440px, visible focus, and a static reduced-motion state.
- Do not autoplay, hijack the wheel, trap the footer, or make copy depend on the SVG.

## Remix prompt

Use $scroll-scrubbed-visual-sequence and the included demo as the quality bar, but replace the subject, copy, palette, object language, and transformation. Preserve the sticky-stage architecture, normalized reversible progress, semantic content, responsive behavior, cleanup, and reduced-motion contract.
