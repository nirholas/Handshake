# Task: Fix x402 ring wallet health (SOL floors, unconfigured wallets, USDC float)

## Context (verified 2026-07-25)

The x402 ring economy recirculates real USDC between three.ws-controlled Solana wallets, settled by our own facilitator (`docs/x402-ring-economy.md` is required reading; self-pay is the operative default, so each payer wallet pays its own ~5,000 lamport fee and its SOL balance is the hard stop that pauses the loop).

Wallet-side failures in `x402_autonomous_log` (Neon, `DATABASE_URL` in `.env`):

- `sponsor_sol_floor` 4,797 all-time and 2,527 in the last 48h, meaning it is active and getting worse: wallets are at or under their SOL fee floor and settlement is refusing to proceed.
- `insufficient_payer_usdc` 4,143 all-time: some payer wallets have run dry of USDC float while others presumably hold the recirculated balance.
- `wallet_unconfigured` 2,528 all-time, 471 in the last 48h: part of the loop roster points at wallets that do not exist or have no key configured.
- `not_settled` 445 in the last 48h.
- Related caps, working as designed but worth a sanity pass: `cap_would_exceed` 4,017, `ring_daily_cap_reached` 1,377.

## Job

1. Map the ring wallet set: the `x402_ring_wallets` and `x402_ring_ledger` tables, plus wherever keys/addresses are configured (Cloud Run env on `three-ws-api`, Secret Manager). Produce a live balance table: wallet, role, SOL, USDC, floor status.
2. Fix `wallet_unconfigured`: either configure the missing wallets properly or remove the roster entries that reference them. No dead entries left.
3. Rebalance: top up SOL on payer wallets below floor and redistribute USDC float so no payer starves. There is likely an existing rebalance mechanism (`api/_lib/economy-rebalance.js` exists; find how it is triggered and why it is not preventing this). Fix the automation so balances self-heal; a one-time manual top-up that decays back into this state within days is a failed fix.
4. IMPORTANT SPEND GATE: moving SOL or USDC between wallets is an on-chain spend action. Before executing any transfer, print recipient, amount, token, chain and get an explicit yes from the owner in the chat. Design and wire everything first so the approval is one yes away. Automated recirculation inside the already-approved ring settle path does not need per-transaction approval; NEW funding transfers into the ring do.
5. Sanity-check the caps: report current daily cap values and whether they match the ring economy doc's fee-floor strategy (fewer, larger payments preferred over many micro payments).

## Constraints

- OWNER RULE, overrides everything: do not modify anything that is working today. Balance top-ups and removing dead roster entries are in scope; rewriting settle paths, caps logic, or rebalance code that currently functions is not. If the existing rebalance automation is genuinely broken (prove it), fix it minimally or add a new complementary mechanism rather than replacing it.
- Do NOT touch the autonomous trading bots or their wallets (three.ws/blog/autonomous-trading-experiment). Ring wallets only.
- Never print or log private keys. Never move funds without the explicit confirmation described above.
- Config-only `gcloud run services update` changes are pre-approved; use `--update-env-vars` (merges), never `--set-env-vars`.
- CLAUDE.md rules apply, including: never use em-dash or en-dash characters anywhere.

## Done means

Zero `wallet_unconfigured` in a full loop cycle, `sponsor_sol_floor` and `insufficient_payer_usdc` at zero after rebalance, the self-healing mechanism verified live (show the log line or ledger row where it acted), balance table in the report, `npm test` passes (no `tail` pipe).
