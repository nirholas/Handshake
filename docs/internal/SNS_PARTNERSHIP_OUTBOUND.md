# SNS partnership — outbound pitch

A short version of [SNS_PARTNERSHIP_PROPOSAL.md](./SNS_PARTNERSHIP_PROPOSAL.md), drafted to be paste-ready for an email or DM to Bilal / SNS leadership. Trim to taste.

---

## Subject

three.ws × SNS — a working integration we'd like to make official

## Body

Hey Bilal,

three.ws is the embodiment layer for Solana agents — 3D avatars that live on-chain, accept x402 payments, and trade on Pump.fun. We've quietly built a full SNS integration over the last week and would like to make it official.

**What's already shipped on three.ws (no asks on your end):**

1. **x402 payment routing by .sol name.** Every 402-Payment-Required manifest a three.ws agent emits now carries `recipient_name` next to the wallet address. The payer sees `claude.threews.sol`, not `7xKX…9aBn`, before they sign. First implementation of pay-by-name x402 in the Solana ecosystem. `POST /api/x402/pay-by-name` resolves any of three namespaces — `@username`, raw `.sol` (including subdomains), or base58 address — and returns either a built USDC transfer tx for the payer to sign, or settles directly from the caller's agent wallet.

2. **Agent ↔ .sol binding.** Users can attach an existing .sol they own to one of their agents (`POST /api/agents/:id/sns`), or register a fresh one in-flow with either the agent's wallet paying USDC or the user's wallet paying SOL. Once bound, every public surface — agent page, x402 manifest, MCP tool list, marketplace card — displays the .sol name in place of the raw wallet.

3. **`threews.sol` subdomains, one-call mint.** We own `threews.sol`. We've built a single endpoint that mints `<label>.threews.sol`, sets a URL record pointing to the user's three.ws showcase page (so **Brave resolves the subdomain directly to the showcase**), and transfers ownership to the user — atomically, in one tx, with three.ws absorbing the SOL gas. From the user's side: type a label, click mint, done. End-to-end in ~5 seconds. Every three.ws user is one POST from owning a `*.threews.sol` and a Brave-resolvable showcase at `https://three.ws/u/<label>`.

**What we're proposing:**

- **Co-marketing** at launch. One email to the .sol holder list + one X post + one Discord drop, in exchange for symmetric coverage on our side. We're going live with the `*.threews.sol` program imminently.
- **Listed partner** on the SNS partners page as the embodiment / agent-identity partner.
- **Partner-tier rate limits** on `sns-api.bonfida.com`. Our `recipient_name` enrichment hits forward + reverse lookup on every manifest emission and showcase load, so formalising the relationship benefits both sides.
- **Shared roadmap channel** for subdomain primitives we're hitting friction on — sub-of-sub naming, transfer hooks, embedded-avatar SOL records.

**The ask is small. The demo is real.** I can show you a working flow on a 15-minute call this week: claim `claude.threews.sol`, attach it to a fresh agent, get paid by name, all confirmed on-chain. No deck. Working software.

Code references:

- Subdomain mint: [api/sns-subdomain.js](../../api/sns-subdomain.js), [src/solana/sns-subdomain.js](../../src/solana/sns-subdomain.js)
- Pay-by-name: [api/x402/pay-by-name.js](../../api/x402/pay-by-name.js), [api/_lib/x402.js](../../api/_lib/x402.js)
- User-level subdomain claim + showcase binding: [api/threews/subdomain.js](../../api/threews/subdomain.js), [api/users/by-subdomain.js](../../api/users/by-subdomain.js)
- Agent ↔ .sol attach: [api/agents/sns.js](../../api/agents/sns.js)
- Claim UI: [pages/threews-claim.html](../../pages/threews-claim.html), live at `https://three.ws/threews/claim`

— Nicholas

---

## One-liner version (for X DM / Telegram)

> Built three.ws ↔ SNS end-to-end: pay-by-`.sol`-name in x402 manifests, agent-bound .sol identities, and a one-call `*.threews.sol` subdomain mint that resolves directly in Brave. 30 of our users could claim a subdomain by Monday. Want to co-launch it?
