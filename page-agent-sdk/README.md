<div align="center">

# @three-ws/page-agent

**A rigged 3D AI agent that talks your visitors through any web page.**

One tag. A skeleton-rigged, lipsync-capable avatar docks in the corner, greets
visitors, narrates your page out loud, and lets each visitor pick the guide they
want — from a diverse roster of rigged agents.

[![npm](https://img.shields.io/npm/v/@three-ws/page-agent?logo=npm&color=cb3837)](https://www.npmjs.com/package/@three-ws/page-agent)
[![downloads](https://img.shields.io/npm/dm/@three-ws/page-agent?color=cb3837)](https://www.npmjs.com/package/@three-ws/page-agent)
![license](https://img.shields.io/npm/l/@three-ws/page-agent?color=3b82f6)
![node](https://img.shields.io/node/v/@three-ws/page-agent?color=339933&logo=node.js)

[Quick start](#quick-start) · [Docs](#documentation) · [The catalog](#the-rigged-catalog) · [Persona presets](#persona-presets) · [API](#api) · [How it works](#how-it-works) · [FAQ](#faq)

</div>

---

## Why

Most "AI widget" embeds are a text bubble. This is a **3D presence**: a rigged
character that looks at the visitor, breathes, blinks, and moves its mouth to the
words it speaks — synthesized in the browser, no backend, no API key, no audio
files.

**Only rigged agents, by design.** Every avatar in the catalog ships a verified
skinned mesh + armature. That's a hard rule, not a preference: the runtime drives
skeletal idle motion and viseme lipsync, so an unrigged mesh would render a
frozen, dead-faced statue. Those are excluded.

## Quick start

### 1 — One script tag (zero JS)

```html
<script src="https://unpkg.com/@three-ws/page-agent/dist/page-agent.global.js"
        data-page-agent
        data-avatar="nova"
        data-auto-narrate
        defer></script>
```

That's it. `Nova` appears bottom-right and tours the page. The visitor can change
guides from the control bar.

### 2 — HTML element

```html
<script type="module">import '@three-ws/page-agent';</script>

<page-agent avatar="sol" position="bottom-right" auto-narrate></page-agent>
```

### 3 — Imperative (full control)

```js
import { PageAgent } from '@three-ws/page-agent';

const guide = new PageAgent({ agent: 'atlas', autoNarrate: true });

guide.narrate('Welcome — let me show you the new dashboard.');
guide.on('segment', ({ text, el }) => highlight(el));
```

> **Peer dependency:** `three` (>= 0.150). Bundler users get tree-shaking and a
> small ESM build with `three` left external. The `/global` build inlines three
> for a plain CDN `<script>`.

## Documentation

Full guides live in [`docs/`](./docs/README.md), tiered by experience:

- 🟢 **Basic** — [Getting started](./docs/getting-started.md) ·
  [Narrating your page](./docs/guide-narration.md) ·
  [Troubleshooting & FAQ](./docs/troubleshooting.md)
- 🟡 **Medium** — [Framework integration](./docs/guide-frameworks.md) (React, Next, Vue, Svelte, Astro, no-code) ·
  [Recipes](./docs/recipes.md) · [API reference](./docs/api-reference.md)
- 🔴 **Advanced** — [Custom avatars](./docs/guide-custom-avatars.md) ·
  [Building blocks](./docs/guide-building-blocks.md) (compose the engine yourself)
- 🛠️ **Contribute** — [CONTRIBUTING](./CONTRIBUTING.md) (add an agent, improve
  lipsync, ship an adapter) · [runnable examples](./examples/)

## The rigged catalog

A deliberately diverse roster — realistic, stylized, and robot guides, with
different presentations and lipsync capabilities. Every one is rigged.

| id      | name  | style      | presents | lipsync   |
|---------|-------|------------|----------|-----------|
| `sol`   | Sol   | realistic  | neutral  | viseme    |
| `nova`  | Nova  | stylized   | female   | viseme    |
| `vera`  | Vera  | realistic  | female   | viseme    |
| `atlas` | Atlas | realistic  | male     | viseme    |
| `echo`  | Echo  | stylized   | neutral  | viseme    |
| `lumen` | Lumen | stylized   | neutral  | jaw       |
| `kai`   | Kai   | robot      | robot    | animation |
| `mira`  | Mira  | stylized   | female   | animation |
| `pax`   | Pax   | stylized   | neutral  | animation |

- **viseme** — full Oculus/ARKit viseme morphs; phoneme-accurate mouth shapes.
- **jaw** — a single jaw/mouthOpen morph driven on a speech envelope.
- **animation**: no face morphs; the agent carries speech with a talk body
  animation + head motion (Mixamo rigs).

```js
import { AGENTS, filterAgents } from '@three-ws/page-agent';

filterAgents({ style: 'realistic' });   // just the realistic guides
filterAgents({ lipsync: 'viseme' });     // best-in-class mouth sync
```

Self-host the GLBs by pointing `assetBase` (or any agent's `url`) at your own CDN.

## Persona presets

One attribute turns the embed from "configure five props" into "pick a use
case": `preset="shop-assistant"` resolves a full persona — a spoken greeting,
a role brief, four tappable suggested-prompt chips, and a tool allowlist —
in one line. Explicit attributes (`greeting`, `suggested-prompts`, `tools`)
always override the preset's defaults.

| preset              | for                                                        |
|---------------------|-------------------------------------------------------------|
| `guide`              | Narrates the host page end to end — today's default, made explicit |
| `shop-assistant`     | Product questions and purchase guidance (pairs with the tour/Shopify story) |
| `defi-advisor`       | Explains yield, holdings, and risk on DeFi pages (the Sperax deployment) |
| `onboarding-coach`   | Walks new users through signup and first steps |
| `support`            | FAQ-style help with escalation phrasing |

```html
<script type="module">import '@three-ws/page-agent';</script>
<page-agent avatar="vera" preset="defi-advisor"></page-agent>
```

```js
import { PageAgent } from '@three-ws/page-agent';

const guide = new PageAgent({ agent: 'vera', preset: 'defi-advisor' });
```

Both mount Vera with the DeFi Advisor's greeting spoken on load and four
suggested-prompt chips ("What does this protocol do?", "How is yield
generated here?", …) docked under the stage. Tapping a chip speaks that
persona's authored answer; the first chip of `guide`/`onboarding-coach` is
wired to a real action (`narratePage()`) instead of a canned line.

### What a preset carries

```ts
interface PagePersonaPreset {
  id: string; name: string; description: string;
  greeting: string;                                   // spoken on load
  systemRole: string;                                  // persona brief for a paired LLM
  suggestedPrompts: { prompt: string; response: string; action?: 'narrate'|'tour' }[];
  tools: string[];                                     // capability allowlist (see note below)
}
```

`PRESETS` and `PRESET_IDS` are exported for docs/tooling — build your own
preset picker with `import { PRESETS, PRESET_IDS } from '@three-ws/page-agent'`.

> **`page-agent` has no chat backend of its own.** It's a client-side TTS
> narrator (Web Speech API) — there's no `fetch()` anywhere in this package.
> `greeting` and `suggestedPrompts` are fully real: what you hear is
> owner-authored copy the widget actually speaks, calibrated to never claim
> live knowledge of the host page it can't have. `tools` is a documented
> capability allowlist for a **paired** LLM chat backend (e.g. three.ws's
> `<agent-3d chat>` component on the same page) — it's metadata today, not
> enforced by this package, because there's no live request path here to
> enforce it against. Read it off `guide.tools` / `guide.currentPreset.tools`
> if you wire up a real chat backend alongside the narrator.

### Host-page context

Fold live host state into the persona's brief with the `context` attribute —
a flat JSON object of strings, sanitized (non-string values dropped, ~1KB
cap, backticks/newlines stripped so a value can't break out of the fenced
block or inject fake instructions):

```html
<page-agent preset="defi-advisor" context='{"page":"vault-detail","chain":"arbitrum"}'></page-agent>
```

```js
const guide = new PageAgent({
  preset: 'defi-advisor',
  context: { page: 'vault-detail', chain: 'arbitrum' },
});

guide.systemPrompt;
// → "You are a DeFi advisor embedded on a protocol or dashboard page. …
//
//    ```
//    [Host page context]
//    - page: vault-detail
//    - chain: arbitrum
//    ```"

guide.setContext({ walletConnected: 'true' }); // update after load, e.g. once a wallet connects
```

`page-agent` never sends `systemPrompt` anywhere — it's exposed for a host
page (or a paired chat component) to hand to a real LLM.

### Full example per preset

```html
<script type="module">import '@three-ws/page-agent';</script>

<!-- Guide — the default experience, explicit -->
<page-agent avatar="sol" preset="guide"></page-agent>

<!-- Shop Assistant — product/storefront pages -->
<page-agent avatar="nova" preset="shop-assistant"></page-agent>

<!-- DeFi Advisor — protocol/dashboard pages -->
<page-agent avatar="vera" preset="defi-advisor" context='{"protocol":"vault"}'></page-agent>

<!-- Onboarding Coach — signup/setup flows -->
<page-agent avatar="echo" preset="onboarding-coach"></page-agent>

<!-- Support — FAQ/help pages -->
<page-agent avatar="atlas" preset="support"></page-agent>
```

## API

### `new PageAgent(config)`

| option         | type                                   | default        | notes |
|----------------|----------------------------------------|----------------|-------|
| `agent`        | `string`                               | saved / `sol`  | initial rigged agent id |
| `agents`       | `string[]`                             | all            | allow-list shown in the picker |
| `position`     | `bottom-right \| bottom-left \| top-right \| top-left` | `bottom-right` | dock corner |
| `assetBase`    | `string`                               | three.ws CDN   | GLB host |
| `autoNarrate`  | `boolean \| string`                    | `false`        | `true` tours the page; a string is a CSS selector of segments |
| `greeting`     | `string`                               | —              | spoken on load (ignored if `autoNarrate`); overrides the preset's greeting |
| `muted`        | `boolean`                              | `false`        | start muted (visual lipsync only) |
| `collapsed`    | `boolean`                              | `false`        | start as the launcher pill |
| `picker`       | `boolean`                              | `true`         | show the "change agent" affordance |
| `controls`     | `boolean`                              | `true`         | show the control bar |
| `persistAgent` | `boolean`                              | `true`         | remember the visitor's choice |
| `preset`       | `string`                               | —              | persona id — see [Persona presets](#persona-presets) |
| `context`      | `Record<string, unknown>`              | —              | host state, sanitized and folded into `systemPrompt` |
| `suggestedPrompts` | `(string \| {prompt, response?, action?})[]` | preset's | overrides the preset's chip row |
| `tools`        | `string[]`                             | preset's       | overrides the preset's tool allowlist (metadata) |

### Properties

```ts
guide.currentPreset     // resolved PagePersonaPreset | undefined
guide.systemPrompt      // preset.systemRole + sanitized context, composed
guide.context           // sanitized context (read-only copy)
guide.tools             // resolved tool allowlist
guide.suggestedPrompts  // resolved, normalized chip list
```

### Methods

```ts
guide.narrate(text, { interrupt? })   // speak one line → Promise
guide.narratePage({ selector?, greet? }) // walk + narrate the page → Promise
guide.stop()                          // cancel narration
guide.setAgent('vera')                // swap rigged avatar live → Promise
guide.mute(true) / guide.collapse(true)
guide.openPicker() / guide.closePicker()
guide.setContext({ walletConnected: 'true' }) // re-sanitize + fold into systemPrompt
guide.on(event, cb) / guide.off(event, cb)
guide.dispose()
```

### Events

`ready` · `agentchange` · `state` (`idle`/`speaking`) · `caption` · `segment` ·
`error`. On the `<page-agent>` element these are DOM `CustomEvent`s prefixed
`page-agent:` (e.g. `page-agent:agentchange`).

### Marking up a guided page

The page walk reads, in order of preference:

1. elements matching your `selector`,
2. `[data-narrate]` elements (optionally ordered with `data-narrate-order`),
3. a heading + lead-paragraph fallback.

```html
<h1 data-narrate="Welcome — here's what's new this week.">Changelog</h1>
<section data-narrate data-narrate-order="2">…read verbatim…</section>
```

## How it works

```
PageAgent  ─┬─  AvatarStage     three.js scene · loads the rigged GLB · frames
            │                    bust/upper/full · idle clip or procedural
            │                    breathing+blink · talk animation
            ├─  SpeechNarrator   Web Speech TTS queue · picks a voice per agent ·
            │                    drives the lipsync timeline on the render loop
            ├─  AvatarPicker     accessible modal grid · persists the choice
            └─  lipsync          text → timed visemes → morph influences
```

No microphone, no network calls for speech, no API keys. Speech is `SpeechSynthesis`;
lipsync is a deterministic text-to-viseme heuristic advanced on three.js's frame
loop so mouth shapes track the spoken words. Where TTS is unavailable or muted,
the avatar still "talks" visually and captions render — narration never silently
stalls.

Accessibility: keyboard-navigable picker with focus trap and `Esc`, `aria-live`
captions, focus-visible rings, and full `prefers-reduced-motion` /
`prefers-color-scheme` support.

## FAQ

**Can I use my own avatar?** Yes — give an agent an absolute `url` to your rigged
GLB, or override `assetBase`. It must be skeleton-rigged; for lipsync include
Oculus visemes (`viseme_aa` …) or at least a `jawOpen` / `mouthOpen` morph.

**Does it need a server?** No. It's fully client-side. Bring your own copy/text;
narrate it with `narrate()` / `[data-narrate]`.

**Bundle size?** The ESM build leaves `three` external and tree-shakes. The
`/global` CDN build inlines three for a single-tag drop-in.

## License

All rights reserved, see [LICENSE](./LICENSE). Part of the [three.ws](https://three.ws)
platform for building, animating, rigging, and monetizing 3D AI agents.
