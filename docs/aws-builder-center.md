# three.ws on the AWS Builder Center

The [AWS Builder Center](https://builder.aws.com) is Amazon's community publishing platform for engineers building on AWS. three.ws publishes there under the official organization account, [**@threews**](https://builder.aws.com/community/@threews), as part of our AWS Partner Network membership.

This page is the index of that writing: what is published, where it lives, and what code each article documents. If you are adding an article, the checklist at the bottom is the process.

- **Profile:** [builder.aws.com/community/@threews](https://builder.aws.com/community/@threews)
- **Account:** organization account, byline "three.ws"
- **Related surfaces:** [three.ws/aws](https://three.ws/aws) (AWS Partner page), [AWS Marketplace listing](./aws-marketplace.md), [AWS partner spotlight](./aws-partner-spotlight.md)

## Published articles

### 1. How we metered a SaaS product through AWS Marketplace with the AWS SDK for JavaScript v3

Published 30 May 2026. Tags: `aws-payment-cryptography`, `blockchain`, `metadata`, `agent-toolkit`, `agentic-ai`.

> [Read it on the AWS Builder Center](https://builder.aws.com/content/3ESpll50BdSp9eiCEIxcfG9pGUN/how-we-metered-a-saas-product-through-aws-marketplace-with-the-aws-sdk-for-javascript-v3)

The full AWS Marketplace SaaS usage-based integration, end to end: `ResolveCustomer` on the fulfillment URL, `MeterUsage` and `BatchMeterUsage` for consumption reporting, `GetEntitlements` for tiered feature gating, and SNS lifecycle webhooks with real signature verification. It closes on the part nobody else writes about: bridging an AWS `CustomerIdentifier` into the same access check that already served an on-chain [x402](./autonomous-x402.md) paywall, so one authorization path bills two economies.

- **Source draft in this repo:** [aws-builder-center-marketplace-x402.md](./aws-builder-center-marketplace-x402.md)
- **Code it documents:** [`api/aws-marketplace/`](https://github.com/nirholas/three.ws/tree/main/api/aws-marketplace), [`api/_lib/aws-marketplace.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/aws-marketplace.js), [`api/_lib/aws-marketplace-bridge.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/aws-marketplace-bridge.js)
- **Since publication:** on 2026-08-17 the integration moved to the updated SaaS integration AWS made mandatory for new products. `ResolveCustomer` now returns `CustomerAWSAccountId` + `LicenseArn` rather than a `CustomerIdentifier`, so the store keys buyers by license ARN (`api/_lib/aws-marketplace-store.js`) and the x402 bridge joins on the customer row id, with `CustomerIdentifier` kept only as a legacy lookup. Lifecycle notifications arrive as EventBridge agreement and license events; the SNS webhook path the article describes is still accepted and still signature-verified. [aws-marketplace.md](./aws-marketplace.md) is the current reference; the article stays accurate for the SDK calls it walks through.
- **Announcement:** [three.ws Publishes on the AWS Builder Center Blog](https://three.ws/news/aws-builder-center-blog)

### 2. Build Autonomous AI Agents with 3D Bodies and On-Chain Payments | three.ws on AWS

Published 27 June 2026. Tags: `ai`, `agent-toolkit`, `blockchain`, `aws-partners`, `multi-agent-orchestrator`.

> [Read it on the AWS Builder Center](https://builder.aws.com/content/3FMY7S5o4lwzb40gDsCJRCE20cX/build-autonomous-ai-agents-with-d-bodies-and-on-chain-payments-threews-on-aws)

The platform-level piece: browser-native 3D AI agents with memory, on-chain wallets, and autonomous payments, available on AWS Marketplace, embeddable in one line of HTML, and governed before they act. Written for AWS builders evaluating three.ws as an agent runtime rather than as a 3D asset tool.

- **Surfaces it covers:** [the `<agent-3d>` web component](./web-component.md), [agent wallets](./agent-wallets.md), [the agent system](./agent-system.md), [AWS Marketplace procurement](./aws-marketplace.md)

## Published by AWS about three.ws

Articles written by AWS staff, not by us. These are not our byline and we do not control their content; they are recorded here because they are the strongest third-party evidence of the integration.

### The Agentic Economy Is Here: x402, MCP, AI Agents, Crypto, and 3D Worlds Converging | AWS Strategic Partnerships

Published 26 June 2026 by Kelly Wu (AWS). Part of the AWS-run series "AWS Partners with three.ws | AWS Strategic Partnerships". Tags: `aws-partners`, `aws-service-catalog`, `agentic-economy`, `x402`, `model-context-protocol`.

> [Read it on the AWS Builder Center](https://builder.aws.com/content/3FgvJFVKstRLVicHsldLM7ba4qB/the-agentic-economy-is-here-x-mcp-ai-agents-crypto-and-d-worlds-converging-aws-strategic-partnerships)

A builder's guide to the agentic economy that uses the three.ws stack as its worked example throughout: the x402 handshake and its three layers, MCP as the distribution layer for agent capabilities, agent-to-agent payments, on-chain agent identity (ERC-8004 and the SPL skill licenses), agent tokens on the bonding curve, and 3D embodiment. It walks the hosted MCP servers, the `@three-ws/*` payment SDKs, and the FSI use cases for per-call data access, and closes on the open problems: payment streaming, automatic cross-chain routing, agent reputation as a credit primitive, and org-scale spend governance.

- **Surfaces it covers:** [the MCP servers](./mcp.md), [x402](./autonomous-x402.md), [agent wallets](./agent-wallets.md), [the `<agent-3d>` web component](./web-component.md)
- **Canonical URL note:** the Builder Center strips digits from slugs, so `x402` becomes `x` and `3d` becomes `d` in the path. The URL above is the one AWS publishes in its own [sitemap](https://builder.aws.com/sitemaps/articles/2026-6.xml); a slug containing the digits also resolves, because the content ID is what routes.

## In draft

Written and reviewed in this repo, not yet submitted:

| Draft | Subject |
|---|---|
| [aws-builder-center-agent-payment-sessions.md](./aws-builder-center-agent-payment-sessions.md) | Agent Payment Sessions: giving an agent a budget instead of a private key, and enforcing it atomically in Postgres |
| [aws-builder-center-mcp-agents.md](./aws-builder-center-mcp-agents.md) | An MCP server whose paid tools settle per call in USDC over HTTP 402 |

## Publishing checklist

The Builder Center editor accepts Markdown, so a draft in `docs/` is the article. To take one from draft to published:

1. **Write the draft as `docs/aws-builder-center-<topic>.md`** with the frontmatter block the existing drafts use (`title`, `venue`, `account`, `description`, `tags`). Every code sample must be real code from this repo, and every claim must be verifiable against it. The Builder Center audience reads the linked source.
2. **Check the rules:** `npm run check:rules -- --paths docs/aws-builder-center-<topic>.md`.
3. **Check the links:** `npm run audit:docs`.
4. **Publish** from [builder.aws.com/create/content](https://builder.aws.com/create/content) using the official account, pasting the Markdown body and setting the tags from the frontmatter.
5. **Record the canonical URL** by adding a section to this page: title, publish date, tags, the live URL, the source draft, and the code it documents.
6. **Announce it** by adding an item to `data/rss/items.json` (the curated news feed) with the canonical Builder Center URL as `link`, then regenerate with `npm run build:news`. The item becomes a page under `/news/<slug>` and enters the RSS feed automatically.
7. **Log it** in `data/changelog.json` with the `docs` tag.

## Why we publish here

The Builder Center is where AWS customers evaluating a partner product go looking for evidence that the engineering is real. A marketing page claims an integration exists; a walkthrough of the exact SDK calls, the signature-verification pitfalls, and the failure modes proves it. Every article we publish there points at readable source in [this repository](https://github.com/nirholas/three.ws), so a reader can check the claim in the same sitting.
