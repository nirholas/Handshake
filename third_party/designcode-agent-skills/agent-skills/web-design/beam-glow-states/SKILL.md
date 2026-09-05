---
name: beam-glow-states
description: Create React loading, processing, selected, current, focus, and pressed states with the border-beam package's animated edge glow. Use when a card, button, input, tab, option, task panel, or agent surface needs a restrained traveling or breathing beam; includes installation, imports, prop selection, state wiring, reduced motion, accessibility, and performance and layout guardrails.
---

# Beam Glow States

Use the beam as a decorative state accent. Keep the state understandable through text, shape, contrast, and the correct semantic attribute when the animation is absent.

The API below was verified against `border-beam` 1.3.0. Recheck the official README and exported types when the installed version changes.

## Install and import

Install the same package with the repository's package manager:

```bash
npm install border-beam
pnpm add border-beam
yarn add border-beam
bun add border-beam
```

The package requires React and React DOM 18 or newer. It ships ESM, CommonJS, and TypeScript declarations. It injects component-scoped styles, so do not import a separate CSS file.

Prefer the named import:

```tsx
import { BorderBeam } from "border-beam";
import type {
  BorderBeamProps,
  BorderBeamSize,
  BorderBeamTheme,
  BorderBeamColorVariant,
} from "border-beam";
```

The default component export is also supported:

```tsx
import BorderBeam from "border-beam";
```

In a Next.js App Router project, render it from a client component because it uses React state, effects, observers, and animation frames:

```tsx
"use client";

import { BorderBeam } from "border-beam";
```

## Choose the effect

| `size` | Motion | Best use |
| --- | --- | --- |
| `sm` | Compact traveling border | Icon buttons, pills, compact controls |
| `md` | Full traveling border | Selected cards, current panels, primary active surfaces |
| `line` | Traveling bottom edge | Search, prompt, input, progress, or command surfaces |
| `pulse-inner` | Contained breathing glow | Loading cards, processing panels, persistent selected states |
| `pulse-outside` | Outward breathing halo | One prominent active task or hero control with room to bloom |

Use these defaults by state:

- Loading or processing: `pulse-inner`, `strength={0.55}` to `0.75`, `duration={2.3}` to `3`.
- Selected or current: `md` or `pulse-inner`, `strength={0.3}` to `0.55`, `duration={3.2}` to `5`.
- Focus or short active feedback: `sm` or `line`, `strength={0.35}` to `0.6`.
- High-priority live task: `pulse-outside`, `strength={0.45}` to `0.7`; allow only one in a view.

Start with `colorVariant="mono"` for neutral product UI, `ocean` for cool technical states, `sunset` for warm urgency, and `colorful` for a rare high-salience moment.

## Start with one mounted wrapper

Keep `BorderBeam` mounted and toggle `active`. Removing it when state becomes false skips the built-in fade-out.

```tsx
<BorderBeam
  size="pulse-inner"
  colorVariant="ocean"
  theme="dark"
  strength={0.65}
  active={isWorking}
>
  <section className="task-card" aria-busy={isWorking}>
    <p>{isWorking ? "Generating layout options…" : "Layout options ready"}</p>
  </section>
</BorderBeam>
```

`active` fades in over `0.6s` and fades out over `0.5s`. Use `onActivate` and `onDeactivate` only when work must align with the completed visual transition.

## Wire loading state

Make the loading state truthful before adding the beam:

```tsx
<BorderBeam
  size="pulse-inner"
  colorVariant="ocean"
  strength={0.65}
  active={pending && !reduceMotion}
  onDeactivate={() => {
    // Optional: advance only after the 0.5s beam exit completes.
  }}
>
  <section className="beam-surface" aria-busy={pending}>
    <span className="status-dot" aria-hidden="true" />
    <span>{pending ? "Building preview…" : "Preview ready"}</span>
  </section>
</BorderBeam>
```

- Show a visible status label or progress value; never make the moving edge the only loading cue.
- Avoid showing the beam for operations that finish in roughly `150ms` or less.
- Once shown, keep the loading presentation visible for about `400ms` to `600ms` to prevent a flash.
- Preserve layout between pending and complete states.
- Keep cancellation, retry, and error controls usable. The effect layers already use `pointer-events: none`.

Use `line` when the work belongs to one input or prompt bar. Use `pulse-inner` when the whole card is busy.

## Wire selected or current state

Use the component state and the semantic state together:

```tsx
<BorderBeam
  size="md"
  colorVariant="mono"
  staticColors
  duration={4.2}
  strength={0.42}
  active={selected && !reduceMotion}
  className="beam-card"
>
  <button
    type="button"
    className="beam-surface"
    aria-pressed={selected}
    onClick={onSelect}
  >
    {label}
  </button>
</BorderBeam>
```

- Use `aria-selected` for tabs, listbox options, grid cells, and similar selection widgets.
- Use `aria-current` for the current page, step, date, or location.
- Use `aria-pressed` only for toggle buttons.
- Keep a static selected background or outline. The beam should add attention, not carry meaning by itself.
- Slow persistent selected beams down. Reserve the faster default travel for loading or brief activation.

For a large collection, animate only the newly selected item for `800ms` to `1200ms`, then retain the static selected style. Do not run a beam on every selected item indefinitely.

## Wire focus and active state

Track focus on the wrapper because all standard `HTMLDivElement` attributes and capture handlers are forwarded:

```tsx
const [focused, setFocused] = useState(false);

<BorderBeam
  size="sm"
  colorVariant="mono"
  strength={0.45}
  active={focused && !reduceMotion}
  className="beam-inline"
  onFocusCapture={() => setFocused(true)}
  onBlurCapture={(event) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocused(false);
  }}
>
  <button className="beam-surface">Run</button>
</BorderBeam>
```

Keep the ordinary `:focus-visible` outline. Pointer hover alone should not start a high-intensity beam, and a pressed state should still have immediate scale, fill, or contrast feedback.

When states overlap, resolve them explicitly:

```tsx
const beamState =
  pending ? "loading" :
  selected ? "selected" :
  focused ? "focus" :
  "idle";

const beamProps = {
  loading: {
    size: "pulse-inner",
    colorVariant: "ocean",
    duration: 2.6,
    strength: 0.65,
  },
  selected: {
    size: "md",
    colorVariant: "mono",
    duration: 4.2,
    strength: 0.42,
    staticColors: true,
  },
  focus: {
    size: "sm",
    colorVariant: "mono",
    duration: 2.4,
    strength: 0.45,
    staticColors: true,
  },
} as const;

const activeProps = beamState === "idle" ? null : beamProps[beamState];

<BorderBeam
  {...(activeProps ?? { size: "md" as const })}
  active={activeProps !== null && !reduceMotion}
>
  <div className="beam-surface" data-state={beamState}>
    {children}
  </div>
</BorderBeam>
```

Use loading above selection, selection above focus, and focus above hover unless the product's state model says otherwise.

## Handle reduced motion

Pulse presets stop their animations under `prefers-reduced-motion: reduce`. Rotate and line presets should also be disabled by the consumer. Use the project's media-query hook or a small client hook:

```tsx
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}
```

Provide a static fallback on the child surface:

```css
.beam-surface {
  border: 1px solid rgb(255 255 255 / 0.12);
}

[data-state="selected"] {
  border-color: rgb(140 155 255 / 0.7);
  box-shadow: 0 0 0 3px rgb(100 120 255 / 0.12);
}

:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}

@media (prefers-reduced-motion: reduce) {
  [data-state="loading"] {
    border-color: rgb(100 150 255 / 0.68);
  }
}
```

## API reference

| Prop | Type | Default | Contract |
| --- | --- | --- | --- |
| `children` | `ReactNode` | Required | Content wrapped by one generated `div` |
| `size` | `"sm" \| "md" \| "line" \| "pulse-outside" \| "pulse-inner"` | `"md"` | Effect family and geometry preset |
| `colorVariant` | `"colorful" \| "mono" \| "ocean" \| "sunset"` | `"colorful"` | Beam palette |
| `theme` | `"dark" \| "light" \| "auto"` | `"dark"` | Adapts opacity and color treatment to the background |
| `strength` | `number` | `1` | Beam-layer opacity; clamped to `0`–`1`; never changes child opacity |
| `duration` | `number` | `1.96` rotate, `3.1` line, `2.3` pulse | Animation cycle in seconds |
| `active` | `boolean` | `true` | Starts fade-in or fade-out and controls ongoing motion |
| `borderRadius` | `number` | Auto-detected | Wrapper radius in pixels |
| `brightness` | `number` | Per preset, usually `1.3` | Glow brightness multiplier |
| `saturation` | `number` | Per theme, usually `1.2` on dark | Glow saturation multiplier |
| `hueRange` | `number` | `30` | Hue-shift range in degrees; `line` is capped at `13` |
| `staticColors` | `boolean` | `false` | Disables hue shifting, not travel or pulse motion |
| `className` | `string` | — | Class on the generated wrapper |
| `style` | `CSSProperties` | — | Inline style on the generated wrapper |
| `onActivate` | `() => void` | — | Fires when the `0.6s` fade-in completes |
| `onDeactivate` | `() => void` | — | Fires when the `0.5s` fade-out completes |

`mono` always uses static colors, even when `staticColors` is false. A forwarded `ref` points to the wrapper. Other standard `HTMLDivElement` attributes and events are forwarded.

The package also exports `sizePresets`, `sizeThemePresets`, and the deprecated `themeColors`. Treat them as implementation reference; prefer component props instead of mutating exported preset objects.

## Respect the wrapper

- `BorderBeam` renders a `div`. Place it inside required semantic parents such as `li`, `td`, or `label`; do not let it replace those elements.
- The wrapper is block-level by default. Use `display: inline-block` or `inline-flex` for compact controls and `width: 100%` for cards.
- Keep the first child aligned to the wrapper bounds. A small child inside a stretched wrapper produces a beam around empty space.
- Border radius is read from the first child's computed top-left radius. Set `borderRadius` explicitly when corners differ, radius changes at runtime, or late styles make detection unreliable.
- `sm`, `md`, `line`, and `pulse-inner` clip overflow. Do not place menus or tooltips inside those wrappers if they must escape.
- `pulse-outside` uses `overflow: visible`. Its child must be opaque so the inner glow does not show through, and the surrounding layout must allow the halo to spill.
- Give `pulse-outside` children their own subtle `1px` border or inset ring. That preset intentionally does not paint a separate idle hairline.

```css
.beam-inline {
  display: inline-block;
}

.beam-card {
  display: block;
  width: 100%;
}

.beam-surface {
  width: 100%;
  border-radius: inherit;
  background: rgb(18 18 20);
}
```

## Keep it restrained

- Use one dominant animated beam per viewport. Several simultaneous beams flatten hierarchy and increase paint work.
- Prefer `strength` before changing brightness or saturation.
- Keep selection beams slower and quieter than loading beams.
- Do not combine a full beam with another animated gradient border, large pulsing shadow, and moving background.
- Let `pulse-outside` breathe into real empty space; never crop it accidentally.
- Expect pulse instances to share a frame-rate-capped animation loop and pause offscreen. Rotate and line use CSS animation and also pause when the component is offscreen.

## Verify

Test:

- Initial inactive, fade-in, steady active, fade-out, and rapid state reversal.
- Loading success, error, retry, and cancellation without abrupt unmounting.
- Correct `aria-busy`, `aria-selected`, `aria-current`, or `aria-pressed` semantics.
- Keyboard focus with the beam disabled and with reduced motion enabled.
- Dark, light, and `auto` themes against the actual surface.
- `sm`, `md`, `line`, `pulse-inner`, and `pulse-outside` at 320, 768, and 1440 widths.
- Border-radius alignment, parent overflow, opaque outside-pulse children, and compact wrapper sizing.
- Long labels, 200% zoom, many list items, offscreen pausing, route cleanup, and console errors.

Keep [REFERENCES.md](REFERENCES.md) as the links-only source list.
