# Listings & Distribution

three.ws is open source and self-hostable. It is also distributed through cloud marketplaces (for enterprise procurement) and indexed in ecosystem dApp directories (for community discovery). This page tracks every official listing.

If you maintain a marketplace, registry, or directory and want three.ws listed, open an issue at [github.com/nirholas/three.ws/issues](https://github.com/nirholas/three.ws/issues) or reach out via the contacts on [three.ws](https://three.ws).

---

## Cloud Marketplaces

Cloud marketplaces are the procurement flow enterprises use to acquire software through their existing cloud account, with consolidated billing, compliance, and support.

| Cloud | Status | Links |
|---|---|---|
| **AWS** Marketplace | Live | three.ws is an AWS Partner. Subscribe via AWS Marketplace to consolidate billing on your AWS account; subscriptions auto-issue an x402 API key via the marketplace entitlement service. See [aws-marketplace.md](./aws-marketplace.md). |
| **Alibaba Cloud** International Marketplace | Live | [Product listing](https://marketplace.alibabacloud.com/products/56724001/sgcmfw00036800.html) · [Storefront](https://marketplace.alibabacloud.com/store/3247293.html) · [Announcement](/blog/three-ws-on-alibaba-cloud-marketplace.html) · [Marketplace blog feature](https://marketplace.alibabacloud.com/doc/blog/detail/mplace-sgcmfw00036800.html) |
| **Google Cloud** Marketplace | Open to partnership | three.ws already runs its production stack on Google Cloud Run (`three-ws-api`, us-central1) — a natural fit for Vertex AI and GCP's global CDN. Reach out for co-listing, credits, and joint GTM. |
| **Microsoft Azure** Marketplace | On roadmap | Targeted alongside the AWS/Alibaba rollout. |

---

## Startup & Credit Programs

Infrastructure programs that back three.ws with credits, tooling, and founder networks.

| Program | Status | Details |
|---|---|---|
| **Quicknode** Startup Program | Accepted (2026-07) | three.ws is accepted into the Quicknode Startup Program and approved for free infrastructure credits. Quicknode's globally distributed RPC endpoints (Solana first, plus the EVM chains x402 settles on) add capacity and redundancy behind agent wallets, settlement verification, and live market data. Announcement: [three.ws Joins the Quicknode Startup Program](/blog/three-ws-quicknode-startup-program). |
| **Google Cloud** for Web3 Startups | Member | Production runs on Google Cloud Run; the program backs compute and Vertex AI usage. Announcement: [three.ws Joins Google Cloud for Web3 Startups](/blog/three-ws-google-cloud-partnership). |

---

## Ecosystem Directories

Ecosystem directories are the discovery surfaces that L1/L2 communities, chain foundations, and dApp explorers publish to help users find vetted projects on their stack.

| Directory | Status | Listing details |
|---|---|---|
| **BNB Chain · Dappbay** | Live | [dappbay.bnbchain.org/detail/three](https://dappbay.bnbchain.org/detail/three) — categories: *AI Agent Launchpad · AI Data · AI Infra*. Announcement: [three.ws Listed on BNB Chain's Dappbay Directory](/blog/three-ws-on-bnb-chain-dappbay.html). |

Dappbay is BNB Chain's official dApp directory. The listing is about distribution and discovery into BNB Chain's AI dApp audience — three.ws still settles agent payments on Solana, Base, and Polygon via the chain-agnostic [x402 protocol](./x402.md).

---

## Media & Content Partners

| Partner | Status | Links |
|---|---|---|
| **IBM Community** | Live | [Embodied, Intelligent, and Self-Custodied: three.ws and the 3D AI Agent Stack](https://community.ibm.com/community/user/blogs/nich8/2026/06/08/3d-ai-web3-just-converge-threews-shipped-the-whole) — IBM Community blog covering the convergence of 3D, AI agents, and web3 in the three.ws stack. |
| **HackerNoon** | Live | [hackernoon.com/u/three-ws](https://hackernoon.com/u/three-ws) — three.ws posts auto-import from the RSS feed. Announcement: [three.ws Partners with HackerNoon](/news/partnered-with-hackernoon) |
| **Alibaba Cloud Marketplace Blog** | Live | [Editorial feature](https://marketplace.alibabacloud.com/doc/blog/detail/mplace-sgcmfw00036800.html) — Alibaba Cloud Marketplace published an editorial introducing three.ws. Announcement: [three.ws Featured on the Alibaba Cloud Marketplace Blog](/blog/three-ws-featured-on-alibaba-cloud-marketplace-blog) |
| **pump.fun** | Live | [Three Builds With Tech Giants](https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump/article): a feature article published on the official $THREE coin page, profiling the platform's browser-native 3D AI agents with onchain identities, the Animations and Poses Studio, the 3D Studio MCP server, and the AWS and IBM milestones. |

HackerNoon is one of the world's largest independent tech publications, read by millions of developers and founders monthly. Every three.ws announcement is pulled automatically from [`three.ws/rss/announcements.xml`](https://three.ws/rss/announcements.xml) into the HackerNoon drafts queue, then published with canonical URLs pointing back to three.ws. See [syndication setup](/docs/syndication#hackernoon) for technical details.

---

## Open Source

The full stack is on GitHub:

- **three.ws** — [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws) (canonical source of truth)

The codebase includes the `<agent-3d>` browser component, the Solana minting SDK, the x402 payment SDK, the ERC-8004 wallet integration, and the agent-payments SDK used by third-party developers.

---

## RSS & Announcements

Every listing is announced through:

- **RSS** — [`https://three.ws/rss/announcements.xml`](https://three.ws/rss/announcements.xml)
- **News index** — [`https://three.ws/news/`](https://three.ws/news/)
- **Blog** — [`https://three.ws/blog/`](https://three.ws/blog/)

Subscribe via RSS to track new listings, integrations, and protocol updates.

---

## Related

- [AWS Marketplace](/docs/aws-marketplace): the AWS listing and entitlement-issued x402 API keys
- [Syndication](/docs/syndication): how announcements flow to HackerNoon and other channels
- [x402 protocol](/docs/x402): the payment rail behind the paid endpoints these listings distribute
- [Introduction](/docs/introduction): the full technical picture of the platform being listed
