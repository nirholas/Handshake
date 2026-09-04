---
venue: AWS Builder Center
account: three.ws (official organization account, byline "three.ws")
suggested_title: "The agent bought a physical object: building an authorization spine for autonomous commerce"
suggested_description: "How we wired AWS Marketplace entitlements, agent spend policies, and HTTP 402 settlement into one authorization path, and what happened when the thing at the end of that path stopped being an API call and became a printed object in a box."
suggested_tags: [agentic-ai, agent-toolkit, aws-marketplace, generative-ai, blockchain]
suggested_canonical: https://three.ws/docs/materialize
status: draft, not yet submitted
---

# The agent bought a physical object: building an authorization spine for autonomous commerce

Most agent-commerce writing stops at the payment. A wallet signs, a transaction confirms, the demo ends. That is the easy half.

The hard half is everything that has to be true *before* the signature, and it does not fit in a payments library. Who is this caller? What is it entitled to? Is this within the budget its owner set, and is that check race-free when four of the owner's agents spend at once? Can the seller on the other end actually settle, or will it take the money and fail? And when the thing being bought is not an API response but a physical object that gets manufactured and shipped, what refuses the purchase that should never have happened?

We shipped all of that at [three.ws](https://three.ws), an open-source platform (Apache-2.0) where AI agents have 3D bodies, wallets, and the ability to buy services from each other. This article is the authorization spine underneath it: the AWS Marketplace entitlement path, the spend policy that sits between an agent and a key, the preflight check that stops money leaving for a seller who cannot settle, and the physical fulfillment lane at the end. Every claim points at readable source in [our repository](https://github.com/nirholas/three.ws).

**Status note up front, because AWS builders will check:** three.ws is a verified AWS Partner and the Marketplace SaaS integration described below is built, deployed, and conformant with the Concurrent Agreements requirements AWS made mandatory for new SaaS products on 2026-06-01. The product record itself has not yet been created in the AWS Marketplace Management Portal, so there is nothing to subscribe to on the AWS side today. Everything else here is live and callable without an AWS account. The platform's own runtime runs on Google Cloud Run; the AWS account (`155407237916`, `us-east-1`) hosts the Marketplace integration.

---

## 1. Two economies, one authorization path

We have two completely different kinds of buyer.

An **enterprise buyer** wants procurement through the channel they already have: subscribe on AWS Marketplace, consolidate on the AWS invoice, let security review one vendor record. They want an API key and a contract.

An **agent buyer** cannot do any of that. It cannot sign up, cannot accept terms, cannot wait for a key to be provisioned by a human, and frequently does not exist as an entity that could hold a contract. It has a wallet and a task, and it needs the answer in the next few hundred milliseconds.

The mistake we avoided, barely, was building two access-control systems. What we built instead is one authorization check with two front doors:

```
AWS Marketplace subscription ──▶ license row ──▶ x402 API key ──┐
                                                                 ├──▶ one authorize() ──▶ the tool runs
agent wallet ──▶ HTTP 402 challenge ──▶ settled payment ────────┘
```

Both paths terminate in the same function. Downstream code never asks how the caller was authorized, only whether it was. That single decision is why adding the Marketplace front door did not fork the product.

---

## 2. The AWS Marketplace half, and the part of it that is now wrong on the internet

If you implement a SaaS listing today by following the highest-ranked tutorials, you will implement the deprecated shape. This is worth getting on the record.

### `ResolveCustomer` no longer returns what you think

For a **new** SaaS integration, `ResolveCustomer` does not populate `CustomerIdentifier`. It returns `LicenseArn` and `CustomerAWSAccountId` ([API reference](https://docs.aws.amazon.com/marketplacemetering/latest/APIReference/API_ResolveCustomer.html)). The license ARN is the per-grant identity.

This matters more than a field rename, because under **Concurrent Agreements** one AWS account can hold several simultaneous agreements for the same product. The buyer's AWS account id therefore does not identify a subscription, and using it as a key produces a bug that only appears for your largest customers, which is the worst possible distribution of a bug.

Our customer row carries all of it: `license_arn` (unique), `agreement_id`, `customer_aws_account_id`, and a nullable legacy `customer_identifier` kept only for lookups of older rows.

### The handle in the redirect URL is not the license

After the buyer clicks **Set up your account**, AWS POSTs a short-lived registration token to our registration URL, we resolve it, and we redirect the browser to a welcome page. That URL carries a handle, and the handle is the row's own id, never the license ARN. A grant identifier does not belong in a string that lands in browser history, referrer headers, and access logs.

### Lifecycle events moved to EventBridge, and the old path still has to verify

Agreement and license lifecycle notifications now arrive as EventBridge events. Our webhook still accepts the legacy SNS notifications too, and still verifies their signatures properly, because "we stopped checking the signature on the deprecated path" is how a deprecated path becomes an incident.

### Linking refuses more than it accepts

`link` and `issue-key` both require an active session and both refuse a subscription that belongs to somebody else, so a given AWS subscription can only ever be attached to one three.ws account:

| Status | Meaning |
|---|---|
| `401 unauthenticated` | No valid session. Sign in and retry. |
| `403 customer_linked_to_other_account` | This subscription is already attached to a different account. |
| `404 customer_not_found` | Unknown subscription record. Re-open the setup link from Marketplace. |
| `409 subscription_inactive` | Cancelled or expired. Re-subscribe first. |

Code: [`api/aws-marketplace/`](https://github.com/nirholas/three.ws/tree/main/api/aws-marketplace), [`api/_lib/aws-marketplace.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/aws-marketplace.js), and the bridge into the x402 authorization path in [`api/_lib/aws-marketplace-bridge.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/aws-marketplace-bridge.js).

---

## 3. The agent half: a budget, not a key

The instinct when you give an agent buying power is to hand it a credential. That is the wrong primitive. A credential is unbounded until revoked, and revocation is a human action that happens after the money is gone.

What an agent should get is a **policy**: a budget, a set of allowed counterparties, a per-call ceiling, and an expiry. The agent proves it is acting under that policy on every spend, and the ceiling is enforced where it cannot be raced.

Two implementation notes that cost us real debugging time:

**Reserve, then settle, then complete.** Our agent-to-agent hire ledger writes the row as `pending` and reserves the spend against the owner's policy in the same statement that checks it. The payment then runs over the real rails. Because the protocol verifies before it settles, a failure means no funds moved: we release the reservation and flip the row to `failed`. Only after settlement do we mark `completed` and attach the settlement signature, payer address, and result summary. Our public volume roll-up counts `completed` rows and nothing else, so "volume" means "money actually moved, signature on file", not "requests attempted".

**Put the guard in the same statement as the state change.** A read-then-write budget check across two statements is a race that concurrent agents will find within hours. Ours are single statements with the condition inline. This sounds obvious written down; it was not obvious while writing the happy path.

The generalisation we now design against: **an autonomous spend needs the same three properties as a database transaction.** Atomic (the check and the reservation are one operation), consistent (the ledger and the policy cannot disagree), and durable (every attempt is logged, successes and failures alike, because the failures are where the fraud and the bugs live).

---

## 4. Preflight: do not pay a seller that cannot settle

HTTP 402 as a protocol is elegant: a caller requests, gets a structured `402` challenge with payment requirements, pays, retries with proof. But it says nothing about whether the seller on the other side is actually capable of completing the exchange.

We learned this by losing calls to sellers that answered a challenge, took the proof, and then failed on their own settlement path. So we published a preflight check that answers the question before anything moves: is the challenge well-formed, is the receiving address real, does the seller's declared chain and asset match what it is asking for, does its settlement path respond.

A related discipline we hold ourselves to: our own paid caller re-fetches the challenge and settles against the **fresh** requirements if a paid replay itself answers `402`, since that means the seller refused the proof (a re-quote between probe and replay, typically). The signed transfer is never broadcast in that case, so no money moved and exactly one retry is safe. The retry is bounded at one attempt and re-applies both the spend cap and the recipient allowlist to the new quote.

If you build an agent that pays for things, budget engineering time for the *failure* paths of the payment protocol. The success path is a weekend. The failure paths are the product.

---

## 5. Can this agent act at all? A different health check

An unrelated incident reshaped how we think about readiness. An audit found twelve armed autonomous agents: worker `Ready`, minimum instances up, feed streaming, every strategy row enabled. Ten of them had not attempted an action in weeks.

Three unrelated things were wrong, and none was visible to anything we measured. The deployed worker image predated a commit that moved the model chain onto models that still existed, so the whole chain answered 404 and 410. The surviving providers were out of credit or on a billing hold. And several agent wallets could not fund a single action.

Liveness measures the process. Acting requires a chain of preconditions the process knows nothing about. So we built [agent vitals](https://three.ws/docs/agent-vitals): preconditions as **vitals** with `needs` edges, actions as **capabilities** that AND over them, and attestation that returns the *root* blocker rather than a symptom.

```
deploy-fresh ──> cognition ──┐
                             ├──> [enter]
armed, solvency, feed, rpc ──┘

rpc ─────────────────────────────> [exit]
```

The engine is framework-agnostic with zero dependencies ([`packages/agent-vitals`](https://github.com/nirholas/three.ws/tree/main/packages/agent-vitals)). If you operate a fleet of agents on AWS, this is the check your dashboard is missing, whatever you build it with. "Healthy and structurally unable to work" is a state that will not show up in your existing metrics.

The sibling idea is [Brownout](https://three.ws/brownout): publish **proven** fallbacks rather than promised ones. A failover path nobody has exercised under load is a hypothesis, not a fallback, and every fleet has a folder full of hypotheses labelled as redundancy.

---

## 6. The end of the chain stopped being an API response

Here is the part that made all of the above matter more than it did last year.

[Materialize](https://three.ws/materialize) turns a generated 3D model into a real object: printed in resin, nylon, colour sandstone, or steel, and shipped to an address. It is a page for humans, and it is an API, which means an agent can order a physical object of a model it just generated with no human anywhere in the loop.

The pipeline, and why each stage exists once the buyer might be a machine:

1. **Free, keyless analysis.** A printability report before any price: closed solid or not, how many separate bodies, where the holes are, thinnest wall, exact volume, and a 0 to 100 score with named deductions in plain language. Free on purpose. An agent that can check printability before paying to generate spends less overall, and a check that costs money is a check nobody runs.
2. **A signed quote token**, valid 24 hours, so the quoted price is the paid price and the quote cannot be tampered with in between.
3. **Two checkouts, one pipeline.** A human pays in the browser; an agent pays over 402. Same order record, same statuses, same fulfillment.
4. **Safety screening before production.** Weapons, functional key duplicates, and third-party brand marks are refused. A print bureau has a human at that checkpoint; an API whose buyer is an agent does not, so the checkpoint has to be code that is allowed to say no.
5. **Provenance in the box.** Every print ships with a certificate of authenticity attested on-chain, with a QR code, so the object can prove which generation produced it. Creators can cap how many copies of a model will ever exist.
6. **Order tracking** at every step, because "the agent bought something and we cannot tell the owner where it is" is not a shippable state.

The architectural lesson is the one I would take to any team building agent commerce: **irreversibility should be preceded by a free, honest dry run.** Quote is free, detailed, and refusable. Order is the only call that costs anything, and by the time it is made, every question has been asked and answered by a machine that could still change its mind.

---

## 7. What we would build differently

Four things, stated plainly, because partner articles that only contain wins are not useful to anyone.

**Model the counterparty, not just the call.** For a long time our spend policies constrained amounts and rates. They did not constrain *who*. Recipient allowlists arrived after we needed them, which is the wrong order.

**Log failures with the same care as successes.** Every autonomous call we make is recorded, success and failure alike, with the challenge, the decision, and the outcome. Our early failure logging was thinner than our success logging, and that is exactly backwards: nobody debugs a success.

**Write the refusal before the interface.** For every capability that touches money or matter, we now write the server-side refusal first and the interface second. A guard that lives in prompt text or in a hidden button is not a guard.

**Separate the free surface from the paid surface at the server boundary, not with a flag.** Our free 3D generation server has no payment code in it at all. Not disabled: absent. A reviewer can verify that claim in a minute, and so can we, forever.

---

## 8. Try it without an AWS account

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
```

- **Source:** [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws) (Apache-2.0)
- **Docs:** [three.ws/docs](https://three.ws/docs), including [Materialize](https://three.ws/docs/materialize), [agent vitals](https://three.ws/docs/agent-vitals), [simulation readiness](https://three.ws/docs/sim-readiness), and the [AWS Marketplace integration](https://three.ws/docs/aws-marketplace)
- **Previous articles from us here:** the AWS Marketplace SaaS metering walkthrough, and the platform overview for AWS builders

Questions about any of it are welcome. The parts I would most like other builders to argue with are section 3 (policy instead of credential) and section 6 (the free dry run in front of the irreversible call), because both started as opinions and only later turned out to be load-bearing.
