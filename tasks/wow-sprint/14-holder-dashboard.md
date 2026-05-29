# Task: $three holder dashboard (real Solana / Helius data)

Give holders a reason to log in: a dashboard that shows their real $three position
and the protocol's real health — all live, no fake numbers.

## Anchor files & data
- Token protocol API: `api/three-token/[action].js` — `stats`, `revenue-share` (per-user, authed), `burns`, `activity`.
- Pump data: `api/pump/balances.js`, `api/pump/helius-stats.js`, `api/pump/dashboard.js`, `api/pump/curve.js`.
- Wallet/auth: `src/wallet.js`, `src/wallet-auth.js`, `src/account.js`. Helius webhook ingestion at `api/pump/helius-webhook.js`.
- $THREE mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.
- Pages: there's `pages/dashboard/` and `pages/pump-dashboard.html`. Build the holder view into the most appropriate one (read both first; don't fork a third dashboard).

## Build a shared data hook FIRST
Create one reusable client module (e.g. `src/pump/three-token-data.js`) that fetches + caches $three protocol stats and the connected wallet's position, with subscribe/refresh. Tasks 13/16/17 should reuse it. Single source of truth.

## What to show (each with loading/empty/error states)
1. **Your position** — connected wallet's $three balance, USD value, % of supply, unrealized PnL if cost basis is derivable; "connect wallet" empty state when not signed in (use `authenticate-wallet` flow).
2. **Your revenue share** — from `?action=revenue-share` (authed). Show claimable/earned if present.
3. **Protocol health** — price, market cap, holders, 24h volume, total burned (from `stats` + `burns`).
4. **Recent activity** — your transactions + protocol activity (`?action=activity`), most recent first, paginated.
5. **Quick actions** — links to trade ($three), the visualizer, and the token page.

## Constraints
- Real on-chain / API data only. Never fabricate balances or PnL — if a value isn't derivable, omit it, don't guess.
- Handle the not-connected and zero-balance cases as designed empty states.

## Definition of done
- `npm run dev`: connect a wallet → real position + protocol data render; all states designed.
- Shared data hook created and used. Zero console errors. `npm run build` clean.
- Run the **completionist** subagent. Report the data sources per widget.

> Build the shared data hook here FIRST if running 13/16/17 in parallel.
