# Vendored design libraries

Two complete MIT source trees from [Meng To](https://github.com/MengTo) live in
[third_party/](../third_party): the **ThreeUI Community** component catalog and the
**Design+Code agent skills** collection. This page is the three.ws-side guide to
them: what is in each, what it is good for here, and how to actually run one.

The vendoring contract itself (why they are byte-identical, which guards skip
them, how to re-sync) is [third_party/README.md](../third_party/README.md). Read that
before you change anything under `third_party/`. The short version: never edit a file
in place, and never import from `third_party/` at runtime.

## Why these two are in the repo

three.ws is a Three.js platform whose product surfaces are galleries of
interactive 3D things, and whose agents are driven by portable `SKILL.md`
folders. These are the two best-maintained open-source collections of exactly
those two artifacts, both MIT, both by the same author.

- **ThreeUI** answers "what should a live component catalog feel like, and what
  do 103 finished WebGL components look like when someone else already built
  them."
- **The skills collection** answers "what does a mature public agent-skill
  library look like," and gives 132 ready workflows for design, web, and game
  work that our own agents can load today.

## third_party/threeui

`@designcodeio/threeui` 1.2.0. The login-free Community edition of
[threeui.com](https://threeui.com): 50 parent components across 111 routes, 141
free variant records, plus the catalog application that renders them.

```
third_party/threeui/
  src/package-components/   103 published components, one .ts per component
  src/shaders/              48 shader and scene studies (the raw HTML sources)
  src/components/           the catalog shell: browse grid, controls, source tabs
  packages/                 the publishable @designcodeio/threeui package + CLI
  public/                   built demo pages and the catalog's source-code index
```

### Run it

The tree carries its own dependency set and is not an npm workspace of this
repo, so install inside it:

```bash
cd third_party/threeui
npm install
npm run dev
```

`npm run build:site` runs the upstream typecheck, public-boundary audit, Vite
build and build audit together, which is the check to run if you ever sync the
tree and want to know the copy is intact.

### Use a component

The library is published, so a three.ws surface that wants one takes the npm
dependency rather than reaching into `third_party/`:

```bash
npm install @designcodeio/threeui
```

```tsx
import { AtTheHorizon } from "@designcodeio/threeui";
import "@designcodeio/threeui/style.css";

export function Hero() {
  return <AtTheHorizon />;
}
```

Our own frontend is vanilla JS modules rather than React, so the more common
path here is the second one: open the matching study under
`third_party/threeui/src/shaders/<name>/` (each is a self-contained HTML document
with its own shaders and scene setup), read how the effect is built, and
implement it in the three.ws surface that needs it. Keep the MIT attribution
with anything you carry across.

### What is worth studying first

- `src/components/` is a working answer to the gallery problem our
  [/gallery](https://three.ws/gallery), [/examples](https://three.ws/examples)
  and [/marketplace](https://three.ws/marketplace) pages all solve separately:
  one shell that gives every catalog entry a live renderer, a controls panel, a
  variant picker and a copyable source tab.
- `src/shaders/bookshelf/`, `src/shaders/japanese-tower/` and
  `src/shaders/landscape/` are complete Three.js scenes in single documents,
  which is the same shape as our embeddable avatar demos.
- `packages/` shows a component library published from inside a catalog repo:
  relevant every time we graduate a surface out of this monorepo (see
  [package-extraction.md](./package-extraction.md)).

## third_party/designcode-agent-skills

132 `SKILL.md` folders in the same Agent Skills format as
[.agents/skills/](../.agents/skills), each with its references, scripts, and a
runnable `demo/`.

| Group | Skills | What it covers |
|---|---:|---|
| `web-design` | 88 | scroll storytelling, GSAP ScrollTrigger, marquees, orbit controls, particle fields, layout systems, animation debugging |
| `game-development` | 20 | playable Three.js systems, gameplay QA, game architecture |
| `codex` | 19 | the capture-to-prompt workflows: video to super prompt, HTML to interaction prompts, stitched full-page capture, daily UI inspiration |
| `ui` | 3 | design-first UI prompting |
| `media` | 2 | image sourcing for a build |

### Load one into a session

A skill folder is portable by design, so pointing an agent at the path is
enough:

```bash
cat third_party/designcode-agent-skills/agent-skills/codex/video-to-superprompt/SKILL.md
```

To make one available to Claude Code as a first-class skill on this machine,
copy the folder (not a symlink, so the skill and its references travel together)
into your skills directory:

```bash
cp -r third_party/designcode-agent-skills/agent-skills/codex/video-to-superprompt \
      ~/.claude/skills/video-to-superprompt
```

They are deliberately NOT copied into `.agents/skills/`. That directory is the
three.ws skill pack we publish: `scripts/build-skills-pack.mjs` generates
`skills-pack.json` and `SKILLS.md` from it, the `three-ws-core` plugin ships it,
and `workers/okx-chat-bot` copies it into its image. Mixing a third party's 132
skills into our published pack would misattribute them and add 90 MB to that
worker's build context. Read [docs/agent-skills.md](./agent-skills.md) for how
our own pack is authored.

### What is worth studying first

- `agent-skills/codex/video-to-superprompt/` is the flagship: it turns a screen
  recording of an interface into a prompt detailed enough to one-shot the HTML.
  Directly useful for building three.ws pages from a reference.
- `agent-skills/game-development/` maps closely onto the `/play` world and the
  multiplayer surfaces, both of which are Three.js gameplay systems.
- Every skill's `demo/` is the worked example. That is why the repo's
  unanchored `demo/` ignore rule had to be negated for `third_party/`: a skill
  without its demo is a description instead of a proof.

## Licence

Both trees are MIT, copyright 2026 Meng To. The licence text ships with each
tree and must stay with it, and with anything derived from it.

## See also

- [third_party/README.md](../third_party/README.md): the vendoring contract, guard
  exemptions, and the re-sync procedure
- [docs/agent-skills.md](./agent-skills.md): how the three.ws skill pack itself
  is authored and published
- [STRUCTURE.md](../STRUCTURE.md): where every three.ws surface lives
