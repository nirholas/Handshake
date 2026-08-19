# X post: onchain-agent-wallets

Announcement copy for [github.com/nirholas/onchain-agent-wallets](https://github.com/nirholas/onchain-agent-wallets),
the MCP server that gives an AI agent a Solana spending allowance instead of a private key.

**Thesis of this announcement:** handing an agent a keypair is the wrong primitive, and the chain
already has the right one. Nothing else. No token talk, no roadmap, no "the future of agentic
commerce."

**Every claim below is true today**, verified against the shipped 0.1.0 code: the vault token
account is owned by the human and derived deterministically from their address plus the agent id;
the agent holds only an SPL Token delegation capped by `approve`; the token program decrements
`delegated_amount` on every spend and refuses anything above it; one owner-signed `revoke` sets it
to zero; the owner can withdraw without the agent's cooperation; 14 MCP tools; 22 tests; the
delegation test runs the real SPL Token program in process and asserts that spending 61 against a
remaining allowance of 60 fails on-chain while 460 sits in the vault; guardrails (per-transaction
cap, rolling 24h cap, recipient allowlist, x402 host allowlist, expiry, pause, confirm-above
threshold) are checked before signing; `pay_x402` reads the price from the unpaid 402 before any
money moves; owner actions return an unsigned transaction for Phantom, Solflare, Backpack, or a
Ledger, so no secret key is needed on the machine.

**Things to NOT claim:**

1. **Do not call it audited.** It is tested against the real token program, which is a different and
   weaker claim. "The token program enforces it" is true and strong enough.
2. **Do not claim a live x402 settlement volume or any usage numbers.** It shipped today.

**Now live, so the drafts below are all postable:** `npx -y @three-ws/onchain-agent-wallets`
(verified: 14 tools over stdio from a clean install), and
`io.github.nirholas/onchain-agent-wallets@0.1.0` in the official MCP registry, flagged latest and
active.

---

## 1. Main post (recommended)

267 characters with X's 23-character URL count, so it posts from any account, Premium or not.

> Everyone hands their AI agent a private key.
> Then keeps $20 in the wallet, because that's the blast radius.
>
> Give it an allowance instead.
>
> Solana's token program enforces the cap, decrements it every spend, and you revoke in one
> instruction.
>
> github.com/nirholas/onchain-agent-wallets

Why this one: the first two lines name a thing every builder has actually done and quietly felt bad
about, which is what earns the repost. "Blast radius" is the phrase doing the work. The fix arrives
as one short line, and the mechanism follows so nobody has to take it on faith. It never says "MCP",
because the people who need MCP will click, and the people who do not would have bounced on the
acronym.

## 2. Alternate: the proof

For a technical timeline. Leads with the test rather than the pitch. 259 characters.

> We wrote a test that gives an agent a 100 USDC allowance, spends 40, then tries to spend 61 with
> 460 USDC still sitting in the vault.
>
> It fails on-chain. Not in our code. In Solana's token program.
>
> That refusal is the entire product.
>
> github.com/nirholas/onchain-agent-wallets

Why this one: engineers trust a failing transaction more than any amount of copy. It also
pre-empts the first reply you will get, which is "so what stops the agent ignoring your limits."

## 3. Alternate: x402 / agent-payments timeline

269 characters.

> Your agent can pay for its own APIs now, without you handing it a wallet.
>
> It gets an allowance. It pays the x402 invoice out of that allowance. The price is read before any
> money moves, and the chain caps the total.
>
> Revoke in one instruction.
>
> github.com/nirholas/onchain-agent-wallets

## 4. Alternate: builder-facing

Now unblocked: the package is live on npm and the command below is verified working. For a
timeline that already knows what MCP is, this is arguably the strongest of the four, because the
install line makes it real in one glance.

> ```
> npx -y @three-ws/onchain-agent-wallets
> ```
>
> 14 MCP tools that give an agent a Solana wallet it cannot drain: an on-chain spending cap, per-tx
> and daily limits, recipient and host allowlists, an audit log of every refusal, and x402.
>
> You keep custody. Revoke any time.
>
> github.com/nirholas/onchain-agent-wallets

---

## Thread version

Post 1 is the main post above. Then:

**2/**

> The problem with agent wallets: a keypair is all-or-nothing. Whoever holds it can move everything
> in the account. There is no ceiling, no allowlist, no expiry, and no way to take it back without
> racing the agent.

**3/**

> So the money never goes to the agent.
>
> It sits in a vault account you own. The agent gets an SPL Token delegation over it, capped. Every
> spend decrements the cap. Spend past it and the token program rejects the transaction.

**4/**

> On top of that: per-transaction cap, rolling 24h cap, recipient allowlist, x402 host allowlist,
> expiry, pause, and a threshold above which a human has to say yes.
>
> Refusals are logged with the exact rule that fired, so you can see what your agent tried to do.

**5/**

> If the machine running the agent is fully compromised, the local rules can be bypassed and the
> on-chain cap still cannot.
>
> That is why they are two layers and not one.

**6/**

> No secret key has to touch the machine either. Owner actions come back as an unsigned transaction
> for Phantom, Solflare, Backpack, or a Ledger to sign.
>
> Free rehearsal on devnet.
>
> github.com/nirholas/onchain-agent-wallets

---

## Replies worth pre-writing

**"Why not a multisig / smart wallet?"**

> Because this needs no new program and no new trust assumption. It is `approve` and `revoke` from
> the SPL Token program, which has been on mainnet for years and is already audited harder than
> anything we would ship. A multisig is a fine answer when you want co-signing. This is the answer
> when you want a ceiling.

**"What stops the agent from just asking you to raise the limit?"**

> Nothing, and that is correct. It should be able to ask. Raising the ceiling is an owner-signed
> `approve`, so a human is in the loop for exactly the decision that deserves one.

**"Solana only?"**

> Today, yes. The custody model is a token-program delegation, so the EVM equivalent is ERC-20
> `approve` with the same shape. Solana first because that is where the agent economy we are
> building actually lives.

---

## Notes on framing

- **Do not lead with MCP.** It narrows the audience to people who already know the acronym, and the
  idea is bigger than the transport.
- **Do not mention $THREE in this post.** There is no fee in this package and no buyback lane, so
  attaching the coin to it would be the kind of claim someone checks and finds hollow. The
  metaplex-agent-mcp post is where the $THREE story is true and load-bearing.
- **"Allowance" is the word.** It is the one term that makes a non-crypto reader understand the
  whole design instantly. Keep it in every rewrite.
- The Pages overview at nirholas.github.io/onchain-agent-wallets is a good second link for a reply,
  not for the main post: one link per post converts better.
- If someone asks where to find it in the MCP ecosystem, the registry name is
  `io.github.nirholas/onchain-agent-wallets`. Worth a reply, not worth crowding the main post.
