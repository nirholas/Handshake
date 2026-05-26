# three.ws on AWS Marketplace

three.ws is a verified AWS Partner and listed on AWS Marketplace as a SaaS usage-based product. This means you can subscribe to three.ws directly through your AWS account — usage is billed to your AWS bill, eligible for AWS credits, and counts toward your Enterprise Discount Program (EDP) commitments.

## Subscribing via AWS Marketplace

1. Find the three.ws listing on [AWS Marketplace](https://aws.amazon.com/marketplace).
2. Choose **Try for free** (free trial available) or **Subscribe**.
3. After confirming in AWS, you are redirected to `https://three.ws/aws-marketplace/welcome` to complete account setup.
4. If you already have a three.ws account, sign in and your AWS subscription is linked automatically.

## Free Trial

three.ws offers a free trial period for new AWS Marketplace subscribers. During the trial you have full access to the platform. When the trial ends, usage is billed on a pay-as-you-go basis through your AWS account.

## Billing

Usage is metered and reported to AWS daily. You are billed for:

| Dimension | Unit |
|---|---|
| API calls | Per call |
| Agent compute | Per minute of active session |

Charges appear on your standard AWS invoice under **AWS Marketplace Software**.

## AWS Infrastructure

three.ws runs on AWS in `us-east-1`. The application is registered in AWS MyApplications under account `155407237916`, which groups all platform resources for unified cost and operations monitoring.

## For Developers: Marketplace Integration Endpoints

If you are integrating three.ws programmatically after subscribing via AWS Marketplace, the relevant API endpoints are:

| Endpoint | Purpose |
|---|---|
| `POST /api/aws-marketplace/register` | Registration URL — receives the Marketplace token, resolves the customer, and starts onboarding |
| `POST /api/aws-marketplace/subscription` | SNS webhook — receives subscription lifecycle events from AWS |

These endpoints are called automatically by AWS during the subscription flow. You do not need to call them directly.

## Support

For billing questions related to your AWS Marketplace subscription, contact [AWS Support](https://aws.amazon.com/contact-us/).

For platform support, open a ticket at [https://three.ws/support](https://three.ws/support).
