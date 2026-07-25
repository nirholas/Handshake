# Agent task prompts

Self-contained task briefs for Claude agents, written to be pasted (or referenced by path) into a fresh chat. Each file carries all context needed to start cold: verified diagnostic data with dates, the job, constraints, and an explicit definition of done. One agent per file; run them in separate chats so each stays focused.

| File | Task | Depends on |
|---|---|---|
| [fix-x402-502-bursts.md](fix-x402-502-bursts.md) | Root-cause the autonomous loop's Cloud Run 502 bursts and the flapping Redis cache | nothing |
| [fix-x402-caller-mismatches.md](fix-x402-caller-mismatches.md) | Fix deterministic 405/400/422/402 loop failures and the zero-value Ring Tick service | nothing |
| [fix-x402-wallet-health.md](fix-x402-wallet-health.md) | Ring wallet SOL floors, unconfigured wallets, USDC float rebalancing | nothing |
| [new-trading-arm-x402-signals.md](new-trading-arm-x402-signals.md) | NEW trading arm driven by paid x402 signals. On HOLD until owner green-light | 502 + caller fixes landed |

Ground rules baked into every brief: existing autonomous trading arms are untouchable, all payments and trades are real, on-chain spend needs an explicit owner yes, and CLAUDE.md applies in full.

When a task completes, delete its file or mark it done here so a later agent does not re-run it.
