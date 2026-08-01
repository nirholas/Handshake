# Fable Audit pack (2026-07-11)

One work order per finding from the maximum-depth audit of 2026-07-11. Snapshot ref before the
pack: `fable-audit-2026-07-11` (commit `267ee1418`).

## State

**Every numbered finding shipped and its work order was retired** (C1, C2, H1 to H7, M1 to M7),
along with the two batch records (`ENHANCEMENTS.md`, `LEAN-deletions.md`) once their items were
closed. All of them, with their defect analysis, fixes and evidence, remain readable in git
history:

```bash
git log --diff-filter=D --name-only -- prompts/fable-audit/ | head -40
git show <sha>^:prompts/fable-audit/<file>.md
```

**What is left is one file:** [RESIDUALS.md](RESIDUALS.md), a runnable work order covering the
three items that were deliberately left open, plus the one item (god-file splitting) that is
explicitly not scheduled as its own session.

| Item | Why it is still open |
|---|---|
| OIDC-authenticated invoker for `/api/cron/*` | Needs Cloud Scheduler and Cloud Run changes; `gcloud` auth on this machine dies to the Workspace reauth policy. The interim in-repo control ships regardless. |
| Payment-outcome observability | The metrics already emit; nothing surfaces them. No UI surface was in scope for the audit batch. |
| `data/skills/seed.json` regeneration | Generator and drift gate shipped; the regeneration diff touches other-project skill content, so committing it needs owner approval. |

## Commit gate reminder

Any commit whose diff references a crypto project other than `$THREE` needs explicit owner
approval first (`CLAUDE.md`). The seed-regeneration item ends at exactly that gate by design.

## Global done criteria for every item

- The change is minimal and matches surrounding code style.
- `npm test` still passes, or the relevant test is added.
- A `data/changelog.json` entry only if the change is user-visible or operator-visible.
- `git diff` self-reviewed before commit; the commit message is specific and neutral.
