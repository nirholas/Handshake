# X posts: 100 stars on GitHub

Post copy for the 100-star milestone on X. Posting is owner-gated; these are ready-to-paste drafts. Attach [media/github-100-stars-x.png](../media/github-100-stars-x.png) (2400x1350, black background, three.ws lockup, twelve stat tiles) to the main post. [media/github-100-stars-square.png](../media/github-100-stars-square.png) (1620x1620) is the square cut for Telegram, Instagram, and LinkedIn.

Regenerate both images with `node scripts/render-github-stars-banner.mjs` after updating the `STATS` array in the script.

## Where every number comes from (as of August 25, 2026)

| Number | Source |
|---|---|
| 104 stars, 26 forks, 7 open issues (22 total), 60 pull requests | GitHub API for `nirholas/three.ws` |
| 21 contributors | distinct author identities in `git shortlog -sne --all` on `main` |
| 9,508 commits | `git rev-list --count HEAD` on `main` |
| 101 npm packages (42 are MCP servers) | `registry.npmjs.org` search, maintainer `three-ws` |
| 6,225 npm downloads, last 30 days (3,261 last 7 days) | `api.npmjs.org/downloads/point/last-month` summed across the scope |
| 72 MCP servers | `registry.modelcontextprotocol.io/v0/servers`, namespace `io.github.nirholas` |
| 60 agent skills | `.agents/skills` + `data/skills` |
| 4,519 x402 endpoints | resources in the live discovery catalog at `https://three.ws/.well-known/x402.json`, all priced on Solana mainnet |
| 110,416 x402 settlements | distinct on-chain settlement signatures across `x402_self_facilitator_log` (settle, ok) and `x402_audit_log` (`payment_settled`); the platform audit log alone records 79,477 settled payments since July 25 for $1,188.56 gross USDC |
| 803,483 x402 verifications | `x402_self_facilitator_log` rows with `action = 'verify'` and `ok` |
| 3,000 validator attestations | `solana_attestations` (SPL Memo envelope `threews.validation.v1`, see `specs/VALIDATORS.md`) |
| 126,522 custody proofs across 244 epochs | `custody_attestation_leaves` / `custody_attestation_epochs` |
| 725 public pages | `data/pages.json` |
| 70 packages, 33 workers, 31 specs, 1,749 test files, 4 Rust crates, 7 Solidity contracts | the repo tree, all Apache-2.0 |

## Main post (@trythreews)

Attach: media/github-100-stars-x.png

```
three.ws just crossed 100 stars on GitHub.

Thank you to everyone who starred, forked, opened an issue, or shipped a PR. Everything three.ws ships is open source, and here is what that repo has grown into:

9,508 commits, 21 contributors, 60 pull requests
101 npm packages under @three-ws
72 MCP servers in the official registry
4,519 x402 endpoints, 110,416 on-chain settlements
3,000 validator attestations on Solana
725 public pages, all Apache-2.0

github.com/nirholas/three.ws
```

## Reply 1 (where the open source stems)

```
Where the three.ws open source ecosystem lives:

npm: 101 packages under @three-ws, 42 of them MCP servers. Avatars, x402 payments, Solana agents, pump.fun tooling, voice, mocap, retargeting.

MCP registry: 72 servers under one namespace at registry.modelcontextprotocol.io. Any MCP client can install them.

Agent skills: 60 ready-to-install SKILL.md skills for Claude Code and any agent that reads them.

On-chain: Solana programs (agent invocation, skill licensing), ERC-8004 identity, reputation and validation registries, and the x402 payment contracts, all in the repo.
```

## Reply 2 (the machine economy, in numbers)

```
The x402 side of the repo is not a demo:

4,519 priced endpoints discoverable at three.ws/.well-known/x402.json
110,416 settlements on Solana in USDC through our own self-hosted facilitator
803,483 payment verifications
3,000 validator attestations and 126,522 custody proofs written on-chain

Every line of that stack is public. Fork it and run your own.
```

## Reply 3 (the ask)

```
If you build AI agents, 3D, or on-chain payments, there is real open work waiting for you: the contributor guide hands out scoped issues, every package has a README, and every PR gets reviewed.

Star it, fork it, ship something.
github.com/nirholas/three.ws

$THREE is the coin in the middle of it.
```

## Telegram (@three_ws)

Attach: media/github-100-stars-square.png

```
100 stars on GitHub.

The three.ws repo now carries 9,508 commits from 21 contributors, 101 npm packages, 72 MCP servers in the official registry, 4,519 x402 endpoints with 110,416 on-chain settlements, and 3,000 validator attestations on Solana. All of it open source. Thank you for building with us.

Star the repo: github.com/nirholas/three.ws
```
