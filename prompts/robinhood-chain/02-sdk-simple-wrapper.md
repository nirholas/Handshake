# 02 — Simple wrapper: `hood-js` (five lines to your first trade)

Read `prompts/robinhood-chain/_shared.md` first. Requires Wave 1 (`robinhood/robinhood-chain-sdk/`)
to exist — install it via `file:../robinhood-chain-sdk` and depend on its npm name.

## Mission
Build `robinhood/hood-js/` — the "just works" layer over the core SDK, for developers who don't
want to know what a viem transport is. One import, sensible defaults, promise-first, browser and
Node. Think `axios` vs `http`. npm name `hood-js` (fallbacks: `hoodjs`, `easyhood`).

## API surface (complete — nothing more, nothing hidden)
```js
import hood from 'hood-js'

await hood.price('AAPL')                    // → { symbol, usd, updatedAt }
await hood.prices(['AAPL','TSLA','NVDA'])   // batched multicall under the hood
await hood.portfolio('0xabc…')              // multiplier-correct, USD-valued positions
await hood.coins()                          // trending memecoins w/ price + 24h (launchpads + Uniswap)
await hood.launches({ live: true }, cb)     // stream new launchpad coins
await hood.quote({ sell: 'USDG', buy: 'CASHCAT', amount: 100 })  // swap quote, no wallet needed
await hood.swap({ ...quote, wallet })       // execute — wallet = private key env or injected EIP-1193
hood.testnet()                              // flip every call to 46630
```
- Zero required config. Public RPC default, `hood.config({ rpcUrl, alchemyKey })` optional.
- Stock Token buy paths require `hood.config({ acknowledgeEligibility: true })` and surface the
  `_shared.md` disclosure in the thrown error otherwise. Memecoins need nothing.
- Every function has a one-line JSDoc + a runnable snippet in the README that matches reality.

## Requirements
- Bundle size budget: ≤ 15 kB gzipped on top of viem (verify with a size check script; print it
  in the report). Browser build works from a `<script type="module">` CDN-style import.
- Friendly errors: no raw viem stack traces — wrap into plain-language messages with a `cause`.
- Vitest: unit (arg validation, formatting) + live (real `hood.price('AAPL')` on mainnet, real
  testnet `hood.swap` with faucet funds — paste tx hash).
- `docs/` site per `_shared.md`: landing page IS the pitch — an interactive REPL-style demo where
  visitors type `hood.price('TSLA')` and see the live answer (client-side, public RPC), a
  copy-paste quickstart, and the full API table. This page must be beautiful enough to trend on
  developer X.
- README: install, 30-second quickstart, API reference table, testnet guide, eligibility note.

## Done checklist
- [ ] The README quickstart runs verbatim (`node quickstart.mjs`) in a fresh folder.
- [ ] Live browser demo returns real prices when docs/index.html is opened locally.
- [ ] Testnet swap tx hash in the report; size budget printed; `npm pack` clean.
