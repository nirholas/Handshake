# AWS Marketplace — AI Agents & Tools Listing Kit (three.ws / x402)

Paste-ready content and the exact step sequence to create the **AI agents & tools**
product in the AWS Marketplace Management Portal (AMMP). The backend integration
(register URL, SNS webhook, key issuance, account linking) is already built and
deployed — see [aws-marketplace.md](./aws-marketplace.md). This doc covers the
listing itself, which has not yet been created (the AMMP "AI agents & tools
products" page shows "No products to display").

> **Backend blockers cleared 2026-08-17.** The four defects that would have failed
> the subscribe round-trip (identity keyed on the retired `CustomerIdentifier`,
> the orphan SNS topic pin, hardcoded SHA1 SNS verification, and the missing
> EventBridge transport) are fixed and covered by tests. The listing is now
> gated only on AWS-console work and Seller Operations review. The evidence
> behind each fix is in "Verified against AWS docs" and "Defects and their
> fixes" at the bottom of this file.

- **Seller account:** three-ws @ 155407237916
- **Delivery method:** API-based (SaaS fulfillment) — **not** container/Bedrock
  AgentCore. The whole backend is SaaS-style (ResolveCustomer + SNS + entitlements),
  so choose the API path. Container listings require Bedrock AgentCore and different infra you don't have.
- **Pricing decision:** **Free** AWS Marketplace listing — usage is priced the **same
  as all other x402 endpoints**. The AWS subscription is a free front door: subscribing
  links the AWS customer to a three.ws account and issues an x402 key
  (`/api/aws-marketplace/issue-key`). Every actual API call is then paid per-call in
  USDC over the x402 / HTTP 402 protocol, identical to a non-AWS caller. AWS Marketplace
  does **not** meter or bill usage — there are no AWS pricing dimensions. This matches the
  current EULA ("offered free of charge through AWS Marketplace") and clears AWS review
  fastest (no tax/bank/dimension interview).

> `AWS_MP_METERING_DIMENSION` and `AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE` remain in
> the code for a future usage-priced listing. Both are inert while the dimension
> is unset, which is the correct state for a free listing. [aws-marketplace.md](./aws-marketplace.md)
> documents them as optional rather than as the billing model.

---

## Prerequisites (run where your seller AWS creds live — NOT in this codespace)

This codespace has no AWS credentials, so these must be run on a machine with
admin creds on account 155407237916.

### 1. Provision the IAM user and the EventBridge relay

```bash
./scripts/aws-marketplace-provision.sh
```

It creates, idempotently:

- the IAM user `three-ws-marketplace` plus the four marketplace actions and an
  access key. `resolveCustomer()` in `api/_lib/aws-marketplace.js` calls
  `aws-marketplace:ResolveCustomer`; without those keys every subscribe redirect
  dies at `/aws-marketplace/error?reason=token_expired`.
- an EventBridge **connection** holding a generated shared secret, an **API
  destination** pointing at `https://three.ws/api/aws-marketplace/subscription`,
  an IAM role EventBridge assumes to invoke it, an SQS dead-letter queue, and a
  **rule** on the default event bus matching `source: aws.agreement-marketplace`.

The relay is required because lifecycle events for a new listing arrive on
EventBridge, which cannot POST to an external HTTPS endpoint directly. **The
seller never supplies an SNS topic ARN**, and there is no field in the SaaS
wizard for one: AWS creates and owns the notification topics and hands them over
on the product overview page *after* product creation, in the form
`arn:aws:sns:us-east-1:<aws-owned-account>:aws-mp-subscription-notification-<PRODUCTCODE>`.
See [Amazon SNS notifications for SaaS products](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html).

Take `AWS_MP_ACCESS_KEY_ID`, `AWS_MP_SECRET_ACCESS_KEY`, `AWS_MP_REGION`, and
`AWS_MP_EVENT_SECRET` and set them on the Cloud Run service (production env lives
there, not Vercel):

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars AWS_MP_ACCESS_KEY_ID=…,AWS_MP_SECRET_ACCESS_KEY=…,AWS_MP_REGION=us-east-1,AWS_MP_EVENT_SECRET=…
```

(`--update-env-vars` merges. Never use `--set-env-vars` here: it replaces the entire
env set and would wipe every other production variable.)

`AWS_MP_PRODUCT_CODE` is assigned by AMMP after the product is created — add it last.

### 1b. Apply the schema migration

The Concurrent Agreements re-key ships as
`api/_lib/migrations/20260817120000_aws_marketplace_concurrent_agreements.sql`.
Preview with `npm run db:status`, then `npm run db:migrate` (which applies every
pending migration immediately, with no dry run). `npm run deploy:gcp:submit`
refuses to submit while it is pending, so this cannot be skipped by accident.

### 2. EULA: pick Standard Contract and skip this entirely (recommended)

The AMMP wizard accepts either the **Standard Contract for AWS Marketplace (SCMP)**
or a custom EULA at a publicly readable S3 URL. Choosing SCMP removes the only
remaining hard blocker on this listing and needs zero setup. For a free listing
there is nothing a custom EULA buys you that is worth delaying the listing for, and
the EULA can be swapped later via **Request changes → Update public offer → Update EULA**.

Only do the S3 work below if you specifically want the custom EULA on day one.

#### (Optional) Publish the EULA to public S3 (currently returns 404)

```bash
./scripts/aws-eula-publish.sh
```

As of this writing `https://three-ws-legal-155407237916.s3.amazonaws.com/aws-marketplace-eula.html`
returns **404 Not Found** — the bucket/object has never been published, so AMMP's
custom-EULA validator will reject it. The EULA IS live on the site
(`https://three.ws/legal/aws-marketplace-eula.html` → 200), but AMMP requires the S3
copy. Run the publish script, then confirm:

```bash
curl -sI "https://three-ws-legal-155407237916.s3.amazonaws.com/aws-marketplace-eula.html" | head -1
# expect: HTTP/1.1 200 OK
```

Alternative if S3 public access is blocked at the org level: in the wizard choose the
**Standard Contract for AWS Marketplace (SCMP)** instead of a custom EULA.

---

## Listing fields (paste into the AMMP "Create AI agents & tools product" wizard)

### Product title
```
three.ws — On-chain 3D AI Agents & x402 Paid API
```

### Short description (≤ 256 chars)
```
Deploy autonomous 3D AI agents that run natively in the browser, each with an on-chain identity and a wallet. A pay-per-call x402 API (HTTP 402 / USDC) for 3D model analysis, Solana token visualization, pump.fun launches, and agent reputation.
```

### Long / product description
```
three.ws is an open-source stack for autonomous 3D AI agents that run natively in
the browser. Every <agent-3d> tag deploys an agent with a Solana NFT identity
(Metaplex Core), an ERC-8004 cross-chain agent wallet, a browser-native 3D body
(WebGL via three.js), a Claude-powered brain, and native x402 / HTTP 402 payments
that settle in USDC on Base, BSC, and Solana.

The same platform exposes an agent-first paid API. Endpoints follow the x402 v2
protocol: every call returns a structured HTTP 402 challenge, the caller's wallet
or facilitator pays in USDC, and the request retries automatically. No API keys to
rotate, no monthly minimum — pay only for what you call.

Capabilities available through the API:
- 3D model analysis — fetch a glTF/GLB and return vertex/triangle counts, materials,
  textures, animations, extensions, and optimization hints.
- Solana token visualization — turn any SPL mint into a themed binary glTF (GLB),
  individually or in batches.
- pump.fun token launch — deploy a brand-new pump.fun token in one paid call; the
  service fronts the SOL deploy cost and signs the create-coin transaction, with
  optional vanity mint addresses.
- Agent analytics — reputation snapshots, pump.fun agent operational audits, and
  on-chain identity verification.
- MCP server — the same surface exposed as JSON-RPC 2.0 tools for MCP clients.

Subscribe through AWS Marketplace to manage access from your AWS account. The
product is currently offered at no charge through AWS Marketplace.
```

### Highlights (3, ≤ 500 chars each)
```
1. Browser-native autonomous agents — every <agent-3d> tag is a 3D AI agent with a Solana NFT identity, an ERC-8004 wallet, and a Claude brain. No SDK lock-in; open source.
2. Agent-first x402 paid API — pay-per-call over HTTP 402, settled in USDC on Base, BSC, and Solana. Covers 3D model analysis, token-to-mesh, pump.fun launches, and agent reputation. Also available as an MCP server.
3. Enterprise procurement on AWS — subscribe from your AWS account, no new vendor in procurement, eligible for AWS credits and EDP commitments. Currently free through AWS Marketplace.
```

### Categories (select up to 3)
```
- AI agents and tools / Developer tools
- Machine learning
- Blockchain
```

### Search keywords
```
ai agent, 3d, webgl, three.js, x402, http 402, usdc, solana, base, pump.fun, metaplex, erc-8004, mcp, glTF, GLB, claude, on-chain identity, agent payments
```

### Product logo
```
public/aws-logo-512.png  — generated 512×512 PNG, the brand mark centered on black.
Within AMMP's required square 120–640px range. Upload this as the product logo.
(Regenerate from public/pwa-icon.svg via scripts/gen-aws-logo.mjs if the brand changes.)
```

### Support / resources
```
- Support: https://github.com/nirholas/three.ws/issues
- Support email: legal@three.ws
- Website: https://three.ws
- API discovery (x402): https://three.ws/.well-known/x402.json
- OpenAPI: https://three.ws/openapi.json
- MCP endpoint: https://three.ws/api/mcp
- Docs: https://three.ws/docs/aws-marketplace.md
```

### Pricing
```
Free.  No AWS pricing dimensions, no contract, no AWS metering.
Usage is paid per-call in USDC via x402 (HTTP 402) — same as every other x402 endpoint.
The free AWS subscription only grants the x402 access key.
```

---

## SaaS fulfillment & integration fields

| AMMP field | Value |
|---|---|
| Fulfillment / SaaS URL (Registration URL) | `https://three.ws/api/aws-marketplace/register` |
| SNS notification topic ARN | Not a field you fill in. AWS hands you the notification configuration on the product overview page after the product is created. |
| EULA | **Standard Contract (SCMP)**: recommended, zero setup. Custom EULA only if the S3 copy returns 200 (see prereq #2). |
| Post-subscribe redirect | `https://three.ws/aws-marketplace/welcome` (handled by register.js) |

Lifecycle events land on `POST /api/aws-marketplace/subscription`, which is
deployed and accepts both transports: EventBridge agreement/license events
relayed through the API destination (the path a new listing uses), and legacy
signed SNS notifications with the SubscriptionConfirmation handshake.

---

## Step sequence in AMMP

Nothing in steps 3-8 depends on the IAM keys, so if creds are slow to arrive, start
the wizard anyway and backfill the env vars before the round-trip test in step 10.

1. Run prereq #1; set `AWS_MP_ACCESS_KEY_ID`, `AWS_MP_SECRET_ACCESS_KEY`,
   `AWS_MP_REGION`, and `AWS_MP_EVENT_SECRET` on the Cloud Run service.
2. Run prereq #1b (`npm run db:status`, then `npm run db:migrate`) and deploy, so
   production is serving the re-keyed schema before any buyer can reach it.
3. AMMP → **AI agents & tools products** → **Create AI agents & tools product**.
4. Delivery method: **API-based** (SaaS). (Until you finish the wizard the draft may
   appear under **SaaS products**, per AMMP's own note — that's expected.)
5. Fill product detail fields from the "Listing fields" section above; upload the logo.
6. Pricing: choose **Free**.
7. Fulfillment: paste the Registration URL from the table. There is no SNS field here.
8. EULA: select **Standard Contract**.
9. Save → AMMP assigns a **Product Code** and shows the notification configuration
   on the product overview page. Set `AWS_MP_PRODUCT_CODE` on the Cloud Run service.
   No rebuild is needed: `gcloud run services update three-ws-api --region
   us-central1 --update-env-vars AWS_MP_PRODUCT_CODE=…` cuts a new revision on its own.
10. Confirm the notification wiring against what that page actually shows. The
    EventBridge rule from prereq #1 already matches every
    `source: aws.agreement-marketplace` event, so a new listing needs nothing
    further. Only if AWS also issues the legacy
    `aws-mp-subscription-notification-<PRODUCTCODE>` topic, set
    `AWS_MP_SNS_TOPIC_ARN` to **that** ARN and add an HTTPS subscription to
    `https://three.ws/api/aws-marketplace/subscription` as a secondary leg. Then
    run one end-to-end subscribe → redirect → welcome → issue-key test from a test
    AWS account while the product is **limited**.
11. Once the private round-trip works, **Request changes → Update visibility →
    Public**. This one needs AWS Marketplace Seller Operations approval, so it is the
    step with real calendar time on it. Everything before it is same-day.

---

## What is and isn't done

Done (in repo, deployed):
- Registration URL, lifecycle webhook (EventBridge + legacy SNS), key issuance,
  account linking endpoints.
- `aws_marketplace_customers` schema, re-keyed onto `LicenseArn` for Concurrent
  Agreements, plus the x402 bridge.
- EULA HTML, S3 publish script, IAM + EventBridge provision script.
- Welcome onboarding page.
- Test coverage for the event mapping, the relay secret, the ambiguity guard, the
  metering call shape, and SNS SignatureVersion 1 and 2.

Not done (requires AWS console / seller creds — cannot be done from this repo):
- Running the provision + EULA-publish scripts (no AWS CLI/creds in codespace).
- Publishing the S3 EULA (currently 404, never uploaded; unnecessary if you pick
  the Standard Contract).
- Creating the product in the AMMP wizard (manual web UI).
- Obtaining and wiring `AWS_MP_PRODUCT_CODE`.
- The limited-visibility round-trip test and the public-visibility request.

## Calendar

There is no same-day path to a public AWS Marketplace URL. Plan against this:

| Day | Step | Owner |
|---|---|---|
| 1 | Prereqs 1 + 1b, deploy, create the product, save the draft | us |
| 1 | Product code lands, env var set, revision cuts | us |
| 1-2 | Limited-visibility round-trip test from a test AWS account | us |
| 2 | Request public visibility | us |
| +7-10 business days | Seller Operations review and publish | AWS |

---

## Verified against AWS docs (2026-08-02)

This section exists because this doc previously instructed the reader to paste a
self-created SNS topic ARN into a wizard field that does not exist. Every claim
below is cited to a primary AWS source. If you change a claim here, re-cite it.

### Claim 1: the seller never supplies an SNS topic ARN

Seven independent confirmations:

| # | Source | Evidence |
|---|---|---|
| 1 | [saas-notification](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html) | "you subscribe to the Amazon SNS topics for AWS Marketplace **provided to you during product creation**" |
| 2 | Same page, ARN format | `arn:aws:sns:us-east-1:123456789012:aws-mp-subscription-notification-PRODUCTCODE`. The name is derived from the product code, which does not exist until AWS assigns it. A seller cannot pre-create it. |
| 3 | Same page, cross-account note | "You can only **subscribe to** AWS Marketplace SNS topics from the AWS account used to sell the products." You subscribe to it; you do not own it. |
| 4 | [saas-integrate-subscription](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-integrate-subscription.html) | "Your SNS topic information was included in the **email message that you received from the AWS Marketplace Seller Operations team** when you created your product." |
| 5 | [saas-create-product](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-create-product.html) | The complete asset list a seller collects is: logo URL, EULA URL, registration URL, metadata, support info. No SNS topic. |
| 6 | [saas-product-settings](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-product-settings.html) | The exhaustive list of seller-editable fields (product info, architecture, allowlist, visibility, pricing, fulfillment URL, country, refund policy, EULA) contains no SNS field. |
| 7 | [saas-create-product](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-create-product.html) | "Your product code and Amazon EventBridge event configuration will be **available to you on the product overview page**." Notification config is an output of creation, never an input. |

Consequence: `scripts/aws-marketplace-provision.sh` creates a topic
(`three-ws-marketplace-subscription`) that has no consumer. Worse, see defect 2 below.

### Claim 2: `CustomerIdentifier` is dead for new listings

Seven independent confirmations:

| # | Source | Evidence |
|---|---|---|
| 1 | [ResolveCustomer API reference](https://docs.aws.amazon.com/marketplacemetering/latest/APIReference/API_ResolveCustomer.html) | Stated three times on the page: "For new SaaS product integrations, the `CustomerIdentifier` field is **not populated**... New integrations must use `CustomerAWSAccountId` and `LicenseArn`." |
| 2 | [saas-integrate-subscription](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-integrate-subscription.html) | Same statement, plus the June 1 2026 mandate for all new SaaS products. |
| 3 | [BatchMeterUsage API reference](https://docs.aws.amazon.com/marketplacemetering/latest/APIReference/API_BatchMeterUsage.html) | "new SaaS products must use `CustomerAWSAccountId` (instead of `CustomerIdentifier`), `LicenseArn` (instead of `ProductCode`)... `BatchMeterUsage` does not support `CustomerIdentifier` for new integrations." |
| 4 | [saas-code-examples](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-code-examples.html) | GetEntitlement example marks the `CUSTOMER_IDENTIFIER` filter "existing integrations only, not supported for new integrations" and prefers `CUSTOMER_AWS_ACCOUNT_ID`; a dedicated "BatchMeterUsage with License ARN" example exists for new products. |
| 5 | [AWS Marketplace blog: Concurrent Agreements upgrade guide](https://aws.amazon.com/blogs/awsmarketplace/complete-guide-to-upgrading-your-saas-product-to-aws-marketplace-concurrent-agreements/) | "replace any existing primary keys based on `CustomerIdentifier` or `ProductCode` with `LicenseArn`" and restructure tables accordingly. |
| 6 | [What's New, 2026-02-26](https://aws.amazon.com/about-aws/whats-new/2026/02/concurrent-agreements-february) | Concurrent Agreements launched; SaaS sellers must update entitlement + metering APIs and move notifications to EventBridge; mandatory for new products from June 1 2026. |
| 7 | Installed SDK, `@aws-sdk/client-marketplace-metering` 3.1066.0 | `ResolveCustomerResult` and `UsageRecord` typings both carry `LicenseArn` and `CustomerAWSAccountId`, so the re-key is implementable with the SDK version already pinned in this repo; no upgrade needed. |

We have never created a product, so our listing is a *new* integration by definition.

### Claim 3: Concurrent Agreements is mandatory for us

[saas-integrate-subscription](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-integrate-subscription.html):
"Starting **June 1, 2026**, all new SaaS products will be required to support updated
integration requirements." That date is in the past; it binds any product we create now.

### Claim 4: public visibility takes 7-10 business days

[saas-create-product](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-create-product.html):
"AWS Marketplace Seller Operations uses a manual process... The process takes 7-10
business days to update visibility to public, and longer if the team finds errors."

There is no same-day path to a public listing URL. Plan around it; do not promise it.

### Claim 5: EventBridge events cannot reach an HTTPS endpoint directly

[notifications-eventbridge](https://docs.aws.amazon.com/marketplace/latest/userguide/notifications-eventbridge.html)
and [saas-eventbridge-integration](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-eventbridge-integration.html):
events are delivered to the seller's **default event bus** in their own AWS account
with `source: aws.agreement-marketplace`. Targets are AWS resources (Lambda, Step
Functions, API Gateway). An external HTTPS webhook needs an EventBridge rule plus an
API destination to relay to it. That relay is what
`scripts/aws-marketplace-provision.sh` now creates, and
`api/aws-marketplace/subscription.js` parses both envelope shapes.

---

## Defects and their fixes (all four closed 2026-08-17)

**Defect 1 (critical, listing-breaking): the identity model was keyed on a field AWS
no longer sends.** `resolveCustomer()` read `result.CustomerIdentifier` and discarded
`LicenseArn` entirely; `register.js` used it as the `ON CONFLICT` key; `subscription.js`
returned 400 `missing_customer_identifier` without it. On a new listing every subscribe
died at the first insert.

*Fixed:* `resolveCustomer()` returns `licenseArn` and `customerAWSAccountId` alongside
the legacy field. `api/_lib/aws-marketplace-store.js` is the single place that knows how
a buyer is identified, keying on `license_arn` (unique) with `agreement_id` as a
correlation key and `customer_identifier` kept nullable for a legacy row. Migration
`20260817120000_aws_marketplace_concurrent_agreements.sql` carries the schema, including
re-pointing the metering audit table's foreign key off the now-nullable column. The
browser handle became the row id, so no license ARN reaches a URL.

**Defect 2 (critical, silent): the SNS topic guard rejected every real notification.**
The old provision script emitted a *self-created* topic ARN for `AWS_MP_SNS_TOPIC_ARN`.
Set as the old docs instructed, every genuine AWS notification failed the pin and
returned 403, visible only in logs.

*Fixed:* the script no longer creates that topic, and both this file and
[aws-marketplace.md](./aws-marketplace.md) state that the variable takes the AWS-issued
`aws-mp-subscription-notification-<PRODUCTCODE>` ARN or nothing at all.

**Defect 3 (latent): SNS signature verification hardcoded SHA1.**
`verifySnsMessage()` always did `createVerify('SHA1')` and never read
`msg.SignatureVersion`, so every message from a SignatureVersion 2 topic (SHA256)
failed verification with an error that reads exactly like a forgery.

*Fixed:* the digest follows `msg.SignatureVersion`. Both versions are covered in
`tests/api/aws-marketplace-sns.test.js`, including a tampered version 2 message.

**Defect 4 (critical, transport-level): the SNS webhook is the wrong transport for a
new listing.** The [Concurrent Agreements upgrade guide](https://aws.amazon.com/blogs/awsmarketplace/complete-guide-to-upgrading-your-saas-product-to-aws-marketplace-concurrent-agreements/)
is explicit: "SNS doesn't send the `LicenseArn` parameter," so new integrations must
consume EventBridge agreement events (`Purchase Agreement Created/Ended`,
`License Updated/Deprovisioned`) instead. Those events land on the **default event bus
of the seller AWS account** (155407237916), not on an HTTPS URL. Reaching
`https://three.ws/api/aws-marketplace/subscription` therefore requires AWS-side
resources: an EventBridge rule matching `source: aws.agreement-marketplace` plus an
API destination (connection + auth) targeting our endpoint, and the endpoint must
parse EventBridge event JSON, not SNS envelopes. `subscription.js` as written
(SNS envelope parse, SNS signature verify, SubscribeURL handshake) would never have
fired on a new listing.

*Fixed:* `subscription.js` detects the envelope shape and routes to the right handler,
so the same URL serves either transport and a listing migrated between them needs no
code change. `parseMarketplaceEvent()` maps every documented detail-type onto the
action the listing takes, stripping the `- Manufacturer` / `- Proposer` role suffix
(we are both). `scripts/aws-marketplace-provision.sh` provisions the connection, API
destination, IAM role, dead-letter queue, and rule instead of the orphan SNS topic.

Two things the relay forced, both worth knowing:

- **The relay needs its own authentication.** An API destination delivery is an
  ordinary HTTPS POST with no AWS signature on it. The connection attaches
  `x-three-ws-marketplace-secret`, checked in constant time against
  `AWS_MP_EVENT_SECRET`; an unset secret refuses EventBridge deliveries outright.
  Without it, anyone who found the URL could revoke a paying buyer's key with a
  forged `Purchase Agreement Ended`.
- **An end event can be ambiguous, and guessing is worse than doing nothing.**
  Agreement events carry no license ARN, and under Concurrent Agreements one AWS
  account can hold several live agreements for the same product. When resolution
  falls back to the acceptor's account id and matches more than one row, the handler
  logs and revokes nothing. Retrying cannot add information, so it answers 200 rather
  than looping the relay into the dead-letter queue.

Still verify against the product overview page at creation time
(`saas-create-product` says the EventBridge configuration appears there).
