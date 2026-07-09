# 03 — Route /oracle's NFT/token images through the existing IPFS proxy

## Mission

`/oracle` is the worst page in the 2026-07-09 crawl: 25 console/network errors, all the same
`net::ERR_BLOCKED_BY_ORB` block, thrown against public IPFS gateways (`ipfs.io`,
`gateway.pinata.cloud`) that the page hot-links directly for token/NFT art. Neither gateway
sends CORS/content-type headers browsers trust for cross-origin `<img>` loads, so every piece of
art on the page fails.

**The fix already exists in this codebase and is already used elsewhere** — `api/img.js` is a
same-origin image proxy with IPFS multi-gateway fallback, SSRF-hardened fetch, and a
deterministic on-brand SVG placeholder on total failure (so the loader never sees a broken
image, ever — see the file's own header comment for the full design). `src/radar.js` already
uses it (`/api/img?url=${encodeURIComponent(coin.image_uri)}&seed=...`) with an `error` listener
that falls back to the seed-only placeholder URL. `/oracle`'s image rendering — currently in
`src/oracle.js` (and check `src/oracle-graph.js`, `src/oracle-tape.js`,
`src/game/oracle-ribbon.js` for any other place `/oracle` renders token art) — does not go
through this proxy. This is almost certainly a "the proxy shipped after `/oracle` was built"
gap, not a design decision.

## Context

- **Reference implementation to copy the pattern from:** `src/radar.js` — search it for
  `/api/img?url=` (three call sites at time of audit: ~lines 651, 781, 1195). Each sets
  `img.src` to the proxied URL and wires an `error` listener that falls back to the seed-only
  placeholder variant, so a proxy failure still degrades to *a* rendered image, never nothing.
- **The proxy itself:** `api/img.js`. Read its header comment in full before touching call
  sites — it explains why it exists, its IPFS gateway fallback list, SSRF hardening, byte cap,
  and placeholder behavior. You should not need to modify `api/img.js` for this prompt; this is
  purely a client-side "route existing image URLs through the existing proxy" change. If you
  find `/oracle`'s image needs (e.g. a specific aspect ratio, a batch-resolve pattern) aren't
  served by `api/img.js` as-is, that's worth flagging, but the default assumption is it already
  covers this case — `pump-visualizer.html`, `pump-live.html`, `coin-intel.html`, and
  `agents-directory.js` all already lean on it for the same class of problem (token/NFT art from
  arbitrary IPFS/CDN sources).
- **Where `/oracle` currently gets its image URLs:** find every place `src/oracle*.js` or
  `src/game/oracle-ribbon.js` sets an `<img>` `src` or a CSS `background-image` from token/NFT
  metadata. `src/erc8004/resolver.js` has the canonical IPFS-gateway-URL-resolution logic
  (`IPFS_GATEWAYS`, `ipfs://` → `https://` conversion) — if `/oracle` is calling into that
  resolver directly and rendering the raw resolved URL, that's the exact place to intercept and
  wrap with `/api/img?url=`.

## Tasks

1. **Enumerate every image render site on `/oracle`.** Grep `src/oracle.js`,
   `src/oracle-graph.js`, `src/oracle-tape.js`, `src/game/oracle-ribbon.js`, and
   `pages/oracle.html` for `<img`, `.src =`, `background-image`, or calls into
   `src/erc8004/resolver.js`'s IPFS-resolution helpers.
2. **Wrap each one** with the same pattern `src/radar.js` uses: build the URL as
   `/api/img?url=${encodeURIComponent(rawUrl)}&seed=${encodeURIComponent(someStableSeed)}`, and
   attach an `error` listener that falls back to `/api/img?seed=...` (proxy-only placeholder,
   no upstream URL) so a genuinely dead source still resolves to *something* rather than a
   broken-image icon.
3. **Pick a stable seed** per token/NFT (mint address, token id, or whatever unique identifier
   `/oracle`'s data model already has) — this matches the existing pattern's cache-busting /
   placeholder-uniqueness behavior and keeps repeat views of the same asset visually consistent.
4. **Verify against production** before reporting done.

## Verification (must all pass)

- [ ] Load `https://three.ws/oracle` in a real Chromium browser (or `scripts/page-audit.mjs`
      scoped to `/oracle`) — zero `ERR_BLOCKED_BY_ORB` / CORS errors in console or network tab.
- [ ] Every token/NFT card that previously showed a broken image now shows either the real art
      (proxied) or the on-brand placeholder (never a native broken-image icon).
- [ ] Spot-check the network tab: image requests now hit `three.ws/api/img?...`, not
      `ipfs.io`/`gateway.pinata.cloud` directly.
- [ ] No regression to any non-image `/oracle` functionality (this change is scoped to `<img>`
      src wiring only).

## Do not

- Do not build a second, parallel IPFS proxy — `api/img.js` already exists precisely to solve
  this class of bug and is the platform's established pattern (per root `CLAUDE.md`: read
  before you write, use existing patterns).
- Do not hardcode a single IPFS gateway as a "fix" (e.g. swapping `ipfs.io` for `dweb.link`
  directly in the client) — that just relocates the same CORS/ORB failure mode to a different
  upstream. Route through the same-origin proxy.
