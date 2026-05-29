# Task: Accessibility pass — semantic HTML, keyboard, focus, contrast

CLAUDE.md: "Accessibility is not optional." Bring the core pages to WCAG AA.

## Scope
`pages/home.html`, `pages/marketplace.html`, `pages/agent-home.html`,
`pages/dashboard/`, `pages/pricing.html`, `pages/skills.html`, and their `src/*.js`
controllers. Plus shared components in `src/components/`.

## Checklist (apply to each page)
1. **Semantic structure** — real `<nav> <main> <header> <footer> <button> <a>` instead of `<div onclick>`. One `<h1>`, logical heading order.
2. **Keyboard nav** — every interactive element reachable and operable by Tab/Enter/Space/Escape. Modals trap focus and restore it on close. No keyboard traps.
3. **Focus indicators** — visible focus ring on every focusable element (don't `outline: none` without a replacement). Respect `:focus-visible`.
4. **ARIA** — labels on icon-only buttons, `aria-expanded` on toggles, `role="dialog"` + `aria-modal` on modals, `aria-live` on async status regions, `alt` on meaningful images (empty `alt` on decorative).
5. **Color contrast** — verify text vs background meets AA (4.5:1 body, 3:1 large). The dark theme tokens are in `home.html :root` (`--text`, `--text-2`, `--text-3`…); check the low-contrast greys against their surfaces and fix the failing ones.
6. **Motion** — respect `prefers-reduced-motion`: gate non-essential animation behind it.
7. **Forms** — every input has an associated `<label>`; errors announced.

## Method
- Tab through each page manually (`npm run dev`). Run an axe-core pass if available (`npx @axe-core/cli` or inject axe in the console).
- Fix violations at the source. Add a skip-to-content link on the main pages.

## Definition of done
- Keyboard-only operation works end-to-end on every audited page.
- No axe-core critical/serious violations remaining (list any intentionally deferred).
- Contrast failures fixed; `prefers-reduced-motion` honored.
- Run the **completionist** subagent. Report violations found + fixes.
