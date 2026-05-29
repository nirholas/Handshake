# Task: Mobile responsiveness pass — flawless at 320 / 768 / 1440

The core pages must be excellent on phones, tablets, and desktop. No horizontal
scroll, no overlap, no tiny tap targets.

## Scope
`pages/home.html`, `pages/marketplace.html`, `pages/agent-home.html`,
`pages/dashboard/`, `pages/pricing.html`, `pages/skills.html`, the global nav
(`public/nav.html`) and footer (`public/footer.html` / `src/components/footer.jsx`).

## Checklist per page (test at 320, 768, 1440)
1. **No horizontal overflow** at 320px. Find the offender (fixed widths, long unbreakable strings, oversized media) and fix with relative units / `min-width: 0` / `overflow-wrap`.
2. **Layout reflows sensibly** — multi-column grids collapse to single column; flex wraps. Use `clamp()` for fluid type and spacing.
3. **Tap targets ≥ 44×44px** on mobile. Space out dense controls.
4. **Nav** — works as a real mobile menu (hamburger/drawer) with keyboard + focus handling, not a desktop bar crammed onto a phone.
5. **3D canvases** — fit the viewport, cap devicePixelRatio on mobile, don't blow the layout. Consider a static poster on very small screens if perf demands.
6. **Modals/sheets** — full-height bottom sheets on mobile rather than tiny centered dialogs.
7. **Images/media** — responsive (`max-width: 100%`, correct `sizes`).

## Method
- `npm run dev`, use devtools device toolbar at each width. Walk every page.
- Prefer the design tokens (task 08) for spacing/type. Use `flex`/`grid`, avoid fixed px widths.

## Definition of done
- Every audited page is clean at 320 / 768 / 1440 — no overflow, overlap, or unreadable text.
- Mobile nav works with keyboard + focus.
- No console errors. `npm run build` clean. Run the **completionist** subagent.
- Report: issues found per breakpoint and the fixes.
