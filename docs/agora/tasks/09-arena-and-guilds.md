# Task 09 — Arena (competitive) + Guilds (collaborative)

**Goal:** Use AgenC's two richer task types to add social structure and spectacle.
**Arena** = `Competitive` tasks where N workers race and the first valid proof wins
the whole escrow, rendered as a live 3D race. **Guilds** = `Collaborative` tasks
where many workers contribute and split the reward, rendered as a team filling a
shared progress structure. Both are real on-chain; both are watchable.

**Depends on:** Task 03 (posting incl. task types) + Task 06 (visuals to extend).

## Context to read first
- `docs/agora.md` (§ The on-chain economy — task types).
- `solana-agent-sdk/src/actions/agenc/tasks.ts` — `AGENC_TASK_TYPE`
  (`Exclusive`/`Collaborative`/`Competitive`), `maxWorkers`.
- Task 03 `post.js`, Task 02 loop (claim/complete), Task 06 `src/agora/*` visuals.
- `api/agenc/[action].js` `get-task?lifecycle=1` — multi-worker fill + timeline.

## Background
A `Competitive` task with `maxWorkers > 1` lets several citizens claim and work the
same task; the first accepted proof wins (others get nothing). A `Collaborative`
task splits the reward across contributors. The engine already claims/completes;
this task adds the **orchestration** (multiple citizens engaging one task) and the
**visualization** (race / guild fill).

## Build (scope)
1. **Engine orchestration.** Extend the demand policy (Task 03) to post occasional
   Arena (`Competitive`, `maxWorkers=N`, juicy reward, `minReputation` gate) and
   Guild (`Collaborative`) tasks. Extend the loop so multiple eligible citizens
   engage the same task honestly: in an Arena they race (real concurrent work, real
   first-valid-proof-wins); in a Guild they each contribute a real sub-result and
   the reward splits per the program's rules. No staged outcomes — whoever's proof
   actually lands first wins.
2. **Arena visual.** A real 3D race: each competing citizen's progress maps to its
   actual work state (claimed → working → proof submitted). Winner (first accepted
   completion) plays a victory animation as the **full escrow** flows to them; the
   others visibly stand down. A leaderboard HUD bound to live task state.
3. **Guild visual.** A shared structure (e.g. a building rising, a bar filling)
   that advances as each contributor's part lands; on completion the **split**
   reward flows to each contributor with their share label. Show the roster.
4. **Board affordances.** Mark Arena/Guild tasks distinctly on the job board
   (Task 06) — type badge, worker fill `current/max`, prize. Clicking opens the
   live race/guild view.
5. **States.** A race with one entrant, a tie/near-tie (first valid proof wins —
   define + show the tiebreak = on-chain acceptance order), a guild that misses its
   worker target before the deadline (expires → reward returns), reduced-motion.

## Out of scope
New on-chain mechanics — use the AgenC program's existing competitive/collaborative
semantics as-is. If a settlement detail (e.g. split math) isn't exposed by the SDK,
read it from on-chain state rather than inventing it.

## Contracts
- Extends: engine demand policy + loop (multi-engage), `src/agora/job-board.js`,
  new `src/agora/arena.js` + `src/agora/guild.js`.
- Drives visuals from real `get-task?lifecycle=1` fill + `pulse.recent`; settlement
  amounts/splits read from chain, never fabricated.

## Definition of Done
- [ ] A real `Competitive` task runs with ≥3 citizens; the **actual** first-valid-
  proof winner takes the full escrow — paste the winning + losing claim txs and the
  single completion tx.
- [ ] The Arena view reflects real per-citizen work state and the real winner;
  losers stand down; escrow flow matches chain.
- [ ] A real `Collaborative` task completes with the reward **split** across
  contributors per on-chain rules — paste the txs + the split.
- [ ] Board badges show type + worker fill + prize; clicking opens the live view.
- [ ] Edge cases handled: single entrant, tie resolved by on-chain order, guild
  expiry returns reward; reduced-motion path.
- [ ] No staged/fake winner — outcomes are whatever the chain settles.

## Verification
Run the engine with an Arena-posting patron + several eligible citizens on devnet;
watch the race resolve to the real winner. Cross-check the winner + escrow against
`get-task?lifecycle=1` and Explorer. Repeat for a Guild split.

## Guardrails
- Outcomes must be real on-chain settlements, not animations chosen by the client.
- Prizes labeled $THREE (mainnet) / devnet unit honestly.
- Push to `threews` only; changelog: yes (user-visible — "Agora Arena: agents race for
  $THREE; Guilds split collaborative rewards").
