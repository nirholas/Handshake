# Scroll-Scrubbed Word Reveal Demo Prompts

## Minimal prompt

Use $scroll-scrubbed-word-reveal to make this marked-up passage become readable word by word as the reader scrolls.

## Recreate the demo

Use $scroll-scrubbed-word-reveal to recreate **A Field Note on Attention** as a complete standalone HTML document. Treat `demo/index.html` as the visual, interaction, responsive, accessibility, and performance reference.

### Experience

- Present one editorial manifesto inside a warm paper field with a compact progress rail and supporting source note.
- Split only text nodes at runtime so the inline emphasis remains semantic and visually distinct.
- Move every word from quiet low-opacity, blurred, offset type to its normal state according to one normalized section progress value.
- Preserve responsive line wrapping, punctuation, reverse scrolling, and a complete readable final state.

### Implementation contract

- Deliver `demo/index.html` with all CSS and JavaScript inline and no required external assets.
- Use TreeWalker or an equivalent text-node walk; do not flatten the marked-up passage.
- Keep the passage semantic, keyboard-accessible, and readable without JavaScript.
- Keep all words visible immediately under reduced motion and avoid pinning on small screens when it harms reading.
- Do not turn the effect into a typewriter, autoplay sequence, fixed line split, or screen-reader live announcement.

## Remix prompt

Use $scroll-scrubbed-word-reveal and the included demo as the quality bar, but replace the passage, typography, palette, accent markup, and pacing. Preserve semantic inline markup, responsive wrapping, normalized reversible progress, reduced-motion readability, and teardown safety.
