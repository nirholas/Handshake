# Task: Consolidate a real design system (tokens)

Many pages redefine the same colors, spacing, and type inline. Extract one
canonical design-token layer and adopt it across the core pages so the product
feels coherent.

## Source of truth
`pages/home.html :root` already defines a clean dark palette (`--bg`,
`--surface-0..3`, `--hairline*`, `--text..text-4`, `--accent`) plus the Inter /
Inter Tight / JetBrains Mono type stack. Promote this into a shared stylesheet.

## What to build
1. Create `src/styles/tokens.css` (or extend an existing shared CSS entry if one is already imported globally — check `vite.config.js` and existing `<link>`s first; reuse, don't duplicate). Define:
   - **Color**: the existing palette + semantic aliases (`--color-bg`, `--color-text`, `--color-accent`, `--color-danger`, `--color-success`, `--color-warning`, border/hairline).
   - **Spacing scale**: `--space-1..8` (4px base).
   - **Radius**: `--radius-sm/md/lg/full`.
   - **Type scale**: font families, sizes, weights, line-heights as tokens.
   - **Elevation/shadow** and **motion** tokens (`--ease-out`, `--dur-fast/med`).
2. Import the token sheet into the core pages (`home`, `marketplace`, `agent-home`, `dashboard`, `pricing`, `skills`).
3. Replace inline literal colors/spacing/type on those pages with the tokens. Keep the visual result identical (this is a refactor, not a redesign).
4. Document the tokens at the top of the file with a short comment block.

## Constraints
- No visual regression — diff each page before/after; pixels should match.
- Don't fork tokens per page. One source.

## Definition of done
- `src/styles/tokens.css` exists, imported by the core pages, documented.
- Inline color/spacing literals on those pages replaced with tokens.
- `npm run dev`: pages look identical to before. `npm run build` clean.
- Run the **completionist** subagent. Report the token set and which pages adopted it.

> Land this BEFORE tasks 09, 10, 11 so they consume the tokens.
