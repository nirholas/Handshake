# Robinhood Chain prompt pack — execution index

Run order matters: later waves consume earlier waves' output. Within a wave, prompts are
independent and can run concurrently. Every agent reads `_shared.md` first, then its prompt.

> DO NOT DELETE PROMPT FILES — even after their work ships. This pack was wiped once by an
> overzealous cleanup and had to be restored. Only the owner removes prompts.

## Wave 1 — foundation (run first, alone)
| Prompt | Product | Folder | Status |
|---|---|---|---|
| [01-sdk-core.md](01-sdk-core.md) | Core TypeScript SDK (`hoodchain`) | `robinhood/robinhood-chain-sdk/` | BUILT 2026-07-12 (testnet-swap E2E owner-blocked on faucet login) |

## Wave 2 — SDK consumers (run after 01 completes; all concurrent)
| Prompt | Product | Folder |
|---|---|---|
| [02-sdk-simple-wrapper.md](02-sdk-simple-wrapper.md) | Dead-simple wrapper (`hood-js`) | `robinhood/hood-js/` |
| [03-sdk-advanced-wrapper.md](03-sdk-advanced-wrapper.md) | Advanced toolkit (`hoodkit`) | `robinhood/hoodkit/` |
| [04-market-data-api.md](04-market-data-api.md) | Hosted market-data API + x402 | `robinhood/hood-api/` |
| [05-x402-usdg-rail.md](05-x402-usdg-rail.md) | x402 USDG middleware + facilitator | `robinhood/hood402/` |
| [06-mcp-servers.md](06-mcp-servers.md) | MCP servers (data + trading) | `robinhood/hood-mcp/` |
| [11-toolkit-cli.md](11-toolkit-cli.md) | CLI toolkit (`hood-cli`) | `robinhood/hood-cli/` |
| [14-wallet-connect-kit.md](14-wallet-connect-kit.md) | Wallet & onboarding kit (`hood-connect`) | `robinhood/hood-connect/` |
| [15-tokenlist.md](15-tokenlist.md) | Canonical token list (`hood-tokenlist`) | `robinhood/hood-tokenlist/` |
| [17-erc8056.md](17-erc8056.md) | ERC-8056 reference (`erc8056`) | `robinhood/erc8056/` |
| [18-status-page.md](18-status-page.md) | Chain status page (`hood-status`) | `robinhood/hood-status/` |

## Wave 3 — applications (after wave 2; all concurrent)
| Prompt | Product | Folder |
|---|---|---|
| [07-agent-trading.md](07-agent-trading.md) | Autonomous trading agents | `robinhood/hood-traders/` |
| [08-agent-launcher.md](08-agent-launcher.md) | Autonomous coin launcher | `robinhood/hood-launcher/` |
| [09-examples.md](09-examples.md) | Examples gallery | `robinhood/robinhood-chain-examples/` |
| [12-threews-markets.md](12-threews-markets.md) | three.ws /markets display + purchase | in-repo (`api/`, `public/`) |
| [13-threews-play.md](13-threews-play.md) | three.ws /play coin worlds + firehose | in-repo |
| [16-alerts-bots.md](16-alerts-bots.md) | Telegram + Discord alert bots (`hood-alerts`) | `robinhood/hood-alerts/` |
| [19-usdg-checkout.md](19-usdg-checkout.md) | USDG checkout for humans (`hood-pay`) | `robinhood/hood-pay/` |

## Wave 4 — synthesis (last)
| Prompt | Product | Folder |
|---|---|---|
| [10-tutorials.md](10-tutorials.md) | Tutorial site (`learn-robinhood-chain`) | `robinhood/learn-robinhood-chain/` |

## Non-negotiables recap
- Read `_shared.md` before starting. Facts there override training data.
- Standalone repos live under `robinhood/<name>/`, MIT © 2026 nirholas, no `git init`, no commits.
- Prompts 12–13 modify the three.ws app itself — same commit gate: leave uncommitted.
- Docs sites are static `/docs` folders (Pages deploy-from-branch). No GitHub Actions anywhere.
- Done = tested + real on-chain evidence + docs + report. See `_shared.md` report format.

Research backing this pack: [PLAN.md](PLAN.md).
