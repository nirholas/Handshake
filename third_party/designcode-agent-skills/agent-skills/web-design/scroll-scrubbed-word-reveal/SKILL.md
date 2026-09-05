---
name: scroll-scrubbed-word-reveal
description: Reveal marked-up text word by word as scroll progress advances, while preserving semantic inline links, emphasis, responsive line wrapping, and reduced-motion readability. Use for headlines, quotes, manifestos, product statements, onboarding messages, or editorial passages where scrolling should pace comprehension rather than simulate typing.
---

# Scroll-Scrubbed Word Reveal

Make reading progress visible without replacing real text, breaking inline markup, or depending on a fixed line count.

## Prepare the text

1. Keep one untouched accessible text source in the DOM.
2. Walk text nodes with `TreeWalker`; do not flatten the container with `textContent` or `innerHTML`.
3. Skip `script`, `style`, form controls, and elements marked with `[data-no-split]`.
4. Replace only non-whitespace tokens with spans and preserve whitespace nodes exactly.
5. Mark generated spans `aria-hidden="true"` only when an equivalent unsplit accessible copy remains available.

Preferred structure:

```html
<p class="reveal" data-reveal>
  Motion should <em>explain</em> the next state, not decorate it.
</p>
```

Avoid line-based splitting. Browser line wraps must remain free to change with container width, language, zoom, and font loading.

## Map scroll to words

Use section progress as the single source of truth:

```js
const reveal = Math.min(1, Math.max(0, progress));
const local = Math.min(1, Math.max(0, reveal * wordCount - index));
word.style.setProperty("--word-progress", local);
```

Interpolate hidden opacity, blur, and vertical offset from `--word-progress`. Keep the visible state identical to normal typography.

Use GSAP ScrollTrigger with `scrub` when precise starts, ends, refresh, or a shared timeline is needed. Use a dependency-free scroll measurement plus `requestAnimationFrame` for a standalone section.

## Set useful defaults

- Hidden opacity: `0.12–0.3`
- Blur: `4–10px`
- Vertical offset: `0.08–0.22em`
- Reveal span: `120–220%` of the viewport for a paragraph
- Direct word overlap: `10–30%`
- Easing: none for the scroll mapping; ease only the visual interpolation when needed

Expose the values as CSS custom properties. Scale the scroll span from text length rather than assuming one duration fits every passage.

## Preserve emphasis

- Let links, `strong`, `em`, marks, and accent spans keep their semantics and styling.
- Use inherited color by default; style accents on the original element, not on token indexes.
- Do not reveal essential links only on hover or after the reader has passed them.
- Re-split only when the source text changes. Responsive wrapping does not require rebuilding tokens.
- Store enough state to restore the original DOM during cleanup.

## Keep it readable

- Use real document flow; pin only when the copy and evidence justify a short deliberate reading beat.
- Do not use a typewriter cursor, random delays, or autoplay unless explicitly requested.
- Under `prefers-reduced-motion: reduce`, show every word immediately, remove blur and transforms, and remove any pinning.
- Keep screen-reader output natural and avoid announcing each word.
- Verify contrast in both the hidden and final states; hidden words may be quiet but the final text must meet the normal reading contract.

## Clean up

Kill ScrollTriggers, remove scroll and resize listeners, cancel animation frames, and restore the original marked-up subtree on route change or component unmount. Refresh measurements after fonts load if start or end positions depend on text geometry.

## Verify

Test inline links and emphasis, punctuation, repeated spaces, long words, 200% zoom, 390/768/1440 widths, content changes, forward and reverse scrolling, reduced motion, keyboard focus, screen-reader reading order, and teardown. The final DOM must still communicate the complete sentence with JavaScript disabled.

Use [demo/index.html](demo/index.html) as the working reference and [demo/PROMPT.md](demo/PROMPT.md) to recreate or remix it. Keep [REFERENCES.md](REFERENCES.md) as the links-only implementation source list.
