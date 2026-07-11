# Design Tokens — three.ws

Canonical design vocabulary. Source of truth for every primitive:
[`public/tokens.css`](../public/tokens.css); [`public/style.css`](../public/style.css)
imports it first and layers component tokens on top. New pages reference these tokens
directly (`var(--surface-1)`, `var(--text-md)`, `var(--font-display)`) instead
of hand-rolling hex/rgba/px values. Per-surface namespaces (`--nv-*`, `--ibm-*`)
alias the canonical tokens through the CSS-var fallback chain so every surface
inherits the system while keeping local names.

> **The rule:** no raw `#hex`, `rgba()`, or `px` font-size where a token exists.
> If you need a value the scale doesn't have, add a rung here first — don't
> hardcode it on the page.

---

## Typography (B07)

One type system, three families, one scale. This replaces the old
Space-Grotesk-vs-Inter-vs-Inter-Tight split.

### Families

| Token | Stack | Use for |
|-------|-------|---------|
| `--font-display` | `'Space Grotesk', 'Inter', system-ui, sans-serif` | Marketing headers, hero copy, brand, section titles |
| `--font-body` | `'Inter', system-ui, sans-serif` | Everything else — product UI, body copy, controls, labels |
| `--font-mono` | `'JetBrains Mono', 'SF Mono', 'Fira Code', ui-monospace, monospace` | Code, wallet/contract addresses, numeric readouts, eyebrows |

- **One display family** (Space Grotesk) for headings; **Inter** for body/product; **JetBrains Mono** for code.
- **`Inter Tight` is retired.** It was declared in eight places but never
  loaded (it silently rendered as Inter). Do not reintroduce it or any other
  family. A page that declares its own `font-family:` other than these three
  tokens is a bug.
- Fonts are **self-hosted** in [`public/fonts/fonts.css`](../public/fonts/fonts.css)
  (woff2, latin + latin-ext, variable, `font-display: swap`) and loaded **once**
  per page via `@import` in `style.css` or a single
  `<link rel="stylesheet" href="/fonts/fonts.css">`. Standalone pages must load
  it or their display family falls back to Inter.

### Type scale

Two registers in one ladder. The **dense UI band** gives px-honest homes to the
sizes the product actually uses most (nav, dashboard, cards, labels) — these
fill the gap the phi steps skip. The **display band** is phi-spaced (×1.618) for
marketing headers.

| Token | Size | Register | Use for |
|-------|------|----------|---------|
| `--text-2xs` | 11px | UI | Pills, badges, hints, timestamps |
| `--text-xs` | ~9.9px | UI | Smallest decorative label |
| `--text-sm` | ~12.2px | UI | Small UI labels, captions |
| `--text-md` | 13px | UI | **Dense UI body — the most common size** |
| `--text-ui` | 14px | UI | Nav links, controls, comfortable UI |
| `--text-base` | 16px | body | Reading body baseline |
| `--text-lg` | ~19.8px | display | Small headings |
| `--text-xl` | ~25.9px | display | Section headings |
| `--text-2xl` | ~41.9px | display | Hero / display |
| `--text-3xl` | ~67.8px | display | Oversized marketing display |

Migrate hardcoded `px` to the **nearest rung**; never reintroduce a raw px
font-size. Round one-offs (10.5, 13.5, 15.5…) to their neighbour.

### Weights & line-heights

| Token | Value | | Token | Value |
|-------|-------|---|-------|-------|
| `--weight-regular` | 400 | | `--leading-tight` | 1.382 |
| `--weight-medium` | 500 | | `--leading-normal` | 1.618 |
| `--weight-semibold` | 600 | | `--leading-loose` | 2.058 |
| `--weight-bold` | 700 | | | |

### Standard classes

Prefer these over declaring family + size + weight by hand. Defined in
`style.css`:

| Class | Renders |
|-------|---------|
| `.h1` `.h2` `.h3` `.h4` | Display headings (Space Grotesk, tight leading, negative tracking), 2xl → base |
| `.display` | Oversized marketing hero, fluid `clamp(2xl, 8vw, 3xl)` |
| `.body-lg` `.body` `.body-sm` | Inter body copy at lg / base / 14px |
| `.label` `.label-sm` | Medium-weight UI labels at 13px / 12px |
| `.eyebrow` | Uppercase mono overline above section titles |
| `.mono` | Monospace code / addresses / numerics |

---

## Color & surface

Monochrome glass on near-black, mirroring the dashboard palette so the whole
site reads as one product. Reference these instead of hand-rolling `rgba()`s.

| Token | Role |
|-------|------|
| `--bg`, `--surface-1/2/3`, `--surface-glass` | Backgrounds, glass cards (rising elevation) |
| `--stroke`, `--stroke-strong` | Hairline borders |
| `--ink`, `--ink-dim` | Primary / dim text |
| `--accent`, `--accent-soft` | Accent (white) + translucent accent |
| `--success`, `--danger`, `--warn` | Semantic states (green / red / amber) |

## Spacing, radii, motion

Phi-based spacing (`--space-3xs` → `--space-2xl`, each step ×1.618) and radii
(`--radius-sm/md/lg`, plus `--radius-card`, `--radius-control`, `--radius-pill`).

## Component tokens (B01 layer)

Buttons (`--btn-*`), cards (`--card-*`), badges/pills (`--badge-*`), modals
(`--modal-*`), and focus/disabled state (`--focus-ring-*`, `--disabled-*`) are
derived from the primitives above. Downstream components consume **only** these
component tokens — never reach past them to a raw rgba/hex.

---

_Maintained as part of the B-series UI uniformity work. Add new rungs/tokens
here when a real need appears; keep the "no hardcoded values" rule intact._
