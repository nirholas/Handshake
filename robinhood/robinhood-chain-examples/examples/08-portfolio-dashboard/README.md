# 08 · Portfolio dashboard

A small Vite + React dashboard wrapping [example 03](../03-portfolio-valuation)'s
multiplier-correct portfolio logic in a polling hook, with designed loading,
empty, and error states — an address lookup form, a total-value header, and a
card grid per holding.

**What it proves:** the same `getPortfolio` call from example 03 is a thin
`useHoodPortfolio` hook away from a real dashboard UI.

## Prerequisites

- Node ≥ 20. Reads only — no wallet, no key.

## Run

```bash
npm install && npm install ../../../robinhood-chain-sdk
npm run dev      # → http://localhost:5183
```

Enter any address in the lookup field (defaults to a live holder) and the
dashboard polls its Stock Token portfolio every 20 seconds.

## Verified

`npm run build` was run against this exact source and succeeded:

```
vite v6.4.3 building for production...
✓ 1236 modules transformed.
dist/index.html                   0.42 kB │ gzip:   0.28 kB
dist/assets/index-DbmVh8zP.css    2.89 kB │ gzip:   1.15 kB
dist/assets/index-FD-SwolM.js   510.84 kB │ gzip: 157.30 kB
✓ built in 3.09s
```

`npm run preview` served the built app and returned the expected HTML shell
with the built asset script tag wired in.

## About `useHoodPortfolio`

`hoodkit` (the SDK's planned React bindings) hasn't been built yet — see the
root README's SDK feedback. `src/useHoodPortfolio.js` is a local stand-in
shaped exactly like the hook `hoodkit` is expected to ship, so upgrading later
is a one-line import swap (`from './useHoodPortfolio.js'` → `from 'hoodkit'`),
documented in the file itself.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
