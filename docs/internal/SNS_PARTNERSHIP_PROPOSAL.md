# three.ws × SNS — Partnership Proposal

**To:** Bilal El Alamy / SNS leadership
**From:** Nicholas, three.ws
**Date:** 2026-05-23

---

## Why now

SNS owns Solana's identity layer — 350K+ .sol domains, the canonical mapping from human-readable name to wallet. three.ws is building the embodiment layer — 3D agents that live on Solana, transact via x402, and trade on Pump.fun. Every .sol domain deserves a face. Every three.ws agent needs a name. The fit is structural, not cosmetic.

We are not asking SNS to build anything new. We have already shipped the integration end-to-end on our side. This proposal is about making the integration official, joint-marketed, and (where it makes sense) revenue-shared.

---

## What is already live on three.ws

### 1. x402 payment routing by .sol name

Every x402 402-Payment-Required manifest emitted by a three.ws agent now carries the recipient's .sol domain alongside the wallet address. Payers — humans or agents — see and verify the human-readable name before signing.

- **Manifest field added:** `recipient_name`, populated from the agent's `meta.sns_domain` or by resolving a .sol-style `payments.receiver` via SNS.
- **Fully backward-compatible:** clients that don't read `recipient_name` continue to pay against `recipient` (base58 wallet) as before.
- **Code:** [api/_lib/x402.js](../../api/_lib/x402.js) — `resolveRecipient()` + `emit402()` + `manifestOnly()`.

This is the first x402 implementation in the Solana ecosystem that pays *by name*.

### 2. User-registered names assigned to agents

Users can register a .sol domain and assign it to one of their agents in a single flow. From that moment, every public surface the agent appears on — agent page, x402 manifest, MCP tool listing, marketplace card — displays the .sol name in place of the raw wallet.

- **Attach existing .sol:** `POST /api/agents/:id/sns { domain }` — verifies on-chain ownership across the agent wallet and the user's linked wallets, then writes `meta.sns_domain`.
- **Register fresh:** `POST /api/agents/:id/sns/register-prep` + `register-confirm` — builds an unsigned tx for the user's wallet, confirms the on-chain owner, attaches the alias.
- **Agent-pays variant:** `POST /api/agents/:id/sns/register` — the agent's own wallet pays in USDC and the alias is attached automatically.
- **Code:** [api/agents/sns.js](../../api/agents/sns.js).

### 3. Subdomains under `threews.sol`

three.ws owns `threews.sol`. We have built a one-call endpoint that mints any-label subdomain — `nich.threews.sol`, `claude.threews.sol`, `vernington.threews.sol` — and transfers ownership to the user (or their agent) in a single transaction. The platform absorbs the SOL gas cost so there is zero wallet-signing friction.

- **Endpoint:** `POST /api/sns-subdomain { label, agent_id?, owner_address? }`.
- **Availability check:** `GET /api/sns-subdomain?label=nich` — on-chain lookup, no upstream call to Bonfida.
- **Atomic create + transfer:** parent owner keypair signs `createSubdomain` and immediately `transferSubdomain` to the requested final owner, bundled into one VersionedTransaction. The subdomain is never claimable by a third party in between.
- **Code:** [api/sns-subdomain.js](../../api/sns-subdomain.js), [src/solana/sns-subdomain.js](../../src/solana/sns-subdomain.js).

Every three.ws user is one POST away from owning a `*.threews.sol` subdomain. Every agent is one POST away from being named.

---

## What we ask from SNS

1. **Co-marketing.** One email + one X post + one Discord announcement to the .sol holder base when we launch the `*.threews.sol` subdomain program. We commit to symmetric coverage on our channels.
2. **Listing.** three.ws on the SNS partners page as the official embodiment partner.
3. **API tier.** Partnership-grade rate limits on `sns-api.bonfida.com` for bulk resolution and reverse lookups — our `recipient_name` enrichment hits this on every x402 manifest emission, so we are the heavy reader you want to formalise.
4. **Roadmap input.** A shared channel (Telegram / Slack) to coordinate on subdomain-related primitives — sub-of-sub naming, on-chain SOL records for embedded avatars, transfer hooks.

---

## What SNS gets

- A consumer-facing visual product attached to every .sol — increases domain perceived value and retention.
- Distribution into the AI-agent narrative (currently the dominant Solana retail story via Pump.fun).
- Revenue share on co-branded subdomains where we sell pricing tiers (vanity labels, single-letter subs).
- Featured placement across three.ws agent pages, MCP tooling, the agent marketplace, and the public x402 payment manifests — every payment receipt for a named agent advertises SNS.

---

## Proposed next step

A 30-minute call this week. We bring a working demo:

1. A user registers `claude.threews.sol` from our UI — confirmed on-chain in under 5 seconds, zero gas paid by the user.
2. We assign it to a freshly-spawned agent.
3. We make an x402 payment to that agent. The 402 manifest shows `recipient_name: "claude.threews.sol"`. The payer sees and verifies the name before signing.

No slides. Working software.

---

## Appendix: technical surface

- Forward resolution: `GET /api/sns?name=nich.threews.sol` → `{ address, network: "solana" }`.
- Reverse resolution: `GET /api/sns?address=<base58>` → primary .sol domain.
- Subdomain mint: `POST /api/sns-subdomain { label, agent_id?, owner_address? }`.
- Subdomain availability: `GET /api/sns-subdomain?label=<label>`.
- Agent attach: `POST /api/agents/:id/sns { domain }`.
- Agent register (user-pays): `/api/agents/:id/sns/register-prep` + `/register-confirm`.
- Agent register (agent-pays): `POST /api/agents/:id/sns/register { domain }`.
- x402 manifest schema, augmented:

  ```json
  {
    "version": "x402/0.1",
    "kind": "agent-skill",
    "agent_id": "…",
    "skill": "…",
    "amount": "1000000",
    "currency": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "recipient": "<base58 wallet>",
    "recipient_name": "claude.threews.sol",
    "memo": "…",
    "valid_until": 1716508800,
    "intent_url": "/api/agents/payments/pay-prep",
    "verify_url": "/api/agents/payments/pay-confirm",
    "retry_with_header": "x-payment-intent"
  }
  ```

- Parent owner keypair: held by three.ws under `THREEWS_SOL_PARENT_SECRET_BASE58`. Subdomains transfer ownership immediately after mint; the platform never retains custody.
