---
title: "One paywall, two economies: putting AWS Marketplace metering in front of an x402 API"
venue: AWS Builder Center
account: three.ws (official)
description: "How we metered a SaaS product through AWS Marketplace with the AWS SDK for JavaScript v3 — ResolveCustomer, MeterUsage, entitlements, and verified SNS lifecycle webhooks — and bridged it to an on-chain x402 paywall so one access check bills two ways. Real code, and the five things that bit us."
tags: [aws, marketplace, saas, serverless, api]
---

# One paywall, two economies: putting AWS Marketplace metering in front of an x402 API

We run [three.ws](https://three.ws), an open-source platform for 3D AI agents and on-chain communities. Our paid API already had a billing system: **x402**, the HTTP-native pay-per-call protocol where a request to a metered endpoint either carries a subscription key or gets a `402 Payment Required`. That works great for developers who pay in stablecoins.

But a lot of teams don't want to touch crypto to pay an invoice. They want it on their AWS bill — drawn down from credits, counted toward their EDP commitment, one line item under *AWS Marketplace Software*. So we listed three.ws as a **SaaS usage-based product on AWS Marketplace** and wired AWS billing straight into the same access check that already powered x402.

The result is one authorization path that meters two ways: an AWS-subscribed customer and a stablecoin-paying developer hit the exact same endpoint, and the platform bills whichever economy that caller belongs to. This post is how we built it with the AWS SDK for JavaScript v3, the parts of the SaaS integration that are easy to get subtly wrong, and the bridge that ties an AWS `CustomerIdentifier` to an x402 key.

Everything here is real code from our open-source repo (Apache 2.0), not pseudocode — the serverless functions run on AWS in `us-east-1`.

## The three integration points of a SaaS listing

A SaaS usage-based listing on AWS Marketplace gives you exactly three seams to implement, and they all live in one helper module:

1. **ResolveCustomer** — turn the short-lived token AWS hands you at signup into a stable customer ID.
2. **MeterUsage** — report consumption back to AWS for billing.
3. **SNS lifecycle webhooks** — get told, with a verified signature, when a customer subscribes, cancels, or changes entitlement.

Here's the module that wraps all three. Two AWS SDK v3 clients, one region, plain credentials:

```js
import {
  MarketplaceMeteringClient,
  ResolveCustomerCommand,
  MeterUsageCommand,
} from '@aws-sdk/client-marketplace-metering';
import {
  MarketplaceEntitlementServiceClient,
  GetEntitlementsCommand,
} from '@aws-sdk/client-marketplace-entitlement-service';

function meteringClient() {
  return new MarketplaceMeteringClient({
    region: env.AWS_MP_REGION,
    credentials: {
      accessKeyId: env.AWS_MP_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_MP_SECRET_ACCESS_KEY,
    },
  });
}
```

## 1. Registration: the token → customer handshake

When a customer clicks **Subscribe** in AWS Marketplace, AWS redirects their browser to your *registration URL* with an HTTP `POST` — `application/x-www-form-urlencoded`, carrying `x-amzn-marketplace-token` and an offer type that tells you whether it's a free trial. That token is short-lived and useless on its own; you exchange it for a stable identity with `ResolveCustomer`:

```js
export async function resolveCustomer(registrationToken) {
  const client = meteringClient();
  const result = await client.send(
    new ResolveCustomerCommand({ RegistrationToken: registrationToken }),
  );
  return {
    customerIdentifier: result.CustomerIdentifier,
    productCode: result.ProductCode,
    customerAWSAccountId: result.CustomerAWSAccountId,
  };
}
```

The handler reads the form post, resolves the customer, upserts a row, links it to a three.ws account if the visitor is already signed in, and redirects to our onboarding page:

```js
const body = await readForm(req);
const token = body['x-amzn-marketplace-token'];
const isFreeTrial = body['x-amzn-marketplace-offer-type'] === 'free-trial';

const { customerIdentifier, productCode, customerAWSAccountId } =
  await resolveCustomer(token);

await sql`
  INSERT INTO aws_marketplace_customers
    (customer_identifier, product_code, customer_aws_account_id,
     subscription_status, is_free_trial, subscribed_at)
  VALUES
    (${customerIdentifier}, ${productCode}, ${customerAWSAccountId ?? null},
     ${isFreeTrial ? 'trial' : 'active'}, ${isFreeTrial}, now())
  ON CONFLICT (customer_identifier) DO UPDATE SET ...
`;

res.statusCode = 302;
res.setHeader('location',
  `${env.APP_ORIGIN}/aws-marketplace/welcome?customer=${customerIdentifier}`);
```

**Gotcha #1:** the registration call is a *browser redirect with a form body*, not a JSON API call. If your framework only parses JSON bodies, the token is silently empty and `ResolveCustomer` throws "token expired" for reasons that have nothing to do with expiry. Read it as a form.

## 2. SNS lifecycle — and actually verifying the signature

AWS Marketplace tells you about the *rest* of the customer's life — cancellations, trial conversions, entitlement changes — over an Amazon SNS topic that POSTs to a webhook. There are three message types, and the most important line of the whole integration is: **verify the signature before you trust a single field.** An unverified webhook is an open door to cancel anyone's subscription or, worse, fake a `subscribe-success`.

AWS signs every SNS message and includes the URL of the signing certificate. Verification means: only trust a cert hosted on `*.amazonaws.com`, rebuild the canonical signing string from the documented fields *in order*, and check the RSA-SHA1 signature:

```js
const certCache = new Map();

async function fetchCert(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.amazonaws.com')) {
    throw new Error(`Untrusted SNS signing cert URL: ${url}`);
  }
  if (certCache.has(url)) return certCache.get(url);
  const pem = await (await fetch(url)).text();
  certCache.set(url, pem);
  return pem;
}

// Field set differs by message type — and order matters.
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
const SUBSCRIPTION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

export async function verifySnsMessage(msg) {
  if (env.AWS_MP_SNS_TOPIC_ARN && msg.TopicArn !== env.AWS_MP_SNS_TOPIC_ARN) {
    throw new Error(`SNS TopicArn mismatch: got ${msg.TopicArn}`);
  }
  const pem = await fetchCert(msg.SigningCertURL);
  const fields = msg.Type === 'Notification' ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
  const signingString = fields
    .filter((k) => msg[k] !== undefined)
    .map((k) => `${k}\n${msg[k]}\n`)
    .join('');
  const verifier = createVerify('SHA1');
  verifier.update(signingString);
  if (!verifier.verify(createPublicKey(pem), msg.Signature, 'base64')) {
    throw new Error('SNS signature verification failed');
  }
}
```

**Gotcha #2:** the canonical string is `Key\nValue\n` for each field, and the field list is *different* for a `Notification` versus a `SubscriptionConfirmation`. Get the set or the order wrong and every signature fails verification with no hint as to why. Also pin the `TopicArn` — the signature proves AWS sent it, the ARN check proves it's *your* topic.

The handler confirms the SNS subscription on the one-time handshake, then routes lifecycle actions:

```js
await verifySnsMessage(msg);

if (msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation') {
  await fetch(msg.SubscribeURL);          // complete the handshake
  return json(res, 200, { ok: true });
}

const payload = JSON.parse(msg.Message);
const { action, 'customer-identifier': customerId } = payload;

if (action === 'subscribe-success')   { /* mark active / trial */ }
if (action === 'unsubscribe-success') { await revokeSubscriptionForCustomer(customerId); /* then mark cancelled */ }
```

**Gotcha #3 (the one that matters for money):** on `unsubscribe-success` we **revoke the customer's API key *before* we flip their status to `cancelled`**, and if the revoke throws we return `500` and leave them `active`. Why backwards? Because the failure we refuse to ship is a *cancelled customer who still has a working key*. Better to retry a stuck revoke than to hand out free access. Order your side effects by which failure you can least afford.

## 3. The bridge: one `CustomerIdentifier`, one x402 key

Here's the part we're proud of. Our metered endpoints (`/api/x402/*`) already authenticate with an x402 subscription key. Rather than build a second, parallel auth path for AWS customers, we **mint an x402 subscription for the AWS customer and tag it** with where it came from:

```js
const subscription = await createSubscription({
  name: `aws-marketplace:${customerId}`,
  rateLimitPerMinute: rateLimitForCustomer(customer),
  meta: {
    source: 'aws-marketplace',
    aws_customer_identifier: customerId,
    aws_product_code: customer.product_code,
    is_free_trial: Boolean(customer.is_free_trial),
  },
});
```

That `meta.source = 'aws-marketplace'` is the whole trick. From here on, an AWS customer is just an x402 caller with a provenance tag. Every existing protection — rate limiting, revocation, audit logging — applies to both economies for free, and the access check stays a single code path.

The plaintext key is returned exactly once, on first issue, and never stored in clear. If the customer cancels and later re-subscribes, the old link is revoked and a fresh key is minted — so a cancelled key can never be reanimated.

## 4. Metering: bill the call, once, idempotently

Now the access check. When a request to a metered route is granted, we look at that provenance tag. AWS-sourced? Report a unit of usage to AWS:

```js
// inside the x402 access-control grant path:
if (sub.meta?.source === 'aws-marketplace') {
  meterAwsSubscriptionUsage({ subscriptionId: sub.id, route });
}
```

`MeterUsage` is the AWS-facing call, idempotent per `usageAllocationId`:

```js
const recordId = await meterUsage({
  customerIdentifier: row.customer_identifier,
  dimension: env.AWS_MP_METERING_DIMENSION,
  quantity: 1,
  timestamp: new Date(bucket * 1000),
  usageAllocationId: `${subscriptionId}-${bucket}`,   // idempotency key
});
```

Metering is fire-and-forget (it must never add latency to the customer's request) and **de-duplicated to one call per subscription per second** before it ever leaves the process, with a Postgres audit row as the canonical count:

```js
const bucket = Math.floor(Date.now() / 1000);
const dedupeKey = `${subscriptionId}:${bucket}`;
if (_inFlight.has(dedupeKey)) return;      // already metering this second
_inFlight.add(dedupeKey);

queueMicrotask(async () => {
  // ...resolve customer, MeterUsage(1), then:
  await sql`
    insert into aws_marketplace_metering
      (customer_identifier, dimension, quantity, metering_record_id, usage_allocation_id)
    values (...)
    on conflict (metering_record_id) do nothing
  `;
});
```

**Gotcha #4:** AWS Marketplace bills idempotently per usage-allocation id, but issuing the network call ten times a second under load is just wasted I/O and noisy retries. A one-second in-process bucket plus a unique `usageAllocationId` plus `ON CONFLICT DO NOTHING` gives you three independent layers that all agree: bill once.

**Gotcha #5 — SNS lag:** when a customer cancels, the `unsubscribe-success` notification can take minutes to arrive. For those minutes, the customer's key is still technically valid. So the access check has a defense-in-depth probe that reads the live AWS status and aborts a zombie key *before* the webhook catches up:

```js
if (await isAwsCustomerInactive(sub)) {
  return { abort: true, status: 403, reason: 'AWS Marketplace subscription inactive' };
}
```

## What the customer actually gets

The product on the other side of all this plumbing is the platform: three.ws agents, the avatar and `/play` 3D-world APIs, and the rest of the metered surface. From the customer's seat the flow is boring in the best way — **Subscribe** in AWS Marketplace → land on our welcome page → copy one API key → call `/api/x402/*`. Their usage shows up on their AWS invoice. They never learn that the same endpoint also speaks an on-chain payment protocol, because they never have to.

## Takeaways

- A SaaS usage-based listing is **three calls** (`ResolveCustomer`, `MeterUsage`, entitlements) plus **one verified webhook**. The AWS SDK v3 marketplace clients make the calls a one-liner each; the webhook security is where the real work is.
- **Verify SNS signatures** with the right field set and order, and pin your `TopicArn`. Treat an unverified webhook as hostile.
- **Order side effects by worst-case failure.** Revoke access before you mark a customer inactive.
- **Don't fork your auth.** Tagging an AWS customer as a first-class entry in our existing subscription model meant rate limiting, revocation, and audit came for free, and one access check bills two economies.

## Resources

- AWS Marketplace SaaS metering — [ResolveCustomer / MeterUsage docs](https://docs.aws.amazon.com/marketplace/latest/userguide/metering-service.html)
- [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) — `@aws-sdk/client-marketplace-metering`, `@aws-sdk/client-marketplace-entitlement-service`
- [x402 protocol](https://www.x402.org) — the HTTP-native pay-per-call standard we bridged to
- three.ws on [AWS Marketplace](https://aws.amazon.com/marketplace) · source on [GitHub](https://github.com/nirholas/three.ws) (Apache 2.0)

---

*three.ws is a verified AWS Partner and an open-source platform for 3D AI agents and on-chain communities, running on AWS in `us-east-1`. Live at [three.ws](https://three.ws).*
