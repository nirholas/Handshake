---
title: "three.ws on AWS: giving AI agents a body, a wallet, and an AWS bill"
venue: AWS Builder Center / APN Partner Spotlight
account: three.ws (official)
description: "A look at three.ws, an AWS Technology Partner building browser-native 3D AI agents that you will buy through AWS Marketplace, govern before they act, embed like a video, and let pay for their own work."
tags: [aws, marketplace, agentic-ai, generative-ai, 3d, open-source]
canonical: https://three.ws/docs/aws-partner-spotlight.md
---

# three.ws on AWS: giving AI agents a body, a wallet, and an AWS bill

Most enterprise AI agents live inside a chat box. For a lot of work that is exactly right. But for a growing class of experiences, including brand agents, product guides, tutors, training characters, storefront assistants, and in-world companions, a text box leaves most of the value on the table. A text box cannot be present. It cannot stand in a room, point at a product, walk a customer through a space, or carry a persistent identity that follows a user across a site and acts on their behalf.

[three.ws](https://three.ws) is built on a simple thesis: the next interface for AI is spatial, embeddable, and able to act. The platform gives an AI agent a body. You describe an agent in a sentence, and in a few minutes it becomes a textured, rigged, talking 3D character. You give it a brain, optionally a wallet and an on-chain identity, and you drop it onto any web page with a single line of HTML, as easily as embedding a video. The agent renders right in the browser, holds a conversation, remembers across visits, reacts to the page around it, and when you let it, pays for the data and tools it needs to be useful.

three.ws is an **AWS Technology Partner in the AWS Partner Network**, and the AWS Marketplace listing is built and awaiting publication, so an enterprise will be able to adopt all of this through procurement it already trusts. This is a look at what the team has built, what they are building next, and why running it with AWS makes embodied agents something a business can actually buy, govern, and put into production.

---

## The idea: give AI a body

Today's agents reply. three.ws agents are present. The difference sounds small and turns out to be enormous. An embodied agent can stand on your storefront and walk a shopper through a product. It can be a tutor that demonstrates rather than describes. It can be a brand character that greets every visitor and remembers the last conversation. It can be a guide inside a 3D space, or a companion that strolls alongside a user as they move through a site.

Two problems have historically killed projects like these before they ship. The first is the sheer cost of building a 3D and games pipeline just to put a character on a page. The second is that even a beautiful agent is inert if it cannot act, if it cannot reach for a tool, pull live data, or pay for the thing that makes it useful. three.ws set out to remove both. Generating and rendering a 3D agent now takes a prompt and a browser, no games team required. And acting, including paying for what it consumes, is built into the runtime. What is left is the fun part: deciding what your agent should be and where it should live.

---

## What three.ws has built

The platform is broad on purpose, because an agent with a body needs a great many things to feel real. The pieces fit together into one product.

**From a sentence to a character.** The generation engine, Forge, turns a text prompt, a few reference photos, or even a hand-drawn sketch into a finished 3D model in minutes, at quality tiers that range from a quick draft to a high-fidelity, physically textured character. There is a free lane that needs no account, so anyone can try it.

**A body that actually moves.** A generated or uploaded model is automatically rigged and brought to life with a deep library of motion, from idle and walk to gestures and a wide emote set. The clever part is that it works with almost any character you bring, rather than a short list of blessed formats, so an avatar walks and gestures and emotes instead of freezing into a lifeless pose. Faces lip-sync to speech, expressions shift with the conversation, and the agent can speak and listen out loud.

**A real mind, not just a script.** Every agent gets a brain with memory and emotion. Builders choose the model behind it, with the latest Claude models as the default and IBM Granite among the first-class options. Emotion is a living blend rather than a set of canned states, and it reads out in the agent's face and posture. Memory persists across sessions and can be genuinely owned by the user, portable, exportable, and verifiable, so an agent's mind is not locked inside one vendor.

**Awareness of where it lives.** A three.ws agent understands the page it is embedded in. It can move across the layout, react to what is happening, and politely cover its eyes when you type a password into a form. It is a participant on the page, not a widget bolted onto the corner of it.

**One line to ship it.** When the agent is ready, it embeds anywhere as a simple web component, a single line of HTML, with a companion library for application teams. The same agent that took shape from a sentence drops into a marketing page, a storefront, a dashboard, or a documentation site without a rebuild. The proof is that these agents already run in production, including a finance dashboard where the avatar reacts with its body language as a position moves, and a live storefront.

**A way to act and to pay.** Agents reach tools through an open standard, and when a tool costs money they can pay for it directly, by the call, with a verifiable receipt and a hard spending limit the owner sets. That last capability is what turns an agent from something that answers into something that does.

**An identity and an economy.** Agents can carry a portable, on-chain identity, a stable name, a wallet, a reputation that cannot be forged, and they can participate in a working economy where agents and people post real work, claim it, deliver it, and get paid. Governance sits in front of the spending, deciding whether an action is allowed, and a tamper-evident record proves what actually happened.

The throughline across all of it is a single, ambitious idea: an agent you can see, talk to, trust, and hand a budget, embedded as easily as a video.

---

## Why AWS

three.ws runs across several clouds, each carrying the work it is best at, and AWS carries the parts where its strengths matter most: storage and delivery of the 3D assets, a slice of the rendering, the operational visibility a serious platform needs, and, most importantly for an enterprise, procurement.

The platform is being listed on **AWS Marketplace** as an API-based (SaaS) product. That single fact changes how a business can adopt it. Instead of a separate vendor relationship and a new way to pay, an enterprise subscribes through the marketplace it already uses, and the subscription itself is free: it links the AWS account, issues an API key, and hands the builders an agent platform without a procurement detour. The finance and security teams see something familiar. (The listing is complete on our side and waiting on AWS publication; until it goes public, the same API is reachable directly.)

What makes this genuinely novel is what sits underneath. three.ws agents can already pay for tools on their own, by the call, over an open payment rail. The team wired AWS Marketplace into the very same access check, so one product serves two economies through one door. An enterprise buyer arrives through AWS procurement. An independent developer pays per call with stablecoins and needs no account at all. Both reach the identical capability, and the platform recognizes whichever world the caller comes from without forking its authorization path. That is a clean, pay-for-what-you-use model that fits how enterprises actually want to adopt agentic AI: autonomous where it helps, bounded by policy, and auditable end to end.

Running on AWS also brings the operational posture an enterprise expects. The team manages its AWS footprint as code, so the environment is reproducible and reviewable rather than hand-assembled. Activity is centralized where an AWS-native operations team already looks, so the people responsible for uptime and security can watch the platform with the tools they already trust. And the whole thing is grouped as a single application in the AWS console, with cost and operational views in one place.

---

## Trust, because these agents hold real value

An agent that can carry an identity and spend from a wallet has to be defensible, not just delightful. three.ws treats trust as a feature rather than an afterthought.

Governance comes before action. When an agent proposes to spend or to act autonomously, that action is weighed against named risks and can be allowed, sent for review, or blocked outright, and a blocked action does not happen. Every one of those decisions is written into a record that cannot be quietly altered and that anyone can re-verify. Spending lives inside limits the owner sets in plain language. Wallets defend themselves, learning an agent's normal behavior and freezing anything that looks wrong. And custody is provable, with regular snapshots anyone can check for themselves, rather than a promise to be taken on faith.

The principle is consistent: governance decides whether an agent may act, and an unforgeable record proves what it did. For an enterprise, that pairing is the difference between a fun demo and something you can put in front of customers.

---

## What three.ws is building next

The platform ships at a pace that is hard to overstate, going from first public appearance to a live, on-stream build with a major partner in roughly two months, and the roadmap keeps widening.

Voice and presence are getting deeper, with real-time spoken conversation, voice cloning, and autonomous voice agents that can join a live audio space, listen, and respond. The agents are stepping off the screen entirely through augmented and virtual reality, where a character can be placed on your real floor, hide behind real objects, and be seen by other people nearby. Whole 3D worlds are being built where agents and people share space, explore, and play together. The agent economy is growing into a genuine marketplace of work, with reputation, verification, and real payment at its core. And the team is helping write the open standards for all of this, so embodiment and agent-to-agent payment become part of the open web rather than one company's private interface. The bet, consistently, is on open rails over walled gardens.

---

## In short

three.ws gives an AI agent a body, a memory, a personality, an identity, and the ability to act and pay, then makes it embeddable in a single line of HTML. AWS is what makes it adoptable at enterprise scale: a platform you will buy through AWS Marketplace, govern before it acts, and watch with the tools you already run, reaching the very same capability an independent developer reaches with no account at all.

One product. Two ways in. One authorization path.

**Learn more**
- Platform: [three.ws](https://three.ws)
- AWS Marketplace and procurement: [three.ws/docs/aws-marketplace](./aws-marketplace.md)
- How agents reach and pay for tools: [three.ws/docs/x402](./x402.md), [three.ws/docs/mcp](./mcp.md)
