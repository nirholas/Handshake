# OWNER-ACTIONS: every human touchpoint on the road to 100%, batched

This file exists so no agent ever parks a task on an owner dependency, and so the owner can
clear every gate in one sitting instead of drip-feeding across sessions. Agents: when a work
order leaves an owner-only remainder, add a row here (and keep the detail in the owning
pack's file or brief; a row is a pointer, not an essay). When the owner clears a row, delete
it and, if that unblocks a work order, say which one in the owning pack's `PROGRESS.md`.

Rows carry the date they were added so staleness is visible. Re-verify a row before acting
on it; some resolve themselves as other work lands.

## Open rows (verified 2026-08-09 when this pack was authored)

| # | Action | Size | Unblocks | Detail lives in |
|---|---|---|---|---|
| 1 | Approve the production deploy (or say "get production working", which is itself the approval). Production trails `main` by 2+ days and every event, benchmark, and discovery fix waits on it. | one yes | Nearly everything user-visible in the map | [01-ship-readiness.md](01-ship-readiness.md) |
| 2 | Fund the settle sponsor wallet `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` with ~1 SOL (about 12 to 16 days at the measured burn). The x402 settle rate stays down without capital; no config change moves it. | ~1 SOL | x402 settle recovery, backlog 01/03 retirement | [../backlog/PROGRESS.md](../backlog/PROGRESS.md), 2026-08-02 entries |
| 3 | Decide the stranded customer funds: two customers hold ~0.35 SOL behind the retired encryption key and cannot withdraw. Credit, contact, or write off. | decision | Closing the support obligation | `docs/ops/stranded-wallets.md` once P100-02 ships it |
| 4 | Rotate or explicitly accept the economy master wallet key, which sat readable as plaintext service env for a window. | decision (+ one fund move if rotating) | P100-03 closeout | `docs/ops/wallet-key-migration.md` once P100-03 extends it |
| 5 | Set `WALLET_ENCRYPTION_KEY_PREVIOUS` policy: none exists to set (the retired key is gone); this row is only here so nobody hunts for it again. Delete on reading. | none | agent time | [../backlog/PROGRESS.md](../backlog/PROGRESS.md) |
| 6 | Accept the Anthropic terms in Vertex Model Garden for `aerial-vehicle-466722-p5`, then an agent flips `VERTEX_CLAUDE_ENABLED=1` after a live probe. | minutes | First-party Claude lane | `docs/ops/llm-lanes.md` |
| 7 | Either reactivate OpenAI billing or approve dropping the key; every OpenAI rung is currently a dead attempt in the chain. Also: OpenRouter fallback key #1 is revoked and still burns a rung. | minutes | LLM chain latency | `docs/ops/llm-lanes.md` |
| 8 | Mint an R2 "Admin Read and Write" token scoped to the storage bucket, put it in `.env.local`, so the CORS policy can be applied at the origin. | minutes | backlog 05 retirement | [../backlog/05-r2-bucket-cors.md](../backlog/05-r2-bucket-cors.md) |
| 9 | Refresh the GitHub PAT (classic, `public_repo`); the stored one returns Bad credentials. Blocks one docs push and the registry-listing comment. | minutes | backlog 10, one external docs commit | [../backlog/00-INDEX.md](../backlog/00-INDEX.md), order 10 |
| 10 | Fund the second-chain testnet deployer named in backlog 07 via the public faucet (reCAPTCHA-gated, no agent path), then say yes to the broadcast. | minutes + one yes | backlog 07 retirement | [../backlog/00-INDEX.md](../backlog/00-INDEX.md), order 07 |
| 11 | The marketplace-listing pack needs its email OTP as `claude@three.ws` (once now, once after first boot) plus an AI-provider key on the new worker service. | minutes | The three listing orders (pack table in [../README.md](../README.md)) | that pack's RUNBOOK |
| 12 | Clear the commit gate for the four backlog orders whose diffs reference third-party projects (07 through 10), per the CLAUDE.md coin rule, if that work should land in history. | one yes each | backlog 07 to 10 commits | [../backlog/00-INDEX.md](../backlog/00-INDEX.md) |
| 13 | Multiplayer scale decision: the world service is a pinned single instance with a measured 400-concurrent ceiling and no autoscale (room affinity needs Redis first). Decide whether to fund/approve the Redis-backed scale-out. | decision | quality-bar 03 scope | [../event/PROGRESS.md](../event/PROGRESS.md), preflight residuals |

## How agents use this file

- Add a row the moment an owner-only remainder appears; never end a session holding one
  silently.
- Never convert a row back into a mid-task question. The work order routes around the gap
  and finishes everything else; the row waits here.
- Keep rows honest: if you discover a row's premise no longer holds, fix or delete it and
  note why in [PROGRESS.md](PROGRESS.md).
