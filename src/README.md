# src/

Frontend source for three.ws: roughly 600 flat ES modules plus 60+ subsystem directories, built by Vite into the static site (`npm run build`) and the embeddable `agent-3d` library (`npm run build:lib`). Every page under [../pages/](../pages/README.md) loads one or more entry modules from here; [../vite.config.js](../vite.config.js) declares those entries explicitly.

## How this directory is organized

The convention is one module per page surface, named after the route it powers, living flat at the root of `src/`. A page named `pages/tracker.html` loads `src/tracker.js`; its styles, when not inline, sit next to it as `tracker.css`. When a surface outgrows a single file it graduates into a subdirectory of the same name (`src/agora/`, `src/scene-studio/`, `src/mission-control/`).

Related surfaces share a filename prefix, so the flat listing reads as clusters. The largest:

| Prefix | What it covers |
|---|---|
| `agent-screen-*` | The live agent screen: casting stage, control handoff, diary, treasury HUD, reputation, world view. Doc: [agent screen control](../docs/agent-screen-control.md). |
| `agent-skills-*` | The skills system UI: catalog, editor, A2A wiring. Doc: [agent skills](../docs/agent-skills.md). |
| `agent-*` (rest) | Agent surfaces: detail pages, editing, memory, naming, wallets, embeds, identities. |
| `walk-companion-*`, `walk-embed-*` | The corner companion and its third-party embed build. Doc: [the agent shell](../docs/agent-shell.md). |
| `avatar-studio-*` | Avatar Studio page modules. Doc: [avatar studio](../docs/avatar-studio.md). |
| `ui-juice-*` | The shared game-feel animation library. Doc: [ui-juice](../docs/ui-juice.md). |
| markets (`radar`, `screener`, `signals`, `watchlist`, `yields`, `stablecoins`, ...) | The trading and market-data surfaces. Doc: [trading surfaces](../docs/trading-surfaces.md). |

## Subsystem directories

The subdirectories hold multi-module subsystems. The ones you will touch most:

- `lib/` and `shared/`: cross-surface utilities (sanitized Markdown, toasts, fuzzy search, retry, caches). Import from here instead of hand-rolling; the catalog is in [shared utilities](../docs/shared-utilities.md).
- `components/`: reusable DOM components used across pages.
- `shell/`: the persistent agent shell (header, command palette, companion) that survives navigation on shell-enabled pages.
- `three/`, `loaders/`, `procedural/`, `physics/`: the Three.js rendering stack, glTF/GLB loading, procedural animation (gaze, foot placement), and physics.
- `viewer/`, `widget/`, `widgets/`: the standalone model viewer and embeddable widgets.
- `solana/`, `eth/`, `bnb/`, `onchain/`, `wallet/`: chain integrations. Solana is the home chain; EVM directories are secondary surfaces.
- `pump/`, `launchpad/`, `mint/`: coin launch surfaces over the platform's own launch records.
- `studio/`, `scene-studio/`, `forge-studio/`, `editor/`: the creation studios.
- `agora/`, `city/`, `play/`, `game/`: the 3D worlds.
- `auth/`, `permissions/`, `proof-of-custody/`: sign-in, permission model, custody verification.
- `pages/`: page-level orchestration modules that do not fit the flat convention.

## Two build targets

`vite.config.js` builds two targets from this tree, controlled by `TARGET`:

- `TARGET=app` (default, `npm run build`): the full site into `dist/`.
- `TARGET=lib` (`npm run build:lib`): `dist-lib/agent-3d.js`, the ES module + UMD bundle third-party sites load for `<agent-3d>` embeds.

Code that ships in the lib target must stay compatible with old embedded WebViews; see the polyfill note at the top of `vite.config.js` before using new runtime APIs.

## Conventions

- Vanilla ES modules. No framework. DOM APIs and Three.js directly.
- One surface, one entry module, named after its route.
- Heavy dependencies are lazy-loaded with dynamic `import()` so first paint stays fast.
- Animation and rig logic lives in `glb-canonicalize.js` and `animation-retarget.js`: any humanoid rig is mapped to the canonical bone set, never a hardcoded rig allowlist.
- Before adding a utility, check `lib/`, `shared/`, and [shared utilities](../docs/shared-utilities.md) for an existing one.

## Related reading

- [STRUCTURE.md](../STRUCTURE.md): maps every product surface to its directory.
- [pages/README.md](../pages/README.md): how a page HTML file becomes a live route (Vite input + route table + registry).
- [docs/architecture.md](../docs/architecture.md): the full system picture.
