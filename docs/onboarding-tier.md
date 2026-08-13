# The onboarding tier (Simple ⇄ Everything)

three.ws ships a lot of surface: over 100 nav destinations and a homepage that
runs from text-to-3D through autonomous trading, on-chain identity and pay-per-call
payments. For someone who already knows the platform that breadth is the point.
For someone arriving for the first time it was the problem — the product's core
promise (make a 3D avatar, give it a brain, put it on your site) was competing for
attention with a trading terminal.

The onboarding tier fixes that without deleting anything. A first-time visitor gets
the **lite** tier: the ~28 destinations and the handful of homepage sections that
carry the core journey. Everything else is one click away behind a labelled control,
and once a visitor asks for it, it stays open on every page and every visit.

**Nothing is removed. Only deferred.**

---

## What a first-time visitor sees

| Surface | Lite tier | Full tier |
| --- | --- | --- |
| Nav menus | Build, Discover, Learn (~28 links) | + Launch (~119 links in all) |
| Homepage | Hero, start path, Forge, embed demo, the three doors, community, pose, AR, showcase | + trading, capabilities grid, token economy, live economy, Oracle, pay-per-call, developer platform, the stack |
| Mobile drawer | the same ~28 destinations in one flat list | all ~119 |

Directly under the homepage hero sits the **start path**: three steps, each with an
honest time estimate, in the order the product actually works.

1. **Create a 3D avatar** (~1 min) → [/create/prompt](https://three.ws/create/prompt)
2. **Build an AI agent** (~3 min) → [/create-agent](https://three.ws/create-agent)
3. **Publish anywhere** (~1 min) → the live embed demo on the same page

A visitor who already knows what they want is not trapped: the start path header
carries a "Power user? Skip to the advanced platform" link straight to the gate.

---

## How to switch tiers

Any of these flips the same preference, and every other surface follows immediately:

- **"Show everything"** at the foot of any nav dropdown (it names the count it is
  hiding, e.g. `Show everything +8`)
- **"Show everything"** at the end of the mobile drawer
- **"Show the advanced platform"** on the homepage's advanced gate
- Any **topic chip** on that gate (Autonomous trading, Token economy, Oracle
  scoring, …), which expands and jumps to that section
- **Following a link into a gated section** — a shared `three.ws/#home-x402` URL
  reveals its section for that visit rather than landing on a page that appears
  to be missing content
- Programmatically: `window.twsTier.set(false)` for full, `true` for lite,
  `window.twsTier.toggle()`, `window.twsTier.isLite()`

Going back is symmetrical: the same control reads "Show the simple menu".

---

## How it works

The tier is **one class on `<html>`** (`tws-lite`) driven by **one localStorage key**
(`tws:tier`, values `lite` | `full`, default `lite`). Everything else is CSS.

```
public/nav-data.js   tier: 'advanced' on a group, a column, or one item
public/nav.js        applyTier() + window.twsTier + the in-menu controls
public/nav.css       html.tws-lite .nav [data-tier="advanced"] { display: none }
pages/home.html      data-tier="advanced" sections + #advanced-gate + boot script
public/home.css      html.tws-lite [data-tier="advanced"] { display: none }
```

Three properties are worth knowing before you touch it:

**It never re-renders.** Switching tiers flips a class, nothing more. The nav's
dropdown and drawer wiring binds document-level listeners once at mount, so
re-rendering the menus would strand those listeners on detached nodes. Every
destination is always in the DOM; CSS decides what is visible.

**It never flashes.** The class is applied before paint — in the homepage's inline
`<head>` boot script, and at the top of `nav.js` before the menus are rendered. A
visitor never sees advanced content appear and then vanish.

**The two surfaces stay in sync through one event.** `applyTier` dispatches
`tws:tier-change`; the homepage gate listens for it, and the nav listens for
changes made elsewhere. Flipping the tier in a nav menu updates the homepage gate
button's `aria-expanded` in the same frame.

### Adding a destination

Add it to `public/nav-data.js` as usual. Then decide the tier:

```js
{
  title: 'Copy Trading',
  href: '/mirror',
  tier: 'advanced',        // a newcomer would need to know what this is first
  desc: 'Follow a proven agent by its honest on-chain track record',
}
```

Tag it `advanced` when someone would have to already know what it is to want it:
trading terminals, payment protocols, on-chain intel, capture rigs. Leave it in the
lite tier when it serves **creating, publishing, or browsing** — that is the journey
the lite tier exists to protect. `tier` works at three levels; the widest one wins:

- **group** — the whole menu disappears from the nav bar (this is how `Launch` is
  handled). A wholly-advanced group deliberately gets no "show everything" footer:
  that control could only ever collapse the menu the visitor is reading.
- **column** — one column of a mega menu, e.g. `Money & social`. The popover
  re-lays its grid to the remaining column count (`lite-cols-N`), so a hidden
  column never leaves an empty track.
- **item** — a single row.

### Adding a homepage section

Put `data-tier="advanced"` and a stable `id` on the `<section>`, then add a chip
for it inside `#advanced-gate` pointing at that id. The id is load-bearing: it is
what deep links and chips resolve against, and
`tests/onboarding-tier.test.js` fails if a chip points at a section that does not
exist.

---

## Guardrails

`tests/onboarding-tier.test.js` (20 tests) pins the parts that would otherwise
drift silently, since the four files involved have no import edge between them:

- the lite menu stays scannable (10–30 links) and the advanced tier keeps >50
- `/create`, `/create-agent`, `/forge`, `/create/selfie`, `/docs` and `/avatar-sdk`
  never leave the lite tier
- `/pay`, `/crypto`, `/mirror`, `/swarms`, `/pulse` and `/clash` stay out of it
- the storage key, the `<html>` class and the sync event match across nav and homepage
- every advanced-gate chip resolves to a real gated section
- the homepage's first magic (the Forge, the embed demo) is never gated
- a new visitor with unreadable localStorage lands on lite, not full

---

## Related

- [`public/nav-data.js`](../public/nav-data.js) — the single source of truth for every menu
- [`STRUCTURE.md`](../STRUCTURE.md) — where every product surface lives
- [`docs/start-here.md`](start-here.md) — the same journey, written for a human rather than a maintainer
