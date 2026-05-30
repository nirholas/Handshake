# AWS Marketplace — AI Agents & Tools Listing Kit (three.ws / x402)

Paste-ready content and the exact step sequence to create the **AI agents & tools**
product in the AWS Marketplace Management Portal (AMMP). The backend integration
(register URL, SNS webhook, key issuance, account linking) is already built and
deployed — see [aws-marketplace.md](./aws-marketplace.md). This doc covers the
listing itself, which has not yet been created (the AMMP "AI agents & tools
products" page shows "No products to display").

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

### 1. Provision SNS topic + IAM user

```bash
./scripts/aws-marketplace-provision.sh
```

Outputs `AWS_MP_SNS_TOPIC_ARN`, `AWS_MP_ACCESS_KEY_ID`, `AWS_MP_SECRET_ACCESS_KEY`,
`AWS_MP_REGION`. Set all four in Vercel (production + preview). `AWS_MP_PRODUCT_CODE`
is assigned by AMMP after the product is created — add it last.

### 2. Publish the EULA to public S3 (currently returns 403 — must be fixed)

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
| SNS notification topic ARN | output of `aws-marketplace-provision.sh` (`arn:aws:sns:us-east-1:155407237916:three-ws-marketplace-subscription`) |
| Custom EULA URL | `https://three-ws-legal-155407237916.s3.amazonaws.com/aws-marketplace-eula.html` (must return 200 — see prereq #2) — or pick Standard Contract |
| Post-subscribe redirect | `https://three.ws/aws-marketplace/welcome` (handled by register.js) |

Lifecycle events land on `POST /api/aws-marketplace/subscription` (SNS webhook —
already deployed; handles subscribe-success, unsubscribe-success, subscribe-fail,
entitlement-updated, and the SubscriptionConfirmation handshake).

---

## Step sequence in AMMP

1. Run prereqs #1 and #2 above; set the five `AWS_MP_*` env vars in Vercel.
2. AMMP → **AI agents & tools products** → **Create AI agents & tools product**.
3. Delivery method: **API-based** (SaaS). (Until you finish the wizard the draft may
   appear under **SaaS products**, per AMMP's own note — that's expected.)
4. Fill product detail fields from the "Listing fields" section above; upload the logo.
5. Pricing: choose **Free**.
6. Fulfillment: paste the Registration URL and SNS Topic ARN from the table.
7. EULA: paste the S3 Custom EULA URL (confirm 200 first) or select Standard Contract.
8. Save → AMMP assigns a **Product Code**. Set `AWS_MP_PRODUCT_CODE` in Vercel and redeploy.
9. Submit as a **limited (private) offer** first and run one end-to-end subscribe →
   redirect → welcome → issue-key test before requesting public visibility.
10. Once the private round-trip works, request **public** visibility.

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
