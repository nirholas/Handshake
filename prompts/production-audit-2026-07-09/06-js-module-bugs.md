# 06 — Two real JS bugs, independent of the deploy lag

## Mission

Two pages are broken by genuine JS bugs — not caching, not a routing issue, not a CORS problem.
Both have precise, already-identified root causes; fix them directly.

## Part A — `/vanity/verify`: `Failed to resolve module specifier "bs58"`

### Root cause

`public/vanity/verify/index.html` is registered as a Vite build entry (`vite.config.js`, search
`'vanity-verify':`), but its inline `<script type="module">` imports
`verifyVanityReceipt` from `/src/solana/vanity/verifiable-grind.js` and `openSealedText` from
`/src/solana/vanity/sealed-envelope.js` — both loaded via an absolute `/src/...` runtime URL
path, not bundled by Vite. This is a known, intentional pattern in this codebase: see the
`copy-src-to-dist` Vite plugin in `vite.config.js` (its comment: *"Several static pages
(dashboard, vanity-wallet, …) import ESM directly from `/src/*.js`. Vite's dev server serves
these from the project root, but production needs them under dist/"*) — it copies raw,
**unbundled** `src/` into `dist/src/` verbatim so the literal `/src/...` URL resolves in
production the same way it does in Vite's dev server.

That works fine for first-party relative imports. It breaks the moment the unbundled file
imports a **bare npm specifier** — and `verifiable-grind.js` / `sealed-envelope.js` both do:
`import bs58 from 'bs58'`, plus `@noble/curves/ed25519.js`, `@noble/hashes/sha256`,
`@noble/hashes/hmac`, `@noble/hashes/hkdf`, `@noble/hashes/utils`. A raw browser ES module has
no way to resolve a bare specifier like `'bs58'` without an import map — Vite's dev server
resolves it on the fly (that's the "dev server serves these" half of the comment), but plain
static hosting in production cannot, hence the console error and the page never rendering.

### The fix — already an established pattern in this repo, copy it exactly

`public/404.html` and `public/500.html` hit this identical problem for a different bare
specifier (`@three-ws/agent-ui`) and solved it with a browser import map pointing the bare name
at its esm.sh ESM build. Copy that pattern verbatim. In `public/404.html` / `public/500.html`,
search for `<script type="importmap">` — note the explanatory comment above it
(*"Resolve the bare @three-ws/agent-ui specifier without a bundler (this file is served verbatim
from public/). esm.sh ships the package's ESM build and resolves its peer deps transitively."*).

Add an equivalent import map to `public/vanity/verify/index.html`'s `<head>`, before the module
script that needs it, mapping every bare specifier `verifiable-grind.js` and
`sealed-envelope.js` actually import:

```html
<script type="importmap">
{
  "imports": {
    "bs58": "https://esm.sh/bs58@6.0.0",
    "@noble/curves/ed25519.js": "https://esm.sh/@noble/curves@1/ed25519.js",
    "@noble/hashes/sha256": "https://esm.sh/@noble/hashes@1/sha256",
    "@noble/hashes/hmac": "https://esm.sh/@noble/hashes@1/hmac",
    "@noble/hashes/hkdf": "https://esm.sh/@noble/hashes@1/hkdf",
    "@noble/hashes/utils": "https://esm.sh/@noble/hashes@1/utils"
  }
}
</script>
```

Pin the `bs58` version to whatever `package.json`'s `"bs58": "^6.0.0"` actually resolves to
locally (`npm ls bs58`) so the CDN build matches the version this code was written/tested
against. Check `package.json` for the installed `@noble/curves` and `@noble/hashes` versions the
same way and pin those exactly too — do not leave `@1` floating if the repo pins a specific
minor/patch elsewhere.

### Tasks

1. Confirm the exact bare specifiers both files import (`grep '^import' src/solana/vanity/verifiable-grind.js src/solana/vanity/sealed-envelope.js`).
2. Confirm installed versions (`npm ls bs58 @noble/curves @noble/hashes`).
3. Add the import map to `public/vanity/verify/index.html`, versions pinned to match.
4. Check whether any **other** page also loads `verifiable-grind.js` or `sealed-envelope.js` via
   this same unbundled `/src/...` pattern (grep `pages/*.html public/*.html` for those two
   filenames) — if so it needs the identical import map, not a copy-pasted divergent one.

### Verification

- [ ] `npm run build && npm run check:dist` passes.
- [ ] Load `https://three.ws/vanity/verify` (or the local `dist/` build) in a real browser —
      no `Failed to resolve module specifier` error in console.
- [ ] Paste a real vanity receipt (or use whatever test fixture the page/tests already use —
      check `scripts/verify-vanity-receipt.mjs` / `tests/src/eth-vanity-server-verify.test.js`
      for a known-good sample) and confirm the verify flow actually runs end to end: pinned-key
      fetch, checks render, verdict renders.

## Part B — `/temporary`: `Cannot use 'import.meta' outside a module`

### Root cause

Precisely identified: `pages/temporary.html` line 1477 loads the shared x402 payment widget as
a **classic** script — `<script src="/x402.js" defer></script>` — but `public/x402.js` uses
`import.meta.url` twice (dynamic `import(new URL('./risk-ack.js', import.meta.url).href)` and
`new URL(import.meta.url).origin`). `import.meta` is a syntax error outside a module context, so
this throws at parse time on `/temporary` specifically.

Confirmed this is an isolated mistake, not a systemic issue: `/x402.js` is loaded on 7 pages
total, and **6 of the other 7 all correctly use `type="module"`**
(`pages/unstoppable.html`, `public/tutor.html`, `pages/club.html`, `public/bazaar.html`,
`public/x402-stripe.html`, `public/siwx-test.html`). `pages/temporary.html` is the one outlier.

### Fix

In `pages/temporary.html`, change:
```html
<script src="/x402.js" defer></script>
```
to:
```html
<script type="module" src="/x402.js"></script>
```
(drop `defer` — module scripts are deferred by default, matching the exact tag used on all 6
other pages; adding both is redundant, not wrong, but match the established pattern exactly).

### Verification

- [ ] Load `https://three.ws/temporary` in a real browser — no `import.meta` syntax error in
      console.
- [ ] The x402 payment widget actually initializes on `/temporary` (check whatever visible
      affordance it renders — a pay button, a balance widget, whatever the other 6 pages show)
      rather than just silently not-crashing.
- [ ] The page's core feature (avatar walk/drive controls — this is the "Drive Your Avatar"
      page) is unaffected; this change only touches one unrelated `<script>` tag's loading mode.

## Do not

- Do not remove or "simplify away" the `import.meta` usage in `public/x402.js` to work around
  the classic-script constraint — `import.meta.url` is the correct, standard way to resolve a
  same-directory sibling module URL; the bug is the loading mode on one page, not the shared
  script.
- Do not add a blanket import map with every npm dependency "just in case" — only add the
  specific bare specifiers `verifiable-grind.js`/`sealed-envelope.js` actually import.
