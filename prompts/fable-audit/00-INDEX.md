# Fable Audit — Work-Order Pack (2026-07-11)

One `.md` per finding from the maximum-depth audit. Each file is a self-contained
work order: context, the exact defect (file:line), the fix, verification, and a
done checklist. Execute in the recommended order below.

Snapshot ref before this pack: `fable-audit-2026-07-11` (at commit `267ee1418`).
Work happens on `main`. Commit each item as its own small, revertible commit.

## Commit gate reminder
Some items touch skill files that reference other crypto projects (four.meme, BNB,
OKX, etc.). Per `CLAUDE.md`, **any commit whose diff references a non-$THREE crypto
project needs explicit owner approval first**. Items flagged `⚠ commit-gate` below
must stop for owner sign-off before staging. Items without the flag are freely
committable.

## Recommended execution order
| # | File | Severity | Area | Commit-gate |
|---|---|---|---|---|
| C1 | [C1-api-path-traversal.md](C1-api-path-traversal.md) | Critical | Server routing | no |
| H1 | [H1-premium-status-ownership.md](H1-premium-status-ownership.md) | High | API authz | no |
| H4 | [H4-dockerignore-ring-secrets.md](H4-dockerignore-ring-secrets.md) | High | Infra/secrets | no |
| H6 | [H6-posthog-cookie-leak.md](H6-posthog-cookie-leak.md) | High | Server proxy | no |
| H2 | [H2-self-facilitator-verify-simulation.md](H2-self-facilitator-verify-simulation.md) | High | Payments | no |
| H3 | [H3-settlement-skip-on-flush.md](H3-settlement-skip-on-flush.md) | High | Payments | no |
| M1 | [M1-facilitator-rate-limit.md](M1-facilitator-rate-limit.md) | Medium | Payments | no |
| M2 | [M2-proxy-stream-crash.md](M2-proxy-stream-crash.md) | Medium | Server proxy | no |
| H5 | [H5-worker-port-listener.md](H5-worker-port-listener.md) | High | Workers | no |
| M3 | [M3-dockerfile-minimal.md](M3-dockerfile-minimal.md) | Medium | Infra | no |
| M5 | [M5-ring-tx-bounds-guard.md](M5-ring-tx-bounds-guard.md) | Medium | Payments | no |
| M6 | [M6-text-extract-allowhttp.md](M6-text-extract-allowhttp.md) | Medium | Security | no |
| M7 | [M7-postversion-push-target.md](M7-postversion-push-target.md) | Medium | Repo/CI | no |
| C2 | [C2-money-skill-confirmation-gates.md](C2-money-skill-confirmation-gates.md) | Critical | Skills | ⚠ partial |
| H7 | [H7-wallet-skill-arbitration.md](H7-wallet-skill-arbitration.md) | High | Skills | ⚠ partial |
| M4 | [M4-nft-model-id-placeholder.md](M4-nft-model-id-placeholder.md) | Medium | Skills | ⚠ commit-gate |
| — | [LEAN-deletions.md](LEAN-deletions.md) | Lean | Deps/dedup | ⚠ partial |
| — | [ENHANCEMENTS.md](ENHANCEMENTS.md) | Nice-to-have | Various | mixed |

## Global done criteria for every item
- Change is minimal and matches surrounding code style.
- `npm test` still passes (or the relevant test is added).
- A `data/changelog.json` entry is added **only** if the change is user-visible
  (security/reliability fixes usually are; internal refactors are not).
- `git diff` self-reviewed before commit; commit message is specific and neutral.
