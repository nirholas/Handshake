# Task: $three holder rewards / revenue-share surface (real on-chain)

Give holders tangible upside they can see and act on: surface the real
revenue-share / rewards the protocol already tracks, and make claiming (if
supported) a first-class flow. This directly answers "what do I get for holding?"

## Anchor files & data
- Revenue share: `api/three-token/[action].js?action=revenue-share` (authenticated, per-user) and `?action=stats` for protocol totals; `?action=burns` for buyback/burn history.
- Staking primitive if present: `src/solana-stake.js`. Wallet/auth: `src/wallet.js`, `src/wallet-auth.js`, `src/account.js`.
- Contracts: check `contracts/` for any rewards/distribution program before assuming none exists.
- $THREE mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`. Reuse `src/pump/three-token-data.js` (task 14) if present.

## First: establish what's real
Read the revenue-share endpoint and any rewards contract to determine what
actually exists (accrued share, claimable amount, distribution cadence, burn-as-
reward). Build the UI around the real mechanism. **Do not invent a rewards model
that the backend doesn't support** — if claiming isn't on-chain yet, present the
accrued/earned view and clearly label what's live vs coming, sourced from real data.

## What to build (with loading/empty/error states)
1. **Your rewards** — connected wallet's accrued/earned revenue share from `revenue-share`. USD value. History if available.
2. **Protocol distribution** — total distributed, total burned (buyback-and-burn is a real holder benefit), cadence — from `stats` + `burns`.
3. **Claim flow** — IF an on-chain claim exists: a real, wired claim transaction with confirmation + tx link. If not, a clear accrual view (no fake "claim" button).
4. **Connect-wallet** empty state when not signed in (`authenticate-wallet`).

## Constraints
- Real data and real transactions only. No fabricated APRs or projected yields presented as fact.
- Server-verify any claim eligibility.

## Definition of done
- `npm run dev`: connected holder sees real accrued revenue share + protocol distribution/burn data; claim flow works if supported, else honest accrual view.
- All states designed; zero console errors; responsive. `npm run build` clean.
- Run the **completionist** subagent. Report exactly what's live vs labeled-coming and the data sources.
