# AWS Marketplace Listing — three.ws

Reference for the AMMP "Create new SaaS product" form. Path = free SaaS subscription (zero metering), shortest route to a public seller profile page.

## Strategy

- **Product type:** SaaS Subscription
- **Pricing:** Free tier — single $0.00 dimension. No tax/banking blockers, fastest AWS review.
- **EULA:** AWS Standard Contract for Marketplace (SCMP). Custom EULAs add weeks of legal review — only switch later when revenue justifies it.
- **Fulfillment:** Existing endpoints in `api/aws-marketplace/` ([register.js](../../api/aws-marketplace/register.js), [subscription.js](../../api/aws-marketplace/subscription.js), [link.js](../../api/aws-marketplace/link.js)). No new code required.
- **Goal:** Public seller profile live on `aws.amazon.com/marketplace/seller-profile?id=...`. Paid tiers added later as separate products on the same seller account.

## Listing copy

### Product title
`three.ws — Open-Source 3D AI Agent Platform`

### Short description (110 char hard limit)
`Create, embed, and register 3D AI agents on EVM and Solana. WebGL-native, LLM-driven, embed anywhere.`

### Long description (paste verbatim)

three.ws is an open-source platform for creating, embedding, and owning 3D AI agents. Drop a glTF or GLB model into the browser, attach an LLM brain, and the agent renders instantly in WebGL with full PBR materials, animations, and morph-target emotion blending. No plugins, no server-side processing.

The agent runtime is built around Anthropic's Claude. A structured tool-loop architecture gives agents native gestures (wave, look-at, play-clip), emotion expression, memory, and an extensible skill system. Skills are self-contained bundles loaded from IPFS, Arweave, or HTTP — anyone can author and distribute new agent capabilities.

Every agent can be registered on-chain for a permanent, verifiable identity:
- **EVM:** ERC-8004 token with IdentityRegistry, ReputationRegistry, and ValidationRegistry contracts
- **Solana:** Metaplex Core asset with SPL Memo–anchored reputation and validation attestations

Agents distribute as the `<agent-3d>` web component — drop one element into any page, no framework dependency. Five widget variants ship out of the box: turntable, animation gallery, talking agent, on-chain passport card, and hotspot tour. The platform also includes Widget Studio, an Embed Editor, and oEmbed support for rich social previews.

three.ws includes a full OAuth 2.1 authorization server, Model Context Protocol (MCP) endpoint over JSON-RPC, and x402 payment integration so agents can transact autonomously in USDC across Base, BSC, and Solana.

The entire stack — viewer, agent runtime, identity contracts, backend, and web component — is open source under Apache 2.0. Production deployment runs at three.ws on AWS `us-east-1`.

**Use cases:** AI-powered customer support avatars on any website; embedded 3D characters for entertainment, education, and games; on-chain agent identity for autonomous economic actors; programmatic 3D presence for AI systems via MCP.

### Highlights (3 bullet points, ~30 chars each)
- Browser-native 3D AI agents — no installs
- On-chain identity on EVM + Solana
- Embed anywhere with one `<agent-3d>` tag

### Categories
Primary: **AI Agents & Tools**
Secondary: **Generative AI**, **Machine Learning** → **Computer Vision**, **Software Development**

### Search keywords
`AI agent, 3D, avatar, LLM, Claude, web component, embed, glTF, GLB, three.js, WebGL, Solana, EVM, ERC-8004, Metaplex, MCP, OAuth, x402, agent runtime, open source`

### Resources / links
- **Product website:** `https://three.ws`
- **Documentation:** `https://three.ws/docs`
- **Source code:** `https://github.com/nirholas/three.ws`
- **Support contact:** `support@three.ws`

### Media assets to upload
| Asset | Spec | Source |
|---|---|---|
| Product logo | PNG, 110×110, transparent | three.ws favicon/logo asset |
| Hero image | PNG/JPG, 1200×630 | `public/screenshots/viewer.png` |
| Screenshot 1 | 1200×800 | `public/screenshots/viewer.png` |
| Screenshot 2 | 1200×800 | `public/screenshots/studio.png` |
| Screenshot 3 | 1200×800 | `public/screenshots/discover.png` |
| Screenshot 4 | 1200×800 | `public/screenshots/create.png` |
| Demo video | YouTube, 60–90s | README hero video |

## Pricing model

**Single dimension, $0.00:**

| Dimension API name | Display name | Unit | Price |
|---|---|---|---|
| `community_edition` | Community Edition | Subscription | $0.00 / month |

This is a free SaaS subscription. AWS still requires a dimension, but `community_edition` priced at $0 keeps the listing free and skips banking/tax verification gates.

## Fulfillment configuration

**Fulfillment URL:** `https://three.ws/aws-marketplace/welcome`

This matches the existing handler at [src/aws-marketplace-welcome.js](../../src/aws-marketplace-welcome.js) and the page route at [pages/aws-marketplace/welcome](../../pages/aws-marketplace).

**Registration flow** (already implemented):
1. Buyer clicks Subscribe in AWS Marketplace → AWS POSTs `x-amzn-marketplace-token` (form-encoded) to the fulfillment URL
2. [api/aws-marketplace/register.js](../../api/aws-marketplace/register.js) receives token, calls `ResolveCustomer` via [api/_lib/aws-marketplace.js](../../api/_lib/aws-marketplace.js#L49), upserts row in `aws_marketplace_customers`
3. Buyer redirected to `/aws-marketplace/welcome` to link an existing three.ws account or create a new one
4. [api/aws-marketplace/link.js](../../api/aws-marketplace/link.js) sets `user_id` on the customer row

**Subscription lifecycle** (SNS):
1. AWS sends SNS notifications on subscribe-success, subscribe-fail, unsubscribe-pending, unsubscribe-success
2. [api/aws-marketplace/subscription.js](../../api/aws-marketplace/subscription.js) verifies signature via [verifySnsMessage](../../api/_lib/aws-marketplace.js#L141) (real cert fetch, hostname pinned to `*.amazonaws.com`, topic ARN check)
3. Updates `subscription_status` in `aws_marketplace_customers`

## Required AWS-side resources

The free listing still needs these provisioned in the seller AWS account before AMMP will accept the listing. The provisioning script in [scripts/aws-marketplace-provision.sh](../../scripts/aws-marketplace-provision.sh) creates all of them idempotently:

```bash
# Configure aws CLI with admin creds on the seller account first
bash scripts/aws-marketplace-provision.sh
```

The script:
1. Creates SNS topic `three-ws-marketplace-subscription` in `us-east-1`
2. Applies a topic policy allowing `aws-marketplace.amazonaws.com` to publish (scoped to the seller account via `aws:SourceAccount`)
3. Creates IAM user `three-ws-marketplace` with an inline policy granting the four required `aws-marketplace:*` actions
4. Issues an access key pair for that user

Output is printed at the end in Vercel env-var format, ready to paste.

### Product code

The script does **not** create the product code — AMMP assigns it when the SaaS product is created in the portal. After creating the product, copy the code into Vercel env as `AWS_MP_PRODUCT_CODE`. Used by `meterUsage` and `getEntitlements` in [api/_lib/aws-marketplace.js](../../api/_lib/aws-marketplace.js).

### Database migration

The customer + metering tables are defined in [api/_lib/migrations/2026-05-26-aws-marketplace-customers.sql](../../api/_lib/migrations/2026-05-26-aws-marketplace-customers.sql). Apply with:

```bash
npm run db:migrate
```

This must be run against the production Neon database **before** the limited listing is exercised end-to-end, otherwise `register.js` and `subscription.js` will 500 on first request.

## Future paid tiers (do not list yet)

Add as separate products on the same seller account once the free listing is public and the seller profile is live. Drafted here so the copy is ready when revenue motion kicks in.

### Pro — $99 / month per agent

**Title:** `three.ws Pro — Production 3D AI Agents`
**Short:** `Production hosting, voice cloning, on-chain identity, and priority support for embedded 3D AI agents.`
**Dimensions:**
| API name | Display | Unit | Price |
|---|---|---|---|
| `agent_seat` | Active agent | Per agent / month | $99.00 |
| `voice_clone_minutes` | Voice cloning | Per minute synthesized | $0.05 |
| `inference_tokens` | LLM tokens | Per 1M output tokens | $8.00 |

### Enterprise — Contract pricing

**Title:** `three.ws Enterprise — Self-Hosted 3D AI Agent Platform`
**Short:** `Self-hosted three.ws deployment with private LLM routing, SSO, audit logs, and dedicated support.`
**Pricing model:** SaaS Contracts (annual, custom-quoted via private offer). No metering — entitlement-checked via `getEntitlements`.

When adding these, the integration code in [api/_lib/aws-marketplace.js](../../api/_lib/aws-marketplace.js) already supports both metered (`meterUsage`) and contract (`getEntitlements`) flows. No code changes required, just new product codes added to env.

## Submission checklist

Before clicking "Submit for review" in AMMP:

- [ ] Migration applied: `npm run db:migrate` against production Neon
- [ ] Provisioning script run: `bash scripts/aws-marketplace-provision.sh` (creates SNS topic + IAM user + keys)
- [ ] All four Vercel env vars set: `AWS_MP_ACCESS_KEY_ID`, `AWS_MP_SECRET_ACCESS_KEY`, `AWS_MP_REGION=us-east-1`, `AWS_MP_SNS_TOPIC_ARN`
- [ ] Seller registration complete in AMMP (tax interview + bank account verified)
- [ ] Public seller profile saved (name "three.ws", logo, description, website)
- [ ] Listing copy pasted from the sections above
- [ ] Logo + 4 screenshots + demo video uploaded
- [ ] Categories + keywords selected
- [ ] Fulfillment URL set to `https://three.ws/aws-marketplace/welcome`
- [ ] Pricing: single `community_edition` dimension at $0.00
- [ ] EULA: AWS Standard Contract for Marketplace selected
- [ ] Support contact: `support@three.ws`
- [ ] After product creation: copy assigned product code into `AWS_MP_PRODUCT_CODE` in Vercel

## Review flow

1. AMMP creates a **limited product** (private, only your test account can subscribe)
2. Run end-to-end test: subscribe from a separate AWS account → token POSTs to register endpoint → SNS subscribe-success arrives at subscription endpoint → buyer lands on `/aws-marketplace/welcome` → account links
3. Submit for **public publication** with link to successful limited test
4. AWS reviews copy, EULA, integration health — typical 5–10 business days
5. On approval, public seller profile page goes live automatically

Once live, the seller profile URL is `https://aws.amazon.com/marketplace/seller-profile?id=<seller-id>` — that's your public sellers page.
