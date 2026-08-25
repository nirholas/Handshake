# X posts: 100 stars on GitHub

Post copy for the 100-star milestone on X. Posting is owner-gated; these are ready-to-paste drafts. Attach [media/github-100-stars-x.png](../media/github-100-stars-x.png) (2400x1350, black background, three.ws lockup) to the main post. [media/github-100-stars-square.png](../media/github-100-stars-square.png) (1620x1620) is the square cut for Telegram, Instagram, and LinkedIn.

Regenerate both images with `node scripts/render-github-stars-banner.mjs` after updating the numbers in the script.

## Where every number comes from (as of August 25, 2026)

| Number | Source |
|---|---|
| 104 stars, 26 forks | `gh api repos/nirholas/three.ws` |
| 11 contributors | GitHub contributors API for `nirholas/three.ws` |
| 9,508 commits | `git rev-list --count HEAD` on `main` |
| 101 npm packages | `registry.npmjs.org` search, maintainer `three-ws` (42 of them are MCP servers) |
| 6,225 npm downloads, last 30 days (3,261 last 7 days) | `api.npmjs.org/downloads/point/last-month` summed across the scope |
| 72 MCP servers | `registry.modelcontextprotocol.io/v0/servers`, namespace `io.github.nirholas` |
| 70 packages, 33 workers, 60 agent skills, 4 Rust crates, Solidity contracts | `packages/`, `workers/`, `.agents/skills` + `data/skills`, `crates/` + `contracts/` in the repo |

## Main post (@trythreews)

Attach: media/github-100-stars-x.png

```
three.ws just crossed 100 stars on GitHub.

Thank you to everyone who starred, forked, opened an issue, or shipped a PR. Open source is not a side project for us. It is how the whole platform is built.

What that repo has grown into:

101 npm packages under @three-ws
72 MCP servers in the official registry
11 contributors, 26 forks, 9,508 commits
6,225 npm downloads in the last 30 days

github.com/nirholas/three.ws
```

## Reply 1 (where the open source stems)

```
Where the three.ws open source ecosystem lives:

npm: 101 packages under @three-ws, 42 of them MCP servers. Avatars, x402 payments, Solana agents, pump.fun tooling, voice, mocap, retargeting.

MCP registry: 72 servers under one namespace at registry.modelcontextprotocol.io. Any MCP client can install them.

On-chain: Solana programs (agent invocation, skill licensing) and Solidity payment contracts, all in the repo.

Agent skills: 60 ready-to-install skills for Claude Code and any agent that reads SKILL.md.
```

## Reply 2 (the ask)

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

The three.ws repo now carries 101 npm packages, 72 MCP servers in the official registry, 11 contributors, 26 forks, and 9,508 commits since April 14. Thank you for building with us.

Star the repo: github.com/nirholas/three.ws
```
