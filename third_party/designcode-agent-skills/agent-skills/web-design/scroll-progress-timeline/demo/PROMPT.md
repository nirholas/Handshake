# Scroll Progress Timeline Demo Prompts

## Minimal prompt

Use $scroll-progress-timeline to turn this ordered process into a responsive scroll story with one truthful progress line and readable active steps.

## Recreate the demo

Use $scroll-progress-timeline to recreate **Fieldwork — From Question to Proof** as a complete standalone HTML document. Treat `demo/index.html` as the visual, interaction, responsive, accessibility, and performance reference.

### Experience

- Present four uneven editorial process steps beside one sticky chapter title.
- Render a vertical base rail from the center of the first dot to the center of the last dot.
- Fill the rail from one normalized scroll value and activate a step as the viewport anchor crosses its point.
- Give each step a number, phase, heading, description, evidence tag, and original abstract media panel.
- Collapse to a simple left rail on mobile without changing semantic reading order.

### Implementation contract

- Deliver `demo/index.html` with all CSS and JavaScript inline and no required external assets.
- Keep the steps as a semantic ordered list in the document before enhancement.
- Coalesce measurement and rendering in requestAnimationFrame and recalculate after resize or layout changes.
- Keep inactive content readable, preserve keyboard order, and use `aria-current="step"` without noisy live announcements.
- Under reduced motion, show a complete line and all steps without scrubbed interpolation or large transitions.

## Remix prompt

Use $scroll-progress-timeline and the included demo as the quality bar, but replace the process, content, palette, media grammar, step count, and layout emphasis. Preserve the data-ready ordered structure, first-to-last point measurement, reversible progress, mobile reading order, keyboard access, and reduced-motion contract.
