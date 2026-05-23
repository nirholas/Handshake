# three.ws × SNS — Partnership Proposal

**To:** Bilal El Alamy / SNS leadership
**From:** Nicholas, three.ws
**Date:** 2026-05-23

---

## Why now

SNS owns Solana's identity layer — 350K+ .sol domains, the canonical wallet-to-name map. three.ws is the embodiment + commerce layer — 3D agents that live on Solana, transact via x402, trade on Pump.fun.

We are not asking you to build anything. The integration is shipped end-to-end on our side. This proposal is to make the partnership official, joint-marketed, and (where it makes sense) revenue-shared.

---

## What is live on three.ws right now

### 1. x402 payment routing by .sol name

Every `402 Payment Required` manifest a three.ws agent emits now carries the recipient's .sol domain alongside the base58 wallet. Payers — humans or agents — see and verify the human-readable name before signing.

- New field: `recipient_name`, populated from `meta.sns_domain` or by resolving a .sol-style `payments.receiver` via SNS at manifest emission time.
- Fully backward-compatible — clients that don't read the new field continue to pay the base58 `recipient`.
- Code: [api/_lib/x402.js](../../api/_lib/x402.js).

This is the first x402 implementation in the Solana ecosystem that pays *by name*.

### 2. Subdomain minting under `threews.sol`

three.ws owns `threews.sol`. Two endpoints expose two flows; both atomically mint, set the SNS `URL` record (so the subdomain is Brave-resolvable), and transfer ownership — all bundled into one VersionedTransaction so the subdomain is never claimable by a third party in between.

- **User flow:** [POST /api/threews/subdomain](../../api/threews/subdomain.js)
  - Label must equal the caller's `users.username` (impersonation guard).
  - URL record → `https://three.ws/u/<label>` (the user's storefront).
  - Claim is recorded in [`user_subdomains`](../../migrations/20260523130000_create_user_subdomains.sql).
- **Agent flow:** [POST /api/sns-subdomain](../../api/sns-subdomain.js)
  - Label is arbitrary (defaults to slugified agent name), reuses the same denylist.
  - URL record → `https://three.ws/a/<agent_id>` (the agent's page).
  - Writes `meta.sns_domain` on `agent_identities` so x402 manifests can carry the new name immediately.

Shared on-chain primitive: [src/solana/sns-subdomain.js](../../src/solana/sns-subdomain.js) — `createSubdomain` + `createRecordV2Instruction(url)` + `transferSubdomain` in one tx, signed only by the platform keypair (`THREEWS_SOL_PARENT_SECRET_BASE58`). Platform absorbs SOL gas. Zero wallet-signing friction for the user.

### 3. SNS-resolved storefronts in Brave

Because every subdomain has a `URL` record set at mint time, typing `nich.threews.sol` in Brave (or any SNS-aware client) resolves directly to the user's `/u/nich` showcase on three.ws — no plugin, no extension, no extra steps. The showcase ([pages/profile.html](../../pages/profile.html), backed by [/api/users/:username](../../api/users/[username].js)) renders the user's public agents, avatars, paid skills, widgets, and socials — already wired and live before this session.

For agent-attached subdomains (`claude.threews.sol`, `vernington.threews.sol`), the same Brave-resolution path lands users on the agent's page directly. Every agent is one POST away from owning its own .sol address.

### 4. Register and assign existing .sol names to agents

Users who already own a .sol domain can attach it to an agent — no minting required:
- `POST /api/agents/:id/sns { domain }` — verifies on-chain ownership against the agent's wallet and the user's linked Solana wallets, then writes `meta.sns_domain`.
- `register-prep` / `register-confirm` — user-pays variant; builds an unsigned tx the user signs.
- `register` (agent-pays variant) — the agent's own USDC ATA pays for the domain registration and the alias attaches automatically.
- Code: [api/agents/sns.js](../../api/agents/sns.js).

---

## What we ask from SNS

1. **Co-marketing.** One email + one X post + one Discord drop to the .sol holder base when we launch the `*.threews.sol` program. Symmetric coverage on our channels.
2. **Partner listing.** three.ws on the SNS partners page as the official embodiment partner.
3. **API tier.** Partnership-grade rate limits on `sns-api.bonfida.com` — our `recipient_name` enrichment hits SNS on every x402 manifest emission for named agents, so we are the heavy reader you would want to formalise.
4. **Shared channel.** A Telegram / Slack to coordinate on subdomain primitives — sub-of-sub naming, on-chain SOL records pointing at avatar bundles, transfer hooks, IPFS record support for self-hostable storefront snapshots.

## What SNS gets

- A consumer visual product attached to every .sol — domain perceived value goes up, retention goes up.
- Distribution into the AI-agent narrative (currently the dominant Solana retail story via Pump.fun).
- Revenue share on co-branded subdomain pricing tiers (vanity labels, single-letter subs).
- Featured placement across three.ws agent pages, MCP tooling, the marketplace, and every paid x402 receipt — every payment for a named agent advertises SNS by name.

---

## Proposed next step

A 30-minute call this week. We bring a working demo:

1. New user signs up, claims `claude.threews.sol` via three.ws — on-chain in under 5 seconds, zero gas paid by the user.
2. Type `claude.threews.sol` into Brave — lands on `https://three.ws/u/claude` showing the user's agents, avatars, paid skills.
3. Spawn a fresh agent. Mint `vernington.threews.sol`, attach to the agent. Type `vernington.threews.sol` in Brave — lands on the agent's page directly.
4. Make an x402 payment to the agent. The 402 manifest shows `recipient_name: "vernington.threews.sol"`. The payer verifies the name before signing.

No slides. Working software.

---

## Appendix: technical surface

- Forward resolution: `GET /api/sns?name=nich.threews.sol` → `{ address, network: "solana" }`.
- Reverse resolution: `GET /api/sns?address=<base58>` → primary .sol domain.
- User subdomain (claim by username): `POST /api/threews/subdomain { label, owner_wallet? }`.
- Agent subdomain (label-flexible, attaches to agent): `POST /api/sns-subdomain { agent_id, label?, owner_address? }`.
- Subdomain availability: `GET /api/sns-subdomain?label=<label>` or `GET /api/threews/subdomain?label=<label>`.
- Subdomain reverse-lookup (claim → user): `GET /api/users/by-subdomain?label=<label>`.
- Agent attach existing .sol: `POST /api/agents/:id/sns { domain }`.
- Agent register existing .sol (user-pays): `/api/agents/:id/sns/register-prep` + `/register-confirm`.
- Agent register existing .sol (agent-pays): `POST /api/agents/:id/sns/register { domain }`.
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
    "recipient_name": "vernington.threews.sol",
    "memo": "…",
    "valid_until": 1716508800,
    "intent_url": "/api/agents/payments/pay-prep",
    "verify_url": "/api/agents/payments/pay-confirm",
    "retry_with_header": "x-payment-intent"
  }
  ```

- Storefront route: `/u/<label>` → [pages/profile.html](../../pages/profile.html), backed by [`/api/users/<label>`](../../api/users/[username].js).
- Parent owner keypair: held by three.ws under `THREEWS_SOL_PARENT_SECRET_BASE58`. Subdomains transfer ownership atomically with mint and URL record write; the platform never retains custody.
- Tests: 44 SNS-related tests pass (`tests/api/sns.test.js`, `tests/api/threews-sns-helper.test.js`, `tests/solana-sns.test.js`).
