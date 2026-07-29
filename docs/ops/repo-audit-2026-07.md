# Private repo audit — what to bring into three.ws

Audited 2026-07-29 against the `nirholas` GitHub account: **312 owned repos, 141 private**.
Ranked by what three.ws can actually use, not by what the READMEs claim.

Method: full repo metadata for all 312, READMEs for ~40 shortlisted, and direct source
inspection (file counts, test counts, licenses, committed secrets, module-level reads) of
the decision-critical clones. Where a verdict rests on metadata rather than a code read,
it says so.

---

## The three findings that change the plan

**1. The dates lie.** 130 of the 141 private repos share a `pushed_at` of 2026-07-06.
That is a bulk migration artifact, not activity. Never rank these repos by push date;
rank by whether the code reads as finished.

**2. Several private repos are stale copies of a public repo that is further ahead.**
The private line is usually the older staging copy. Before adopting any private repo,
check for its public twin:

| Private | Public twin | Which is ahead |
|---|---|---|
| `x-dashboard` | `XActions` (418★) | Public: bigger and 3 weeks newer |
| `github2mcp` | `github-to-mcp` (31★) | Public: 4x bigger, newer |
| `ABI-to-MCP` | `UCAI` (35★) | Public: newer |
| `pumpk.it` | `pumpkit` (17★) | Different things; `pumpk.it` is a chat-UI fork |
| `agent-space`, `swarmsy` | `xspace-AI` (19★) | Same monorepo, three copies |
| `swarms` | `crypto-vision` (84★) | Private is **larger**; needs a diff before either is trusted |

**3. The single highest-profile candidate is already obsolete for its headline use.**
`cluster` is real, production-grade code (1,485 source files, 317 test files, live-mainnet
reports committed). Its Solana treasury sweep encodes genuinely hard-won knowledge: it
lands a swept wallet at *exactly* zero because the runtime rejects any transfer leaving an
account nonzero but below rent-exemption, and it picks between destination-pays and
payer-drains-to-zero depending on whether we can sign for the destination.

**But three.ws already solved this, and solved it better.** `api/_lib/economy-sweepback.js`
has both return legs: `reclaimIdleSol()` for the `SOLANA_SIGNERS` registry engines and
`planAgentReclaim()`/`reclaimIdleAgentSol()` for platform-owned agent custody wallets. Ours
adds what cluster has no concept of: a hard ownership boundary so a customer's agent is
never swept (SQL gate plus a redundant in-JS re-check), strategy-aware floors that keep an
enabled trading arm's working capital, and an `autoFundEnabled` anti-oscillation floor added
after a real funder/reclaim ping-pong round-tripped 0.24 SOL six times in 15 minutes.

Do not port cluster's sweeper. The dispersion problem it would "fix" was closed 2026-07-28.

---

## Tier 1 — bring in

**`cluster`** *(verdict: port two modules, not the product)*
Ignore the sweeper. The parts three.ws lacks are the **operator surface**: a fleet console
with live per-wallet portfolio, a `stats`/`tracker` service, and a job supervisor with
pause/stop checkpoints between batches (`control.checkpoint()`), which is exactly the
primitive our long-running batch jobs keep re-inventing. `src/lib/failover.js` and
`src/lib/journal.js` are small, clean, and directly reusable. Effort: ~3 days for the
supervisor + journal patterns. **Skip its arb, volume-bot, and bundle-buy paths entirely** —
coordinated multi-wallet buying is not something this platform should run.

**`paste-markets-og`** *(verdict: deploy as a new surface)*
The most genuinely *new* product in the account: paste a source, an AI extracts the trade
call, the price is captured as of when the author said it, and P&L is tracked from there.
Next.js, 156 source files, real routes already built (`/leaderboard`, `/heatmap`, `/events`,
`/trade`, `/alpha`, `/[author]` with a fade scorecard, plus `/docs` and `/developer`).
**Zero tests** — that is the gap, not the features. It slots directly beside our existing
fact-check and crypto-intel surfaces, and "accountability scoring for public callers" is a
sharper wedge than another dashboard. Effort: ~5 days to port the extraction pipeline behind
our LLM chain and put the author scorecard on an x402-paid endpoint.

**The "anything → MCP" family** — `github2mcp` + `ABI-to-MCP` + `mintlify-ai-toolkit` +
`gitbook-ai-toolkit` *(verdict: merge into one surface, build from the public twins)*
Four repos solving one problem: turn a source (repo, contract ABI, docs site) into an MCP
server. `github2mcp` is a proper pnpm monorepo (`core`, `mcp-server`, `openapi-parser`),
MIT, with real tests and a release pipeline. Individually each is a small tool; merged they
are a developer-acquisition funnel that ends at our x402 rail: free generation, paid hosted
endpoint. Build from `github-to-mcp` and `UCAI` (the public, newer lines). Effort: ~6 days.

## Tier 2 — mine for parts

- **`swarms` / `crypto-vision`** — claims 200+ endpoints, 37 data sources, 58 agents. The
  private copy is the larger of the two but three weeks older; diff them before trusting
  either. AGPL-3.0, which matters if any of it lands in our tree. The real question is how
  many data sources have working clients versus stubs, and how many need paid keys we do
  not hold. Worth one focused pass to pull the best 3-5 endpoint groups onto our existing
  paid `crypto-intel` rail rather than deploying the whole platform.
- **`AI-Agents-Library`** (505+ agent definitions, 18 languages) — seed content for an agent
  directory. Value depends entirely on whether the definitions are quality prompts or
  filler; sample before committing.
- **`agent-payments-sdk1`** — same lineage as our `agent-payments-sdk/`. 114 files, **no
  tests**. Dedupe against ours; do not adopt wholesale.
- **`eth-agents`** (ERC-8004 identity/reputation registries) — reference only. Solana is the
  home chain; an EVM identity registry is a secondary surface at best.

## Tier 3 — do not deploy

- **`bundle-vol-mm`, `pump-swarm-dashboard`, `GMGN_Trading_Bot`** — volume bots, bundle buys,
  coordinated multi-wallet trading. The dashboard UI is reusable as an ops HUD; the engines
  are not something we should run.
- **`x-dashboard` / XActions** — cookie-based X automation. Real and capable, but pointing it
  at the production `@trythreews` account puts our main distribution channel at ToS risk for
  marginal gain over the changelog cron we already run. Use it as a research tool, not a
  production dependency.
- **LobeChat forks** (`chatty`, `slatty`, `plugin-delivery`, `pai-chat`, `pumpk.it`) and
  **Sperax-branded platforms** (`sperax`, `SperaxOS`, `HQ`, `folio`, `tg-auth`, `valuecell`) —
  different products with different branding. Nothing here that our stack needs.
- **`browser`** — a Chrome DevTools frontend fork. Not ours to maintain.
- **`3D-Agent`** — the retired three.ws mirror. Per the operating rules, never pull from it.

---

## Recommended order

1. **`paste-markets-og`** — highest new-surface value, cleanest fit, no chain risk.
2. **The MCP family, merged** — developer funnel that terminates at the x402 rail.
3. **`cluster`'s supervisor + journal** — infrastructure our batch jobs already need.
4. **`swarms` endpoint triage** — highest ceiling, but gated on a real stub-vs-real count.

## Housekeeping

- The audit token was used read-only and has been removed from the workspace. It is a
  classic PAT with broad account scope: **rotate it**, since it was pasted into a chat.
- No committed `.env` files or private keys were found in the five repos inspected at source
  level (`cluster`, `paste-markets-og`, `github2mcp`, `agent-payments-sdk1`,
  `consolidate-wallet`). The other clones were removed before a secret scan ran; scan them
  before adopting.
- `cluster` and `agent-payments-sdk1` ship **no LICENSE file**. Add one before either
  informs code in this repo.
