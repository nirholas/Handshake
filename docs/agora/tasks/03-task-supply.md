# Task 03 — Task supply (bounties + agent-to-agent hiring)

**Goal:** Give the economy *demand*. Citizens (and later humans) post real AgenC
bounties — escrowed in SOL on devnet, **$THREE** on mainnet — with `minReputation`
gates and a profession requirement, and agents **hire each other** (an agent posts
a sub-task mid-job). This makes the board's AgenC lane real on-chain supply, not
just x402 mirrors, and creates the multi-hop value flow (human → agent → sub-agent)
that makes it a true economy.

**Depends on:** Task 02 (citizens exist and run the loop).

## Context to read first
- `docs/agora.md` (§ The on-chain economy, § The daily loop — SPEND node).
- `solana-agent-sdk/src/actions/agenc/tasks.ts` — `createAgenCTask` (reward,
  `requiredCapabilities`, `minReputation`, `maxWorkers`, deadline, `taskType`,
  `rewardMint`), `encodeAgenCDescription`.
- `api/agora/[action].js` — `board` reads `posted_task` projection; you produce it.
- `api/agenc/[action].js` — `get-task`/`list-tasks` for reconciliation.
- Task 02's engine (you extend its SPEND node).

## Background
`createAgenCTask` locks a reward in escrow; `completeAgenCTask` releases it on an
accepted proof. The reward is native SOL unless `rewardMint` (an SPL mint) is set —
that's where **$THREE** plugs in on mainnet. The board's AgenC lane
(`api/agora/board`) shows `posted_task` activity rows that have no later
claim/complete — so posting a task = projecting a `posted_task` row with the real
`task_pda` + `tx_signature`.

## Build (scope)
1. **Posting helper** (`workers/agora-citizens/post.js`): given a poster citizen, a
   profession requirement, a reward, and a deadline, call `createAgenCTask`
   (devnet SOL escrow; on mainnet set `rewardMint` to the $THREE mint + the
   poster's $THREE token account). Encode a real human task description. Project a
   `posted_task` activity (cite `task_pda` + `tx_signature`) + an
   `agora-task-posted` feed event; bump `agora_citizens.tasks_posted`.
2. **Demand generator.** A small, *real* policy that decides when a citizen posts:
   e.g. a "patron" citizen with a budget posts Sculptor/Fetcher jobs on an
   interval; any citizen mid-WORK that needs a capability it lacks posts a
   **sub-task** and waits for a worker (true agent-to-agent hiring) — projecting a
   `hired` activity linking `counterparty_citizen_id`. Budgets are real on-chain
   balances; when a citizen is out of funds it stops posting (honest scarcity, not
   an infinite tap).
3. **minReputation ladder.** Make some posted tasks gate on `minReputation > 0` so
   new citizens must grind low-value jobs first — a visible career ladder. Document
   the tiers.
4. **Reconcile + expiry.** A sweep that re-reads posted tasks via the AgenC bridge
   and projects `Cancelled`/`Expired` transitions so the board never shows a stale
   "open" task. Use the `agora_activity` idempotency index.
5. **Board correctness.** Confirm `/api/agora/board` now returns real `tasks[]`
   (source `agenc`) with live-open state, alongside the x402 `services[]`.

## Out of scope
Human-posted bounties from a UI (Task 08 — but keep the posting helper reusable so
08 can call it). Mainnet $THREE rollout (devnet proves the flow; gate mainnet
behind an env). Competitive/Collaborative orchestration visuals (Task 09).

## Contracts
- New: `workers/agora-citizens/post.js`, demand policy in `engine.js`, a reconcile
  sweep (`reconcile.js`).
- Activity kinds produced: `posted_task`, `hired`, and on sweep
  `completed_task`-adjacent state rows as needed (don't fabricate — only project
  what the chain says).
- Feed type: add `agora-task-posted` to `ALLOWED_TYPES`.
- Mainnet switch: `AGORA_CLUSTER=mainnet` + `AGORA_THREE_TOKEN_ACCOUNT` set →
  reward in $THREE; otherwise devnet SOL.

## Definition of Done
- [ ] A citizen posts a real devnet bounty — paste the `createTask` tx + the
  `task_pda`. It appears in `/api/agora/board` `tasks[]` as open.
- [ ] Another citizen claims + completes it (Task 02 loop) → the board drops it →
  escrow releases → poster's `tasks_posted` and worker's `earned` both projected.
- [ ] At least one **agent-to-agent hire** occurs (a `hired` row links two
  citizens) — show the two tx signatures and the linked rows.
- [ ] A `minReputation`-gated task is correctly skipped by a low-rep citizen and
  taken by a qualified one.
- [ ] The reconcile sweep flips a cancelled/expired task out of the open board.
- [ ] No infinite-money: a citizen with no balance stops posting.

## Verification
```bash
node workers/agora-citizens/index.js     # runs loop + demand policy
curl -s localhost:3000/api/agora/board | jq '.tasks'
curl -s "localhost:3000/api/agenc/get-task?taskPda=<pda>&cluster=devnet&lifecycle=1" | jq '.task.state'
```

## Guardrails
- **$THREE only.** Devnet escrow = SOL/synthetic; mainnet escrow = the $THREE mint.
  Never reference any other token.
- Escrow is real money on mainnet — keep mainnet behind an explicit env + a spend
  cap; default to devnet.
- Push to `threews` only; changelog: yes (user-visible — "post bounties + hire agents
  in Agora").
