// The single source of truth for the <model-viewer> build server-rendered
// embed surfaces load.
//
// Current consumer: api/_mcp-studio/component.js (the ChatGPT Apps SDK inline
// widget), which renders a GLB from HTML generated on the server and needs the
// CDN host named in its `openai/widgetCSP` resource_domains allowlist, a second
// reason the URL must not be retyped per file. (/api/ar used to inline a
// <model-viewer> from this pin too; it now 302s to /ar/view, a Vite-bundled
// page (see api/_lib/ar-launch.js) because a server-rendered HTML string
// can offer AR modes but can never generate the ios-src USDZ Quick Look
// actually needs.)
//
// Why every surface is on ONE version: an embed and a first-party page can end
// up in the same document, and the second `customElements.define('model-viewer',
// ...)` in a document throws. Two three.ws surfaces on two different builds is
// therefore a live collision hazard, so the platform pins a single build
// everywhere and the pins differ only in DELIVERY, never in version:
//   1. THIS module, jsdelivr, no SRI: every server-rendered embed that runs
//      inside a host page's frame (the ChatGPT widget), plus the static embed
//      bundles that ship the same build (public/agenc/embed.js,
//      public/ar-forge.html, public/spatial-mcp/, pages/daily.html). A
//      template-interpolated embed cannot carry an integrity hash as cheaply as
//      a hand-authored document can, which is the only reason this rung has none.
//   2. public/viewer.html and the static first-party pages, Google's CDN with
//      an SRI hash: top-level documents that own their whole page and can
//      afford the stricter integrity check.
//   3. src/shared/model-viewer-loader.js, three CDNs in a failover chain: the
//      Vite-bundled first-party pages (/forge and the pickers), where a blocked
//      CDN must fall through to the next host instead of leaving an inert box.
//      A runtime chain cannot carry one SRI hash, so it carries none.
//
// scripts/check-model-viewer-version.mjs holds that invariant: it fails if any
// reference in the tree names a different version from the rest, if one version
// is served with two different integrity hashes, or if the vendored copy under
// pages/ibm/vendor/ stops matching the pinned build.

/** The pinned model-viewer version. One build platform-wide; see above. */
export const MODEL_VIEWER_VERSION = '4.0.0';

/** CDN origin the embed surfaces load model-viewer from (must be CSP-allowlisted). */
export const MODEL_VIEWER_CDN_ORIGIN = 'https://cdn.jsdelivr.net';

/** Full module URL for `<script type="module" src="...">` on the embed surfaces. */
export const MODEL_VIEWER_SRC = `${MODEL_VIEWER_CDN_ORIGIN}/npm/@google/model-viewer@${MODEL_VIEWER_VERSION}/dist/model-viewer.min.js`;
