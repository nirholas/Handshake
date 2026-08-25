# X posts: 100 stars on GitHub

Post copy for the 100-star milestone on X. Posting is owner-gated; these are ready-to-paste drafts. Attach [media/github-100-stars-x.png](../media/github-100-stars-x.png) (2400x1350, black background, three.ws lockup, twelve stat tiles) to the main post, and [media/github-100-stars-ecosystem.png](../media/github-100-stars-ecosystem.png) (same size, the footprint beyond the repo) to reply 3. [media/github-100-stars-square.png](../media/github-100-stars-square.png) (1620x1620) is the square cut for Telegram, Instagram, and LinkedIn.

Regenerate both images with `node scripts/render-github-stars-banner.mjs` after updating the `STATS` and `SURFACES` arrays in the script. The canonical link and number table both announcements (the post and the X article) must cite is [open-source-footprint.md](../open-source-footprint.md); keep the copy below in sync with it.

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
| 70 packages, 33 workers (27 Docker images), 31 specs, 1,752 test files, 323 docs, 4 Rust crates, 7 Solidity contracts, 2 Anchor programs | the repo tree, all Apache-2.0 |
| 111 related public repos, 1,222 stars between them (192 non-fork repos and 9,298 stars across the whole `nirholas` account) | `gh repo list nirholas`, filtered to repos spun out of or built for three.ws (x402 suite, Robinhood Chain family, MCP servers, SDKs, AR Studio, wallets, news archive) |
| ERC-8004 registries live on 12 mainnet chains | `contracts/DEPLOYMENTS.md`, bytecode-verified 2026-06-19 (Ethereum, Optimism, BSC, Gnosis, Polygon, Mantle, Base, Arbitrum, Celo, Avalanche, Linea, Scroll) |
| Hugging Face org, Space, model repo, blog post | `huggingface.co/three-ws`, `spaces/three-ws/avatar-viewer`, `three-ws/avatars`, `blog/three-ws/giving-ai-agents-bodies-and-wallets` |
| MCP directories: official registry (72 servers), Glama (10), PulseMCP (18); x402scan server page. Smithery, Docker Hub, PyPI, crates.io: not published, do not claim | registry APIs, `docs/open-source-footprint.md` |
| Blender addon, ComfyUI nodes, VS Code and Open VSX extension, Chrome extension, 2 Claude Code plugins | `integrations/blender`, `integrations/comfyui`, `packages/vscode-x402`, `extensions/`, `marketplace/plugins` |
| 3 GitHub Pages apps | `nirholas.github.io/3D-AR-Studio`, `/metaplex-agent-mcp`, `/onchain-agent-wallets` |

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

## Reply 1 (the scale of it)

```
100 stars understates it. In 19 weeks this one repo became:

101 npm packages. 72 servers in the official MCP registry, the largest namespace on it we know of. 60 agent skills any agent can install.

1,000,000+ priced x402 endpoints, 110,416 of them already settled on Solana. Our own facilitator, our own validators, 3,000 attestations on-chain.

ERC-8004 identity, reputation, and validation registries at one address on 12 EVM mainnets. Two Solana programs. 111 spin-out repos.

3,000+ mocap animations, 500+ CC0 props, 106 rigged characters, a 740,889-article crypto news archive, a self-hosted NVIDIA GPU fleet.

All Apache-2.0. All in one place.
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

## Reply 3 (beyond this one repo)

Attach: media/github-100-stars-ecosystem.png

```
And three.ws does not stop at one repo.

111 open-source repos spun out of it, 1,222 stars between them: a 50-repo x402 suite, the Robinhood Chain family, standalone MCP servers, the AR Studio, on-chain agent wallets, the news archive.

ERC-8004 identity, reputation, and validation registries live on 12 EVM mainnets. Two Solana programs. 33 GPU and CPU workers as Docker images.

A Hugging Face org with a Space and a model repo. A Blender addon. ComfyUI nodes. A VS Code extension. Listed on the official MCP registry, Glama, PulseMCP, and x402scan.

All Apache-2.0.
```

## Reply 4 (the partners and platforms)

```
And the places that noticed:

IBM built a dedicated three.ws User Group on IBM Community and hosted our first in-world meetup (3,145 avatars at peak).
AWS Builder Center: three published articles on metering, agents, and the agentic economy.
NVIDIA: Inception member, two Developer Forum write-ups, L4 and Blackwell workers in production.
OpenAI: three.ws 3D Studio is live in the GPT Store.
Alibaba Cloud Marketplace: live listing. Google Cloud for Web3 Startups: member.

Every link, with the number behind it: three.ws/docs/open-source-footprint
```

## Reply 5 (the ask)

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
