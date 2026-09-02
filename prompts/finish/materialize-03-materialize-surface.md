# Work order 03: the /materialize surface and every entry point

**How to run:** paste this whole file into a fresh Claude Code chat in this
repo, or name its path. Read `prompts/finish/materialize-00-CONTEXT.md` first; its
decisions bind this order.

**Binding operating clause:** finish 100%. Never end with a question or an
unexecuted plan. CLAUDE.md hard rules apply in full, including the UI/UX
standards section: every state designed (loading, empty, error, populated),
transitions with intention, responsive at 320/768/1440, accessibility,
microinteractions. No em-dash. Explicit-path commits. The definition of
done for UI work includes exercising it in a real browser via `npm run dev`.

## Why this order exists

The screenshot moment. A user watches their prompt become an object they
can hold: the model spinning in a material-accurate preview, a slider that
resizes it over a coffee mug for scale, a price that updates live, an AR
button that puts the print at true size on their actual desk. This page is
the demo that sells the platform; the quality bar is the best product
pages on the internet, not the average of ours.

## Step 0: re-derive current state

```
grep -n materialize data/pages.json public/nav-data.js 2>/dev/null
ls pages/materialize.html src/materialize.js 2>/dev/null
curl -s localhost:3000/api/print/catalog | head -c 400
grep -n "print" src/model-page.js src/forge.js | head
```

Orders 01 and 02 must be live locally (analyze, prepare, catalog, quote,
orders). Verify by calling them, not by reading this sentence. Read before
writing: `src/model-page.js` (viewer + action-bar patterns), one recent
page module end to end for the house style (`src/labs.js` is compact), and
`docs/ui-juice.md` if present for the platform's motion conventions.

## Tasks

### 1. The page (`pages/materialize.html` + `src/materialize.js` + styles)

Route `/materialize`, registered in `data/pages.json` (path, title,
description, `added` date; this alone wires sitemap, llms.txt, features,
changelog). Flow, one screen, no wizard:

- **Pick a model**: accept `?creation=<id>` deep links, a paste-a-URL/GLB
  upload drop zone, and a "your creations" rail for signed-in users
  (reuse the creations fetch the portfolio page uses). Anonymous users get
  the full flow up to checkout, which asks for sign-in (state designed,
  not a dead end).
- **Live printability**: call analyze on selection; render the score as a
  meter with the named deductions as fixable line items; "Repair" runs
  prepare and shows before/after metrics (shells closed, walls thickened,
  final volume). Real progress from the job, never a fake bar.
- **Material + size**: material cards from the catalog (photo-real swatch
  styling per class; resin glossy, nylon matte, sandstone full-color using
  the model's own texture in the preview via a material override in the
  viewer). Size slider between the material's min/max height with a
  real-world scale reference silhouette (person svg at 175mm-scale logic:
  a mug at 95mm, a hand at 180mm, a person at full scale) that resizes
  against the model.
- **Live quote**: itemized panel re-quoted on every material/size/qty
  change (debounced), rendering exactly the engine's line items including
  the $THREE holder discount line when present. Rejections (walls too
  thin for resin) render as guidance pointing at the repair or a material
  that accepts the mesh, never a bare error.
- **True-scale AR**: the platform already ships model-viewer AR on model
  pages; here set the AR scale so the object appears at the exact ordered
  size. This is the feature phones were made for; make the button
  prominent on mobile.
- **Checkout**: shipping form (minimum PII fields, inline validation,
  country select drives the shipping zone), then the USDC payment step
  reusing the existing wallet-pay UI pattern (re-derive from the
  marketplace purchase flow). Success state links the order page and
  explains the certificate that will follow.

### 2. Order tracking (`/materialize/orders/:id`)

A timeline page over `GET /api/print/orders/:id`: status steps rendered as
a vertical progress rail with real timestamps from `print_order_events`,
the prepared model spinning at the top, tracking number once shipped,
certificate link once attested. Design the waiting states; most of this
page's life is spent between `submitted` and `shipped`.

### 3. Entry points (the platform must feel like one product)

- `/m/:id` model pages: a "Materialize" action next to the existing
  download/remix actions (`src/model-page.js`), deep-linking with the
  creation preselected.
- Forge result bar (`src/forge.js`): same action on a finished generation.
- Creations gallery cards: the action in the existing card menu.
- Nav: add to the appropriate menu in `public/nav-data.js` (advanced tier
  tag per the onboarding-tier conventions).

### 4. Tests + browser verification

Unit-test the pure page logic you extract (scale math, quote-panel
rendering from a fixture itemization; follow `src/model-lib.js` +
`tests/model-lib.test.js` precedent for the split). Then `npm run dev`,
exercise the full flow in a real browser on a real forge creation, and
capture: no console errors, network tab shows real analyze/quote calls,
every interactive element has hover/focus/active states, 320px layout
holds.

## Definition of done

- [ ] `/materialize` in `data/pages.json`; `npm run check:pages` (or the build's page audit) passes.
- [ ] Full flow exercised in a real browser against the dev server on a real creation: select, analyze, repair, quote, checkout to the payment step; described with evidence in the report.
- [ ] AR opens at ordered scale on a real device or the report states exactly what was verified locally vs what needs a phone.
- [ ] All three entry points render and deep-link correctly.
- [ ] Every state visible: empty (no model picked), loading, analyze failure (feed it a broken URL), quote rejection, checkout success.
- [ ] `npm test` green including new pure-logic tests.
- [ ] `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Committed with explicit paths; this file deleted in the closing commit; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Backend endpoint missing or broken | Fix it; orders 01/02 are in-repo code, not another team. Root-cause, never mask in the UI. |
| No real device for AR | Verify the scale attribute wiring and the model-viewer config locally, state the residual as one line in the report. Do not fake a verification. |
| Wallet-pay UI pattern unclear | Read the marketplace purchase flow end to end; reuse its components/copy. If it is genuinely bespoke per surface, match the closest one and note it. |
| Design tokens | Use the existing CSS variables; the platform has them (grep `--` in `public/nav.css` and neighbors). Do not invent a parallel palette. |
| Signed-in creations rail | The portfolio page's paginated creations endpoint already exists (`api/users/[username]/creations.js`). Reuse. |

## Report format

Files + tests, the browser-verification evidence (states seen, console
clean, network calls), screenshots if captured, residuals (AR device), one
line per 00-CONTEXT deviation, next action for 04/05/06.
