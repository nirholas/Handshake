# Robinhood Chain pack: execution index

Robinhood in this workspace always means **Robinhood Crypto**, never equities or options
(`CLAUDE.md`). Chain facts live in [_shared.md](_shared.md); the research behind the campaign is
in [PLAN.md](PLAN.md). Facts in those two files override training data.

## State: every work order in this pack has shipped and been retired

All 19 numbered work orders were completed and their files removed from the working tree; each
remains readable in git history (`git log --diff-filter=D --name-only -- prompts/robinhood-chain/`).
What they produced is on disk:

| Product | Folder | Kind |
|---|---|---|
| Core TypeScript SDK | `robinhood/robinhood-chain-sdk/` | standalone repo |
| Simple wrapper | `robinhood/hood-js/` | standalone repo |
| Advanced toolkit | `robinhood/hoodkit/` | standalone repo |
| Market-data API + x402 | `robinhood/hood-api/` | standalone repo |
| x402 USDG rail | `robinhood/hood402/` | standalone repo |
| MCP servers | `robinhood/hood-mcp/` | standalone repo, published to npm |
| CLI toolkit | `robinhood/hood-cli/` | standalone repo |
| Wallet and onboarding kit | `robinhood/hood-connect/` | standalone repo |
| Canonical token list | `robinhood/hood-tokenlist/` | standalone repo |
| ERC-8056 reference | `robinhood/erc8056/` | standalone repo |
| Chain status page | `robinhood/hood-status/` | standalone repo |
| Trading agents | `robinhood/hood-traders/` | standalone repo |
| Coin launcher | `robinhood/hood-launcher/` | standalone repo |
| Alert bots | `robinhood/hood-alerts/` | standalone repo |
| USDG checkout | `robinhood/hood-pay/` | standalone repo |
| Examples gallery | `robinhood/robinhood-chain-examples/` | standalone repo |
| Tutorial site | `robinhood/learn-robinhood-chain/` | standalone repo |
| In-repo markets board | `pages/markets.html`, `api/v1/robinhood/*`, route `/markets/robinhood` | three.ws surface |
| In-repo coin worlds and firehose | `api/robinhood/play-worlds.js`, `api/robinhood/coin-trades.js`, `workers/robinhood-feed/` | three.ws surface |

## What is left, and it is all owner-side

None of these is agent-executable from this machine:

1. **npm publish.** Every package is publish-ready (`npm pack` clean, `files`, `exports`,
   `types` set). The owner holds the token: `npm publish --access public` per package.
2. **GitHub Pages.** Each standalone repo ships a static `docs/` site. Enable Settings, Pages,
   main branch, `/docs` after the repo is pushed. No GitHub Actions anywhere in this project.
3. **Repo extraction and push.** The folders under `robinhood/` deliberately have no `.git`.
   The owner extracts and pushes them.
4. **Testnet faucet funding.** The official faucet requires Turnstile plus Google Sign-In in a
   real browser, so a shared test wallet must be funded once by hand.

## If you want an agent pass over this pack

There is no open work order, so give a specific instruction instead. Useful ones:

- "Re-verify every repo under `robinhood/`: install, build, test, `npm pack`, and report which
  ones are still green." Real on-chain reads against mainnet 4663 are free and unblocked.
- "Refresh `_shared.md` against the live chain and the current viem chain defs."
- "Audit the in-repo `/markets/robinhood` surface against the live APIs and fix what drifted."

## Non-negotiables recap

- Standalone repos live under `robinhood/<name>/`, MIT, copyright 2026 nirholas, no `git init`
  inside them and no commits from an agent.
- **Commit gate:** everything in this campaign references a crypto project other than `$THREE`,
  so no commit that touches it ships without explicit owner approval (`CLAUDE.md`).
- Stock Token display is unrestricted; any buy or swap flow carries the eligibility disclosure
  and a config-level geo gate. Memecoins carry no such restriction.
- Done means tested, with real on-chain evidence, docs, and a report. Format in `_shared.md`.
