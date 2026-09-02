# Partner ecosystem

`three.ws/partners` is the public map of the cloud, AI, hardware, infrastructure, and media programmes three.ws takes part in. This doc is the developer-facing companion to that page: for each surface it says what the integration actually **is**, at the status the page and the per-partner docs claim, and links the doc that goes deeper.

Page source: [`pages/partners.html`](../pages/partners.html). Partnership enquiries go to **partners@three.ws** (the page's "Become a partner" call to action). Press and brand requests go to **partnerships@three.ws**, covered in [Press kit](./press-kit.md).

**Read the status labels literally.** Each card carries a one-word tier chip that is a category, not a rank: Select Partner, Strategic, Cloud, Inception, Media, Infrastructure. Nothing on the page grants an endorsement, and several of the docs below carry explicit "this is not an endorsement" language that must survive any rewrite.

---

## The eight cards, in page order

| Partner | Chip on the card | Card links to | Deeper docs |
|---|---|---|---|
| OpenAI | Select Partner | `/openai` | [MCP 3D Studio (free)](./mcp-studio.md), [3D Studio (paid)](./mcp-3d-studio.md), [Custom GPT config](./chatgpt-3d-studio-gpt.md), [AR in ChatGPT](./chatgpt-ar.md), [Spatial MCP](./spatial-mcp.md) |
| IBM | Strategic | `/blog/three-ws-ibm-business-partner` | [IBM watsonx and Granite](./ibm.md), [IBM Granite x402 MCP](./ibm-x402-mcp.md) |
| Amazon Web Services | Cloud | `/aws` | [AWS Marketplace](./aws-marketplace.md), [listing kit](./aws-marketplace-listing-kit.md), [partner spotlight](./aws-partner-spotlight.md) |
| Google Cloud | Cloud | `/blog/three-ws-google-cloud-partnership` | [Production runbook](./ops/gcp-production.md), [credits plan](./ops/gcp-credits-plan.md), [model workers](./ops/gcp-model-workers.md) |
| Alibaba Cloud | Cloud | `/blog/three-ws-alibaba-cloud-partnership` | [Listings and distribution](./listings.md), [the model router](./brain.md) |
| NVIDIA | Inception | `/nvidia` | [NVIDIA Inception](./nvidia-inception.md), [NVIDIA models](./nvidia-models.md), [Nemotron spotlight](./nvidia-nemotron-spotlight.md) |
| HackerNoon | Media | `/blog/three-ws-hackernoon-partnership` | [Syndication](./syndication.md), [Listings and distribution](./listings.md) |
| Quicknode | Infrastructure | `/blog/three-ws-quicknode-startup-program` | [Solana integration](./solana.md), [Listings and distribution](./listings.md) |

The page's stat bar reads 8 partners, 22 chains, and an infinity glyph for scale. It is marked `aria-hidden` and is decorative framing, not a metric to quote.

---

## OpenAI

**What the page claims.** three.ws is an OpenAI Select Partner in the OpenAI Partner Network. The free three.ws 3D Studio connector gives ChatGPT nine keyless 3D tools: text to model, rigged avatars, conversational refinement, and a living agent body, all rendered interactively inline in the conversation. Card tags: Apps SDK, MCP, Custom GPT, Spatial MCP.

**What the integration is.**

- **The keyless connector** at `https://three.ws/api/mcp-studio` is a free MCP server exposing only 3D generation tools: no account, no payment, no API key, no wallet, no token. That is the surface submitted to the ChatGPT App Directory. See [MCP 3D Studio](./mcp-studio.md).
- **The paid sibling** at `https://three.ws/api/mcp-3d` is a separate server with rigging, animation, retexturing, and analysis, authenticated by OAuth 2.1 or paid per call over x402. It shares none of the keyless server's surface. See [3D Studio MCP](./mcp-3d-studio.md).
- **The custom GPT** in the GPT Store calls an Actions contract served from `/.well-known/3d-studio-openapi.yaml`. Its builder configuration is checked in, because the GPT itself is configured by hand: [Custom GPT config](./chatgpt-3d-studio-gpt.md).
- **AR handoff** works from any of these: every generation carries a place-in-your-room link, and the whole pipeline is public and keyless rather than ChatGPT-exclusive. See [AR in ChatGPT](./chatgpt-ar.md).
- **Spatial MCP** is the open, CC0 response shape that makes a 3D scene a native MCP result instead of a URL in text. three.ws is the reference implementation; the shape is renderer-agnostic and carries no payment, wallet, or coin surface. See [Spatial MCP](./spatial-mcp.md).

**Saying it correctly.** Write the status as "OpenAI Select Partner". three.ws is an independent member of the network at the Select tier: not an OpenAI product, and not endorsed by OpenAI beyond the partner designation. Badge rules, the required independence line, and every asset are in [`marketing/openai-select-partner/badge-usage.md`](../marketing/openai-select-partner/badge-usage.md); the graphics cleared for editorial use are in [Press kit](./press-kit.md). The pre-submission verification pack is [`prompts/finish/openai-pr-00-START-HERE.md`](../prompts/finish/openai-pr-00-START-HERE.md).

---

## IBM

**What the page claims.** three.ws 3D agent identity and x402 payment rails integrate with IBM watsonx and IBM Granite. Agents run enterprise AI models while maintaining on-chain identity and executing real micropayments, all from a single agent profile. Card tags: watsonx.ai, Granite, x402, MCP.

**What the integration is.** Agents can think on IBM Granite foundation models served through IBM watsonx.ai, using your own IBM Cloud credentials. On top of that runtime sit the Granite-backed API surfaces (avatar brain, Guardian trust layer, TimeSeries forecasting, digital twin, semantic discovery, vision) and an MCP server, all documented in [IBM watsonx and Granite](./ibm.md). [IBM Granite x402 MCP](./ibm-x402-mcp.md) covers the pay-per-call path: an MCP client reaches Granite inference and settles per call in stablecoin from a wallet it already controls, with no IBM Cloud account of its own.

**The caveat that must not be dropped.** [`docs/ibm.md`](./ibm.md) states it plainly: three.ws is an IBM Business Partner, but the public showcase is not the partnership. The `/api/ibm/*` tools are an independent set of developer tools built on IBM's publicly available Granite models. They are not official IBM partnership deliverables, not IBM products, and not endorsed by IBM. The formal partnership work is being built on the IBM platform and is not yet public. Never present the public demos as that work.

Live product surfaces: `three.ws/ibm/hello` (the partnership page) and `three.ws/ibm/x402-demo` (the x402 live demo).

---

## Amazon Web Services

**What the page claims.** Deployed on AWS infrastructure with Marketplace availability. Enterprises can provision three.ws agent capabilities directly through their existing AWS billing, with support for VPC deployment and IAM-integrated access control. Card tags: Marketplace, EC2, IAM. The card's link label reads "View on AWS Marketplace" and points at `/aws`.

**What the integration is.** The AWS Marketplace SaaS contract is implemented and deployed: a fulfillment endpoint that exchanges the marketplace token for a customer identifier via `ResolveCustomer`, a signature-verified SNS webhook for subscribe and unsubscribe lifecycle events, account linking after the post-subscribe redirect, and daily metering plus entitlement checks. The subscription itself is a free front door: it links an AWS account to a three.ws account and issues an x402 access key, and usage is then paid per call in stablecoin over x402. AWS Marketplace does not meter or bill the usage. Code lives in `api/aws-marketplace/` and `api/_lib/aws-marketplace.js`; the reference is [AWS Marketplace](./aws-marketplace.md).

**Status wording differs across surfaces, so quote the surface you are on.**

- The `/partners` card says "Marketplace availability".
- The `/aws` page badge says "AWS Partner, Software Path" and its hero says "Marketplace listing coming soon".
- [`docs/listings.md`](./listings.md) records AWS Marketplace as Live and three.ws as an AWS Partner.
- [`docs/aws-marketplace-listing-kit.md`](./aws-marketplace-listing-kit.md) says the backend integration is built and deployed but the listing itself has not yet been created in the AWS Marketplace Management Portal.

Do not resolve that spread by picking the strongest claim. If you need one sentence, the safe one is the one the product page uses: three.ws is an AWS Partner, and the Marketplace listing is coming. Longer-form pieces written for AWS channels are [partner spotlight](./aws-partner-spotlight.md), [MCP agents](./aws-builder-center-mcp-agents.md), and [Marketplace metering in front of x402](./aws-builder-center-marketplace-x402.md).

---

## Google Cloud

**What the page claims.** Google Cloud powers three.ws inference, storage, and real-time serving at global scale. Vertex AI integration lets agents leverage Gemini models alongside the three.ws identity and payment layer. Card tags: Vertex AI, Gemini, Cloud Run.

**What the integration is.** Production runs on Google Cloud: one Cloud Run service serves the static frontend, the route table, and every API handler, with the crons on Cloud Scheduler and the GPU model workers on their own services. Vertex AI provides the Gemini and image lanes. The operational detail is in [production runbook](./ops/gcp-production.md), [fleet and quota plan](./ops/gcp-credits-plan.md), and [model workers](./ops/gcp-model-workers.md).

**Programme status.** [`docs/listings.md`](./listings.md) records three.ws as a **member of Google Cloud for Web3 Startups**, with the programme backing compute and Vertex AI usage, and records Google Cloud Marketplace separately as **open to partnership** (no listing yet). The page card describes the technical dependency, not a marketplace listing; keep those two apart.

---

## Alibaba Cloud

**What the page claims.** Alibaba Cloud extends three.ws into APAC markets with Qwen model integration and regional MCP server deployment. three.ws agents reach global audiences with low-latency inference close to users in Asia. Card tags: Qwen, MCP, APAC.

**What the integration is.** Qwen models are first-class lanes in the platform's multi-model brain router (`/api/brain/chat`), reached through DashScope alongside the other providers, so an agent can be pointed at a Qwen model the same way it is pointed at any other. See [the agent brain](./brain.md) for the router and the model ids.

**Listing status.** [`docs/listings.md`](./listings.md) records the Alibaba Cloud International Marketplace listing as **Live**, with a product listing, a storefront, and an editorial feature published on the Alibaba Cloud Marketplace blog. That doc holds the canonical links; treat it as the source of truth rather than restating URLs here.

---

## NVIDIA

**What the page claims.** three.ws is a member of NVIDIA Inception, NVIDIA's program for startups building on accelerated computing. Every 3D generation lane already runs on NVIDIA silicon: text to 3D, photo to avatar, auto-rigging, and motion capture, plus the free hosted NIM lane behind the forge. Card tags: NIM, Inception, GPU.

**What the integration is.** Two distinct things, and the docs keep them distinct:

- **Inception membership**, accepted July 2026. [NVIDIA Inception](./nvidia-inception.md) states what membership adds (GPU credits, hardware access, engineering support) and where it shows up in the product.
- **The free hosted inference lane.** A large share of platform AI runs on NVIDIA-hosted models unlocked by a single `NVIDIA_API_KEY`, a rate-limited free tier with no per-model billing and no SLA, which is why the platform always keeps a fallback behind it. [NVIDIA models](./nvidia-models.md) is the canonical map of which model does what and where it is wired. Membership does not change that lane; it is how the platform scales past free-tier limits without giving up the free-first design.

[Nemotron spotlight](./nvidia-nemotron-spotlight.md) is a published community piece on building the text-to-3D pipeline on NIM. It is a developer-blog showcase, not a partnership document.

---

## HackerNoon

**What the page claims.** A builder-focused publishing partnership: feature articles, tutorials, and developer guides for people shipping with AI, published to HackerNoon's developer audience. Card tags: Publishing, Developer content.

**What the integration is.** Mechanical, and worth knowing if you write posts here: HackerNoon auto-imports from `https://three.ws/rss/announcements.xml`, polls roughly hourly, pulls every new item into the drafts queue, and publishes with canonical URLs pointing back to three.ws. There is no per-post action. Setup steps and the author-profile claim flow are in [Syndication](./syndication.md); the listing row is in [Listings and distribution](./listings.md).

---

## Quicknode

**What the page claims.** three.ws is a member of the Quicknode Startup Program with approved infrastructure credits. Quicknode's globally distributed RPC endpoints add capacity and redundancy to the chain access behind agent wallets, x402 settlement verification, and live Solana market data. Card tags: Solana RPC, Streams, Multi-chain. [`docs/listings.md`](./listings.md) records the programme as **accepted (2026-07)** with approved free infrastructure credits.

**What the integration is.** A rung in the Solana RPC failover chain, not the whole chain. Server-side calls build a chain across an explicit primary, keyed providers, operator-supplied fallbacks, keyless public endpoints, and a paid reserve tried last, rotating past anything rate-limited. [Solana integration](./solana.md) documents it, including the trap that matters operationally: never name the same endpoint as both the primary and the last-resort reserve, because the chain dedupes by URL and keeps the first occurrence, so the "reserve" silently absorbs all traffic.

---

## What the page does not claim

Worth stating, because partner claims drift upward when nobody writes the boundary down:

- **No Intel, Microsoft, or Oracle programme appears on `/partners`.** [`docs/listings.md`](./listings.md) records Microsoft Azure Marketplace as **on roadmap**. Third-party model or component names that appear in the stack (for example the image-to-3D backends listed in [3D Studio MCP](./mcp-3d-studio.md)) are technical dependencies, not partnerships.
- **No tier is claimed beyond the chips on the cards.** "Strategic", "Cloud", "Media", and "Infrastructure" are groupings three.ws chose for its own page. Only two named programme statuses come from the partner: OpenAI Select Partner, and NVIDIA Inception member.
- **No endorsement is claimed anywhere.** OpenAI, IBM, and NVIDIA all carry explicit independence language in their docs. Reproduce it.

---

## Why partner with three.ws

The page closes with four reasons, useful as the short pitch when someone asks: global distribution to developers and enterprises building AI agents; a verifiable on-chain identity for every agent; x402 payments so partners can monetise API surface through agent-to-agent micropayments; and a first-class MCP server that agents can discover and call natively inside three.ws. The page's own next steps are `partners@three.ws` and `/integrations`.

---

## Related

- [Press kit](./press-kit.md): marks, announcement graphics, boilerplate, and the rules for all of it
- [Listings and distribution](./listings.md): marketplaces, ecosystem directories, and media partners with per-listing status
- [Integrations](./integrations.md): the catalog of ways to put an agent on a site you do not control
- [x402](./x402.md): the payment rail behind the agent-to-agent micropayments every partner surface references
