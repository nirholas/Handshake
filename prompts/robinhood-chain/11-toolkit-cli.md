# 11 — CLI toolkit: `hood-cli`

Read `prompts/robinhood-chain/_shared.md` first. Wave 2: requires core SDK
(`file:../robinhood-chain-sdk`).

## Mission
Build `robinhood/hood-cli/` — the command-line toolkit for Robinhood Chain: the `gh`/`vercel` of
chain 4663. Instant reads with zero config, guarded writes with a wallet. npm `hood-cli`
(fallbacks: `hoodchain-cli`, `hood-toolkit`) exposing the `hood` binary (bin fallback `hoodc`
if a global `hood` conflict is likely — check npm).

## Command surface
```
hood price AAPL [--watch]            # Chainlink + DEX price + premium, live-updating table
hood stocks [--sort premium]         # full Stock Token board
hood coins [--new|--trending]        # memecoin screener
hood launches [--follow]             # launchpad feed, streaming
hood portfolio <address>             # multiplier-correct positions, USD totals
hood tx <hash> | hood token <addr>   # decoded inspection via Blockscout + RPC
hood watch <addr|token>              # live activity stream for an address/token
hood swap --sell USDG --buy <token> --amount 100 [--execute]   # quote by default; --execute signs
hood transfer --to <addr> --amount 5 --token USDG
hood faucet                          # testnet: request funds, print balances
hood deploy-token --config coin.json # direct-rail ERC-20 deploy (testnet default)
hood config [set|get|list]           # rpc, alchemy key, wallet, network (mainnet|testnet)
```
- Reads need zero setup. Writes need `hood config set wallet` (env/keystore file with password,
  never plaintext in config) + explicit `--execute`, defaulting to a printed simulation.
  Stock Token buys additionally require `--acknowledge-eligibility` (with the `_shared.md` note
  in help text). `--json` on every command for scripting; exit codes meaningful.

## Requirements
- Node ≥ 20, commander or clipanion, chalk-free custom ANSI styling consistent with the design
  bar (a CLI has aesthetics too: aligned tables, subtle color semantics — green/red only for
  numbers, spinners for network waits, graceful narrow-terminal fallback).
- `--watch`/`--follow` modes render flicker-free (diff-repaint, not clear-screen spam).
- Errors: human-first message + `--verbose` for the raw cause. Offline/RPC-down states designed.
- Vitest: command parsing, formatting, guard rails (execute-gate, eligibility-gate, cap flag).
  E2E script driving the built binary: real mainnet reads + real testnet swap and transfer
  (faucet funds) — paste session transcript in the report.
- `docs/` static site per `_shared.md`: landing = animated terminal session (CSS/JS typewriter
  over a REAL captured session, not invented output), install (`npm i -g`), command reference
  generated from the CLI's own help definitions (single source of truth), scripting recipes.
- README: full command reference + quickstart GIF-alternative (the animated session).

## Done checklist
- [ ] Real transcript evidence for every command (mainnet reads, testnet writes).
- [ ] `npm pack` clean; `npm i -g ./hood-cli-*.tgz && hood price AAPL` works in a clean shell.
- [ ] Guard-rail tests green; docs terminal animation uses the real captured session.
