---
venue: AWS Builder Center
account: three.ws (official organization account, byline "three.ws")
suggested_title: "The agent bought a physical object: building an authorization spine for autonomous commerce"
suggested_description: "How we wired AWS Marketplace entitlements, agent spend policies, a self-hosted x402 facilitator, and per-call settlement into one authorization path, and what happened when the thing at the end of that path stopped being an API call and became a printed object in a box."
suggested_tags: [agentic-ai, agent-toolkit, aws-marketplace, generative-ai, blockchain]
suggested_canonical: https://three.ws/docs/materialize
status: draft, not yet submitted
---

# The agent bought a physical object: building an authorization spine for autonomous commerce

Most agent-commerce writing stops at the payment. A wallet signs, a transaction confirms, the demo ends. That is the easy half.

The hard half is everything that has to be true *before* the signature, and it does not fit in a payments library. Who is this caller? What is it entitled to? Is this within the budget its owner set, and is that check race-free when four of the owner's agents spend at once? Can the seller on the other end actually settle, or will it take the money and fail? What proves, afterwards, that the exchange happened? And when the thing being bought is not an API response but a physical object that gets manufactured and shipped, what refuses the purchase that should never have happened?

We shipped all of that at [three.ws](https://three.ws), an open-source platform (Apache-2.0) where AI agents have 3D bodies, wallets, and the ability to buy services from each other. This article is the authorization spine underneath it: the AWS Marketplace entitlement path with the AWS SDK for JavaScript v3, the spend policy that sits between an agent and a credential, the preflight check that stops money leaving for a seller who cannot settle, the receipt layer that makes it auditable, and the physical fulfillment lane at the end. Every claim points at readable source in [our repository](https://github.com/nirholas/three.ws).

**Status note up front, because AWS builders will check.** three.ws is a verified AWS Partner and the Marketplace SaaS integration described below is built, deployed, and conformant with the Concurrent Agreements requirements AWS made mandatory for new SaaS products on 2026-06-01. The product record itself has not yet been created in the AWS Marketplace Management Portal, so there is nothing to subscribe to on the AWS side today, and the `AWS_MP_*` credentials are correspondingly unset in production (the subscription endpoint answers `503 not_configured`). Everything else in this article is live and callable without an AWS account. The AWS account `155407237916` (`us-east-1`) hosts the Marketplace integration: the IAM user for the metering APIs, the EventBridge relay, and the EULA. The platform's own runtime runs on Google Cloud Run. I would rather say that plainly than let a partner article imply a hosting story that is not ours.

**Contents**

1. Two economies, one authorization path
2. The AWS Marketplace half, and the part of it that is now wrong on the internet
3. The agent half: a budget, not a credential
4. Payment sessions: what "budget" looks like as an API
5. Preflight, re-quotes, and the failure paths that are the actual product
6. Receipts: the part that makes it auditable a year later
7. Can this agent act at all? A different health check
8. The end of the chain stopped being an API response
9. What is open, and what you can lift from it
10. What we would build differently
11. Try it without an AWS account

---

## 1. Two economies, one authorization path

We have two completely different kinds of buyer.

An **enterprise buyer** wants procurement through the channel they already have: subscribe on AWS Marketplace, consolidate on the AWS invoice, let security review one vendor record. They want an API key and a contract.

An **agent buyer** cannot do any of that. It cannot sign up, cannot accept terms, cannot wait for a key to be provisioned by a human, and frequently does not exist as an entity that could hold a contract. It has a wallet and a task, and it needs the answer in the next few hundred milliseconds.

The mistake we avoided, barely, was building two access-control systems. What we built instead is one authorization check with two front doors:

```
AWS Marketplace subscription
        │  ResolveCustomer (SDK v3)
        ▼
  license row  ──▶  account link  ──▶  API key  ──┐
                                                   ├──▶  authorize()  ──▶  the tool runs
agent wallet  ──▶  402 challenge  ──▶  settled  ──┘                          │
                                                                             ▼
                                                                     signed receipt
```

Both paths terminate in the same function. Downstream code never asks how the caller was authorized, only whether it was. That single decision is why adding the Marketplace front door did not fork the product, and it is the recommendation I would make to anyone adding a marketplace listing to an existing usage-priced API: **resolve both identities to one internal principal as early as possible, and let nothing downstream know the difference.**

Worth being explicit about the billing model, because it is unusual: the AWS Marketplace subscription is a **free front door**. There are no AWS pricing dimensions and no AWS-side metering. Subscribing links an AWS account to a three.ws account and issues an x402 access key; usage is then paid per call in USDC over HTTP 402, exactly as a non-AWS caller pays. Nothing to reconcile on the AWS invoice. We still implemented `MeterUsage`, `BatchMeterUsage`, and `GetEntitlements` against the SDK v3 clients, because a usage-priced dimension is a listing change rather than a re-architecture, and the code path for it should exist before the day you need it.

---

## 2. The AWS Marketplace half, and the part of it that is now wrong on the internet

If you implement a SaaS listing today by following the highest-ranked tutorials, you will implement the deprecated shape. This is worth getting on the record.

### `ResolveCustomer` no longer returns what you think

For a **new** SaaS integration, `ResolveCustomer` does not populate `CustomerIdentifier`. It returns `LicenseArn` and `CustomerAWSAccountId` ([API reference](https://docs.aws.amazon.com/marketplacemetering/latest/APIReference/API_ResolveCustomer.html)). The license ARN is the per-grant identity.

This matters more than a field rename, because under **Concurrent Agreements** one AWS account can hold several simultaneous agreements for the same product. The buyer's AWS account id therefore does not identify a subscription, and using it as a key produces a bug that only appears for your largest customers, which is the worst possible distribution of a bug.

Our customer row carries all of it: `license_arn` (unique), `agreement_id`, `customer_aws_account_id`, and a nullable legacy `customer_identifier` kept only for lookups of older rows. Migrating an existing integration means adding columns and a backfill, not rewriting the flow, but you have to key the *new* rows correctly from day one.

### The handle in the redirect URL is not the license

After the buyer clicks **Set up your account**, AWS POSTs a short-lived registration token to our registration URL. We exchange it, then redirect the browser to a welcome page carrying a handle, and that handle is **the row's own id**, never the license ARN. A grant identifier does not belong in a string that lands in browser history, referrer headers, proxy logs, and analytics.

### Lifecycle events moved to EventBridge, and the old path still has to verify

Agreement and license lifecycle notifications now arrive as EventBridge events. Our webhook still accepts the legacy SNS notifications too, and still verifies their signatures properly, because "we stopped checking the signature on the deprecated path" is how a deprecated path becomes an incident. If you support both, write one handler with two adapters rather than two handlers, so the authorization consequences of an event cannot diverge between them.

### The endpoints, and what refuses what

| Endpoint | Purpose |
|---|---|
| `POST /api/aws-marketplace/register` | Registration URL. Receives the token, resolves the license, starts onboarding. Called by AWS. |
| `POST /api/aws-marketplace/subscription` | Lifecycle webhook. EventBridge agreement and license events, plus legacy signature-verified SNS. Called by AWS. |
| `POST /api/aws-marketplace/link` | Attaches a resolved subscription to the signed-in account. Requires a session. |
| `POST /api/aws-marketplace/issue-key` | Mints or returns the x402 API key. Plaintext is returned once, on first issue. |

`link` and `issue-key` both require an active session and both refuse a subscription that belongs to somebody else, so a given AWS subscription can only ever be attached to one account:

| Status | Meaning |
|---|---|
| `401 unauthenticated` | No valid session. Sign in and retry. |
| `403 customer_linked_to_other_account` | Already attached to a different account. |
| `404 customer_not_found` | Unknown subscription record. Re-open the setup link from Marketplace. |
| `409 subscription_inactive` | Cancelled or expired. Re-subscribe first. |

Note that "the plaintext key is returned once" is a deliberate constraint and it is worth holding even under support pressure. A key you can re-read is a key your support process can leak.

Code: [`api/aws-marketplace/`](https://github.com/nirholas/three.ws/tree/main/api/aws-marketplace), [`api/_lib/aws-marketplace.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/aws-marketplace.js), the store in `api/_lib/aws-marketplace-store.js`, and the bridge into the shared authorization path in [`api/_lib/aws-marketplace-bridge.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/aws-marketplace-bridge.js). The SDK v3 clients in use are `@aws-sdk/client-marketplace-metering`, `@aws-sdk/client-marketplace-entitlement-service`, `@aws-sdk/client-s3`, and `@aws-sdk/s3-request-presigner`.

---

## 3. The agent half: a budget, not a credential

The instinct when you give an agent buying power is to hand it a credential. That is the wrong primitive. A credential is unbounded until revoked, and revocation is a human action that happens after the money is gone.

What an agent should get is a **policy**: a budget, a set of allowed counterparties, a per-call ceiling, and an expiry. The agent proves it is acting under that policy on every spend, and the ceiling is enforced where it cannot be raced.

Three implementation notes that cost us real debugging time.

**Reserve, then settle, then complete.** Our agent-to-agent hire ledger writes the row as `pending` and reserves the spend against the owner's policy in the same statement that checks it. The payment then runs over the real rails. Because the protocol verifies before it settles, a failure means no funds moved: we release the reservation and flip the row to `failed`. Only after settlement do we mark `completed` and attach the settlement signature, payer address, and result summary.

**Put the guard in the same statement as the state change.** A read-then-write budget check across two statements is a race that concurrent agents will find within hours. Ours are single statements with the condition inline. This sounds obvious written down; it was not obvious while writing the happy path.

**Only settled rows count as anything.** Our public volume roll-up filters on `completed` in every aggregate, so "volume" means "money actually moved, signature on file", and pending or failed attempts contribute exactly zero to totals, counts, averages, leaderboards, or the feed. When the ledger is empty the endpoint returns a real zero shape and the page renders its empty state rather than a placeholder number. If you are building a dashboard over an agent economy, decide what a row means **before** you put a number on a page, because the number is what people will quote back at you.

The generalisation we now design against: **an autonomous spend needs the same three properties as a database transaction.** Atomic (the check and the reservation are one operation), consistent (the ledger and the policy cannot disagree), durable (every attempt is logged, successes and failures alike, because the failures are where the fraud and the bugs live).

---

## 4. Payment sessions: what "budget" looks like as an API

The policy idea only works if it is easy to hand out, so we published it as a session primitive: [`@three-ws/agentcore-payments-mcp`](https://www.npmjs.com/package/@three-ws/agentcore-payments-mcp) creates a **budgeted payment session** and lets an agent pay any priced endpoint from it without ever holding a key.

The shape, in plain terms: an owner creates a session with a total budget, a per-call ceiling, an allowlist of recipients, and an expiry. The agent gets a session handle, not a wallet. Every call debits the session atomically. When the budget is gone, the session refuses, and the refusal is a normal, expected, well-typed outcome rather than an error the agent has to interpret.

Two related packages, because different consumers want different ergonomics:

- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch), a drop-in `fetch` wrapper that pays challenges automatically. If your code already speaks `fetch`, this is a two-line adoption.
- [`@three-ws/agent-guards`](https://www.npmjs.com/package/@three-ws/agent-guards), per-agent spend policies and trade guards as a standalone library, if you want the enforcement without the rest of our stack.
- [`@three-ws/onchain-agent-wallets`](https://www.npmjs.com/package/@three-ws/onchain-agent-wallets), which frames the same idea at the chain level: give an agent a spending allowance rather than a private key.

And the merchant side, since half of any economy is the seller: [`@three-ws/x402-server`](https://www.npmjs.com/package/@three-ws/x402-server) turns any HTTP endpoint into a paid one, issuing the challenge and verifying proof.

---

## 5. Preflight, re-quotes, and the failure paths that are the actual product

HTTP 402 as a protocol is elegant: a caller requests, gets a structured challenge with payment requirements, pays, and retries with proof. That is about a third of the work.

The other two thirds are the failure paths, and they are where an agent economy either becomes real or quietly loses money.

**Preflight.** Before paying anyone, ask whether the seller can actually settle: is the challenge well-formed, is the receiving address real, do the declared chain and asset match what is being asked for, does the settlement path respond. We shipped this as a surface ([three.ws/preflight](https://three.ws/preflight)) and a package ([`@three-ws/x402-preflight`](https://www.npmjs.com/package/@three-ws/x402-preflight)), because we learned it by losing calls to sellers that answered a challenge, accepted the proof, and then failed on their own settlement.

**Re-quote handling, bounded at exactly one retry.** If a paid replay itself answers `402`, the seller refused the proof, usually because it re-quoted between probe and replay. In that case the signed transfer is never broadcast, so no money moved and one retry is safe. Our buyer re-fetches the challenge once, settles against the **fresh** requirements, re-applies both the spend cap and the recipient allowlist to the new quote, and reports the retry distinctly in its logs so it shows up as a pattern rather than as noise. One attempt, then stop. An unbounded retry against a re-quoting seller is a slow drain.

**A daily spend cap across the whole loop**, not per call. Per-call caps feel safe and compose into an unbounded total.

**Log the refusal as carefully as the success.** Every autonomous call we make is recorded either way, with the challenge, the decision, and the outcome. Nobody debugs a success.

---

## 6. Receipts: the part that makes it auditable a year later

An entitlement answers "may this caller do this". A receipt answers "did this exchange actually happen, and can a third party check". Enterprise buyers ask the second question eventually, and the answer needs to exist before they ask.

Our receipt layer stores signed Offer and Receipt artifacts and keeps them retrievable: at the last footprint audit (2026-08-25) the vault held **58,907 signed artifacts**. Alongside it we run our own settlement facilitator rather than routing through a third party: **110,416 on-chain settlements and 803,483 verifications** at that same audit, with the implementation in the repo under `api/_lib/x402/`. Discovery is a static, public catalog at `/.well-known/x402.json` listing **4,519 priced endpoints**, which is what lets an agent find a seller at all.

Two lessons that transfer to any metered API, marketplace-billed or not:

**Self-hosting the settlement path was worth it.** Not for ideology: for the failure modes. When settlement is a third-party dependency, your outage postmortem has a gap in the middle of it that you cannot close, and your latency floor is somebody else's routing decision.

**Discovery should be a boring static document.** Ours is a file on our own domain, cacheable, diffable, and readable by anything. Every dynamic discovery API we considered would have been a new availability dependency in the middle of a payment flow.

---

## 7. Can this agent act at all? A different health check

An unrelated incident reshaped how we think about readiness. An audit found twelve armed autonomous agents: worker `Ready`, minimum instances up, feed streaming, every strategy row enabled. Ten of them had not attempted an action in weeks.

Three unrelated things were wrong, and none was visible to anything we measured. The deployed worker image predated a commit that moved the model chain onto models that still existed, so the whole chain answered 404 and 410. The surviving providers were out of credit or on a billing hold. And several agent wallets could not fund a single action.

Liveness measures the process. Acting requires a chain of preconditions the process knows nothing about. So we built [agent vitals](https://three.ws/docs/agent-vitals): preconditions as **vitals** with `needs` edges, actions as **capabilities** that AND over them, and attestation that returns the *root* blocker rather than a symptom.

```
deploy-fresh ──> cognition ──┐
                             ├──> [enter]
armed, solvency, feed, rpc ──┘

rpc ─────────────────────────────> [exit]
```

The engine is framework-agnostic with zero dependencies ([`packages/agent-vitals`](https://github.com/nirholas/three.ws/tree/main/packages/agent-vitals)), and there is an operator CLI and an ops-gated HTTP endpoint on our side. If you operate a fleet of agents on AWS, this is the check your dashboard is missing, whatever you build it with. "Healthy and structurally unable to work" is a state that will not show up in your existing metrics, and it is common the moment agents depend on external credit, external models, and funded wallets.

Two siblings from the same problem:

- [Brownout](https://three.ws/brownout): publish **proven** fallbacks rather than promised ones, and expose where a response's data came from and how fresh it is. A failover path nobody has exercised under load is a hypothesis, and every fleet has a folder of hypotheses labelled as redundancy.
- [`@three-ws/witness`](https://www.npmjs.com/package/@three-ws/witness): record what a user actually did and compile it into a Playwright spec that is red while the bug exists and green once it is fixed. A bug report is an experiment somebody else has to reconstruct, and the reconstruction is the part a machine can do.

---

## 8. The end of the chain stopped being an API response

Here is the part that made all of the above matter more than it did last year.

[Materialize](https://three.ws/materialize) turns a generated 3D model into a real object: printed in resin, nylon, colour sandstone, or steel, and shipped to an address. It is a page for humans, and it is an API, which means an agent can order a physical object of a model it just generated with no human anywhere in the loop.

The pipeline, and why each stage exists once the buyer might be a machine:

1. **Free, keyless analysis.** A printability report before any price: closed solid or not, how many separate bodies, where the holes are, thinnest wall, exact volume, and a 0 to 100 score with named deductions in plain language. Free on purpose. An agent that can check printability before paying to generate spends less overall, and a check that costs money is a check nobody runs.
2. **A signed quote token**, valid 24 hours, so the quoted price is the paid price and nothing between the two can move it.
3. **Two checkouts, one pipeline.** A human pays in the browser; an agent pays over 402. Same order record, same statuses, same fulfillment.
4. **Safety screening before production.** Weapons, functional key duplicates, and third-party brand marks are refused. A print bureau has a human at that checkpoint; an API whose buyer is an agent does not, so the checkpoint has to be code that is allowed to say no.
5. **Provenance in the box.** A certificate of authenticity, attested publicly, with a QR code, so the object proves which generation produced it. Creators can cap how many copies of a model will ever exist.
6. **Order tracking at every step**, because "the agent bought something and we cannot tell the owner where it is" is not a shippable state.

There is a quieter dependency underneath it that is worth naming, because it is the kind of thing that gets discovered in production: a model that renders beautifully can be physically impossible. We publish a separate free grade for the neighbouring question of whether an asset is usable in a **physics engine** ([simulation readiness](https://three.ws/docs/sim-readiness), CC0 spec), for the same reason. **Generative pipelines produce artifacts whose fitness for a downstream physical process is not visible in the artifact.** If your agent pipeline ends in manufacturing, robotics, or simulation, you need a mechanical claim about fitness, made once, checkable by anyone.

The architectural lesson I would take to any team building agent commerce: **irreversibility should be preceded by a free, honest dry run.** Quote is free, detailed, and refusable. Order is the only call that costs anything, and by the time it is made, every question has been asked and answered by a machine that could still change its mind.

---

## 9. What is open, and what you can lift from it

Everything in this article is Apache-2.0 and installable. As of a footprint audit on 2026-08-25:

| | |
|---|---|
| npm packages under `@three-ws` | 91 in this repo (101 across the wider scope at audit time) |
| MCP servers in the official registry | 72, under one namespace |
| GPU and service workers | 32, most as Docker images you can build and run |
| Specs (wire formats other code depends on) | 31, several CC0 |
| Public pages | 795 |

The pieces most worth lifting if you are building agent commerce on AWS, in the order I would reach for them:

1. `@three-ws/x402-server` (be a seller) and `@three-ws/x402-fetch` (be a buyer).
2. `@three-ws/x402-preflight` (do not pay a seller that cannot settle).
3. `@three-ws/agent-guards` and `@three-ws/agentcore-payments-mcp` (budgets instead of credentials).
4. `@three-ws/agent-vitals` (know whether your fleet can act).
5. `@three-ws/brownout` (know which of your fallbacks are real).
6. `@three-ws/witness` (turn support reports into failing tests).

None of them require the rest of the platform, and none of them require our hosting.

---

## 10. What we would build differently

Four things, stated plainly, because partner articles that contain only wins are not useful to anyone.

**Model the counterparty, not just the call.** For a long time our spend policies constrained amounts and rates but not *who*. Recipient allowlists arrived after we needed them, which is the wrong order.

**Decide what a ledger row means before you publish a number.** We got this right by accident more than by design, and the version where "volume" quietly includes attempts is a number you cannot walk back once people have quoted it.

**Write the refusal before the interface.** For every capability that touches money or matter, write the server-side refusal first and the interface second. A guard that lives in prompt text or a hidden button is not a guard.

**Separate free and paid at the server boundary, not with a flag.** Our free generation server contains no payment code at all. Not disabled: absent. That claim is verifiable in a minute by a reviewer, a customer, or us.

---

## 11. Try it without an AWS account

Everything free below is keyless. Paste and run.

```bash
# grade a 3D asset for physics use
curl "https://three.ws/api/sim-readiness?src=https://three.ws/avatars/cesium-man.glb"

# printability report and an itemized quote for a real print
curl -s -X POST https://three.ws/api/print/quote \
  -H 'content-type: application/json' \
  -d '{"src":"https://three.ws/avatars/cesium-man.glb","material":"nylon"}'

# the free 3D generation MCP server, 11 tools, no auth
curl -s https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# the public catalog of priced endpoints an agent can discover
curl -s https://three.ws/.well-known/x402.json | head -c 600

# the exact commit and revision production is running
curl -s https://three.ws/api/version
```

- **Source:** [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws) (Apache-2.0)
- **Docs:** [three.ws/docs](https://three.ws/docs), including [Materialize](https://three.ws/docs/materialize), [agent vitals](https://three.ws/docs/agent-vitals), [simulation readiness](https://three.ws/docs/sim-readiness), and the [AWS Marketplace integration](https://three.ws/docs/aws-marketplace)
- **Previously from us here:** the AWS Marketplace SaaS metering walkthrough with the SDK for JavaScript v3, and the platform overview for AWS builders

Questions are welcome. The parts I would most like other builders to argue with are section 3 (policy instead of credential) and section 8 (the free dry run in front of the irreversible call), because both started as opinions and only later turned out to be load-bearing.
