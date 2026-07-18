# Do I need crypto?

Short answer: it depends on what you want to do. Here's the honest breakdown.

---

## Viewing and chatting with agents

**No wallet or crypto needed.** Anyone can open an agent link (`three.ws/agents/<id>`) and chat with it. No account, no extension, no sign-in.

---

## Embedding agents on your site

**No wallet or crypto needed.** Copy the iframe snippet from [Widget Studio](/studio) and paste it into any page. The agent runs in your visitor's browser — no payment, no wallet extension required for them or for you to generate the snippet.

---

## Creating or editing agents

**No wallet needed.** The sign-in page at [three.ws/login](/login) offers two paths side by side:

- **Email + password**: register with just an email address (or a username). No extension, no seed phrase. This is all you need to create, edit, and publish agents.
- **Wallet sign-in**: EIP-4361 SIWE for EVM wallets like MetaMask, or a Solana wallet like Phantom. Choose this if you want on-chain features tied to a wallet you already own.

The two are equivalent for building agents. A wallet only becomes relevant when you use the optional on-chain features below.

---

## Paying for things

Most basic features are free. You pay when you use premium capabilities:

| What | How | Roughly how much |
|---|---|---|
| Hosted AI brain (LLM calls) | A free default model is included; premium Claude models run on a paid plan or your own API key | Free to start |
| Premium skills (skill purchases) | USDC micropayment via x402 | Set by the skill author |
| On-chain registration (ERC-8004) | Small gas fee on Base | A few cents in ETH |

**USDC** is a dollar-pegged stablecoin — 1 USDC ≈ $1 USD. It doesn't go up or down the way ETH or SOL does. When you see a price in USDC, you can treat it as dollars. Payment surfaces on the platform also show the approximate USD (or SOL) equivalent next to the amount, so you never have to do mental math from crypto to dollars.

---

## On-chain features — what they are and why they're optional

three.ws has a set of on-chain features that are entirely optional. They exist for users who want their agent to:

- **Outlive the platform** — register on Base via ERC-8004 and your agent's identity lives on a blockchain, not just on three.ws servers
- **Be verifiable** — anyone can check the agent's action history without trusting three.ws
- **Have a stable address** — `agent://base/42` works anywhere that speaks the protocol
- **Hold a wallet** — agents can receive and send USDC autonomously via x402

If you don't need any of that, you can ignore it entirely. A basic agent — avatar, voice, embedded chat — works without touching any blockchain.

---

## The only coin on this platform

When you do interact with on-chain features, the platform's native token is **$THREE** (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). This is the only coin three.ws uses. USDC (the payment currency) is a separate, dollar-pegged stablecoin — not a platform token.

---

## Summary

| Task | Wallet needed? | Crypto needed? |
|---|---|---|
| View / chat with an agent | No | No |
| Embed a widget on your site | No | No |
| Create an account and build agents | No (email sign-in works) | No |
| Use a premium skill | Yes + small USDC balance | Yes (USDC ≈ $) |
| Register on-chain (optional) | Yes + gas | Yes (small ETH) |

---

## What's next

- **Create your first agent** → [Make your first agent](./make-your-agent.md)
- **Put it on your site** → [Share & embed](./share-and-embed.md)
- **Optional: register on-chain** → [Register on-chain](./tutorials/register-onchain.md)
- **Technical auth details** → [Authentication](./authentication.md)
