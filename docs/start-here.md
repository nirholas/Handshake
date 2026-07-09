# Start here

Welcome to three.ws. If you're new, this is the right place to begin — no prior experience with 3D, AI, or crypto required.

---

## What is three.ws?

three.ws lets you create AI agents that live inside a 3D avatar — a character that speaks, reacts, and can be embedded anywhere on the web.

Think of it as giving your AI a body and a face. Instead of a plain text chatbox, your agent appears as a 3D character that talks, waves, and expresses emotion. It still uses the same AI models (Claude, GPT, etc.) under the hood — it just has a presence.

**You can:**

- Create a 3D AI character that responds to questions in natural language
- Pick from a gallery of avatars or upload your own 3D model
- Embed the agent on any website with a single line of code
- Give it a personality, a voice, and a set of capabilities ("skills")
- Optionally give it an on-chain identity so it outlives any single platform

**You don't need:**

- Any coding experience to create and embed a basic agent
- Crypto or a wallet to view or embed agents made by others
- A 3D background — the platform handles all the rendering

---

## Two kinds of people use three.ws

**Creators (no code required):** You want to publish a 3D AI character — for your business, your personal site, a product, or just for fun. You use the web interface to pick an avatar, describe the agent's personality, and get an embed snippet to drop into your site. Start with [Make your first agent →](./make-your-agent.md)

**Developers:** You want to build on top of the platform — integrate the `<agent-3d>` web component, write custom skills, call the REST API, or self-host the stack. Start with the [Introduction →](./introduction.md) or [Quick start →](./quick-start.md)

---

## The four things on three.ws

Every page on the platform is one of four things. Knowing these will orient you:

| | What it is | Where to find it |
|---|---|---|
| **Avatar** | A 3D model — the body | `/marketplace` |
| **Agent** | An AI mind wearing an avatar | Your dashboard |
| **Marketplace** | Where avatars (and shared agents) live | `/marketplace` |
| **Studio** | Where you assemble everything | `/studio` |

For a deeper explanation of how agents and avatars differ, see [Agents vs. Avatars →](./agents-vs-avatars.md)

---

## The non-developer track

If you're here to create and share agents rather than write code, follow this path in order:

1. **[Agents vs. Avatars](./agents-vs-avatars.md)** — understand the two core concepts (5 min read)
2. **[Make your first agent](./make-your-agent.md)** — create a 3D AI character in the browser, no code
3. **[Share & embed](./share-and-embed.md)** — get the embed snippet and put your agent anywhere
4. **[Do I need crypto?](./do-i-need-crypto.md)** — honest answers to the wallet and payment questions

---

## Ready to build?

- **Just exploring?** → Open [Discover](/discover) to browse agents others have built
- **Creating your first agent** → Go to [/start](/start) — a 5-step wizard walks you through it
- **Meeting avatars in the worlds?** → Press <kbd>I</kbd> on anyone in `/play`, `/city`, a coin world, or `/agora` to see who they are — the [avatar inspector](./avatar-inspector.md) shows their reputation, wallet, and profile
- **Making 3D models?** → [The free 3D Studio MCP](./mcp-studio.md) turns a prompt into a model, avatar, or rigged character — and lets you refine it by talking to it (*"make it metallic"*) with a revertable version history. Publish a model as remixable and earn on-chain royalties when others build on it: [the remix economy](./remix.md)
- **Trading?** → [The trading surfaces](./trading-surfaces.md) maps the solo stack (Radar, Coin Intelligence, Live Trade Feed, Watchlist, Mission Control); [trading arenas](./trading-arenas.md) covers tournaments, the theater, vaults, and swarms; [Oracle](./oracle.md) is the conviction engine underneath all of it
- **Trusting an agent with money?** → [Custody you can verify](./custody.md) — spend limits, freeze, Merkle proof-of-custody, and social recovery; [claim your wallet](./trader-card.md) turns any pump.fun track record into a public, provable Trader Card. Every real-funds feature sits behind the [risk acknowledgment](./risk-acknowledgment.md) — read the [Risk Disclosure](https://three.ws/legal/risk) before committing anything
- **Vetting a counterparty before you pay it?** → [Trust primitives](./trust-primitives.md) — the cross-chain Agent Reputation endpoint scores ANY wallet, mint, or agent id (Solana or EVM) 0–100 from real on-chain evidence, in one paid call, before your agent transacts
- **Debugging an x402 integration?** → [x402 developer tools](./x402-dev-tools.md) — a free test bench: echo your payment envelope (signatures redacted), debug a failed 402 exchange into an ordered fix list, and verify a receipt's attestation and on-chain settlement, all against a live server without spending anything
- **Paying from the BNB ecosystem?** → [BNB Chain payments](./bnb-payments.md) — three.ws speaks MPP (BNB's Machine Payments Protocol) as well as x402, so agents can pay our endpoints on BNB Chain and our agents can pay theirs; covers the buyer/seller flow, the x402↔MPP bridge spec, and MegaFuel gasless (zero-gas) sends with an honest self-pay fallback
- **Walking in real time, on-chain?** → [The on-chain world](./bnb-world.md) — `/agora`'s Play mode has an opt-in toggle that commits your walk to a real BNB Chain contract at its live ~0.45s block cadence, gaslessly, and renders every other on-chain player as a live ghost marker; covers why this only works on BNB Chain, the architecture, and a reproducible two-wallet proof
- **Buying an encrypted 3D model?** → [The vault](./bnb-vault.md) — `/vault` sells access to encrypted 3D models gated by a real BSC purchase that triggers a real cross-chain Greenfield permission grant; covers the buyer flow (browse, buy, settle, unlock, view — all decrypted client-side), the local session-key wallet model, and a reproducible anvil-fork browser proof
- **Want a branded on-chain address?** → [Vanity grinder](./vanity.md) — grind a Solana address that starts with your ticker (branded token mint or agent/treasury wallet) in one paid USDC call; keypair or importable mnemonic, nothing stored, optional sealed delivery, plus a provably-fair variant and a pre-ground premium inventory
- **Going Pro?** → [Paid plans](./plan-checkout.md) — upgrade with a single on-chain payment in USDC, SOL, or $THREE (the platform coin takes 20% off); [hold-to-access](./hold-to-access.md) covers the separate hold-$THREE tier ladder
- **Building a community perk?** → [Token-gated 3D embeds](./token-gated-3d-embeds.md) — turn an avatar or on-chain agent into a holder-only interactive embed; visitors prove a real, server-verified on-chain balance before the live scene renders, no download-only gate
- **Developer docs** → Read the [Introduction](./introduction.md) for the full technical picture
- **Your agent needs a face?** → [OKX.AI marketplace services](./okx-marketplace.md) — the Agent Identity Studio and the pay-per-call 3D services other agents buy from us; demo identities at [/agent-identities](/agent-identities)
- **Buying 3D asset work per call?** → [The 3D Asset Pipeline](./3d-pipeline.md) — pay a few cents in USDC to rig, remesh, make game-ready, stylize, or background-remove an asset; one call, one finished URL, no account or API key
- **Want your agent to have a body?** → [Embodiment](./embody.md) — one $1 USDC call turns a prompt or image into a rigged, animated, voiced 3D avatar plus a one-tag embed for any website; no account, no separate rigging step
- **Building UI?** → [ui-juice](./ui-juice.md) is the shared game-feel library (count-ups, sparklines, ring gauges, live dots, the "it shipped" ripple) every surface animates with
- **Teaching another AI to use three.ws?** → [The Agent Skills pack](./agent-skills.md) — portable `SKILL.md` folders that give any Claude surface (Claude Code, the Claude apps, the Agent SDK) three.ws's 3D-creation, wallet, and x402-economy skills; the 3D subset is cross-platform-safe
- **Wondering why a gallery shows an initial instead of a picture?** → [Avatar thumbnails](./avatar-thumbnails.md) — where an avatar's preview image comes from, the one rule every code path obeys (never publish a thumbnail URL whose object doesn't exist), the two crons that keep coverage at 100%, and how to run the backfill
