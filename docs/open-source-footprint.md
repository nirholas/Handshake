# Where three.ws stems: the open-source footprint

Every place the three.ws codebase, its packages, its listings, or its community lives outside three.ws itself, with the link to cite and the number behind it. This is the canonical reference for announcements (the 100-star post, the X article, the weekly report): if two pieces of copy quote different numbers, this page wins. Every link below returned a live page on August 25, 2026; every count came from the registry's own API on the same day. Regenerate the milestone graphic that renders these numbers with `node scripts/render-github-stars-banner.mjs`.

Related: [listings.md](listings.md) (marketplace status and submission history), [x402-distribution.md](x402-distribution.md) (every x402 crawler and directory, with mechanism), [community.md](community.md), [partners.md](partners.md).

## The repo

| Surface | Link | Number |
|---|---|---|
| Canonical repository | https://github.com/nirholas/three.ws | 104 stars, 26 forks, 21 contributors, 60 pull requests, 22 issues, 9,508 commits, Apache-2.0 |
| GitHub Discussions | https://github.com/nirholas/three.ws/discussions | community Q&A |
| Spun-out repos under `nirholas/*` | https://github.com/nirholas?tab=repositories | `readme-3d`, `onchain-agent-wallets`, `metaplex-agent-mcp`, `ibm-x402-mcp`, `vscode-x402`, `x402-fetch`, `x402-payments-mcp`, `x402-modal`, `x402-payment-modal`, `x402-server`, `3D-AR-Studio`, plus the Robinhood Chain package family |
| Contributor guide | https://github.com/nirholas/three.ws/blob/main/CONTRIBUTING.md | scoped open issues handed out to newcomers |

## Package registries

| Surface | Link | Number |
|---|---|---|
| npm, `@three-ws` scope | https://www.npmjs.com/org/three-ws | 101 packages (42 MCP servers), 6,225 downloads in the last 30 days |
| Official MCP Registry | https://registry.modelcontextprotocol.io/?q=io.github.nirholas | 72 servers under `io.github.nirholas` |
| Claude Code plugin marketplace | `/plugin marketplace add nirholas/three.ws` | 4 plugins in `.claude-plugin/marketplace.json` |
| Glama | https://glama.ai/mcp/servers?query=nirholas | 10 servers |
| PulseMCP | https://www.pulsemcp.com/servers?q=nirholas | 18 servers |
| VS Code Marketplace | https://marketplace.visualstudio.com/items?itemName=threews.vscode-x402 | `x402: Pay-per-call APIs`, 111 downloads |
| Open VSX | https://open-vsx.org/extension/threews/vscode-x402 | same extension |
| Hugging Face | https://huggingface.co/three-ws | `three-ws/avatars` model repo, `avatar-viewer` Space, and a blog post |
| LobeHub | https://lobehub.com/mcp | plugin manifest at https://three.ws/lobehub/plugin.json |
| SperaxOS chat plugin | https://chat.sperax.io | manifest at https://three.ws/.well-known/sperax-plugin.json |

Not published anywhere yet (do not claim): PyPI, crates.io, Docker Hub, Smithery.

## Cloud marketplaces and partner programs

| Surface | Link | Status |
|---|---|---|
| IBM Community, three.ws User Group | https://community.ibm.com/community/user/usergroup?CommunityKey=e71510cc-d953-408f-9a1c-019f5c0a7016 | live; IBM-authored welcome post and first-meetup recap, 3,145 peak concurrent avatars on August 7 |
| IBM Community blog (founding post) | https://community.ibm.com/community/user/blogs/nich8/2026/06/08/3d-ai-web3-just-converge-threews-shipped-the-whole | live |
| IBM on X about three.ws | https://x.com/IBM/status/2061418285896269952 | live |
| IBM watsonx / Granite | `@three-ws/ibm-watsonx-mcp`, `@three-ws/ibm-x402-mcp` on npm | IBM Business Partner |
| AWS Builder Center author profile | https://builder.aws.com/community/@threews | 3 published articles |
| AWS Builder Center articles | [metering through AWS Marketplace](https://builder.aws.com/content/3ESpll50BdSp9eiCEIxcfG9pGUN/how-we-metered-a-saas-product-through-aws-marketplace-with-the-aws-sdk-for-javascript-v3), [autonomous agents on AWS](https://builder.aws.com/content/3FMY7S5o4lwzb40gDsCJRCE20cX/build-autonomous-ai-agents-with-d-bodies-and-on-chain-payments-threews-on-aws), [the agentic economy](https://builder.aws.com/content/3FgvJFVKstRLVicHsldLM7ba4qB/the-agentic-economy-is-here-x-mcp-ai-agents-crypto-and-d-worlds-converging-aws-strategic-partnerships) | live |
| AWS Marketplace | SaaS metering integration built ([aws-marketplace.md](aws-marketplace.md)) | listing not yet created |
| NVIDIA Inception | https://www.nvidia.com/en-gb/accelerated-applications/inception/ | member since July 2026 |
| NVIDIA Developer Forums | [Nemotron in the text-to-3D pipeline](https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445), [NIM-powered i18n into 100 languages](https://forums.developer.nvidia.com/t/how-three-ws-translates-a-web-app-into-100-languages-with-nvidia-nim-an-llm-powered-i18n-pipeline/377379) | live |
| NVIDIA hardware | Cloud Run GPU fleet | NVIDIA L4 and RTX PRO 6000 Blackwell workers |
| Google Cloud for Web3 Startups | project runs on Cloud Run, Vertex AI, Imagen | member |
| Alibaba Cloud International Marketplace | https://marketplace.alibabacloud.com/products/56724001/sgcmfw00036800.html | live listing, plus the [storefront](https://marketplace.alibabacloud.com/store/3247293.html) |
| OpenAI GPT Store | https://chatgpt.com/g/g-6a563a3b49a88191abf346245491a444-three-ws-3d-studio | `three.ws 3D Studio`, live |
| OpenAI Cookbook | https://github.com/openai/openai-cookbook/pull/2874 | PR open |
| Quicknode Startup Program | accepted July 2026 | RPC |
| OKX.AI marketplace | ASP agent #2632 `three.ws 3D Studio` | resubmission pending |

## x402 economy

| Surface | Link | Number |
|---|---|---|
| Discovery catalog | https://three.ws/.well-known/x402.json | 4,519 priced endpoints, all on Solana mainnet |
| Self-hosted facilitator | in the repo, `api/_lib/x402/` | 110,416 on-chain USDC settlements, 803,483 verifications |
| x402scan | https://www.x402scan.com/server/17cbd874-52ac-4920-a020-b22ff2489a07 | server page (60 registered resources), plus [our facilitator](https://www.x402scan.com/facilitator/three-ws) since the upstream [PR](https://github.com/Merit-Systems/x402scan/pull/1032) merged 2026-08-11 |
| Coinbase CDP Bazaar | https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources | settlement-indexed |
| 402index.io | registered via `scripts/x402-register-directories.mjs` | 19 endpoints, domain claimed |
| Receipts | https://three.ws/receipts | 58,907 signed Offer and Receipt artifacts |

## On-chain

| Surface | Link | Number |
|---|---|---|
| Solana attestations | SPL Memo envelope `threews.validation.v1`, see [specs/VALIDATORS.md](../specs/VALIDATORS.md) | 3,000 validator attestations |
| Custody attestations | `custody_attestation_*` | 126,522 proofs across 244 epochs |
| ERC-8004 registries | Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, see [erc8004.md](erc8004.md) | same address on every EVM chain |
| Solana programs | `contracts/agent-invocation`, `contracts/skill-license` | 2 programs, 4 Rust crates |
| Solidity | `contracts/src` | 7 contracts (payments, identity, reputation, validation, vault) |
| BNB Chain Dappbay | https://dappbay.bnbchain.org/detail/three | live |
| Metaplex Core | `@three-ws/metaplex-agent-mcp` | agent identity on Solana |

## $THREE

Mint `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`. Venues: [pump.fun (verified)](https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump), [Jupiter](https://jup.ag/tokens/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump), [Phantom](https://trade.phantom.com/token/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump), [CoinGecko](https://www.coingecko.com/en/coins/three-ws), [Bybit Alpha](https://announcements.bybit.com/en/article/three-is-now-live-on-bybit-alpha-bltc04fc471efada919/), [KuCoin Alpha](https://www.kucoin.com/announcement/en-kucoin-alpha-new-listed-token-three-percolator), [MEXC](https://www.mexc.com/exchange/THREE_USDT), [LBank](https://www.lbank.com/trade/three_usdt), [KCEX](https://www.kcex.com/exchange/THREE_USDT), [Binance Web3](https://web3.binance.com/en/token/sol/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump). Live holder and market figures: https://three.ws/three.

## Press and community

| Surface | Link |
|---|---|
| Yahoo Finance | https://finance.yahoo.com/sectors/technology/articles/ibm-extends-ai-narrative-three-010650764.html |
| Business Insider Markets | https://markets.businessinsider.com/news/stocks/three-ws-and-ibm-announce-strategic-partnership-to-advance-ai-powered-3d-agent-technology-1036222181 |
| HackerNoon | https://hackernoon.com/u/three-ws |
| X | https://x.com/trythreews |
| Telegram | https://t.me/three_ws (releases), https://t.me/three_ws_community |
| Blog | https://three.ws/blog, 40 posts |

## Inside the repo, all Apache-2.0

725 public pages, 70 packages, 33 GPU workers, 60 agent skills, 31 specs, 1,749 test files, 2,674 changelog entries pushed to holders automatically.
