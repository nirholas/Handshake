# Production Issues — three.ws

Live tracker for known production issues. When an item is fixed, drop it from
this file rather than leaving it here marked ✅ — this file should only contain
work that is still open.

> The 2026-05 incident batch (20 items, all resolved) and the 2026-06 resolved
> items were archived under `docs/internal/`, which was removed from the repo
> along with the rest of the internal content in commit `b80c1c379`. Both
> archives remain readable in git history:
> `git show b80c1c379^:docs/internal/ISSUES-ARCHIVE-2026-05.md`

---

## Open

Re-verified against the live Cloud Run services on 2026-07-22. The 2026-07-04
log-export batch is now mostly closed: `JWT_SECRET` and `WALLET_ENCRYPTION_KEY`
are set on `three-ws-api` (wallet sign-in and custodial provisioning work),
`ADMIN_CODE` is set on `hyperfy-world` (world.three.ws build rights are gated
again), and the reconstruct lane has a real fallback via
`GCP_RECONSTRUCTION_URL`. What remains requires owner/operator action outside
this repo:

1. **LLM paid backstops are dead** (owner billing decision). `OPENAI_API_KEY`
   is set on the service but the account returns `billing_not_active` 429s, so
   every OpenAI paid backstop is out. The OpenRouter platform key burned its
   credit on paid-model routing (invisible in metering: llm-pricing records
   OpenRouter as $0). Traffic survives on the free lanes (Groq/NIM plus the
   vertex-gemini credits anchor). Action: reactivate OpenAI billing and/or
   fund the OpenRouter key, or accept free-lane-only service.
2. **Neon storage over the high-water mark; write crons silently no-op**
   (found 2026-07-21). Database size exceeds the 2048MB high-water, which
   makes six write crons no-op without alerting, and `db-retention`'s plain
   `VACUUM` never returns space to the OS, so the condition cannot self-heal.
   `intel-learn` also OOMs on an unbounded 64k-row query while the cap holds.
   Action: bump the Neon plan or approve a destructive prune; until then the
   affected crons stay dark.
3. **Helius quota exhaustion, still live** (observed 2026-07-22: mainnet and
   devnet RPC 429 "max usage reached"; balances and solana-rpc fail over to
   public RPC with the designed 10min/360min cooldowns). Action: bump the
   Helius plan if the 429s persist at this volume.
