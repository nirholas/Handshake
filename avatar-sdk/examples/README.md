# @three-ws/avatar examples

## index.html

A self-contained page, no build step. It loads the SDK's `@three-ws/avatar/agent` entry from a CDN, awaits `ensureAgent3D()` to register the `<agent-3d>` element, and renders the real three.ws default avatar using the documented `src` and `kiosk` attributes.

Serve the folder with any static file server and open the page:

```bash
npx serve avatar-sdk/examples
```

or

```bash
python3 -m http.server --directory avatar-sdk/examples 8000
```

Everything it loads is live: the runtime comes from unpkg (`@three-ws/avatar@0.2.1`) and the GLB from `https://three.ws/avatars/default.glb`. When served off-origin like this, the runtime logs a couple of benign console warnings about optional extras (watermark, animation manifest); the avatar renders regardless. For richer embed options (chat brains, events, theming), see the [package README](../README.md) and the tutorials at [three.ws/tutorials](https://three.ws/tutorials).
