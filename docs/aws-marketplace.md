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

These endpoints are called automatically by AWS during the subscription flow. You do not need to call them directly.

## Support

For billing questions related to your AWS Marketplace subscription, contact [AWS Support](https://aws.amazon.com/contact-us/).

For platform support, open an issue at [github.com/nirholas/three.ws/issues](https://github.com/nirholas/three.ws/issues).
