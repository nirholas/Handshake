# docs/internal/

Internal documents. This tree is excluded from the public site build and from
`ALL.md` by `vite.config.js` and `scripts/combine-docs.mjs` (alongside `ops/` and
`security/`), so nothing here is served at `/docs/<slug>`. Public docs must not
link into it.

| Doc | What it is |
|---|---|
| [fable-playbook.md](fable-playbook.md) | The operating strategy above the work orders in `prompts/finish/`: how to run long-horizon agent sessions, the engineering plays ranked by revenue impact, the revenue ladder, and the measured external-revenue position. Promoted here on 2026-09-03 because it is durable strategy, not a one-shot order. |
| [MAINNET-TEST-2026-07-03.md](MAINNET-TEST-2026-07-03.md) | Record of the 3 July 2026 mainnet test run. |

Put a document here when it is durable, useful to the team, and states something
we would not publish: revenue figures, competitive positioning, unshipped plans.
Runbooks belong in [`ops/`](../ops/README.md); review records in `security/`.
