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
// Why 3.5.0 and not the newest release: the widget runs inside someone else's
// frame (ChatGPT's sandboxed iframe). 3.5.0 is the build the rest of the
// platform's embeddable bundles ship (public/agenc/embed.js,
// public/ar-forge.html, public/spatial-mcp/), so an embedding page that already
// loaded model-viewer for one three.ws embed reuses the exact same module
// instead of registering a second, conflicting <model-viewer> custom element.
//
// The standalone browser viewer (public/viewer.html) is deliberately NOT on this
// pin. It is a first-party top-level page, not an embed, so it takes 4.0.0 with
// an SRI hash from Google's own CDN: it owns its whole document, has no
// custom-element collision to avoid, and can afford the stricter integrity check
// that a template-interpolated embed cannot carry as cheaply. That split is by
// surface and is intentional; see the comment at the top of public/viewer.html.
//
// So `grep -rn "model-viewer@"` maps to exactly three intentional pins, one per
// surface class, and nothing else should introduce a fourth:
//   1. THIS module, 3.5.0 via jsdelivr: every server-rendered embed that runs
//      inside a host page's frame (the ChatGPT widget), plus the static embed
//      bundles that ship the same build (public/agenc/embed.js,
//      public/ar-forge.html, public/spatial-mcp/, pages/daily.html).
//   2. public/viewer.html, 4.0.0 with SRI from Google's CDN: the one
//      standalone, top-level viewer document.
//   3. src/shared/model-viewer-loader.js, 4.0.0 across three CDNs: the
//      Vite-bundled first-party pages (/forge and the pickers), where a blocked
//      CDN must fall through to the next host instead of leaving an inert box.
// 2 and 3 are the same 4.0.0 build on first-party pages; only the delivery
// differs (one document can carry an SRI hash, a runtime chain cannot).

/** The pinned model-viewer version for the server-rendered embed surfaces. */
export const MODEL_VIEWER_VERSION = '3.5.0';

/** CDN origin the embed surfaces load model-viewer from (must be CSP-allowlisted). */
export const MODEL_VIEWER_CDN_ORIGIN = 'https://cdn.jsdelivr.net';

/** Full module URL for `<script type="module" src="...">` on the embed surfaces. */
export const MODEL_VIEWER_SRC = `${MODEL_VIEWER_CDN_ORIGIN}/npm/@google/model-viewer@${MODEL_VIEWER_VERSION}/dist/model-viewer.min.js`;
