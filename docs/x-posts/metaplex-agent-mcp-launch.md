# X post: the agent wallet + on-chain deploy stack is open source

Announcement copy for open-sourcing the infrastructure that's been running three.ws agent wallets:

- [**@three-ws/onchain-agent-wallets**](https://github.com/nirholas/three.ws/tree/main/packages/onchain-agent-wallets):
  gives an agent a Solana wallet as a capped spending allowance, not a private key. Guardrails
  (per-tx cap, daily cap, allowlists, expiry, pause), x402 payments, owner keeps custody.
- [**@three-ws/metaplex-agent-mcp**](https://github.com/nirholas/metaplex-agent-mcp): mints an
  agent onto Solana with its own on-chain wallet and an EIP-8004 identity in the Metaplex Agent
  Registry, in one command.

**Thesis (owner framing, 2026-08-19):** three.ws already had agent wallets, and people know it.
That's not the news. The news is that the infrastructure is now open source, so any developer, any
project, can give their own agents the same thing: a wallet, an identity, and x402 payments,
without building it themselves. That's bullish for $THREE specifically because it's not just
three.ws users deploying agents anymore, it's every project that plugs into this stack, and every
deploy pays a fee that funds $THREE buybacks. Lead with the open-source/developer angle, not "an
agent has a wallet" (old news, less bullish) or a mint-drop framing (wrong thesis entirely, no
supply/collection talk).

**Verified true today** (shipped code, checked against mainnet): `metaplex-agent-mcp` is at 0.2.0
on npm and in the official MCP registry (`io.github.nirholas/metaplex-agent`); a mainnet deploy
through it costs ~0.007 SOL rent plus a 0.02 SOL fee paid to the wallet the $THREE buyback lane
spends from, halved at 50,000 $THREE held in the paying wallet and waived at 250,000, free on
devnet; keys never leave the client either way (agent's own key, or Phantom/Solflare/Backpack/
Ledger). `onchain-agent-wallets` is live and published, funds sit in a vault the owner controls, the
agent holds a capped SPL Token delegation the token program itself enforces on-chain.

**One thing to NOT claim:** that $THREE buybacks are running right now. The fee lane is wired and
funded, but `buyback.enabled` is currently `false` on the public ledger
([`/api/three-token/stats`](https://three.ws/api/three-token/stats)), and someone will check.
"Every deploy funds $THREE buybacks" is true and safe. "We are buying back $THREE right now" is
not, until that flag flips.

---

## 1. Main post (recommended): open source, developer-focused

> We open-sourced our agent wallet + on-chain deploy + x402 stack.
>
> Any project can now give their agents a Solana wallet, an EIP-8004 identity, and payment rails in
> one command. No account, no server.
>
> Every deploy through it funds $THREE buybacks.
>
> github.com/nirholas/metaplex-agent-mcp

Why this one: it doesn't re-announce something people already know (three.ws agents have wallets).
It announces that the *infrastructure* is now anyone's to build on, which is the actually-new,
actually-bullish fact. The last line is the whole investment thesis in six words.

## 1b. Alternate: sharper on the mechanism

> Just open-sourced the agent wallet stack that's been running on three.ws.
>
> `npx @three-ws/metaplex-agent-mcp` gives any project on-chain wallets, identity, and x402
> payments for their agents. One command, self-custodial, MCP-native.
>
> Every project that builds on it becomes a $THREE buyer.
>
> github.com/nirholas/metaplex-agent-mcp

The line to protect in any edit: **"every project that builds on it becomes a $THREE buyer."**
That's the actual bull case, stated plainly: this isn't three.ws's own deploy volume, it's every
other project's users too, compounding.

## 1c. Alternate: tightest cut

> We open-sourced the infrastructure behind three.ws agent wallets.
>
> Any developer, any project, can now give their agents a real Solana wallet + on-chain identity +
> x402 payments. One command.
>
> Every integration is a $THREE buyer, forever.
>
> github.com/nirholas/metaplex-agent-mcp

## 2. Superseded framing (kept for reference, not recommended)

Drafted before the open-source/developer reframe. Still technically accurate, but leads with
"your agent has a wallet," which the owner correctly flagged as old news for anyone who already
knows three.ws, and it undersells the actual story.

> Your agent can now hold its own wallet.
>
> One command and it deploys itself into the Metaplex Agent Registry on Solana: its own on-chain
> wallet, an EIP-8004 identity, x402 on.
>
> The 0.02 SOL deploy fee buys $THREE. Hold 250k and you deploy free, forever.
>
> github.com/nirholas/metaplex-agent-mcp

## 3. Thread (use if the main post lands)

**1/**
> We open-sourced the agent wallet + on-chain deploy stack that's been running on three.ws.
>
> Any project can now give their agents the same thing: a Solana wallet, an on-chain identity, and
> x402 payments. One command, self-custodial.
>
> Here's what shipped. 🧵

**2/**
> Two pieces, both real, both open source today.
>
> **onchain-agent-wallets**: an agent gets a Solana wallet as a capped spending allowance, not a
> key. **metaplex-agent-mcp**: an agent gets minted on-chain with its own identity in the Metaplex
> Agent Registry.

**3/**
> The wallet piece: your money stays in a vault YOU own. The agent gets a delegation with a
> ceiling, and the Solana token program itself refuses any spend past it, no matter how the agent
> is prompted. Per-tx caps, daily caps, allowlists, a pause switch. Revocable in one instruction.

**4/**
> The identity piece: mint a Metaplex Core asset, register an EIP-8004 identity, done. The agent
> gets its own on-chain wallet (the asset's own signer, not one you made and named after it) and
> shows up in the Metaplex Agent Registry with a portable, publicly-readable identity.

**5/**
> Both speak x402. An HTTP 402 comes back with a price, the agent checks it against its
> guardrails, pays, gets the response. No key sharing, no invoice, no human in the loop for a
> $0.001 call.

**6/**
> Custody is the part we refused to compromise on, in both packages. Agents sign with their own
> keypair or a capped delegation, never a raw key with no ceiling. Owner actions come back as
> unsigned transactions for Phantom, Solflare, or a Ledger. Nothing custodial on our servers, ever.

**7/**
> Now the part that makes this pay for itself.
>
> A mainnet deploy through metaplex-agent-mcp costs 0.02 SOL on top of rent. That fee goes to the
> wallet the $THREE buyback lane spends from. Deploys fund buybacks. That's the business model.

**8/**
> And holding $THREE is how you stop paying it.
>
> 50,000 $THREE in the paying wallet halves the fee. 250,000 waives it. Read live from the chain
> when the transaction is built. Nothing staked, nothing locked. Hold the tokens, deploy your whole
> fleet free.

**9/**
> This is why open-sourcing it is bullish, not just generous: every project that plugs into this
> stack sends deploy fees to $THREE buybacks. Not just our users. Anyone's.

**10/**
> Works in any MCP client:
>
> ```
> claude mcp add metaplex-agent -- npx -y @three-ws/metaplex-agent-mcp
> claude mcp add onchain-agent-wallets -- npx -y @three-ws/onchain-agent-wallets
> ```
>
> Or skip the install and deploy from the browser.

**11/**
> Open source. Real programs, real Solana, no mocks.
>
> github.com/nirholas/metaplex-agent-mcp
> github.com/nirholas/three.ws/tree/main/packages/onchain-agent-wallets

## 4. Reply-slot copy (post as first reply to the main post)

Use this to carry the second link and the browser path without spending the main post's one
outbound slot.

> The wallet half of this is @three-ws/onchain-agent-wallets, a capped spending allowance
> enforced by the Solana token program itself, not a raw key. And if you just want to see the
> deploy: the browser version builds the transaction locally, your wallet signs it, nothing
> touches a server.
