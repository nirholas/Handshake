# @three-ws/concierge, examples

Runnable examples for every way to use the concierge. The HTML files load the SDK from `../dist`, build it first (`npm run build` in the package root), then serve this folder (`npx serve .`) and open each file. Swap the `../dist/concierge.global.js` src for `https://three.ws/concierge/concierge.global.js` (or the unpkg URL) to run against the published build.

| File | Shows |
| --- | --- |
| [index.html](./index.html) | The one-tag CDN install with `data-*` config, grounded in the page + curated knowledge. |
| [web-component.html](./web-component.html) | The declarative `<three-concierge>` element. |
| [imperative.html](./imperative.html) | The `new Concierge({...})` API: events, programmatic `ask()`, hot-swapping avatars. |
| [custom-avatar.html](./custom-avatar.html) | Using your own rigged GLB instead of the catalog. |
| [react.jsx](./react.jsx) | A `<Concierge>` React wrapper component. |
| [self-hosted-endpoint.md](./self-hosted-endpoint.md) | Point the widget at your own answer backend (the wire format + a runnable Node server). |

All examples are real and self-contained, no build step beyond the SDK bundle, no keys, no accounts. The default answer endpoint is the free hosted `https://three.ws/api/concierge`.
