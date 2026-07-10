# Sperax × three.ws — a partnership proposal

*Historical record: this is a partnership proposal drafted around 2026-07-08, including TVL figures current as of that date. It is a point-in-time pitch, not a status report on shipped work.*

**TL;DR**
Sperax has 7 years of shipped DeFi credibility and an auto-yield stablecoin; three.ws has crypto-native attention and a live 3D-agent platform. The trade: they rent our cultural relevance, we rent their credibility and capital. Five pillars: a recurring USDs/SPA-gated AI-credits funnel, USDs-endowed "agents that never die," a 3D guide embedded on Sperax's product via our published SDKs, Sperax's designed agent-economy split going live on our running x402/hiring rails, and a co-marketing sequence where every beat is a real ship, not a press release. 90 days, ordered by what's cheapest to prove first. Ask: a credit-pool budget, a technical contact, and a co-announcement slot.

## The trade

Sperax has shipped for seven years, raised $17M from Alameda, Outliers, Polychain, and Amber Group, and built USDs — a stablecoin that pays yield automatically, no staking — but carries low cultural heat for a protocol this established. three.ws has the opposite problem: real trench attention and momentum, on a live agent platform that already does 3D embeds, agent-to-agent payments, and agent hiring in production. Neither side needs to invent trust or attention — we hand each other the thing we already have.

## The five pillars

**1. Sponsored credits funnel — S**
"Hold USDs/SPA, claim monthly AI credits on three.ws" — recurring, not a one-shot airdrop. three.ws already runs a prepaid credit wallet (`/credits`) that accepts SOL and $THREE deposits and gives $THREE holders up to 30% off every spend; a SperaxOS plugin already exists (`/sperax`) granting three.ws users free AI credits on `chat.sperax.io` as a launch offer. This pillar extends that same ledger to accept USDs/SPA and makes the offer recurring. *Sperax gets:* retention — a reason to keep holding, not just claim once. *three.ws gets:* qualified, DeFi-native signups every month.

**2. Agent Endowments (flagship) — M/L**
Deposit USDs once; its auto-yield perpetually funds an agent's compute balance on three.ws — "agents that never die." Sperax's own docs describe USDs as earning "by default, no staking required," auto-yield starting "the moment USDs enter your wallet" (usds.sperax.io) — this pillar is new plumbing on a mechanism that already works, wired into three.ws's existing credit ledger, plus a public badge: "self-funding since \<date\>." Sperax USD carries roughly $521K TVL on Arbitrum (~$551K with staking) per DefiLlama, as of 2026-07-08 — real but early, which is exactly why a flagship new yield sink matters to them. *Sperax gets:* a genuine new USDs yield sink and the best USDs use-case story in years. *three.ws gets:* an answer to "who pays for agent compute long-term" that isn't "the user, forever."

**3. Their tools, our bodies — S/M**
three.ws ships two published, drop-in 3D SDKs: `@three-ws/page-agent` (a narrating 3D guide + avatar picker, one web component) and `@three-ws/tour` (a guide that walks a live site, spotlighting and narrating each section — one-tag CDN embed, demoable today at `/tour-builder`). Either drops onto `sperax.io` or `usds.sperax.io`; no new SDK to build. In return, Sperax's DeFi depth — USDs mechanics, veSPA staking, farms — becomes a skill pack three.ws agents call on, matching three.ws's existing 40-pack skill library. *Sperax gets:* a talking product face, fast. *three.ws gets:* real DeFi competence for its agents.

**4. The agent economy ships on three.ws — L**
The rails already run: x402 pay-per-call is live across dozens of endpoints (plus a self-hosted facilitator and the `@three-ws/x402-server` merchant SDK for turning any endpoint paid), agent-to-agent hiring is live (`agent_hire` / `agent_hire_discover` settle real USDC end to end with spend caps and a provenance receipt), and escrowed agent labor already exists via AgenC/Agora — task escrow with competitive and collaborative payout splits, currently in $THREE, plus a royalty-split precedent in the remix-asset settlement rail (creator-set royalty, capped, paid on-chain). Sperax's designed 70/20/10 creator/protocol/staker economics is a policy layer for these rails, not a rail to build from scratch; the concrete new work is adding USDs as a second settlement asset alongside $THREE and USDC. *Sperax gets:* their agent-economy design actually shipping, on infrastructure that already processes real payments. *three.ws gets:* a second settlement asset and a credible economic partner.

**5. Co-marketing beats — S**
Each pillar is a standalone, shippable announcement — not one big launch that slips. Order: credits funnel refresh → 3D guide on `sperax.io` → endowments pilot → economy split live. Every beat has a working URL to point at.

## Sequencing — 90 days

- **Weeks 1–2:** Pillar 1 (credits funnel extended to USDs/SPA, recurring) and a refreshed `/sperax` page reflecting it. Cheapest to ship — the ledger and the plugin both already exist.
- **Weeks 3–6:** Pillar 3 — a Sperax-tuned tour built with `@three-ws/tour` live on `sperax.io` or `usds.sperax.io`, plus the first Sperax skill pack for three.ws agents.
- **Weeks 7–12:** Pillar 2 pilot (a capped USDs endowment pool, first "self-funding since" badge) and Pillar 4 kickoff — USDs settlement integration and the economy-split design doc, published alongside Pillar 5's next co-marketing beat.

## What we need from Sperax

1. A credit-pool budget commitment (USDs/SPA) to fund pillar 1's monthly grant and seed pillar 2's endowment pilot.
2. A technical contact for the USDs contract interfaces (auto-yield, mint/redeem) and a plugin review on the SperaxOS side.
3. A co-announcement slot for the week 1–2 beat.

Both sides already ship for a living — this proposal only asks each of us to do more of what we're already good at, pointed at each other.
