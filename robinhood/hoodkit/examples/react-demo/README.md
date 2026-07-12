# hoodkit React demo

A live dashboard built entirely with `hoodkit/react`: real Chainlink Stock Token
prices ticking in from the public Robinhood Chain RPC, and a real-time feed of
new NOXA / The Odyssey launches — no backend, everything client-side.

## Run it

```bash
npm install
npm run dev
```

Open the printed local URL. Toggle mainnet/testnet in the header — testnet has
no priced Stock Tokens outside the faucet set, so prices will mostly show
"connecting…" there; that's expected.

## What it demonstrates

- `HoodProvider` + `useHoodClient` — wiring a `HoodClient` once at the root.
- `useQuote(symbol)` — a live-updating Chainlink price tile per Stock Token,
  with loading/error states designed (skeleton shimmer, inline error).
- `useLaunches({ limit })` — a live-prepending list of new token launches.
- SSR-safety: every subscription lives inside `useEffect`; this same component
  tree renders inertly on the server and hydrates on the client.

## Building for production

```bash
npm run build
npm run preview
```
