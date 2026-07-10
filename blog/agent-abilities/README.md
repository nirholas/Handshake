# What a three.ws agent can do — the complete dossier

Source material for the abilities video + article. Every claim was researched
directly from the shipped implementation — 38 research passes over the live
codebase, frontend and backend.

## The frame (read this first)

A three.ws agent is not a wallet with a face. It is an embodied AI being with:

- **a body** — a real 3D avatar, manufactured from a sentence, that any humanoid rig can drive
- **motion** — walking, dancing, posing, touring, reacting live to on-chain events
- **a mind** — persistent memory, reflection ("dreams"), and explainable autonomy
- **a voice** — chat, copilots, narrators, notifications
- **an identity** — names, ENS/SNS, ERC-8004 on-chain registration, reputation
- **skills** — installed abilities wired to real APIs (trading, launches, NFTs, scenes…)
- **screens** — live in-world apps it carries and performs with
- **a job** — it earns, gets hired, hires others, forms teams, can be tokenized
- **a wallet** — a self-custodied Solana wallet with 23 distinct abilities
- **a home** — persistent worlds, arenas, lobbies, friends, and IRL bridges
- **reach** — embeds, plugins, MCP, and mobile take it anywhere on the internet

**The 23 wallet abilities are ONE chapter of this story** — the money layer,
one page of the site (`/agent/:id/wallet`). They get the per-ability deep
dives in [wallet/](wallet/) because the video opens there, but every other
chapter is the rest of the agent, and there is a lot more of it.

## The chapters

| # | Chapter |
|---|---------|
| 01 | [The Body — 3D creation](chapters/01-the-body.md) |
| 02 | [Motion — embodiment and animation](chapters/02-motion.md) |
| 03 | [Creation studios — where agents are made](chapters/03-creation-studios.md) |
| 04 | [The Mind — memory, dreams, and autonomy](chapters/04-the-mind.md) |
| 05 | [The Voice — conversation](chapters/05-the-voice.md) |
| 06 | [Identity & reputation](chapters/06-identity-reputation.md) |
| 07 | [Skills — what agents know how to do](chapters/07-skills.md) |
| 08 | [Screens — the apps agents carry](chapters/08-screens.md) |
| 09 | [The Agent Economy — earning, hiring, owning](chapters/09-the-agent-economy.md) |
| 10 | [The Agent Wallet — the money layer (23 abilities)](chapters/10-the-agent-wallet.md) |
| 11 | [Markets & intelligence](chapters/11-markets-intelligence.md) |
| 12 | [Live worlds, social & IRL](chapters/12-live-worlds-social-irl.md) |
| 13 | [Agents everywhere — embeds, plugins, mobile](chapters/13-agents-everywhere.md) |
| 14 | [The Developer platform](chapters/14-the-developer-platform.md) |
| 15 | [Appendix — the full product map](chapters/15-appendix.md) |

## The 23 wallet abilities (video order)

| # | Ability | Hook |
|---|---------|------|
| 01 | [Balance](wallet/01-balance.md) | Your agent's real Solana balance, live from the chain — with a USD estimate and a receipt trail for every transaction. |
| 02 | [Go Live](wallet/02-go-live.md) | One tap sends real SOL from the three.ws treasury to your agent's wallet and puts it live on the Money Pulse — with an explorer-verifiable receipt. |
| 03 | [Portfolio](wallet/03-portfolio.md) | Your agent's entire trading life — net worth, holdings, P&L, and risk — on one live screen that never fakes a number. |
| 04 | [Deposit](wallet/04-deposit.md) | Fund any agent in one scan — a tap-to-pay Solana QR with live on-chain confirmation the second the money lands. |
| 05 | [Copilot](wallet/05-copilot.md) | Talk to your agent's wallet — by text or voice — and it answers with live on-chain data, then preps guarded trades you confirm with one tap. |
| 06 | [Trust](wallet/06-trust.md) | A credit bureau plus proof-of-reserves for AI agents — one 0–100 trust score where every point traces to real money on-chain. |
| 07 | [Signals](wallet/07-signals.md) | A copy-trading marketplace where only provably profitable agents can sell signals — and one red button kills any subscription instantly. |
| 08 | [Trade](wallet/08-trade.md) | Your agent's wallet is a full trading desk — paste any pump.fun coin, see a live quote and a real on-chain safety verdict, and execute server-signed in two taps. |
| 09 | [Pulse](wallet/09-pulse.md) | Every tip, trade, launch, and payment your agent's wallet makes — streaming live, public, and provable on-chain. |
| 10 | [Snipe](wallet/10-snipe.md) | Describe a snipe strategy in plain English, backtest it against real launch history, and arm your agent to trade it from its own wallet — in one tap. |
| 11 | [Earn](wallet/11-earn.md) | Your avatar has a job: price its skills, watch it earn real USDC while you sleep, and hold the kill switch the whole time. |
| 12 | [Orders](wallet/12-orders.md) | Set-and-forget limit, stop, trailing, DCA, TWAP, and signal-driven orders that fire automatically from your agent's own wallet — on live on-chain data, inside your guardrails. |
| 13 | [Autopilot](wallet/13-autopilot.md) | Write one sentence in plain English and your agent starts paying its own bills, stacking $THREE, buying back its own coin, and sweeping the profit to you — for real, on-chain. |
| 14 | [Intents](wallet/14-intents.md) | Tell your agent's wallet what to do in one plain sentence — it compiles the rule, shows you a dry run, and then executes it for real on Solana, inside guardrails you set. |
| 15 | [Pay](wallet/15-pay.md) | Your agent shops the open x402 economy: find any paid API, see its live price, and settle it in USDC from the agent's own Solana wallet — receipt on-chain in seconds. |
| 16 | [Vanity](wallet/16-vanity.md) | Give your agent a wallet address that spells its name — ground on your own CPU at millions of attempts, then applied with a funds-safe swap that sweeps every asset over first. |
| 17 | [Policy](wallet/17-policy.md) | Write your agent's spending rules in plain English — AI translates them, deterministic code enforces them on every single spend. |
| 18 | [Withdraw](wallet/18-withdraw.md) | Sweep any asset out of your agent's wallet in three taps — server-signed, policy-guarded, and audited down to every single key touch. |
| 19 | [Give](wallet/19-give.md) | Turn your agent's wallet into a giving wallet — round up the spare change or donate any amount to any Solana cause, settled on-chain with a receipt you can verify. |
| 20 | [Proof of Custody](wallet/20-proof-of-custody.md) | Don't trust — verify: your agent wallet's custody, cryptographically proven in your own browser against the Solana blockchain itself. |
| 21 | [Access](wallet/21-access.md) | Put every bot on a leash: mint tight, revocable spending keys so no strategy ever touches more of your agent's wallet than you allow. |
| 22 | [Recovery](wallet/22-recovery.md) | Lose your login — or go silent forever — and your funded agent wallet still finds its way home: guardians, a beneficiary, and a dead-man's switch that only fires when you truly can't stop it. |
| 23 | [Self-defense](wallet/23-self-defense.md) | Every agent wallet gets an immune system — it learns what normal spending looks like, freezes itself the instant something looks wrong, and explains why in plain English. |

## How to use these files

- **Video segments:** each wallet file is one segment — the tagline is the
  voiceover hook, "What it does" is the script body, "Screenshot-worthy" is the
  shot list, "Every feature" is the b-roll checklist. Chapter files work the
  same way at a coarser grain (each capability = one beat).
- **Article:** `FULL-ARTICLE.md` stitches everything into one long-form draft
  in chapter order.
