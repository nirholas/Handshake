# CLAUDE_ARTIFACT — contract spec

`/api/artifact` returns a single self-contained HTML document suitable for rendering as a Claude.ai artifact.

The document is fully inlined — three.js, GLTFLoader, the viewer code, and the GLB itself are all in the response body. No external script, no fetch. This is mandatory: Claude.ai applies its own Content-Security-Policy to artifact iframes that forbids fetch to any host except `cdn.jsdelivr.net/pyodide/`, and only permits scripts from `claudeusercontent.com`, `cdnjs.cloudflare.com`, and `cdn.jsdelivr.net/pyodide/`. A pre-2026 version of this endpoint that loaded `https://three.ws/dist-lib/agent-3d.js` and fetched agent metadata from `three.ws/api` silently failed inside Claude.

## URL shape

```
GET https://three.ws/api/artifact
```

### Parameters

| Param   | Required | Pattern                            | Notes                                     |
| ------- | -------- | ---------------------------------- | ----------------------------------------- |
| `agent` | one of   | `/^[a-z0-9_-]{3,64}$/i`            | Agent ID; looked up in `agent_identities` |
| `model` | one of   | `https://` URL, whitelisted origin | GLB URL; viewer-only, no persona          |
| `theme` | no       | `dark` \| `light`                  | Default `dark`                            |
| `idle`  | no       | string ≤64 chars                   | Animation clip name to play while idle    |
| `bg`    | no       | hex string, no `#`, exactly 6 hex  | Background colour                         |

Exactly one of `agent` or `model` must be supplied; both, or neither, → 400.

## Whitelisted model origins

The endpoint server-side fetches the GLB and inlines it as base64. The fetch
is restricted to known-good CDNs to prevent SSRF / arbitrary URL fetch:

- `*.r2.cloudflarestorage.com`
- `*.amazonaws.com`
- `*.cloudfront.net`
- `storage.googleapis.com`
- `*.blob.core.windows.net`
- `three.ws`
- `*.vercel.app`

Any other origin, or non-`https:` scheme → 400.

## Size limits

- Maximum GLB size: **6 MB raw** (≈ 8 MB base64). Larger → 413.
- Server-side fetch timeout: 8 s.
- Viewer bundle adds a flat **565 KB** to every response.

The 6 MB cap exists because Claude's artifact panel begins to misbehave on
very large inlined documents (multi-MB paste latency, rendering hangs).
There is no way to stream — Claude doesn't fetch artifacts; it inlines the
HTML you give it.

## Response

- **Status:** `200 OK`
- **Content-Type:** `text/html; charset=utf-8`
- **Cache:** `public, max-age=60, s-maxage=60, stale-while-revalidate=3600`

### Content-Security-Policy

The response carries this CSP:

```
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
connect-src 'self';
font-src data:;
base-uri 'none';
form-action 'none';
object-src 'none';
frame-ancestors *;
```

This is intentionally tighter than what Claude's sandbox enforces. The benefit:
behaviour matches between the live preview at `/artifact/` (which renders the
response directly in a sandboxed iframe) and Claude's artifact panel — anything
that would silently break inside Claude also breaks in our preview.

`frame-ancestors *` is loosened so embedders other than Claude can iframe the
response too.

### Claude.ai sandbox CSP (for reference)

The CSP Claude actually applies to artifact iframes, scraped at
[`github.com/simonw/scrape-claude-artifacts`](https://github.com/simonw/scrape-claude-artifacts)
and vendored at [`tests/_fixtures/claude-artifact-csp.txt`](../tests/_fixtures/claude-artifact-csp.txt):

```
default-src https://www.claudeusercontent.com;
script-src 'unsafe-eval' 'unsafe-inline' https://www.claudeusercontent.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/pyodide/;
connect-src https://cdn.jsdelivr.net/pyodide/;
worker-src https://www.claudeusercontent.com blob:;
style-src 'unsafe-inline' https://www.claudeusercontent.com https://cdnjs.cloudflare.com https://fonts.googleapis.com;
img-src blob: data: https://www.claudeusercontent.com;
font-src data: https://www.claudeusercontent.com;
object-src 'none';
base-uri https://www.claudeusercontent.com;
form-action https://www.claudeusercontent.com;
frame-ancestors https://www.claudeusercontent.com https://claude.ai https://preview.claude.ai https://claude.site https://feedback.anthropic.com;
upgrade-insecure-requests;
block-all-mixed-content
```

`tests/api/artifact.test.js` parses this and verifies that every URL referenced
in our generated HTML is allowed by it. Refresh via:

```bash
node scripts/refresh-claude-csp.mjs
```

If upstream changes, the test will fail until the endpoint is updated.

## Error responses

All errors are `application/json` in the standard `{ error, error_description }` envelope:

| Status | Code                 | Cause                                                       |
| ------ | -------------------- | ----------------------------------------------------------- |
| 400    | `invalid_request`    | Bad agent ID pattern, bad model URL, or wrong arity         |
| 404    | `not_found`          | Agent ID not found or deleted                               |
| 405    | `method_not_allowed` | Non-GET/HEAD request                                        |
| 413    | `too_large`          | GLB exceeds 6 MB limit                                      |
| 422    | `no_avatar`          | Agent has no avatar attached yet                            |
| 429    | `rate_limited`       | Exceeded `widgetRead` preset (600/min per IP)               |
| 502    | `upstream_error`     | `?model=` fetch failed or timed out                         |

## Build pipeline

The viewer bundle is prebuilt and committed at
[`public/artifact-viewer.bundle.js`](../public/artifact-viewer.bundle.js).
Source: [`scripts/artifact-viewer/src.js`](../scripts/artifact-viewer/src.js).

Rebuild via:

```bash
npm run build:artifact-viewer
```

The endpoint reads the bundle from disk on first request and caches it for
the lifetime of the server process. If the file is missing the endpoint throws —
run `npm run build:artifact-viewer` before deploy.

## Authoring notes

- `res.end(html)` is used intentionally. The "no `res.end`" rule in `CLAUDE.md` applies to JSON responses only.
- HTML attribute and inline JSON values are escaped via `escAttr()` / JSON-string sanitisation to prevent XSS from user-supplied agent names, animation names, or model URLs.
- SQL lookup uses tagged-template `sql\`...\`` — no string concat.
- The viewer's GLB ingestion uses `GLTFLoader.parse(arrayBuffer)`, never `loader.load(url)`. The arrayBuffer comes from `atob()` of the inline base64 — no fetch, no CSP gate.
