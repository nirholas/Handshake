# three.ws on AWS Marketplace

three.ws is a verified AWS Partner. The AWS Marketplace product is an API-based (SaaS) listing, and the AWS subscription is a **free front door**: subscribing links your AWS account to a three.ws account and issues an x402 access key. Actual usage is then paid per-call in USDC over the x402 / HTTP 402 protocol, the same as every other x402 endpoint. AWS Marketplace itself does not meter or bill usage.

> **Listing status (checked 2026-08-17): not yet public.** The integration is built, deployed, and now conforms to the Concurrent Agreements requirements AWS made mandatory for new SaaS products on 2026-06-01, but the product has not been created in the AWS Marketplace Management Portal, so there is nothing to subscribe to on the AWS side yet. The Marketplace credentials (`AWS_MP_*`) are correspondingly unset in production, so `POST /api/aws-marketplace/subscription` answers `503 not_configured` today. The remaining steps are AWS-console work and Seller Operations approval, tracked in [aws-marketplace-listing-kit.md](./aws-marketplace-listing-kit.md). Until then, use x402 directly: no AWS subscription is required to call `/api/x402/*`.

## Subscribing via AWS Marketplace

This is the flow once the listing is public.

1. Find the three.ws listing on [AWS Marketplace](https://aws.amazon.com/marketplace).
2. Choose **Subscribe** — the AWS Marketplace subscription is free.
3. Choose **Set up your account**. AWS POSTs a short-lived registration token to `https://three.ws/api/aws-marketplace/register`, which exchanges it for your license and redirects you to `https://three.ws/aws-marketplace/welcome`.
4. If you already have a three.ws account, sign in and your AWS subscription is linked automatically.
5. Once linked, the welcome page issues your x402 access key so you can start calling `/api/x402/*` immediately.

## Billing

The AWS Marketplace subscription is free: there are no AWS pricing dimensions, no contract, and no AWS-side metering. Usage is paid per-call in USDC via x402 (HTTP 402): every call returns a structured 402 challenge, your wallet or facilitator pays in USDC, and the request retries automatically. This is identical to how a non-AWS caller pays, so there is nothing to reconcile on your AWS invoice.

## How a buyer is identified

This matters if you are reading the code, because AWS changed the answer and the old answer is still all over the internet.

For a **new** SaaS integration, `ResolveCustomer` no longer populates `CustomerIdentifier`. It returns `LicenseArn` and `CustomerAWSAccountId`, and the license ARN is the per-grant identity ([ResolveCustomer API reference](https://docs.aws.amazon.com/marketplacemetering/latest/APIReference/API_ResolveCustomer.html)). Under **Concurrent Agreements** one AWS account can hold several simultaneous agreements for the same product, so the buyer's AWS account id alone does not identify a subscription and is never used as a key.

The record in `aws_marketplace_customers` therefore carries all of `license_arn` (unique), `agreement_id`, `customer_aws_account_id`, and a nullable legacy `customer_identifier`. The handle passed to the browser on `/aws-marketplace/welcome?customer=…` is the row's own id, not the license ARN: a grant identifier does not belong in a URL that lands in browser history, referrer headers, and access logs.

## AWS account

The AWS Marketplace seller account for three.ws is `155407237916` (`us-east-1`), which hosts the Marketplace integration: the IAM user for the metering APIs, the EventBridge relay for lifecycle events, and the EULA. The platform's own production runtime runs on Google Cloud Run (service `three-ws-api`, region `us-central1`); see [ops/gcp-production.md](./ops/gcp-production.md) for the hosting runbook.

## For developers: Marketplace integration endpoints

If you are integrating three.ws programmatically after subscribing via AWS Marketplace, the relevant API endpoints are:

| Endpoint | Purpose |
|---|---|
| `POST /api/aws-marketplace/register` | Registration URL. Receives the Marketplace token, resolves the license, and starts onboarding |
| `POST /api/aws-marketplace/subscription` | Lifecycle webhook. Receives EventBridge agreement/license events (and legacy SNS notifications) |
| `POST /api/aws-marketplace/link` | Attaches your resolved AWS subscription record to your signed-in three.ws account. Called by the welcome page; requires a session cookie. |
| `POST /api/aws-marketplace/issue-key` | Mints (or returns) the x402 API key for your linked subscription. The plaintext key is returned once, on first issue. |

`register` and `subscription` are called by AWS during and after the subscription flow; you do not call them directly. `link` and `issue-key` are called by the welcome page on your behalf once you sign in.

Both `link` and `issue-key` require an active session and refuse a subscription that belongs to someone else, so a given AWS subscription can only ever be attached to one three.ws account:

| Status | Meaning |
|---|---|
| `401 unauthenticated` | No valid session cookie. Sign in, then retry. |
| `403 customer_linked_to_other_account` | This AWS subscription is already attached to a different three.ws account. |
| `404 customer_not_found` | The subscription record is unknown. Re-open the setup link from AWS Marketplace. |
| `409 subscription_inactive` | The AWS subscription is cancelled or expired. Re-subscribe in AWS Marketplace first. |

## Lifecycle notifications

New listings receive lifecycle events on **Amazon EventBridge**, not SNS. AWS Marketplace delivers agreement and license events to the seller account's default event bus with `source: aws.agreement-marketplace`, and SNS does not carry the `LicenseArn` these events are keyed on. EventBridge cannot POST to an external HTTPS endpoint on its own, so an EventBridge rule targets an **API destination** that relays to `https://three.ws/api/aws-marketplace/subscription`. `scripts/aws-marketplace-provision.sh` creates the connection, destination, IAM role, dead-letter queue, and rule.

| Event | Effect |
|---|---|
| `Purchase Agreement Created` / `Amended` | Record the agreement; open a pending record if the buyer has not registered yet |
| `License Updated` | Attach the license ARN to the buyer's record |
| `Purchase Agreement Ended` | Revoke the x402 key and mark the record cancelled |
| `License Deprovisioned` | Revoke the x402 key and mark the record cancelled |

The webhook **refuses to guess**. If an end event only identifies the buyer's AWS account and that account holds more than one live agreement for the product, it logs the ambiguity and revokes nothing, because revoking the wrong one cuts off access a buyer is still paying for. Retrying cannot add information, so it answers `200` rather than looping the relay.

The legacy SNS transport is still accepted for an existing integration: `subscribe-success`, `unsubscribe-success`, `subscribe-fail`, and `entitlement-updated`, with full signature verification against the AWS-issued topic.

### Operator configuration

The integration reads its AWS credentials from the environment and ships inert without them: nothing fabricates an entitlement AWS did not grant.

| Variable | Required | Purpose |
|---|---|---|
| `AWS_MP_ACCESS_KEY_ID` | Yes | Credentials for ResolveCustomer, BatchMeterUsage, and GetEntitlements. |
| `AWS_MP_SECRET_ACCESS_KEY` | Yes | Paired secret for the above. |
| `AWS_MP_PRODUCT_CODE` | Yes | Product code from the Marketplace listing. |
| `AWS_MP_EVENT_SECRET` | Yes, for the webhook | Shared secret the EventBridge API destination attaches as `x-three-ws-marketplace-secret`. `POST /api/aws-marketplace/subscription` answers `503 not_configured` for EventBridge deliveries until it is set. |
| `AWS_MP_SNS_TOPIC_ARN` | Only for the legacy SNS leg | The AWS-issued `aws-mp-subscription-notification-<PRODUCTCODE>` topic. Never a self-created topic. |
| `AWS_MP_REGION` | No (default `us-east-1`) | Region for the Marketplace API clients. |
| `AWS_MP_METERING_DIMENSION` | No | Set for a usage-based listing to report BatchMeterUsage per granted call. Leave unset for a free or contract listing. |
| `AWS_MP_ENTITLEMENT_REQUIRED` | No | Set truthy on a contract listing to gate key issuance on a live GetEntitlements check. |
| `AWS_MP_DEFAULT_RATE_LIMIT_PER_MINUTE` | No (default `600`) | Rate limit stamped on issued keys. Override per offer with `AWS_MP_RATE_LIMIT_<OFFER_ID>`. |

**`AWS_MP_EVENT_SECRET` is what authenticates the EventBridge relay.** An API destination delivery is an ordinary HTTPS POST; the header the connection attaches is the only thing distinguishing it from an anonymous caller who found the URL. Without that check a forged `Purchase Agreement Ended` could revoke a paying buyer's key. The handler therefore refuses EventBridge deliveries outright while the secret is unset, and compares it in constant time when it is. EventBridge retries with backoff and dead-letters to SQS, so deliveries that arrive during a misconfiguration are recoverable.

**`AWS_MP_SNS_TOPIC_ARN` plays the same role for the legacy leg.** A valid SNS signature only proves that some AWS account signed the message: anyone can create an SNS topic in their own account and have AWS sign a notification for it. The topic ARN is what binds the webhook to this listing, so the handler refuses SNS delivery outright rather than trusting an unpinned topic. Signature verification follows the message's `SignatureVersion` (version 2 topics sign with SHA256, version 1 with SHA1).

If the registration URL is hit while the AWS credentials are missing, the customer is redirected to `/aws-marketplace/error?reason=not_configured` (not `token_expired`) and the missing variables are named in the server log. If AWS resolves the token but returns no usable identity at all, the redirect reason is `unresolved_customer` and no record is written: an unkeyed record would grant access we could never revoke.

## Support

For billing questions related to your AWS Marketplace subscription, contact [AWS Support](https://aws.amazon.com/contact-us/).

For platform support, open an issue at [github.com/nirholas/three.ws/issues](https://github.com/nirholas/three.ws/issues).
