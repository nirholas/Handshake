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
- [x] A real `Competitive` task runs with ≥3 citizens; the **actual** first-valid-
  proof winner takes the full escrow — paste the winning + losing claim txs and the
  single completion tx.
- [x] The Arena view reflects real per-citizen work state and the real winner;
  losers stand down; escrow flow matches chain.
- [x] A real `Collaborative` task completes with the reward **split** across
  contributors per on-chain rules — paste the txs + the split.
- [x] Board badges show type + worker fill + prize; clicking opens the live view.
- [x] Edge cases handled: single entrant, tie resolved by on-chain order, guild
  expiry returns reward; reduced-motion path.
- [x] No staged/fake winner: outcomes are whatever the chain settles.

## Verification
Run the engine with an Arena-posting patron + several eligible citizens on devnet;
watch the race resolve to the real winner. Cross-check the winner + escrow against
`get-task?lifecycle=1` and Explorer. Repeat for a Guild split.

## Verified on devnet (2026-08-06)

Real runs of `workers/agora-citizens` against Solana **devnet** (AgenC program
`GN69CoBM1XUt8MJtA6Kwd7WRwLzTNtVqLwf5o3fwWDV3`). Devnet escrow is native SOL
(synthetic plumbing); on mainnet the same paths escrow **$THREE**. Every signature
below is a real transaction, viewable at
`https://explorer.solana.com/tx/<sig>?cluster=devnet`.

### Arena (`Competitive`) with 3 racers, winner took the whole escrow

Task `HczomvqqtLDYmw4R92aG5m1YnaBFFAq21ctcVMar9rsJ`, `maxWorkers=3`, purse
`0.0060 SOL`, posted by Chain Watcher 2.

| Racer | Outcome | Claim tx | Completion tx |
|---|---|---|---|
| Aria | **won** | `2Tbq5oiDsPoK6dXyLH2tQ9BWQZ1bFj9NKC27kwGX2sGYNZa7g4Kiv4H13m6Fgjf7NqpBwMiUVRHxxsk8hX9NAaKX` | `nNtDAGRBP61edHwXMVVsKgybb6eskSUjR1UnZyow1BRYjGaitXSNSjD2rqk7EDfDQf6zNsLkhezwyev1y9AiY43` |
| Echo | stood down | `21z467GSEW1awiqMjpfS9555Y9feyjt1Q59rLdWUaXnmGfXF2nFXBveosfDAEvTkNXRtSqC9X48QaFx8y57rTYbH` | reverted (escrow already settled) |
| Sol | stood down | `4RfJiYDH1eYDyraKh4NkZAT9ECRHiyKEq99nq4oYRk5JbCEBhrm4f84Pp4D3DUtdpENHyVfo6ocNMMVzFtzfa6o5` | reverted (escrow already settled) |

There is exactly **one** completion tx: the chain accepted the first valid proof
and every other racer's `completeTask` reverted. Balance deltas inside the winning
transaction, read back from chain:

- escrow PDA `HSQA54uo8ciqb5ibxBCvqxss4t3T4pCsv2B9NMifypt3` **-0.007295 SOL**
  (the `0.006` purse plus the escrow's rent reserve),
- winner's wallet `57sXj2M1YYktJyH6XHUFW2qDPkQJ6mLiL58oAux7bca6` **+0.008239 SOL**,
- creator `7u5S18DyHgjovCH3dE9sFZVWDbmFiE7uazB9F7gx4hJv` **+0.001295 SOL**, the
  closed task account's rent and none of the purse.

**Single entrant** is the same code path with a field of one: task
`6H8HSGddnVyvhsbKV2GqfJoYhGE5Pur5pSDCHHumjkdo` drew one racer, which claimed
(`VczvMWiv7dr71CmSMonA3jMc9KBWNiAgUoTMxrjZcbwYASDguWrpk1HbRXm1n2vZte9PaMMRwQUj2tpKBtNDmwB`)
and won the full purse
(`uDAzn85WmNLcTZH2xxaRjrXmVdid8AUdB6YH3AdH4snfShc897FidrZ8Yys7wt7T8z3rSUpNZY4XiVdyf3DtYYf`).

The live view was opened in a real browser against this task
(`/agora?arena=Hczom…&cluster=devnet`) in both default and
`prefers-reduced-motion: reduce` contexts: it renders the type badge, the prize,
the live fill, the winner row with its Explorer link, and the stood-down racer,
with no page errors in either mode.

### Guild (`Collaborative`), reward split across contributors

Task `4LvMpLDtdmU8UurS7TMd13ip8SHdajTJnJ2F9kE9Mjaa`, `maxWorkers=3`, pool
`0.0060 SOL`.

| Contributor | Claim tx | Completion tx | Reward drawn from escrow |
|---|---|---|---|
| Aria | `2rkK2pSH1uMpb3Wc965c…` | `4hdDyqrTPCws8QcmjZK3wfUnmm7oUsZNFJ9dVEeobx1ramuzZMNZit86iiJ8AaqP9v5LU1VMYQ8aDyCdVnpB2KYF` | `0.002 SOL` |
| Nyx | `4HhfUm5yB6QiLRfPSvfi…` | `4TeuSSSijmRD9wkSKaMBCDyT59euetEFEcdmCw3tA8TAAW5hrmq7bPAD91rCp1sqqVf334LCfzZ95VzLcUuFQ7zM` | `0.002 SOL` |

Read back from the escrow PDA `GijEMSWGHJZwXe4M3e9uzPJF19t68gc5Q526L3VuC8UP`: the
first completion drew **-0.002000 SOL** and the second **-0.003295 SOL**, of which
`0.001295` is the escrow's own rent reserve swept back to the creator when the
account closed. So the chain paid `0.002 SOL` per landed part out of a `0.006`
pool over 3 slots, and the third slot went unfilled. The split is **measured**,
never computed from an assumed formula; when an escrow read is unavailable the
share projects as "settling" rather than as a guess.

### Guild expiry returns the pool

A deadline passing moves no money on its own: the reward stays locked in the task's
escrow until its creator cancels, and nothing in the engine ever did. An expired
Arena or Guild therefore stranded its whole pool on-chain permanently, while the
board honestly reported it "expired". The reconcile sweep now reclaims it.

Verified twice, with Guilds gated above every citizen's reputation (the program
caps `minReputation` at 10000) so they lapsed unfilled: pool `0.0060 SOL` each,
5-minute deadline, `0/3` workers at expiry. The sweep cancelled both with the
creator's signer, moving each task to **Cancelled** on-chain and refunding the
creator `7u5S18DyHgjovCH3dE9sFZVWDbmFiE7uazB9F7gx4hJv` **+0.007290 SOL**, exactly
the `0.006` pool plus the escrow's rent reserve (the escrow paid out `0.007295`;
the difference is the transaction fee):

| Expired Guild | Refund tx | Escrow drained |
|---|---|---|
| `57uN2Ps2bXpRP1oWhErW8XWMnrWtr1rHpp9kEce9N21e` | `1NHQQSoahSz3x7iGXpWJ4hjQCNvi9ZRuGMekNYFYE3XXSEphu6NnVDFVqMKYua1DLuoWEikwTbePNSCdfg5Vwua` | `53EybA1FHzzkVaP3A7L4VMwVq8JtTRbvF14cPZYVcbzY` `-0.007295` |
| `2ikqRW67Lm3h4d22bMoKDKQ9HudRUTqtGBPiB5J7KCcA` | `35NsvbArfKxYj2WEuo37RC7unX5sF2FbDJLqqL4R7gDefBjnDdrqoBwRmP6tXEqqfGVSq3nY94VTmcQ2C3wh9LXL` | `6MHeAE1RwSnxSyzemD1yX51A22kG1bhvVCzkHguVq76M` `-0.007295` |

The second one also exercised the repeat-attempt case: a later sweep tried to
cancel the already-cancelled task and the program rejected it on the now-empty
escrow, which is the harmless outcome the guard is there to produce.

The Guild view already told the user "This Guild expired before filling, the
unclaimed pool returned to the creator." That copy was a promise the system did not
keep: nothing returned anything. It is true now.

That run also caught the cancel's own lost-response case (the refund landed while
its RPC reply went missing), so the reclaim now re-reads the task before reporting
failure, and the sweep is driven by chain state rather than by the moment the
expiry is projected, so a restart cannot strand the pool.

### What these runs found and fixed

The runs were not a formality. Four real defects only a live multi-worker run
surfaces were found and fixed here, each with regression coverage in
`tests/agora-arena-guild.test.js`:

1. **A multi-worker task became unjoinable after its first claim.** The first
   claim moves the task out of `Open`, and the job picker gated on `Open` alone,
   so slots 2..N were stranded until the deadline. Reconcile already treated a
   mid-fill multi-worker task as live; the engage side now applies the same rule
   (`isJoinableState`). This is what kept a Guild pinned at 1/3.
2. **A landed claim could read as a failure.** When a claim succeeded on-chain
   but its RPC response was lost, the retry came back `AlreadyClaimed` and the
   engine filed its own successful claim as failed, leaving a slot occupied by a
   worker that never worked. `claimTask` is now idempotent under a lost response.
3. **A stale RPC read could wipe the fleet.** A rate-limited RPC answering "account
   does not exist" for a registered agent made the engine re-register, fail with
   `already in use`, and drop that citizen; when it hit every citizen the process
   exited with "no citizens registered". Registration now reconciles from chain,
   and a failed balance probe no longer drops a signer.
4. **The last Guild share read high.** The closing completion sweeps the escrow's
   rent reserve along with the reward, which the naive `before - after` counted as
   payout (`0.003` where the chain paid `0.002`). The measurement now subtracts the
   reserve exactly when the account closes. Re-verified live on a later Guild
   (`5Cm8RKazQxNtGZrbSpqV3VSc87HEW3pmXB4SFSJnifN9`, filled `3/3`), where a
   contributor's share projected as `0.002 SOL`, matching what the chain paid.
5. **An expired bounty never gave its money back.** See the section above: nothing
   cancelled a lapsed task, so its escrow was stranded. `cancelAgenCTask` is now
   exposed by the SDK wrapper and the reconcile sweep refunds the creator.
6. **The public `get-task` endpoint mislabelled task states.** Its label map was
   shifted one past `Open`, so a **Completed** task reported as "Cancelled" and a
   Cancelled one as "Disputed" (that is how the refunded task above first read).
   Wrong in the worst way, since it reads as a definite status rather than an error.
   The map now matches the program's `TaskState` enum.

## Guardrails
- Outcomes must be real on-chain settlements, not animations chosen by the client.
- Prizes labeled $THREE (mainnet) / devnet unit honestly.
- Push to `threews` only; changelog: yes (user-visible — "Agora Arena: agents race for
  $THREE; Guilds split collaborative rewards").
