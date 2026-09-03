# Listings & Distribution

three.ws is open source and self-hostable. It is also distributed through cloud marketplaces (for enterprise procurement) and indexed in ecosystem dApp directories (for community discovery). This page tracks every official listing.

If you maintain a marketplace, registry, or directory and want three.ws listed, open an issue at [github.com/nirholas/three.ws/issues](https://github.com/nirholas/three.ws/issues) or reach out via the contacts on [three.ws](https://three.ws).

---

## Cloud Marketplaces

Cloud marketplaces are the procurement flow enterprises use to acquire software through their existing cloud account, with consolidated billing, compliance, and support.

| Cloud | Status | Links |
|---|---|---|
| **AWS** Marketplace | Integration ready, listing not yet created | three.ws is an AWS Partner and the SaaS integration is built, deployed, and conformant with the Concurrent Agreements requirements AWS made mandatory for new products on 2026-06-01. The product itself has not been created in the AWS Marketplace Management Portal yet, so there is nothing to subscribe to on the AWS side: use [x402](/docs/x402) directly in the meantime, which needs no AWS account. Once the listing is public, subscribing consolidates procurement on your AWS account and auto-issues an x402 API key. See [aws-marketplace.md](./aws-marketplace.md) and the [listing kit](./aws-marketplace-listing-kit.md). |
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
| **NVIDIA Inception** | Member (2026-07) | NVIDIA's program for startups building on accelerated computing. Every generation lane runs on NVIDIA: a self-hosted Cloud Run GPU fleet (L4 plus one RTX PRO 6000 Blackwell) behind text-to-3D, rigging, and motion, and a free hosted lane behind chat, vision, embeddings, safety, and speech. Surface: [/nvidia](/nvidia). Docs: [NVIDIA Inception](./nvidia-inception.md), [NVIDIA models](./nvidia-models.md), [visibility map](./nvidia-visibility-map.md). Listings that run through the membership are in AI Platform Directories below. Membership is a startup program, not a partnership, an investment, or an endorsement. |

---

## Ecosystem Directories

Ecosystem directories are the discovery surfaces that L1/L2 communities, chain foundations, and dApp explorers publish to help users find vetted projects on their stack.

| Directory | Status | Listing details |
|---|---|---|
| **BNB Chain · Dappbay** | Live | [dappbay.bnbchain.org/detail/three](https://dappbay.bnbchain.org/detail/three) — categories: *AI Agent Launchpad · AI Data · AI Infra*. Announcement: [three.ws Listed on BNB Chain's Dappbay Directory](/blog/three-ws-on-bnb-chain-dappbay.html). |

Dappbay is BNB Chain's official dApp directory. The listing is about distribution and discovery into BNB Chain's AI dApp audience — three.ws still settles agent payments on Solana, Base, and Polygon via the chain-agnostic [x402 protocol](./x402.md).

---

## AI Platform Directories

The discovery surfaces owned by the AI platforms themselves, where an MCP server can be listed as an installable product rather than a documentation page.

| Directory | Status | Listing details |
|---|---|---|
| **OpenAI** Plugin Directory (ChatGPT + Codex) | Open to submission | The universal directory shared by ChatGPT and Codex since 2026-07-09, superseding the former App directory. three.ws already meets the gating requirement: a public OAuth 2.1 MCP server at `https://three.ws/api/mcp` ([mcp.md](./mcp.md)). Full submission kit, prerequisites, and rejection criteria: [openai-listing-channels.md](./openai-listing-channels.md). |
| **OpenAI** Showcase Gallery | Open to submission | Editorial feature on openai.com for apps, demos, and open-source projects built with OpenAI models, APIs, or Codex. Open web form, no repo gate. See [openai-listing-channels.md](./openai-listing-channels.md). |
| **OpenAI** Cookbook | Submitted, not merged | [PR #2874](https://github.com/openai/openai-cookbook/pull/2874) (a self-correcting 3D collectible pipeline using text-to-3D, function calling, and vision) has been open since 2026-07-21. Root-cause analysis and the revival steps are in [openai-listing-channels.md](./openai-listing-channels.md). |
| **NVIDIA** Accelerated Apps Catalog | Prepared, not submitted | NVIDIA's curated catalog of applications built by Inception members, published at [marketplace.nvidia.com](https://marketplace.nvidia.com/en-us/enterprise/applications/). There is no self-serve control: a product record in the Inception portal makes the company eligible, and NVIDIA curates the public listing. The portal record is filed and the correction sheet, the paste-ready copy, and the inclusion email are all written. See [nvidia-apps-catalog-listing.md](./nvidia-apps-catalog-listing.md) and [nvidia-apps-catalog-request.md](./nvidia-apps-catalog-request.md). |
| **NVIDIA** NGC Catalog | Prerequisites cleared, submission pending | The one NVIDIA directory with a self-serve intake form, and a real distribution channel: an NVIDIA-hosted listing for the container itself at [catalog.ngc.nvidia.com](https://catalog.ngc.nvidia.com/). Our candidate is the [model-trellis](../workers/model-trellis) image-to-3D server (MIT upstream model, no baked weights, no telemetry). The EULA prerequisite is closed at [/legal/nvidia-ngc-eula](/legal/nvidia-ngc-eula); what remains is one build and the partner legal agreement. Kit: [nvidia-ngc-listing.md](./nvidia-ngc-listing.md). |

---

## Media & Content Partners

| Partner | Status | Links |
|---|---|---|
| **IBM Community** | Live | [Embodied, Intelligent, and Self-Custodied: three.ws and the 3D AI Agent Stack](https://community.ibm.com/community/user/blogs/nich8/2026/06/08/3d-ai-web3-just-converge-threews-shipped-the-whole) — IBM Community blog covering the convergence of 3D, AI agents, and web3 in the three.ws stack. |
| **HackerNoon** | Live | [hackernoon.com/u/three-ws](https://hackernoon.com/u/three-ws) — three.ws posts auto-import from the RSS feed. Announcement: [three.ws Partners with HackerNoon](/news/partnered-with-hackernoon) |
| **Alibaba Cloud Marketplace Blog** | Live | [Editorial feature](https://marketplace.alibabacloud.com/doc/blog/detail/mplace-sgcmfw00036800.html) — Alibaba Cloud Marketplace published an editorial introducing three.ws. Announcement: [three.ws Featured on the Alibaba Cloud Marketplace Blog](/blog/three-ws-featured-on-alibaba-cloud-marketplace-blog) |
| **pump.fun** | Live | [Three Builds With Tech Giants](https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump/article): a feature article published on the official $THREE coin page, profiling the platform's browser-native 3D AI agents with onchain identities, the Animations and Poses Studio, the 3D Studio MCP server, and the AWS and IBM milestones. |

### pump.fun verification

$THREE is a verified project on pump.fun. Verification is pump.fun's own statement that the coin at `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump` belongs to three.ws, which is what separates the real token from the copies that share its name and ticker.

three.ws never hardcodes that claim. `GET /api/three-token/stats` reads pump.fun's public coin record on every (5-minute cached) request and returns the live flag on the token block:

```json
{
  "token": {
    "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
    "symbol": "$THREE",
    "verified": true,
    "verified_source": "pumpfun",
    "pump_url": "https://pump.fun/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump"
  }
}
```

`verified` has three states, and callers should treat them differently:

| Value | Meaning | What the UI does |
|---|---|---|
| `true` | pump.fun publishes the badge right now | Render the badge |
| `false` | pump.fun publishes no badge | Render nothing |
| `null` | pump.fun could not be reached this request | Render nothing |

The badge itself is one shared component ([src/pump/verified-badge.js](../src/pump/verified-badge.js)), so the public [/three-token](/three-token) page and the [/dashboard/three-token](/dashboard/three-token) holder view can never disagree about whether the coin is verified. If pump.fun ever withdraws verification, the badge disappears on the next stats read with no deploy.

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
- **News index**: [`https://three.ws/news`](https://three.ws/news)
- **Blog** — [`https://three.ws/blog/`](https://three.ws/blog/)

Subscribe via RSS to track new listings, integrations, and protocol updates.

---

## Related

- [AWS Marketplace](/docs/aws-marketplace): the AWS listing and entitlement-issued x402 API keys
- [Syndication](/docs/syndication): how announcements flow to HackerNoon and other channels
- [x402 protocol](/docs/x402): the payment rail behind the paid endpoints these listings distribute
- [Introduction](/docs/introduction): the full technical picture of the platform being listed
