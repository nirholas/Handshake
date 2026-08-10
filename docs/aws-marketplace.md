# three.ws on AWS Marketplace

three.ws is a verified AWS Partner and listed on AWS Marketplace as an API-based (SaaS) product. The AWS subscription is a **free front door**: subscribing links your AWS account to a three.ws account and issues an x402 access key. Actual usage is then paid per-call in USDC over the x402 / HTTP 402 protocol — the same as every other x402 endpoint. AWS Marketplace itself does not meter or bill usage.

## Subscribing via AWS Marketplace

1. Find the three.ws listing on [AWS Marketplace](https://aws.amazon.com/marketplace).
2. Choose **Subscribe** — the AWS Marketplace subscription is free.
3. After confirming in AWS, you are redirected to `https://three.ws/aws-marketplace/welcome` to complete account setup.
4. If you already have a three.ws account, sign in and your AWS subscription is linked automatically.
5. Once linked, the welcome page issues your x402 access key so you can start calling `/api/x402/*` immediately.

## Billing

The AWS Marketplace subscription is free — there are no AWS pricing dimensions, no contract, and no AWS-side metering. Usage is paid per-call in USDC via x402 (HTTP 402): every call returns a structured 402 challenge, your wallet or facilitator pays in USDC, and the request retries automatically. This is identical to how a non-AWS caller pays, so there is nothing to reconcile on your AWS invoice.

## AWS account

The AWS Marketplace seller account for three.ws is `155407237916` (`us-east-1`), which hosts the Marketplace integration — the SNS subscription topic, the ResolveCustomer/entitlement bridge, and the EULA. The platform's own production runtime runs on Google Cloud Run (service `three-ws-api`, region `us-central1`); see [ops/gcp-production.md](./ops/gcp-production.md) for the hosting runbook.

## For Developers: Marketplace Integration Endpoints

If you are integrating three.ws programmatically after subscribing via AWS Marketplace, the relevant API endpoints are:

| Endpoint | Purpose |
|---|---|
| `POST /api/aws-marketplace/register` | Registration URL — receives the Marketplace token, resolves the customer, and starts onboarding |
| `POST /api/aws-marketplace/subscription` | SNS webhook — receives subscription lifecycle events from AWS |
| `POST /api/aws-marketplace/link` | Attaches your resolved AWS customer record to your signed-in three.ws account. Called by the welcome page; requires a session cookie. |
| `POST /api/aws-marketplace/issue-key` | Mints (or returns) the x402 API key for your linked subscription. The plaintext key is returned once, on first issue. |

`register` and `subscription` are called automatically by AWS during the subscription flow; you do not need to call them directly. `link` and `issue-key` are called by the welcome page on your behalf once you sign in.

Both `link` and `issue-key` require an active session and refuse a subscription that belongs to someone else, so a given AWS customer record can only ever be attached to one three.ws account:

| Status | Meaning |
|---|---|
| `401 unauthenticated` | No valid session cookie. Sign in, then retry. |
| `403 customer_linked_to_other_account` | This AWS subscription is already attached to a different three.ws account. |
| `404 customer_not_found` | The customer identifier is unknown. Re-open the setup link from AWS Marketplace. |
| `409 subscription_inactive` | The AWS subscription is cancelled or expired. Re-subscribe in AWS Marketplace first. |

### Operator configuration

The integration reads its AWS credentials from the environment and ships inert without them: nothing fabricates an entitlement AWS did not grant.

| Variable | Required | Purpose |
|---|---|---|
| `AWS_MP_ACCESS_KEY_ID` | Yes | Credentials for ResolveCustomer, MeterUsage, and GetEntitlements. |
| `AWS_MP_SECRET_ACCESS_KEY` | Yes | Paired secret for the above. |
| `AWS_MP_PRODUCT_CODE` | Yes | Product code from the Marketplace listing. |
| `AWS_MP_SNS_TOPIC_ARN` | Yes, for the webhook | The Marketplace SNS topic. `POST /api/aws-marketplace/subscription` answers `503 not_configured` until it is set. |
| `AWS_MP_REGION` | No (default `us-east-1`) | Region for the Marketplace API clients. |
| `AWS_MP_METERING_DIMENSION` | No | Set for a usage-based listing to report MeterUsage per granted call. Leave unset for a contract listing. |
| `AWS_MP_ENTITLEMENT_REQUIRED` | No | Set truthy on a contract listing to gate key issuance on a live GetEntitlements check. |
| `AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE` | No (default `600`) | Rate limit stamped on issued keys. Override per offer with `AWS_MP_RATE_LIMIT_<OFFER_ID>`. |

**`AWS_MP_SNS_TOPIC_ARN` is not optional in practice.** A valid SNS signature only proves that some AWS account signed the message: anyone can create an SNS topic in their own account and have AWS sign a notification for it. The topic ARN is what binds the webhook to this listing, so without it a forged `subscribe-success` could mint a free API key and a forged `unsubscribe-success` could revoke a paying customer's. The handler therefore refuses delivery outright rather than trusting an unpinned topic. SNS retries with backoff, so notifications that arrive during a misconfiguration are redelivered once the variable is set.

If the registration URL is hit while the AWS credentials are missing, the customer is redirected to `/aws-marketplace/error?reason=not_configured` (not `token_expired`) and the missing variables are named in the server log.

## Support

For billing questions related to your AWS Marketplace subscription, contact [AWS Support](https://aws.amazon.com/contact-us/).

For platform support, open an issue at [github.com/nirholas/three.ws/issues](https://github.com/nirholas/three.ws/issues).
