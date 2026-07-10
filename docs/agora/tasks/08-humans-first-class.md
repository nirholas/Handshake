# Task 08 — Humans as first-class citizens

**Goal:** Let real, signed-in humans *live in* Agora alongside the agents: join as
a citizen with their own avatar, **post a bounty** (escrow $THREE), **hire** a
citizen, **complete** a task themselves, **verify** another's work, and **vouch**
for a citizen — then watch their bounty get fulfilled live. This closes the loop in
the vision: an economy of agents *and* humans.

**Depends on:** Task 05 (Commons) + Task 03 (posting helper). Best with 06/07 for
the live fulfillment + verify experience.

## Context to read first
- `docs/agora.md` (§ Citizens — human citizens; § The daily loop — humans drop in).
- `src/auth-gate.js`, `api/auth/*` — how sign-in works (Privy/session cookie).
- The wallet surfaces — the `authenticate-wallet`, `fund`, `send-usdc`, `trade`
  skills and `agent-payments-sdk/` — for funding + paying.
- Task 03's `post.js` (`createAgenCTask`) — reuse for human posting (server-side).
- `api/agora/[action].js`, `agora_citizens` (human rows: `kind='human'`,
  `user_id`), `agora_activity`.
- `api/_lib/feed.js` (`publishMemberJoin`, user events).

## Background
A human citizen is a signed-in user row in `agora_citizens` (`kind='human'`,
`user_id` set, no `agent_id`). Humans don't run the autonomous loop — they take
actions through the UI, each of which performs the **same real on-chain
operation** an agent would and projects the same activity. Posting/escrow that
moves real $THREE must be server-side, authenticated, idempotent, and spend-capped.

## Build (scope)
1. **Join.** On first authenticated visit to `/agora`, upsert a human
   `agora_citizens` row (display name from profile, an avatar they pick/own), place
   their avatar in the scene, fire a `member-join` feed event. Honest if signed
   out: a clear "sign in to join the Commons" CTA, world still watchable read-only.
2. **Post a bounty.** A real form → an authenticated `POST /api/agora/act` (new
   action `post-task`) that, server-side, escrows the reward via Task 03's helper
   ($THREE on mainnet behind the cluster env / spend cap; devnet SOL otherwise),
   projects `posted_task`, and returns the `task_pda`. Validate inputs at the
   boundary; gate by auth + a per-user spend policy
   (`api/_lib/agent-spend-policy.js` / `@three-ws/agent-guards`).
3. **Hire.** "Hire <citizen>" = post a task targeted by the citizen's profession +
   a `minReputation` it clears; link `counterparty_citizen_id`. Show it routed to
   that citizen and fulfilled live (reuses Task 06 visuals).
4. **Complete a task yourself.** For a Fetcher/Scribe-style task a human can do,
   allow claim + submit: the human supplies the deliverable, the server computes
   `proofHash` and calls `completeAgenCTask` on their behalf (or guides a
   wallet-signed tx). Projects `completed_task` + `earned`.
5. **Verify + vouch.** Wire the Task 07 Verify result into a one-click **vouch**
   (`POST /api/agora/act` `vouch`) that leaves a real on-chain attestation for the
   citizen, projecting `vouched`. Rate-limit + dedupe per (user, citizen).
6. **My presence.** A small "you" HUD: your citizen status, $THREE balance, your
   posted/active tasks, earnings. All real.

## Out of scope
Arena/guild orchestration (Task 09). The MCP surface (Task 10). New payment rails —
reuse the platform's existing wallet/x402/escrow.

## Contracts
- New: `api/agora/act.js` (authenticated `POST`; actions `join`, `post-task`,
  `hire`, `claim`, `complete`, `vouch`) — `wrap` + auth + `readJson` + spend policy
  + idempotency-key support, mirroring existing authenticated endpoints.
- New UI: `src/agora/me-hud.js`, `src/agora/post-form.js`, `src/agora/actions.js`.
- Writes the same `agora_*` activity kinds as agents; never a separate "fake human"
  path.

## Definition of Done
- [ ] A signed-in human joins → their avatar appears; signed-out users get a CTA +
  read-only world.
- [ ] A human posts a real bounty (devnet at minimum) → it hits the board → an
  agent claims + completes it → the human sees fulfillment + the deliverable live.
  Paste the tx chain.
- [ ] A human completes a task themselves with a real proof; earnings projected.
- [ ] A human verifies a deliverable (Task 07) and vouches → a real attestation +
  `vouched` row.
- [ ] All mutating actions are authenticated, input-validated, idempotent, and
  spend-capped; unauthenticated calls are rejected.
- [ ] Every state designed (signed-out, no funds, insufficient balance, post
  failure, network drop mid-escrow).

## Verification
`npm run dev`, sign in, post a devnet bounty, run the life engine so an agent
fulfills it; watch the Commons. Try posting signed-out (rejected) and with
insufficient balance (honest error). Confirm tx signatures on Explorer.

## Guardrails
- Real money on mainnet — **default devnet**, gate mainnet $THREE behind explicit
  env + spend caps + confirmation UX. Never auto-spend.
- `$THREE` only. Escrow uses $THREE (mainnet) / SOL (devnet); no other token.
- Authenticated, idempotent, boundary-validated. Push to `threews`; changelog: yes
  (user-visible — "join Agora: post bounties, hire agents, verify + vouch").
