# Atlas: one keystroke to anywhere

three.ws has more than 700 public routes. Atlas is the layer that makes that
navigable instead of overwhelming.

Press **Cmd+K** (Ctrl+K on Windows and Linux) on any page of the site. A search
box opens over whatever you are doing. Type a page name, a URL fragment, or a
plain-English goal. Press Enter to go there. Press Escape to carry on where you
were.

`/` also opens it, as long as you are not already typing in a field and the page
itself did not claim that key first (pages with their own "press / to search"
hint keep it; Atlas listens in the bubble phase and stands down).

There are two halves, and the second one is the interesting one.

## Pages

Every route in the site's route table is searchable by title, path, and
description. Ranking is deliberately strict: every word you type has to match
the page somewhere, so adding a word narrows the list instead of widening it.
Typing `agent` returns a lot; typing `agent wallet` returns the handful that are
actually about agent wallets.

Small conveniences that matter in practice:

- Typing a path directly (`/pricing`) puts that exact page first, always.
- Typos are recovered by subsequence match, so `marketplce` still finds
  Marketplace. A real substring match always outranks a fuzzy one, so this can
  never push the obvious answer down.
- Pages that need an account are tagged `sign-in` in the result row, before you
  click and get bounced to a login screen.
- Your recently visited pages are the first thing shown when you open the box
  with nothing typed.

## Tasks

Searching only helps if you already know what the destination is called. The
harder question is "which page do I open to get paid per API call?", where four
different pages are plausible and only one of them starts the flow.

So Atlas also carries a curated set of **tasks**. A task answers with ordered
steps, each linking to the page for that step:

```
Query: "get paid"

  Get paid per API call
  Meter any endpoint with x402 and let other agents pay to use it.
    1. Wire the paywall in x402 Studio.                        -> /x402/studio
    2. Follow the worked example of a paid endpoint end to end. -> /tutorials/paid-x402-endpoint
    3. Watch the signed receipts come in.                      -> /receipts
```

Tasks appear above page results and only on a real signal (an exact-ish match on
one of their trigger phrases, or every word you typed appearing across them).
A task card is visually louder than a page row, so surfacing one loosely would
push real results down; the matcher is tuned to stay quiet rather than guess.

Opening Atlas with an empty box shows the tasks as a menu. That is the intended
first-run experience: someone who has no idea what to type still leaves with a
concrete next step.

## The map

[`/atlas`](/atlas) is the same data as a page you can read and share. Every
route grouped by section, with counts, live filtering, and the task shortcuts at
the top. Search state lives in the URL, so `/atlas?q=x402` is a link you can send
to someone.

Use the palette when you know roughly where you are going. Use the map when you
want to see what the product actually contains.

## Adding a task

Tasks live in [`data/atlas-intents.json`](../data/atlas-intents.json). Add one:

```json
{
  "id": "restyle-a-model",
  "title": "Restyle a model I already have",
  "blurb": "Swap materials, or re-texture the whole thing from a prompt.",
  "match": ["restyle", "retexture", "change materials", "new look", "reskin"],
  "steps": [
    { "do": "Open Restyle Studio and drop the model in.", "to": "/restyle" },
    { "do": "Save the variant to your collection.", "to": "/collection", "note": "Requires sign-in" }
  ]
}
```

Then regenerate the index:

```bash
node scripts/build-atlas-index.mjs
```

Every `to` is resolved against the real route table at that moment. A step
pointing at a route that does not exist **fails the build**, with the offending
target named:

```
[atlas] the intent catalog does not hold up:
  - intent "restyle-a-model" step 1 points at "/restlye", which is not a route in data/pages.json
```

That gate is the whole reason the index is generated rather than read at
runtime. Hand-written getting-started docs rot silently as routes move; an
onboarding path here cannot dead-end on a 404, because the build refuses to
produce one.

Write `match` phrases in the words a newcomer would type, not in our internal
feature names. Nobody types "x402 facilitator"; they type "get paid".

## How it is wired

| Piece | File | What it does |
| --- | --- | --- |
| Ranking | [`public/atlas/score.js`](../public/atlas/score.js) | Pure, DOM-free scoring for pages and tasks. Shared by the palette and the map, so a result can never be findable in one and missing from the other. |
| Palette | [`public/atlas.js`](../public/atlas.js) | The Cmd+K overlay. Zero dependencies, one file, no framework, because it has to run identically on 250+ standalone HTML pages. |
| Map page | [`src/atlas-page.js`](../src/atlas-page.js) | The `/atlas` browse-and-filter view. |
| Index | [`scripts/build-atlas-index.mjs`](../scripts/build-atlas-index.mjs) | Flattens `data/pages.json` plus the task catalog into `public/atlas-index.json`, and runs the gate. Wired into `prebuild`. |
| Coverage | [`scripts/inject-atlas.mjs`](../scripts/inject-atlas.mjs) | Walks `dist/` after the build and guarantees every page loads the palette. |

The index is fetched on **first open**, never at page load, so a visitor who
never presses Cmd+K pays only for the small boot script. It is warmed on the
first idle callback, so the first open is still instant.

### Opting a page out

Embeds, widgets, and anything rendered inside a third-party iframe never get
Atlas: taking someone else's Cmd+K is hostile, and the script refuses to run in
a frame regardless. To opt a first-party page out:

```html
<html data-no-atlas>
```

or

```html
<meta name="atlas" content="off" />
```

### Opening it from your own code

```html
<button data-atlas-open>Search</button>
<button data-atlas-open="launch a coin">How do I launch a coin?</button>
```

Any element with `data-atlas-open` opens the palette on click, seeded with the
attribute's value. From JavaScript:

```js
window.__twsAtlas.open('get paid'); // open, pre-filled
window.__twsAtlas.close();
```

Linking straight into it works too, which is what a support reply or a doc
wants: [`/?atlas=embed`](/?atlas=embed) opens any page with the palette already
searching for "embed".

## Related

- [`/atlas`](/atlas) is the browsable map.
- [`/sitemap`](/sitemap) is the flat list of every route, and does not depend on
  the index loading.
- [`llms.txt`](/llms.txt) is the same territory for machines.
- [Start here](/docs/start-here) is the guided introduction to the docs.
