# three.ws — Design Tokens (B01)

One vocabulary for the whole platform. Every colour, surface, spacing, type,
radius, shadow, blur, and motion value comes from **`public/tokens.css`** — the
single source of truth. Reference tokens by name; never hardcode a value a token
already expresses.

> The eight legacy per-surface namespaces (`--mk-*`, `--pd-*`, `--ibm-*`,
> `--gx-*`, `--ho-*`, `--saas-*`, `--sdk-*`, `--t-*`) were removed in B02. Do not
> reintroduce a parallel palette.

## Where it lives & how it loads

- **`public/tokens.css`** — canonical primitives (this is what you edit to change
  a global value).
- **`public/style.css`** `@import`s it first, then layers *component* tokens on
  top (buttons, cards, badges, skeleton — all referencing primitives via `var()`).
- **`public/nav.css`** also `@import`s it, so pages that inject the shared nav but
  don't load the full `style.css` (embed / standalone surfaces) still resolve the
  vocabulary.

A page is covered if it links **`/style.css`** *or* injects the shared nav
(`/nav.css`). New pages should do one of those — never redefine tokens locally.

## The naming convention

Tokens use **flat, semantic, unprefixed names** (`--surface-1`, `--ink`,
`--space-md`). That set is already adopted across the site, so it is the
canonical prefix — there is no `--ds-`/`--nxt-` rename. `--nxt-*` (app shell)
and `--nv-*` (nav) are thin alias layers that resolve *to* these tokens via
`var(--surface-1, …)`; keep them as aliases, don't fork them.

## Vocabulary

### Colour — ink (text)
| Token | Use |
|-------|-----|
| `--ink-bright` | pure-white headings, primary CTA labels |
| `--ink` | default body text |
| `--ink-dim` | secondary / muted text |
| `--ink-faint` | tertiary hints, disabled, watermark labels |

### Colour — surfaces, strokes, accent, backgrounds
| Token | Use |
|-------|-----|
| `--bg-0` / `--bg-1` | opaque page background / raised solid panel |
| `--surface-1/2/3` | translucent glass fills (low → high) |
| `--surface-glass` | gradient glass for cards/docks |
| `--stroke` / `--stroke-strong` | hairline border / emphasized border |
| `--accent` / `--accent-soft` | accent (white) / 10% accent wash |

### Colour — state
`--success` `#4ade80` · `--danger` `#f87171` · `--warn` `#fbbf24`. Tinted
variants (e.g. badge/button danger fills) are derived in the component layer of
`style.css` — reuse those, don't re-derive.

### Colour: scrim & on-scrim (B14)
The one part of the palette that does **not** flip with the theme. A scrim sits
on top of *media* (a screenshot, a video frame, a 3D canvas, a modal backdrop),
not on a page surface, so its job is legibility over unknown pixels: it stays
dark and its ink stays light in both themes.

| Token | Use |
|-------|-----|
| `--scrim-soft` | gradient legibility wash under a caption |
| `--scrim` | standard chip or label resting on media |
| `--scrim-strong` | hover/pressed state of the above, heavy caption bars, letterboxing |
| `--scrim-modal` | full-screen backdrop behind a dialog or lightbox |
| `--on-scrim-bright` / `--on-scrim` / `--on-scrim-dim` | ink on a scrim |
| `--on-scrim-stroke` | hairline on a scrim |

Pair scrims with `--on-scrim*`, never with `--ink*` (which flips to near-black
on light and would vanish). These four values replaced a cluster of 400+
hand-typed `rgba(0, 0, 0, …)` overlays that had drifted across ~12 alphas.

### Spacing (φ = 1.618 scale)
`--space-3xs` `--space-2xs` `--space-xs` `--space-sm` `--space-md` (16px base)
`--space-lg` `--space-xl` `--space-2xl`. Use for padding, gap, margin.

### Typography
- **Sizes:** `--text-2xs` (11px) `--text-xs` `--text-sm` `--text-md` (13px, the
  common UI size) `--text-ui` (14px) `--text-base` (16px) `--text-lg` `--text-xl`
  `--text-2xl` `--text-3xl`.
- **Families:** `--font-display` (Space Grotesk) · `--font-body` (Inter) ·
  `--font-mono` (JetBrains Mono).
- **Weights:** `--weight-regular|medium|semibold|bold`.
- **Line height:** `--leading-tight|normal|loose`.

### Radius (4-token scale)
`--radius-sm` (6px, chips/inputs) · `--radius-md` (10px, controls) ·
`--radius-lg` (14px, cards/modals) · `--radius-pill` (999px). Legacy aliases
`--radius-control`→md, `--radius-card`→lg remain for existing consumers.

### Elevation / shadow
`--shadow-1` (resting panel) · `--shadow-2` (card) · `--shadow-3` (lifted/hover/
modal). Utility classes `.elev-1/2/3` apply them.

### Blur (backdrop glass)
`--blur-sm` (8px) · `--blur-md` (16px) · `--blur-lg` (28px). Pair with a
`--surface-*` fill: `backdrop-filter: blur(var(--blur-md));`.

### Motion
- **Durations:** `--duration-instant` (80ms) · `--duration-fast` (140ms,
  controls) · `--duration-base` (220ms, panels) · `--duration-slow` (420ms,
  reveals).
- **Easings:** `--ease-standard` (default UI) · `--ease-emphasized` (expressive
  enter) · `--ease-out` (decelerate-only).
- Durations collapse to `0ms` under `prefers-reduced-motion: reduce` (handled in
  `tokens.css`).

```css
transition: transform var(--duration-fast) var(--ease-standard),
            opacity   var(--duration-fast) var(--ease-standard);
```

### Layout
`--header-h` (3.5rem) · `--phi` (1.618).

### Semantic alias layer (B12)
Thin, intention-named synonyms that resolve *to* the primitives above (same
sanctioned pattern as `--nxt-*` / `--nv-*` — they alias, never fork). Reach for
these when an intention name reads clearer than the primitive:

- **Colour:** `--color-bg`→`--bg-0` · `--color-surface`→`--surface-1` ·
  `--color-text`→`--ink` · `--color-text-bright`→`--ink-bright` ·
  `--color-text-dim`→`--ink-dim` · `--color-text-faint`→`--ink-faint` ·
  `--color-accent`→`--accent` · `--color-border`/`--color-hairline`→`--stroke` ·
  `--color-danger`→`--danger` · `--color-success`→`--success` ·
  `--color-warning`→`--warn`. Because they point at the remapped primitives they
  flip automatically under `[data-theme='light']`.
- **Spacing (4px UI grid):** `--space-1`…`--space-8` (4/8/12/16/20/24/28/32px).
  Complements — does not replace — the φ display scale (`--space-sm/md/lg…`).
  Use the φ rungs for marketing rhythm; use the 4px ramp for product chrome
  (nav/cards/forms) where dense layouts sit on a 4px grid.
- **Radius:** `--radius-full`→`--radius-pill`.
- **Motion:** `--dur-fast`→`--duration-fast` · `--dur-med`→`--duration-base`.

## Platform floors (B14)

Naming a focus ring only helps the components that remember to reach for it. A
sweep found ~1,500 selectors that declare `cursor: pointer` yet define no
focus-visible or disabled rule at all, and 26 stylesheets with `@keyframes` and
no `prefers-reduced-motion` block. `public/tokens.css` now closes all three gaps
once, for every page (it is imported by both `style.css` and `nav.css`).

**These are floors, never ceilings.** The focus and disabled rules are wrapped in
`:where()`, which forces their specificity to (0,0,0), so any component rule,
however weakly written, still overrides them. Nothing that already styles its own
state changes appearance.

| Floor | What it guarantees |
|-------|--------------------|
| Focus | Every link, button, form control, `[tabindex]` and interactive ARIA role gets `outline: var(--focus-ring-width) solid var(--focus-ring-color)` on `:focus-visible`. Keyboard only, so mouse clicks are unaffected. |
| Disabled | `[disabled]` and `[aria-disabled='true']` get `--disabled-opacity` and `--disabled-cursor`. The ARIA half matters for custom controls (a `div[role=button]` can't use the native attribute). |
| Reduced motion | Under `prefers-reduced-motion: reduce`, animations and transitions collapse platform-wide, on top of the existing duration-token zeroing. |

Want no ring on a control? Re-style it (a different colour, an inset shadow).
Do not remove it.

### Opting out of the reduced-motion floor

"Reduce" does not mean "remove status". A spinner frozen mid-rotation reads as a
hung page, which is worse than the motion. Two carve-outs keep animating:

1. **Busy and progress indicators**, matched by `[aria-busy='true']`,
   `[role='progressbar']`, and a substring class match on `spin` / `loader`
   (this covers the ~28 differently-named spinner classes without maintaining a
   list of them).
2. **Anything you mark explicitly**: `data-motion="essential"` or the
   `.motion-keep` class, plus its subtree. Reach for this only where the movement
   *is* the information.

```html
<!-- movement carries meaning here, so keep it under reduced motion -->
<div class="tx-progress" data-motion="essential">…</div>
```

## The rule: no hardcoded values

Before typing a literal, check for a token:

| ❌ Don't | ✅ Do |
|---------|------|
| `color: #888` | `color: var(--ink-dim)` |
| `background: #0a0a0a` | `background: var(--bg-0)` |
| `border: 1px solid rgba(255,255,255,.08)` | `border: 1px solid var(--stroke)` |
| `padding: 16px` | `padding: var(--space-md)` |
| `font-size: 13px` | `font-size: var(--text-md)` |
| `border-radius: 14px` | `border-radius: var(--radius-lg)` |
| `box-shadow: 0 8px 32px rgba(0,0,0,.5)` | `box-shadow: var(--shadow-3)` |
| `backdrop-filter: blur(16px)` | `backdrop-filter: blur(var(--blur-md))` |
| `transition: .2s ease` | `transition: var(--duration-base) var(--ease-standard)` |

Need a value no token expresses? Add the token to `public/tokens.css` (with a
comment), then reference it — don't inline a one-off. Migrating existing
hardcoded values to tokens is tracked under **B08**.

### Enforcement: the token-drift ratchet (B13)

`npm run audit:tokens` (part of `npm run gate`) runs
[scripts/audit-token-drift.mjs](scripts/audit-token-drift.mjs): it counts
hardcoded hexes that literally equal a canonical token value (`#4ade80` =
`--success`, `#f87171` = `--danger`, `#fbbf24` = `--warn`) inside `<style>`
blocks of `pages/` files that load the token vocabulary. The count may only go
**down** — the baseline (`scripts/audit-token-drift.baseline.json`, currently
**0**) fails the build if a new hardcoded status hex lands. Pages that
deliberately re-theme a status token (they define their own `--success` etc.)
are exempt for that token; JS/canvas literals are out of scope. When you
eliminate drift, lock it in with `node scripts/audit-token-drift.mjs --update`.

## Brand themes

A surface needing a distinct brand accent (e.g. IBM Carbon blue at `/ibm/*`)
remaps tokens in a small scoped theme layer — it never ships a standalone
palette:

```css
.ibm-surface { --accent: #0f62fe; --accent-soft: rgba(15,98,254,.12); }
```
