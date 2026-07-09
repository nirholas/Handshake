# 05 — Fix two pages calling third-party APIs directly from the browser

## Mission

Two unrelated pages call third-party APIs client-side and get CORS-blocked:

- **`/three-live`** fetches `api.jup.ag/price/v2` directly from the browser. Jupiter doesn't
  send CORS headers for browser calls, so the SOL/USD price feed silently fails (caught by an
  empty `.catch(() => {})`, so it fails quietly rather than loudly — that's why it shipped
  unnoticed).
- **`/play/ufo`** calls `flappin-ufo.vercel.app/api/leaderboard`, which both CORS-blocks and
  404s on its own root. **Confirmed independently during this audit pass:**
  `curl -o /dev/null -w '%{http_code}' https://flappin-ufo.vercel.app` → `404`, and
  `.../api/leaderboard` → `404`. This is not a transient outage — the embedded game's Vercel
  deployment is gone.

These are unrelated bugs; fix them independently.

## Part A — `/three-live` Jupiter price call

### Context

- The client-side fetch lives in `pages/three-live.html` — search for
  `fetch('https://api.jup.ag/price/v2...`. It seeds `_solUsd`, a local variable used to value
  trades that only supply a `sol_amount` (no USD amount) in the live trade feed.
- The server already has a canonical, cached SOL/USD price source for exactly this purpose:
  `api/_lib/sol-price.js` exports `solPriceUsd()` — four independent free providers tried in
  order with 60s cooldown-on-failure via `src/shared/failover-fetch.js`, 60s TTL cache. It's
  already used by `api/_lib/economy-ledger.js`, `api/agent/wallet.js`, `api/agent/send-sol.js`,
  `api/agent-economy/status.js`, `api/pay/deal.js` and others for ledger/accounting-grade SOL
  valuations — this is the platform's one shared implementation, not a one-off.
- There is **no existing public GET endpoint** that just returns this value as JSON — every
  current caller is server-side Node code importing the function directly. You have two
  reasonable options; pick based on what you find:
  1. **Reuse `api/crypto/token.js`** (the free, keyless `/api/crypto/token?address=<mint>`
     market-snapshot endpoint, part of the public Crypto Data API — see its header comment) with
     the wrapped-SOL mint (`So11111111111111111111111111111111111111112`) and read
     `priceUsd` from the response. **Verify this actually resolves a sane price for SOL before
     committing to it** — `api/crypto/token.js` sources from DexScreener pair data, and SOL is
     usually the *quote* currency in a pair rather than the base, so confirm DexScreener returns
     a direct SOL/USD read for the wSOL mint and not `null`/an unrelated pair. Test with
     `curl 'https://three.ws/api/crypto/token?address=So11111111111111111111111111111111111111112'`
     against production (or a local dev server) before wiring the client to it.
  2. **If that doesn't resolve cleanly**, add a minimal, free, cached passthrough — e.g.
     `GET /api/crypto/sol-price` — that calls `solPriceUsd()` from `api/_lib/sol-price.js` and
     returns `{ priceUsd, ts }`. Follow the plain-handler pattern (`cors`, `wrap`, `error`/`json`
     from `../_lib/http.js`, per-IP rate limit from `../_lib/rate-limit.js`) used by every other
     `api/crypto/*.js` free endpoint — model it on `api/crypto/symbol.js` or `api/crypto/token.js`
     for exact structure. This is the smaller, more certain fix if option 1 doesn't pan out.

### Task

Replace the direct `fetch('https://api.jup.ag/price/v2...')` call in `pages/three-live.html`
with a same-origin call to whichever of the two above you land on. Keep the existing
`AbortSignal.timeout(5000)` and silent-catch behavior (this is a non-critical price seed, not a
page-blocking dependency) — only the URL and response-shape parsing change.

### Verification

- [ ] Load `https://three.ws/three-live` in a real browser — no CORS error in console for the
      price fetch.
- [ ] `_solUsd` (or whatever the seeded variable is now) ends up populated with a plausible SOL
      price (check via a breakpoint or a temporary `console.log` you remove before committing).
- [ ] Trades in the live feed that only carry `sol_amount` still show a correct USD value.

## Part B — `/play/ufo` embed

### Context

`pages/play/ufo.html` full-screen-`<iframe>`s `https://flappin-ufo.vercel.app` and separately
polls `https://flappin-ufo.vercel.app/api/leaderboard` (search the file for `LEADERBOARD_URL`)
every 15s for the wallet-address leaderboard panel. Both the iframe's root and the leaderboard
API 404 live right now — this is not a CORS-only problem, the deployment itself is gone. There
is no `flappin-ufo` source in this repo (checked — not a workspace package, not a sibling
directory); it was an external/side deployment that has been decommissioned.

### Task

Since the upstream is confirmed dead (not flaky, not CORS-only — a 404 on its own root), do not
ship a CORS proxy for a deployment that no longer serves the game itself; that would still leave
visitors staring at a blank iframe. Retire the broken embed:

1. Confirm there is no newer canonical URL for the game (check if `flappin-ufo` was renamed or
   redeployed elsewhere — search recent commit history / `git log --all --oneline -- '*ufo*'`
   for context on where this came from before assuming it's permanently gone).
2. If genuinely gone: replace the full-screen iframe with a designed empty/retired state on
   `/play/ufo` (per root `CLAUDE.md`'s "every state is designed" rule — not a blank white iframe)
   that explains the demo is no longer available and links back to `/play` (or whatever the
   current games/demos hub is — check `/play`'s index for siblings). Remove the dead
   `LEADERBOARD_URL` polling entirely rather than leaving it to fail silently every 15s.
3. Update `data/pages.json` if `/play/ufo`'s description promises a live game that no longer
   exists — either mark it retired or adjust the copy to match reality. Check `/play`'s own
   listing/nav for a card linking to `/play/ufo` and update or remove that link so no other page
   points at a now-retired demo.
4. If you instead find evidence during step 1 that this was meant to stay alive (e.g. a very
   recent commit referencing it, or an owner note), stop and flag it rather than guessing —
   this is the one call in this pack that's genuinely ambiguous without more context (is this
   side project still owned/maintained by anyone here?).

### Verification

- [ ] `/play/ufo` no longer embeds a 404ing iframe or polls a dead leaderboard endpoint.
- [ ] The page's new state is designed, not blank — matches root `CLAUDE.md`'s empty-state bar.
- [ ] No other page/nav link still promises a live game at a dead URL.
- [ ] `data/pages.json` description for `/play/ufo` (if kept) matches the page's actual current
      state.
