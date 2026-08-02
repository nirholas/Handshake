# robinhood/: the Robinhood Chain suite

Everything three.ws builds for **Robinhood Chain** (Robinhood's Arbitrum
Orbit L2, chain ID 4663): Robinhood Crypto only. Solana remains the home
chain; these are additional crypto surfaces, and each subproject below has its
own README with install and usage.

> **npm publishing note (2026-08-02):** the npm releases of these packages
> (hood-cli 0.2.1, hood-traders 0.2.1, hood-mcp / hoodkit / hood402 / hood-api /
> hood-js / hood-connect / erc8056 0.1.1) were published from their standalone
> GitHub repos (`nirholas/robinhood-chain-*`), which are the source of truth.
> The copies in this directory are older snapshots kept for reference. Do NOT
> `npm publish` from here: you would ship stale code over a newer release. Sync
> from the standalone repo (or the published tarball) first if a release must
> happen from this tree.

## Developer tooling

| Project | What it is |
| --- | --- |
| [robinhood-chain-sdk](robinhood-chain-sdk/) | The TypeScript SDK for Robinhood Chain |
| [hood-js](hood-js/) | Five-lines-to-your-first-trade wrapper around the SDK |
| [hood-cli](hood-cli/) | Command-line toolkit |
| [hoodkit](hoodkit/) | Power-user toolkit |
| [hood-connect](hood-connect/) | Add-to-wallet / connect helpers |
| [robinhood-chain-examples](robinhood-chain-examples/) | Runnable example projects |
| [learn-robinhood-chain](learn-robinhood-chain/) | The learning site for building on the chain |

## Data + infrastructure

| Project | What it is |
| --- | --- |
| [hood-api](hood-api/) | Hosted market-data API |
| [hood-status](hood-status/) | Status page for the chain |
| [hood-tokenlist](hood-tokenlist/) | Canonical token list |
| [hood-alerts](hood-alerts/) | Alerting |
| [hood-mcp](hood-mcp/) | MCP servers exposing chain data + actions to agents |

## Payments + agents

| Project | What it is |
| --- | --- |
| [hood402](hood402/) | x402 payment rail for USDG on Robinhood Chain |
| [hood-pay](hood-pay/) | Checkout-grade USDG payments |
| [hood-traders](hood-traders/) | Autonomous trading agent fleet |
| [hood-launcher](hood-launcher/) | Token launcher |
| [erc8056](erc8056/) | Reference implementation of ERC-8056 (Scaled UI amounts) |

The platform's Robinhood feed worker lives separately at
[workers/robinhood-feed/](../workers/robinhood-feed/); chain-priority rules
for the whole workspace are in [CLAUDE.md](../CLAUDE.md).
