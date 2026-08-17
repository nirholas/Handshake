# Avatar Studio (Character Studio fork)

The trait-based 3D avatar builder behind the "three.ws Studio" option in the platform's avatar creator. A user picks a base character class, swaps and tints hair, clothing, and accessory traits with live 3D preview, and exports an optimized, animation-ready GLB or VRM. No modeling experience required.

This directory is a rebranded fork of the MIT-licensed [M3-org/CharacterStudio](https://github.com/M3-org/CharacterStudio) (React 19 + Three.js + VRM). Upstream attribution lives in [LICENSE](LICENSE). The platform's separate from-scratch sculpting builder (the page at `three.ws/avatar-studio` and `/create/studio`) is a native implementation documented in [../docs/avatar-studio.md](../docs/avatar-studio.md); this fork is the trait-swapping builder that runs inside the Avatar Creator iframe. Product-level documentation for this fork: [../docs/character-studio.md](../docs/character-studio.md).

## Why it exists

Every three.ws agent needs an avatar, and not every user wants to generate one from a prompt or a selfie. This app gives them a point-and-click builder whose output plugs straight into the rest of the platform: the exported GLB drives the animation library, the emotion system, AR viewing, and the `<agent-3d>` embed. It runs entirely in the browser against same-origin assets, so there is no third-party avatar SDK dependency.

## Where it runs

- **Embedded (primary):** the agent edit page opens it in a modal iframe via the Avatar Creator wrappers ([../src/avatar-creator.js](../src/avatar-creator.js) in-app, [../avatar-sdk/src/creator.js](../avatar-sdk/src/creator.js) in the published `@three-ws/avatar` SDK). The user clicks **Save Avatar** and the GLB is handed back to the host page.
- **Standalone demo:** mounted on the Avatar OS demo page at [three.ws/demo/avatar-os](https://three.ws/demo/avatar-os).
- **In production** the compiled app is served same-origin under the `/avatar-studio/` path prefix, and its entry point is `https://three.ws/avatar-studio/index.html`. Address that index file, not the bare `/avatar-studio` path: the route table in [../vercel.json](../vercel.json) maps `/avatar-studio` and `/avatar-studio/` to the platform's separate native sculpting page, which does not speak the export contract below. The root build copies [build/](build) into `dist/avatar-studio` via [../scripts/copy-avatar-studio.mjs](../scripts/copy-avatar-studio.mjs); the Vite `base` is pinned to `/avatar-studio/` in [vite.config.js](vite.config.js) so every emitted asset URL matches.

## Install and run

```bash
cd character-studio
npm install        # this directory is an npm workspace: the install runs at the repo root
npm run dev        # Vite dev server on port 5173 (base path /avatar-studio/)
```

Open `http://localhost:5173/avatar-studio/` in a browser.

Other scripts:

```bash
npm run build      # production build to ./build
npm run serve      # preview the production build
npm run test:run   # vitest once (unit + integration, see tests/)
npm test           # the same suite in watch mode
npm run lint       # eslint + prettier
npm run get-assets # clone the upstream loot-assets trait library into public/
```

From the repo root, `npm run build:avatar-studio` runs the build here, and `npm run ensure:avatar-studio` builds only if `build/index.html` is missing.

## Configuration

Environment variables (see [.env.example](.env.example)):

| Variable | Purpose |
|---|---|
| `VITE_ASSET_PATH` | Root the app fetches `manifest.json` from. Unset means same-origin under the Vite base, i.e. `/avatar-studio/manifest.json` from [public/](public). |
| `VITE_OPENSEA_KEY` | OpenSea API key for the NFT trait-ownership checks. |
| `VITE_HELIUS_KEY` | Helius RPC key for the Solana flows. |
| `VITE_VALIDATION_SERVER_URL` | Mint validation server for the claim/mint pages. |

Character classes and their trait slots are declared in [public/manifest.json](public/manifest.json). In production, trait assets are the upstream [loot-assets](https://github.com/m3-org/loot-assets) library mirrored same-origin through `GET /api/studio-assets/<path>` ([../api/studio-assets/\[...path\].js](../api/studio-assets/%5B...path%5D.js)) so the browser never hits a vendor CDN.

## Architecture

Entry chain: [index.html](index.html) loads [src/Main.jsx](src/Main.jsx) (context providers: account, scene, view, audio, language) which renders [src/App.jsx](src/App.jsx). `App.jsx` fetches the manifest and routes between the view-mode pages in [src/pages/](src/pages): `Landing`, `Create`, `Appearance` (the main builder), `Save`, `Load`, `Mint`, `Wallet`, `Claim`, `Optimizer`, `BatchDownload`, `BatchManifest`, and `Studio`.

The engine lives in [src/library/](src/library) and has its own module index in [src/library/README.md](src/library/README.md). The load-bearing pieces:

- `characterManager.js`: loads classes, swaps traits, owns `downloadGLB()` / `downloadVRM()`
- `merge-geometry.js`, `cull-mesh.js`, `create-texture-atlas.js`: export-time optimization (mesh merge, hidden-face culling, texture atlasing, optional KTX2 compression)
- `VRMExporter.js` / `VRMExporterv0.js`: VRM 1 and VRM 0 export
- `animationManager.js`, `blinkManager.js`, `lookatManager.js`, `lipsync.js`: preview animation and face runtime

## Public interface: the export contract

This is an application, not an npm library; nothing here is imported by other code. Its one public API is the postMessage contract a host page relies on when the app is embedded in an iframe. When `window.self !== window.top`, the export menu ([src/components/ExportMenu.jsx](src/components/ExportMenu.jsx)) replaces the GLB/VRM download buttons with a single **Save Avatar** button that posts the finished avatar to the parent window:

```js
import { postAvatarToHost } from './library/embed-export'

postAvatarToHost(arrayBuffer)
// posts { source: 'characterstudio', type: 'export', format: 'glb', glb: arrayBuffer }
// to window.parent with the buffer transferred, not copied
```

The envelope, the `characterstudio` source name, and the `window.self !== window.top` embed check all live in [src/library/embed-export.js](src/library/embed-export.js), which is the module to import (and the module the tests cover) rather than re-typing the message shape. `glb` is the binary glTF as a transferable `ArrayBuffer`.

Standalone (top-level window), the same menu offers direct **GLB** and **VRM 0** downloads instead. There is no VRM 1 button: the VRM 1 exporter is broken upstream and [src/library/download-utils.js](src/library/download-utils.js) always falls back to the VRM 0 exporter.

## Example: receive an avatar from the embedded studio

The published SDK wraps the contract above. This is the real consumer path (from [../avatar-sdk/src/creator.js](../avatar-sdk/src/creator.js), also shown in [../avatar-sdk/README.md](../avatar-sdk/README.md)):

```js
import { AvatarCreator } from '@three-ws/avatar/creator';

const creator = new AvatarCreator({
  onExport: (blob) => {
    // blob is the finished avatar, type model/gltf-binary
    console.log('avatar GLB:', blob.size, 'bytes');
  },
  onClose: () => console.log('closed without exporting'),
});
await creator.open();
```

`AvatarCreator` opens this app in a modal iframe (default URL `https://three.ws/avatar-studio/index.html`, overridable with `studioUrl` for a local dev server), verifies the message origin against the iframe it opened, and resolves the `characterstudio` export payload into a `Blob` before closing the modal.

## Tests

`npm run test:run` runs the vitest suite in [tests/](tests) once (`npm test` is the same suite in watch mode). The root repo's `npm test` gate does not include this suite; run it here when touching this directory.

- [tests/unit/export-contract.test.js](tests/unit/export-contract.test.js) covers the core path: a real three.js rigged mesh through `getGLBBlobData()` into valid binary glTF, and the embed envelope from `embed-export.js`.
- [tests/unit/utils.test.js](tests/unit/utils.test.js) covers the shipped helpers in `src/library/utils.js`.
- [tests/unit/i18n.test.js](tests/unit/i18n.test.js) covers translation lookups.
- [tests/integration/](tests/integration) holds the input-validation and blockchain-input checks.

[tests/setup.js](tests/setup.js) deliberately leaves `Blob`, `File` and `FileReader` to jsdom: three.js `GLTFExporter` reads its binary output through a `FileReader`, so a partial stub hangs every export test.

## Related surfaces

- Row in the platform map: [../STRUCTURE.md](../STRUCTURE.md) ("Avatar builder (full app)")
- Product docs: [../docs/character-studio.md](../docs/character-studio.md)
- Native sculpting builder (separate app): [../docs/avatar-studio.md](../docs/avatar-studio.md)
- Consumer SDK: [../avatar-sdk/](../avatar-sdk)
