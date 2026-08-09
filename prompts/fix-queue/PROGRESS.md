# fix-queue progress log

The only memory between chats. Append, never rewrite. Newest at the bottom.

Format: `YYYY-MM-DD | work order | what changed | verification`.

---

2026-08-01 | pack opened | 8 work orders written from a live sweep of this
worktree and of production. Sweep commands: `npm run gate`, `npm run lint`,
`npm run audit:links`, `npm run audit:tour-atlas`, `npm run check:cron-drift`,
`npm run check:runnable-docs`, `npm run audit:docs`, `npm run check:claude`,
`npm run check:browser-graph`, `npm run test:core` (timed out), plus
`GET /api/version` and `GET /api/healthz` against production | each work order
carries the verbatim output that reproduced it

2026-08-01 | pack trimmed | six ISSUES.md-derived work orders (x402 settle,
Solana RPC, LLM lanes, R2 CORS, fact-check benchmark, BNB and OKX blockers) were
deleted an hour after being written, because a concurrent agent shipped
`prompts/backlog/` covering the same items with an equally current measured
snapshot. Keeping both would have guaranteed drift. fix-queue now owns only
defects reproduced by running the repo's own checks; backlog owns the
infrastructure and owner-gated items | `ls prompts/backlog prompts/fix-queue`

2026-08-01 | 08-avatar-optimize-inflates | new finding, not in any tracker:
`/api/avatar/optimize?draco=1` returns output larger than its input on both
production sample avatars (default.glb 748,088 to 890,160; michelle.glb 849,756
to 974,036), and the Draco output still carries `EXT_meshopt_compression`. Note
this supersedes the older `ISSUES.md` item 9 claim of a 500 `transcode_failed`,
which is fixed | sizes measured with `curl -w '%{size_download}'`

2026-08-09 | 02-lint-errors | eslint now exits 0 with zero errors. The three
original errors were partly fixed by earlier sessions (the vite.config
duplicate key was gone); this session cleared the rest plus four newer ones:
the money-test precision literal replaced with Number.MAX_SAFE_INTEGER + 2
(same guarantee, no lossy literal; 22/22 tests pass), .claude/workflows/**
added to eslint ignores beside scripts/wf-*.mjs (same Workflow-DSL rationale),
an unknown-rule disable comment removed from agent-runtime UsageCounter, three
case-block declarations braced and one intentionally yield-less error-path
generator annotated in agent-runtime runtime.test.js (48/48 tests pass) |
npm run lint exit 0 (8352 warnings remain, all pre-existing)
