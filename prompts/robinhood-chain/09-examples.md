# 09 — Examples gallery: `robinhood-chain-examples`

Read `prompts/robinhood-chain/_shared.md` first. Wave 3: consumes everything built in Waves 1–2
(core SDK, hood-js, hoodkit, hood-api, hood402, hood-mcp). Check which siblings exist in
`robinhood/` and cover what's actually there; note any gaps in the report.

## Mission
Build `robinhood/robinhood-chain-examples/` — THE examples repo for the chain: the place every
new Robinhood Chain developer lands from a search. Each example is small, complete, runnable,
and real. This repo is also our SDK's honesty check — if an example is awkward to write, file
that as feedback in your report.

## Structure
```
examples/
  01-read-stock-price/        # viem-only, no SDK — the "hello chain" baseline
  02-stock-price-sdk/         # same thing in 3 lines of hoodchain
  03-portfolio-valuation/     # multiplier-correct portfolio (the correctness showpiece)
  04-swap-memecoin/           # quote + execute on testnet, faucet-funded
  05-watch-launches/          # live launchpad stream to console
  06-firehose/                # sequencer feed → filtered event stream
  07-live-price-webpage/      # single index.html, client-side RPC, ticking prices
  08-portfolio-dashboard/     # small Vite app on hoodkit react hooks
  09-x402-paid-api-call/      # client paying a hood-api endpoint via hood402
  10-x402-sell-your-api/      # 20-line paid endpoint with hood402 middleware
  11-mcp-agent-session/       # scripted MCP client driving hood-mcp tools
  12-telegram-price-bot/      # grammY bot: /price AAPL, /trending — deployable free-tier
  13-launch-a-coin-testnet/   # hood-launcher direct rail on 46630
  14-agent-paper-trader/      # minimal hood-traders strategy in paper mode
```
Each folder: `README.md` (what it shows, prerequisites, exact run commands, expected output —
real captured output), minimal deps, `package.json` with a single `npm start`.

## Requirements
- RUN EVERY EXAMPLE yourself; paste real output snippets into each README. Anything needing
  funds uses testnet 46630 + faucet (if the faucet remains owner-blocked, mark those examples'
  outputs as pending-funding — never fabricate output). Anything needing keys documents the
  env var and fails with a helpful message when missing (test that path too).
- Root README: gallery table (example → concept → difficulty → what it proves) + a
  "which package do I need?" decision map, consistent with hoodkit's decision table.
- `docs/` static site per `_shared.md`: gallery landing where example 07's live-price page is
  EMBEDDED and running (it's client-side — it works on Pages), with per-example pages rendering
  the READMEs beautifully with syntax highlighting (build-time rendered to static HTML, no
  client-side markdown fetching).
- Keep dependencies per example minimal and pinned `^`. No shared root node_modules trickery —
  each example installs standalone.

## Done checklist
- [ ] All examples run; captured outputs in READMEs; testnet hashes where applicable.
- [ ] Gallery site works locally as static files; example 07 lives inside it.
- [ ] SDK feedback list in the report (rough edges you hit — this feeds fixes upstream).
