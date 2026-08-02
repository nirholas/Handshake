# AWS Marketplace — AI Agents & Tools Listing Kit (three.ws / x402)

Paste-ready content and the exact step sequence to create the **AI agents & tools**
product in the AWS Marketplace Management Portal (AMMP). The backend integration
(register URL, SNS webhook, key issuance, account linking) is already built and
deployed — see [aws-marketplace.md](./aws-marketplace.md). This doc covers the
listing itself, which has not yet been created (the AMMP "AI agents & tools
products" page shows "No products to display").

> **BLOCKER, verified 2026-08-02: the integration in this repo cannot serve a new
> listing as written.** AWS stopped populating `CustomerIdentifier` for new SaaS
> integrations, and all 51 references across 7 files key on it. Read
> "Verified against AWS docs" and "Confirmed defects" at the bottom of this file
> before touching the listing. Do not create the product expecting the backend to
> work; it will fail the subscribe round-trip.

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

> Note: `docs/aws-marketplace.md` and the unused `AWS_MP_METERING_DIMENSION` /
> `AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE` env references describe an earlier
> AWS-metered-billing plan. That is superseded: billing is x402-per-call, not AWS-metered.
> Reconcile `docs/aws-marketplace.md` so it stops promising per-call/per-agent-minute AWS
> billing.

---

## Prerequisites (run where your seller AWS creds live — NOT in this codespace)

This codespace has no AWS credentials, so these must be run on a machine with
admin creds on account 155407237916.

### 1. Provision the IAM user (the SNS half of the script is dead weight)

```bash
./scripts/aws-marketplace-provision.sh
```

**The SNS topic this script creates is NOT the topic AMMP wants, and there is no
field in the SaaS wizard to paste it into.** AWS Marketplace creates and owns the
notification topics and hands you the ARN *during product creation*, in the form
`arn:aws:sns:us-east-1:<aws-owned-account>:aws-mp-subscription-notification-<PRODUCTCODE>`.
You subscribe to that topic afterwards; you never supply your own. Ignore the
script's `AWS_MP_SNS_TOPIC_ARN` output. See
[Amazon SNS notifications for SaaS products](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html).

What the script is genuinely needed for is the IAM user: `resolveCustomer()` in
`api/_lib/aws-marketplace.js` calls `aws-marketplace:ResolveCustomer`, and without
those keys every subscribe redirect dies at `/aws-marketplace/error?reason=token_expired`.

Take `AWS_MP_ACCESS_KEY_ID`, `AWS_MP_SECRET_ACCESS_KEY`, and `AWS_MP_REGION` and set
them on the Cloud Run service (production env lives there, not Vercel):

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars AWS_MP_ACCESS_KEY_ID=…,AWS_MP_SECRET_ACCESS_KEY=…,AWS_MP_REGION=…
```

(`--update-env-vars` merges. Never use `--set-env-vars` here: it replaces the entire
env set and would wipe every other production variable.)

`AWS_MP_PRODUCT_CODE` is assigned by AMMP after the product is created — add it last.

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
| SNS notification topic ARN | Not a field you fill in. AWS hands you `aws-mp-subscription-notification-<PRODUCTCODE>` after the product is created; subscribe to it then. |
| EULA | **Standard Contract (SCMP)**: recommended, zero setup. Custom EULA only if the S3 copy returns 200 (see prereq #2). |
| Post-subscribe redirect | `https://three.ws/aws-marketplace/welcome` (handled by register.js) |

Lifecycle events land on `POST /api/aws-marketplace/subscription` (SNS webhook —
already deployed; handles subscribe-success, unsubscribe-success, subscribe-fail,
entitlement-updated, and the SubscriptionConfirmation handshake).

---

## Step sequence in AMMP

Nothing in steps 2-7 depends on the IAM keys, so if creds are slow to arrive, start
the wizard anyway and backfill the env vars before the round-trip test in step 9.

1. Run prereq #1; set `AWS_MP_ACCESS_KEY_ID`, `AWS_MP_SECRET_ACCESS_KEY`, and
   `AWS_MP_REGION` on the Cloud Run service.
2. AMMP → **AI agents & tools products** → **Create AI agents & tools product**.
3. Delivery method: **API-based** (SaaS). (Until you finish the wizard the draft may
   appear under **SaaS products**, per AMMP's own note — that's expected.)
4. Fill product detail fields from the "Listing fields" section above; upload the logo.
5. Pricing: choose **Free**.
6. Fulfillment: paste the Registration URL from the table. There is no SNS field here.
7. EULA: select **Standard Contract**.
8. Save → AMMP assigns a **Product Code** and gives you the two `aws-mp-*` SNS topic
   ARNs. Set `AWS_MP_PRODUCT_CODE` on the Cloud Run service. No rebuild is needed:
   `gcloud run services update three-ws-api --region us-central1 --update-env-vars
   AWS_MP_PRODUCT_CODE=…` cuts a new revision on its own.
9. Subscribe `https://three.ws/api/aws-marketplace/subscription` to the
   `aws-mp-subscription-notification-<PRODUCTCODE>` topic (HTTPS subscription; the
   handler already answers the `SubscriptionConfirmation` handshake). This must be
   done from the seller account 155407237916. Then run one end-to-end
   subscribe → redirect → welcome → issue-key test while the product is **limited**.
10. Once the private round-trip works, **Request changes → Update visibility →
    Public**. This one needs AWS Marketplace Seller Operations approval, so it is the
    step with real calendar time on it. Everything before it is same-day.

---

## What is and isn't done

Done (in repo, deployed):
- Registration URL, SNS webhook, key issuance, account linking endpoints.
- `aws_marketplace_customers` schema + x402 bridge.
- EULA HTML, S3 publish script, SNS/IAM provision script.
- Welcome onboarding page.

Not done (requires AWS console / seller creds — cannot be done from this repo):
- Running the provision + EULA-publish scripts (no AWS CLI/creds in codespace).
- Publishing the S3 EULA (currently 404 — never uploaded).
- Creating the product in the AMMP wizard (manual web UI).
- Obtaining and wiring `AWS_MP_PRODUCT_CODE`.

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

[ResolveCustomer API reference](https://docs.aws.amazon.com/marketplacemetering/latest/APIReference/API_ResolveCustomer.html),
stated three times on that page:

> "For new SaaS product integrations, the `CustomerIdentifier` field is **not populated**
> in the `ResolveCustomer` API response. New integrations must use `CustomerAWSAccountId`
> and `LicenseArn` to identify customers. Existing integrations continue to work unchanged."

Corroborated in [saas-integrate-subscription](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-integrate-subscription.html):
"For new SaaS product integrations, the `CustomerIdentifier` field is not populated."

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
API destination to relay to it. `api/aws-marketplace/subscription.js` is an SNS HTTPS
webhook and cannot be an EventBridge target as written.

---

## Confirmed defects (fix before the listing goes anywhere)

**Defect 1 (critical, listing-breaking): the identity model is keyed on a field AWS
no longer sends.** `resolveCustomer()` in `api/_lib/aws-marketplace.js` reads
`result.CustomerIdentifier` and discards `LicenseArn` entirely. `register.js` uses it
as the `ON CONFLICT` key. `subscription.js` returns 400 `missing_customer_identifier`
without it. 51 references across 7 files: `aws-marketplace.js`,
`aws-marketplace-bridge.js`, `x402-subscriptions.js`, `issue-key.js`, `register.js`,
`subscription.js`, `link.js`. On a new listing every subscribe dies at the first
insert. Fix: return and persist `LicenseArn` + `CustomerAWSAccountId`, key on those,
keep `customer_identifier` nullable for any legacy row.

**Defect 2 (critical, silent): the SNS topic guard rejects every real notification.**
`verifySnsMessage()` compares `msg.TopicArn` against `env.AWS_MP_SNS_TOPIC_ARN`. The
provision script emits the *self-created* topic ARN for that variable. Set it as the
old docs instructed and every genuine AWS notification fails the check and returns 403,
with the cause visible only in logs. Fix: set that var to the AWS-issued
`aws-mp-subscription-notification-<PRODUCTCODE>` ARN, or leave it unset (the guard is
skipped when empty) until the real ARN is known.

**Defect 3 (latent): SNS signature verification hardcodes SHA1.**
`verifySnsMessage()` always does `createVerify('SHA1')` and never reads
`msg.SignatureVersion`. AWS SNS SignatureVersion 2 signs with SHA256. On a
SignatureVersion 2 topic every message fails verification and returns 403. Fix: branch
on `msg.SignatureVersion` (`'2'` implies SHA256, otherwise SHA1).

**Open decision, resolvable only at product creation:** whether our product is issued
SNS topics, EventBridge config, or both. `saas-create-product` says EventBridge config
appears on the product overview page; `saas-integrate-subscription` still describes the
SNS email from Seller Ops. Read the product overview page the moment the product is
created and build the leg AWS actually gave us. Do not build both on spec.
