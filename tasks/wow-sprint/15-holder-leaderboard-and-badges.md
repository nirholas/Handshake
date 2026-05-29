# Task: Holder leaderboard + gated 3D badge / PFP generator

Add status and identity for $three holders: a live leaderboard and a 3D badge/PFP
that holders can mint/export — gated by their on-chain holdings. Shareable = growth.

## Anchor files & data
- Holders/balances: `api/pump/balances.js`, `api/pump/helius-stats.js`. Token stats: `api/three-token/[action].js?action=stats`.
- Holder enrichment: Helius (see `api/pump/helius-webhook.js`, `api/pump/helius-stats.js`) — use the real holder set for the token mint `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.
- Wallet/auth: `src/wallet.js`, `src/wallet-auth.js`. SNS names for display: `src/solana/sns.js` / `src/sns/`.
- 3D + export: `src/viewer.js`, avatar/badge export utilities in `src/avatar-export.js`; existing badge HTML at `public/agent-badge.html` / `public/agent-passport.html` — reuse patterns.

## What to build
1. **Leaderboard** — top $three holders by balance, ranked, with truncated address or resolved SNS/handle, balance, % supply, and rank movement if derivable. Real data, paginated, with loading/empty/error states. Add an API endpoint if one doesn't exist (e.g. `api/three-token` `?action=leaderboard`) sourcing the real holder list — do not hardcode.
2. **Holder tier** — derive a tier from balance (e.g. thresholds → tiers). Show the connected user's rank + tier.
3. **Gated 3D badge / PFP** — a Three.js badge whose look reflects the holder's tier (materials/effects scale with tier). Only generatable when the connected wallet holds $three (verify on-chain balance; show a "hold $three to unlock" state otherwise). Let the user export it as a PNG (and/or GLB) to share.

## Constraints
- Real holder data + real on-chain balance gating. No fake leaderboard rows, no bypassing the hold check client-side only — verify balance server-side for the gate.
- Respect privacy: show truncated addresses / opt-in handles.

## Definition of done
- `npm run dev`: leaderboard renders real holders; connected holder sees rank/tier; badge generates + exports only when holding $three.
- All states designed; zero console errors; responsive. `npm run build` clean.
- Run the **completionist** subagent. Report the gating logic and data sources.
